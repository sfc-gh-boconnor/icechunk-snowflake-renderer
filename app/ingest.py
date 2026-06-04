"""
ingest.py — download Met Office Global Deterministic 10km NetCDF files
from the public ASDI S3 bucket (eu-west-2) and write them into the
Icechunk repository on S3.

Parallel downloads via ThreadPoolExecutor for speed.
Tag creation is idempotent — silently skips if tag already exists.

Surface variables loaded (T+0, single forecast step):
  air_temperature              temperature_at_screen_level.nc
  lwe_precipitation_rate       precipitation_rate.nc
  air_pressure_at_sea_level    pressure_at_mean_sea_level.nc
  relative_humidity            relative_humidity_at_screen_level.nc
  cloud_amount_of_total_cloud  cloud_amount_of_total_cloud.nc
  cloud_amount_of_high_cloud   cloud_amount_of_high_cloud.nc
  cloud_amount_of_low_cloud    cloud_amount_of_low_cloud.nc
  cloud_amount_of_medium_cloud cloud_amount_of_medium_cloud.nc
"""
import io
import os
import logging
import concurrent.futures
from datetime import datetime, timezone, timedelta
from typing import Optional

import boto3
import numpy as np
import zarr
import xarray as xr
from botocore import UNSIGNED
from botocore.config import Config

from icechunk_client import open_or_create_repo

logger = logging.getLogger(__name__)

SRC_BUCKET = "met-office-atmospheric-model-data"
SRC_PREFIX = "global-deterministic-10km"

# variable_name → file suffix (without run stamp prefix)
SURFACE_FILES: dict[str, str] = {
    "air_temperature":              "temperature_at_screen_level",
    "lwe_precipitation_rate":       "precipitation_rate",
    "air_pressure_at_sea_level":    "pressure_at_mean_sea_level",
    "relative_humidity":            "relative_humidity_at_screen_level",
    "wind_speed_at_10m":            "wind_speed_at_10m",
    "cloud_amount_of_total_cloud":  "cloud_amount_of_total_cloud",
    "cloud_amount_of_high_cloud":   "cloud_amount_of_high_cloud",
    "cloud_amount_of_low_cloud":    "cloud_amount_of_low_cloud",
    "cloud_amount_of_medium_cloud": "cloud_amount_of_medium_cloud",
}

# Chunk shape for 2D spatial arrays — ~10° lat strips × ~36° lon strips
CHUNKS = (192, 256)


def _anon_s3():
    """Anonymous boto3 client for the public Met Office ASDI bucket."""
    return boto3.client(
        "s3",
        region_name="eu-west-2",
        config=Config(signature_version=UNSIGNED),
    )


def latest_run_stamp() -> str:
    """
    Return the most likely available run stamp.
    Met Office publishes the 0000Z run several hours into the day.
    Try today first, fall back to yesterday if needed.
    The caller handles the case where neither is available.
    """
    today = datetime.now(timezone.utc)
    return today.strftime("%Y%m%dT0000Z")


def _download_one(args: tuple) -> tuple[str, Optional[xr.Dataset]]:
    """Download a single NetCDF file. Returns (var_name, dataset|None)."""
    var_name, file_suffix, run_stamp = args
    fname = f"{run_stamp}-PT0000H00M-{file_suffix}.nc"
    key = f"{SRC_PREFIX}/{run_stamp}/{fname}"
    s3 = _anon_s3()
    try:
        obj = s3.get_object(Bucket=SRC_BUCKET, Key=key)
        raw = obj["Body"].read()
        logger.info(f"  {var_name}: {len(raw) / 1e6:.1f} MB from {key}")
        ds = xr.open_dataset(io.BytesIO(raw), engine="h5netcdf")
        return var_name, ds
    except Exception as e:
        logger.error(f"  FAILED {key}: {e}")
        return var_name, None


def _create_tag_safe(repo, tag_name: str, snapshot_id: str) -> None:
    """Create a tag, silently ignoring 'already exists' errors (tags are immutable)."""
    try:
        repo.create_tag(tag_name, snapshot_id=snapshot_id)
        logger.info(f"  Tagged snapshot as '{tag_name}'")
    except Exception as e:
        if "already exists" in str(e) or "immutable" in str(e):
            logger.info(f"  Tag '{tag_name}' already exists — skipping")
        else:
            logger.warning(f"  Tag '{tag_name}' creation failed: {e}")


