"""
ingest_uk.py — download Met Office UK Deterministic 2km NetCDF files
from the public ASDI S3 bucket and write them into a separate Icechunk
repository on S3 (ICECHUNK_UK_PREFIX, default met_office_uk_2km).

The UK 2km model uses OSGB36 Transverse Mercator (easting/northing in metres,
EPSG:27700).  DeckGL and all slice/H3 code requires WGS84 lat/lon.
We reproject once at ingest time using pyproj and store 2D latitude/longitude
arrays in the Zarr store.  Every downstream consumer then gets plain lat/lon.

Surface variables (T+0000H00M):
  air_temperature              temperature_at_screen_level.nc
  lwe_precipitation_rate       precipitation_rate.nc
  wind_speed_at_10m            wind_speed_at_10m.nc
  air_pressure_at_sea_level    pressure_at_mean_sea_level.nc
  relative_humidity            relative_humidity_at_screen_level.nc
  cloud_amount_of_total_cloud  cloud_amount_of_total_cloud.nc
  visibility_at_screen_level   visibility_at_screen_level.nc  ← UK-only
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
from pyproj import Transformer

from icechunk_client import open_or_create_uk_repo

logger = logging.getLogger(__name__)

SRC_BUCKET = "met-office-atmospheric-model-data"
SRC_PREFIX = "uk-deterministic-2km"

UK_SURFACE_FILES: dict[str, str] = {
    "air_temperature":              "temperature_at_screen_level",
    "lwe_precipitation_rate":       "precipitation_rate",
    "wind_speed_at_10m":            "wind_speed_at_10m",
    "air_pressure_at_sea_level":    "pressure_at_mean_sea_level",
    "relative_humidity":            "relative_humidity_at_screen_level",
    "cloud_amount_of_total_cloud":  "cloud_amount_of_total_cloud",
    "visibility_at_screen_level":   "visibility_at_screen_level",
}

CHUNKS = (128, 128)

# OSGB36 (EPSG:27700) → WGS84 (EPSG:4326); always_xy → (lon, lat)
_PROJ = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)


def _anon_s3():
    return boto3.client("s3", region_name="eu-west-2",
                        config=Config(signature_version=UNSIGNED))


def latest_uk_run_stamp() -> str:
    now = datetime.now(timezone.utc)
    return now.strftime("%Y%m%dT%H00Z")


def _download_one(args: tuple) -> tuple[str, Optional[xr.Dataset]]:
    var_name, file_suffix, run_stamp = args
    fname = f"{run_stamp}-PT0000H00M-{file_suffix}.nc"
    key = f"{SRC_PREFIX}/{run_stamp}/{fname}"
    s3 = _anon_s3()
    try:
        obj = s3.get_object(Bucket=SRC_BUCKET, Key=key)
        raw = obj["Body"].read()
        logger.info(f"  {var_name}: {len(raw)/1e6:.1f} MB from {key}")
        return var_name, xr.open_dataset(io.BytesIO(raw), engine="h5netcdf")
    except Exception as e:
        logger.error(f"  FAILED {key}: {e}")
        return var_name, None


def _reproject_to_latlon(easting_1d: np.ndarray, northing_1d: np.ndarray):
    E, N = np.meshgrid(easting_1d, northing_1d)
    lon2d, lat2d = _PROJ.transform(E.ravel(), N.ravel())
    return (lat2d.reshape(E.shape).astype("float32"),
            lon2d.reshape(E.shape).astype("float32"))


def _get_osgb36_coords(ds: xr.Dataset):
    for x_name in ("projection_x_coordinate", "x", "easting"):
        if x_name in ds.coords or x_name in ds:
            easting = ds[x_name].values.ravel().astype("float64"); break
    else:
        raise KeyError("Could not find easting coordinate")
    for y_name in ("projection_y_coordinate", "y", "northing"):
        if y_name in ds.coords or y_name in ds:
            northing = ds[y_name].values.ravel().astype("float64"); break
    else:
        raise KeyError("Could not find northing coordinate")
    return easting, northing


def _create_tag_safe(repo, tag_name: str, snapshot_id: str) -> None:
    try:
        repo.create_tag(tag_name, snapshot_id=snapshot_id)
        logger.info(f"  Tagged '{tag_name}'")
    except Exception as e:
        if "already exists" not in str(e) and "immutable" not in str(e):
            logger.warning(f"  Tag '{tag_name}' failed: {e}")


def ingest_uk(run_stamp: Optional[str] = None) -> dict:
    """Download UK 2km surface fields and commit to the UK Icechunk repo."""
    if not run_stamp:
        run_stamp = latest_uk_run_stamp()

    logger.info(f"=== Met Office UK 2km ingest: {run_stamp} ===")

    download_args = [(v, s, run_stamp) for v, s in UK_SURFACE_FILES.items()]
    datasets: dict[str, xr.Dataset] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        for var_name, ds in pool.map(_download_one, download_args):
            if ds is not None:
                datasets[var_name] = ds

    # Fall back up to 3 hours if current run not yet published
    for offset_h in range(1, 4):
        if datasets:
            break
        dt = datetime.strptime(run_stamp, "%Y%m%dT%H00Z").replace(tzinfo=timezone.utc)
        fallback = (dt - timedelta(hours=offset_h)).strftime("%Y%m%dT%H00Z")
        logger.warning(f"No files for {run_stamp}, trying {fallback}...")
        fallback_args = [(v, s, fallback) for v, s in UK_SURFACE_FILES.items()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for var_name, ds in pool.map(_download_one, fallback_args):
                if ds is not None:
                    datasets[var_name] = ds
        if datasets:
            run_stamp = fallback

    if not datasets:
        raise RuntimeError(f"No UK 2km files available for recent runs.")

    logger.info(f"Downloaded {len(datasets)}/{len(UK_SURFACE_FILES)} variables")

    first_ds = next(iter(datasets.values()))
    easting, northing = _get_osgb36_coords(first_ds)

    logger.info("Reprojecting OSGB36 → WGS84...")
    lat2d, lon2d = _reproject_to_latlon(easting, northing)
    nrows, ncols = lat2d.shape
    logger.info(f"  Grid: {nrows}×{ncols}  lat [{lat2d.min():.2f},{lat2d.max():.2f}]")

    repo = open_or_create_uk_repo()
    session = repo.writable_session("main")
    root = zarr.open_group(session.store, mode="w")

    root.create_array("latitude",  shape=(nrows, ncols), chunks=CHUNKS, dtype="float32")
    root["latitude"][:] = lat2d
    root["latitude"].attrs.update({"units": "degrees_north", "source_crs": "EPSG:27700"})

    root.create_array("longitude", shape=(nrows, ncols), chunks=CHUNKS, dtype="float32")
    root["longitude"][:] = lon2d
    root["longitude"].attrs.update({"units": "degrees_east", "source_crs": "EPSG:27700"})

    root.attrs.update({"model": "uk-deterministic-2km", "run": run_stamp,
                        "resolution": "~2km", "projection": "WGS84 (from OSGB36)"})

    for var_name, ds in datasets.items():
        data_var = list(ds.data_vars)[0]
        arr_data = ds[data_var].values.astype("float32")
        while arr_data.ndim > 2:
            arr_data = arr_data[0]
        if arr_data.shape != (nrows, ncols):
            logger.warning(f"  {var_name}: shape mismatch {arr_data.shape}, skipping")
            continue
        logger.info(f"  Writing {var_name} {arr_data.shape}...")
        arr = root.create_array(var_name, shape=arr_data.shape, chunks=CHUNKS, dtype="float32")
        arr.attrs["units"] = str(ds[data_var].attrs.get("units", ""))
        arr.attrs["long_name"] = str(ds[data_var].attrs.get("long_name", var_name))
        arr[:] = arr_data

    snapshot_id = session.commit(
        f"Met Office UK Deterministic 2km — {run_stamp} T+0 surface fields"
    )
    logger.info(f"Committed: {snapshot_id}")
    _create_tag_safe(repo, f"met_office_uk_{run_stamp}", snapshot_id)

    return {
        "snapshot_id": snapshot_id,
        "run_stamp":   run_stamp,
        "variables":   list(datasets.keys()),
        "grid": {
            "nrows":     nrows,
            "ncols":     ncols,
            "lat_range": [round(float(lat2d.min()), 4), round(float(lat2d.max()), 4)],
            "lon_range": [round(float(lon2d.min()), 4), round(float(lon2d.max()), 4)],
        },
        "message": f"Loaded {len(datasets)} variables at {nrows}×{ncols} grid (~2km UK)",
    }