def ingest(run_stamp: Optional[str] = None) -> dict:
    """
    Download Met Office surface fields for the given run stamp and commit
    them to the Icechunk repository.

    Args:
        run_stamp: e.g. "20260601T0000Z". Defaults to yesterday's 0000Z run.

    Returns:
        dict with snapshot_id, run_stamp, variables, grid info.
    """
    if not run_stamp:
        run_stamp = latest_run_stamp()

    logger.info(f"=== Met Office 10km ingest: {run_stamp} ===")

    # ── parallel downloads ────────────────────────────────────────────────────
    download_args = [
        (var, suffix, run_stamp) for var, suffix in SURFACE_FILES.items()
    ]
    datasets: dict[str, xr.Dataset] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for var_name, ds in pool.map(_download_one, download_args):
            if ds is not None:
                datasets[var_name] = ds

    if not datasets:
        raise RuntimeError(
            f"No files downloaded for run {run_stamp}. "
            "The data may not be available yet — try a previous day's run."
        )

    logger.info(f"Downloaded {len(datasets)}/{len(SURFACE_FILES)} variables")

    # ── open or create Icechunk repo ─────────────────────────────────────────
    logger.info("Opening Icechunk repository...")
    repo = open_or_create_repo()
    session = repo.writable_session("main")
    root = zarr.open_group(session.store, mode="w")

    # ── write coordinate arrays ───────────────────────────────────────────────
    first_ds = next(iter(datasets.values()))

    # Try both coordinate name conventions used in Met Office NetCDF files
    def _get_coord(ds: xr.Dataset, *names: str) -> np.ndarray:
        for n in names:
            if n in ds:
                return ds[n].values.astype("float32")
            if n in ds.coords:
                return ds.coords[n].values.astype("float32")
        raise KeyError(f"Coordinate not found: {names}")

    lat = _get_coord(first_ds, "latitude", "lat", "projection_y_coordinate")
    lon = _get_coord(first_ds, "longitude", "lon", "projection_x_coordinate")

    root.create_array("latitude",  shape=lat.shape, chunks=lat.shape, dtype="float32")
    root["latitude"][:] = lat
    root["latitude"].attrs["units"]     = "degrees_north"
    root["latitude"].attrs["long_name"] = "Latitude"

    root.create_array("longitude", shape=lon.shape, chunks=lon.shape, dtype="float32")
    root["longitude"][:] = lon
    root["longitude"].attrs["units"]     = "degrees_east"
    root["longitude"].attrs["long_name"] = "Longitude"

    root.attrs["model"]      = "global-deterministic-10km"
    root.attrs["run"]        = run_stamp
    root.attrs["source"]     = f"s3://{SRC_BUCKET}/{SRC_PREFIX}/{run_stamp}/"
    root.attrs["created_at"] = datetime.now(timezone.utc).isoformat()
    root.attrs["resolution"] = "~10km"

    # ── write each variable as a 2D chunked Zarr array (lat × lon) ───────────
    for var_name, ds in datasets.items():
        data_var = list(ds.data_vars)[0]
        arr_data = ds[data_var].values.astype("float32")

        # Squeeze extra leading dims (time=1, ensemble=1, etc.)
        while arr_data.ndim > 2:
            arr_data = arr_data[0]

        logger.info(f"  Writing {var_name} {arr_data.shape} ...")
        arr = root.create_array(
            var_name,
            shape=arr_data.shape,
            chunks=CHUNKS,
            dtype="float32",
        )
        arr.attrs["units"]       = str(ds[data_var].attrs.get("units", ""))
        arr.attrs["long_name"]   = str(ds[data_var].attrs.get("long_name", var_name))
        arr.attrs["source_file"] = f"{run_stamp}-PT0000H00M-{SURFACE_FILES.get(var_name, var_name)}.nc"
        arr[:] = arr_data

    # ── commit ────────────────────────────────────────────────────────────────
    snapshot_id = session.commit(
        f"Met Office Global Deterministic 10km — {run_stamp} T+0 surface fields"
    )
    logger.info(f"Committed snapshot: {snapshot_id}")

    # ── tag (idempotent — skip if already exists) ─────────────────────────────
    # Date tag for this run
    _create_tag_safe(repo, f"met_office_{run_stamp}", snapshot_id)
    # v1.0 marks the first/canonical release — skip silently on repeat calls
    _create_tag_safe(repo, "v1.0", snapshot_id)

    result = {
        "snapshot_id": snapshot_id,
        "run_stamp":   run_stamp,
        "variables":   list(datasets.keys()),
        "grid": {
            "lat_count": int(len(lat)),
            "lon_count": int(len(lon)),
            "lat_range": [round(float(lat.min()), 4), round(float(lat.max()), 4)],
            "lon_range": [round(float(lon.min()), 4), round(float(lon.max()), 4)],
        },
        "message": f"Loaded {len(datasets)} variables at "
                   f"{len(lat)}×{len(lon)} grid points (~10km global)",
    }
    logger.info(f"=== Ingest complete: {len(lat)}×{len(lon)} grid, {len(datasets)} vars ===")
    return result
