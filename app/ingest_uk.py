"""
ingest_uk.py — download Met Office UK Deterministic 2km NetCDF files
from the public ASDI S3 bucket and write them into a separate Icechunk
repository on S3 (ICECHUNK_UK_PREFIX, default met_office_uk_2km).

Uses Lambert Azimuthal Equal Area (LAEA) → WGS84 reprojection via pyproj.

Variables are split into:
  Surface (2D):         UK_SURFACE_FILES
  Height-level (3D):    UK_3D_FILES (height dim)
  Pressure-level (3D):  UK_3D_FILES (pressure dim)

Call ingest_uk(selected_vars=['air_temperature', ...]) to choose a subset.
Default (selected_vars=None) loads all surface-only variables.
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
from pyproj import Transformer, CRS

from icechunk_client import open_or_create_uk_repo

logger = logging.getLogger(__name__)

SRC_BUCKET = "met-office-atmospheric-model-data"
SRC_PREFIX = "uk-deterministic-2km"

# zarr_key → ASDI filename suffix (without run stamp / .nc)
UK_SURFACE_FILES: dict[str, str] = {
    "air_temperature":              "temperature_at_screen_level",
    "lwe_precipitation_rate":       "precipitation_rate",
    "wind_speed_at_10m":            "wind_speed_at_10m",
    "air_pressure_at_sea_level":    "pressure_at_mean_sea_level",
    "relative_humidity":            "relative_humidity_at_screen_level",
    "cloud_amount_of_total_cloud":  "cloud_amount_of_total_cloud",
    "visibility_at_screen_level":   "visibility_at_screen_level",
    "cloud_amount_of_high_cloud":   "cloud_amount_of_high_cloud",
    "cloud_amount_of_low_cloud":    "cloud_amount_of_low_cloud",
    "cloud_amount_of_medium_cloud": "cloud_amount_of_medium_cloud",
    "wind_gust_at_10m":             "wind_gust_at_10m",
    "dew_point_temperature":        "temperature_of_dew_point_at_screen_level",
    "snowfall_rate":                "snowfall_rate",
    "rainfall_rate":                "rainfall_rate",
    "fog_fraction":                 "fog_fraction_at_screen_level",
}

# 3D variables: zarr_key → (asdi_filename_suffix, level_coord_zarr_name, level_units)
UK_3D_FILES: dict[str, tuple[str, str, str]] = {
    # height-level variables
    "cloud_amount_on_height_levels":  ("cloud_amount_on_height_levels", "cloud_height_levels", "m"),
    "temperature_on_height_levels":   ("temperature_on_height_levels",  "height_levels",       "m"),
    "wind_speed_on_height_levels":    ("wind_speed_on_height_levels",   "height_levels",       "m"),
    # pressure-level variables
    "temperature_on_pressure_levels":           ("temperature_on_pressure_levels",           "pressure_levels", "Pa"),
    "relative_humidity_on_pressure_levels":     ("relative_humidity_on_pressure_levels",     "pressure_levels", "Pa"),
    "wind_speed_on_pressure_levels":            ("wind_speed_on_pressure_levels",            "pressure_levels", "Pa"),
    "wind_direction_on_pressure_levels":        ("wind_direction_on_pressure_levels",        "pressure_levels", "Pa"),
}

# Default: all surface variables (no 3D by default — they are large)
UK_DEFAULT_SURFACE: set[str] = set(UK_SURFACE_FILES.keys())

CHUNKS = (128, 128)

_LAEA_UK = CRS.from_dict({
    'proj':  'laea',
    'lat_0': 54.9,
    'lon_0': -2.5,
    'x_0':   0.0,
    'y_0':   0.0,
    'a':     6378137.0,
    'b':     6356752.314140356,
    'units': 'm',
})
_PROJ = Transformer.from_crs(_LAEA_UK, "EPSG:4326", always_xy=True)


def _anon_s3():
    return boto3.client("s3", region_name="eu-west-2",
                        config=Config(signature_version=UNSIGNED))


def latest_uk_run_stamp() -> str:
    """Find the most recently published UK 2km run in the ASDI bucket."""
    s3 = _anon_s3()
    try:
        result = s3.list_objects_v2(
            Bucket=SRC_BUCKET, Prefix=SRC_PREFIX + "/",
            Delimiter="/",
        )
        prefixes = [p["Prefix"] for p in result.get("CommonPrefixes", [])]
        if prefixes:
            stamps = sorted([p.rstrip("/").split("/")[-1] for p in prefixes])
            return stamps[-1]
    except Exception as e:
        logger.warning(f"Could not list bucket for latest run: {e}")
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


def _get_projected_coords(ds: xr.Dataset):
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


def ingest_uk(run_stamp: Optional[str] = None,
              selected_vars: Optional[list[str]] = None) -> dict:
    """
    Download UK 2km fields and commit to the UK Icechunk repo.

    selected_vars: list of zarr_key names to download.
                   Accepts keys from UK_SURFACE_FILES and UK_3D_FILES.
                   None = all surface-only defaults (no large 3D vars).
    """
    if not run_stamp:
        run_stamp = latest_uk_run_stamp()

    # Resolve which variables to fetch
    if selected_vars is None:
        surface_to_fetch = dict(UK_SURFACE_FILES)
        d3_to_fetch: dict[str, tuple[str, str, str]] = {}
    else:
        sel = set(selected_vars)
        surface_to_fetch = {k: v for k, v in UK_SURFACE_FILES.items() if k in sel}
        d3_to_fetch      = {k: v for k, v in UK_3D_FILES.items()      if k in sel}

    logger.info(f"=== Met Office UK 2km ingest: {run_stamp} ===")
    logger.info(f"  Surface: {list(surface_to_fetch.keys())}")
    logger.info(f"  3D:      {list(d3_to_fetch.keys())}")

    # ── Download surface variables in parallel ─────────────────────────────────
    datasets: dict[str, xr.Dataset] = {}
    if surface_to_fetch:
        download_args = [(v, s, run_stamp) for v, s in surface_to_fetch.items()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            for var_name, ds in pool.map(_download_one, download_args):
                if ds is not None:
                    datasets[var_name] = ds

        # Fall back up to 6 hours if no files available
        for offset_h in range(1, 7):
            if datasets:
                break
            dt = datetime.strptime(run_stamp, "%Y%m%dT%H00Z").replace(tzinfo=timezone.utc)
            fallback = (dt - timedelta(hours=offset_h)).strftime("%Y%m%dT%H00Z")
            logger.warning(f"No files for {run_stamp}, trying {fallback}...")
            fallback_args = [(v, s, fallback) for v, s in surface_to_fetch.items()]
            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                for var_name, ds in pool.map(_download_one, fallback_args):
                    if ds is not None:
                        datasets[var_name] = ds
            if datasets:
                run_stamp = fallback

        if not datasets and not d3_to_fetch:
            raise RuntimeError(f"No UK 2km files available for recent runs.")

    # ── Establish projected coordinates ───────────────────────────────────────
    first_ds = None
    if datasets:
        first_ds = next(iter(datasets.values()))
    elif d3_to_fetch:
        first_key   = next(iter(d3_to_fetch))
        asdi_suffix = d3_to_fetch[first_key][0]
        _, first_ds = _download_one((first_key, asdi_suffix, run_stamp))
        if first_ds is None:
            raise RuntimeError("Could not download any files to establish grid coords.")

    easting, northing = _get_projected_coords(first_ds)
    logger.info("Reprojecting LAEA → WGS84…")
    lat2d, lon2d = _reproject_to_latlon(easting, northing)
    nrows, ncols = lat2d.shape
    logger.info(f"  Grid: {nrows}×{ncols}  lat [{lat2d.min():.2f},{lat2d.max():.2f}]")

    # ── Open/create repo and write surface variables ───────────────────────────
    repo    = open_or_create_uk_repo()
    session = repo.writable_session("main")
    root    = zarr.open_group(session.store, mode="w")

    root.create_array("latitude",  shape=(nrows, ncols), chunks=CHUNKS, dtype="float32")
    root["latitude"][:] = lat2d
    root["latitude"].attrs.update({"units": "degrees_north", "source_crs": "LAEA"})

    root.create_array("longitude", shape=(nrows, ncols), chunks=CHUNKS, dtype="float32")
    root["longitude"][:] = lon2d
    root["longitude"].attrs.update({"units": "degrees_east", "source_crs": "LAEA"})

    root.attrs.update({"model": "uk-deterministic-2km", "run": run_stamp,
                        "resolution": "~2km", "projection": "WGS84 (from LAEA)"})

    loaded_surface: list[str] = []
    for var_name, ds in datasets.items():
        data_var = list(ds.data_vars)[0]
        arr_data = ds[data_var].values.astype("float32")
        while arr_data.ndim > 2:
            arr_data = arr_data[0]
        if arr_data.shape != (nrows, ncols):
            logger.warning(f"  {var_name}: shape mismatch {arr_data.shape}, skipping")
            continue
        logger.info(f"  Writing {var_name} {arr_data.shape}…")
        arr = root.create_array(var_name, shape=arr_data.shape, chunks=CHUNKS, dtype="float32")
        arr.attrs["units"]     = str(ds[data_var].attrs.get("units", ""))
        arr.attrs["long_name"] = str(ds[data_var].attrs.get("long_name", var_name))
        arr[:] = arr_data
        loaded_surface.append(var_name)

    snapshot_id = session.commit(
        f"Met Office UK 2km — {run_stamp} T+0 surface fields ({len(loaded_surface)} vars)"
    )
    logger.info(f"Surface committed: {snapshot_id}")
    _create_tag_safe(repo, f"met_office_uk_{run_stamp}", snapshot_id)

    # ── Download and commit 3D variables (each in its own commit) ─────────────
    loaded_3d: list[str] = []
    stored_level_coords: set[str] = set()

    for zarr_key, (asdi_suffix, level_coord_name, level_coord_units) in d3_to_fetch.items():
        try:
            logger.info(f"Downloading 3D var: {zarr_key} ({asdi_suffix})")
            _, ds3 = _download_one((zarr_key, asdi_suffix, run_stamp))
            if ds3 is None:
                logger.warning(f"  {zarr_key}: download failed, skipping")
                continue

            data_var = list(ds3.data_vars)[0]
            arr3 = ds3[data_var].values.astype("float32")
            # Squeeze singleton leading dims (e.g. time) but keep (level, y, x)
            while arr3.ndim > 3:
                arr3 = arr3[0]

            if arr3.ndim != 3 or arr3.shape[1] != nrows or arr3.shape[2] != ncols:
                logger.warning(f"  {zarr_key}: unexpected shape {arr3.shape}, skipping")
                continue

            n_levels = arr3.shape[0]
            logger.info(f"  {zarr_key}: {arr3.shape} ({n_levels} levels)")

            session3 = repo.writable_session("main")
            root3    = zarr.open_group(session3.store, mode="a")

            # Store level coordinate array once per unique coord name
            if level_coord_name not in stored_level_coords:
                for cname in ("pressure", "height", "level_height",
                              "atmosphere_hybrid_height_coordinate", "height_levels"):
                    if cname in ds3.coords:
                        coord_vals = ds3.coords[cname].values.astype("float32")
                        lc = root3.create_array(level_coord_name,
                                                shape=coord_vals.shape,
                                                chunks=coord_vals.shape,
                                                dtype="float32",
                                                overwrite=True)
                        lc.attrs["units"]     = str(ds3.coords[cname].attrs.get("units", level_coord_units))
                        lc.attrs["long_name"] = f"Level coordinates for {zarr_key}"
                        lc[:] = coord_vals
                        stored_level_coords.add(level_coord_name)
                        logger.info(f"  Stored '{level_coord_name}' ({cname}): {coord_vals[:3]}…")
                        break

            # Chunk by single level for fast per-level reads
            z3 = root3.create_array(zarr_key,
                                    shape=arr3.shape,
                                    chunks=(1, 128, 128),
                                    dtype="float32",
                                    overwrite=True)
            z3.attrs["units"]       = str(ds3[data_var].attrs.get("units", ""))
            z3.attrs["long_name"]   = str(ds3[data_var].attrs.get("long_name", zarr_key))
            z3.attrs["dims"]        = ["level", "grid_y", "grid_x"]
            z3.attrs["level_coord"] = level_coord_name
            z3.attrs["level_units"] = level_coord_units
            z3.attrs["n_levels"]    = n_levels
            z3[:] = arr3

            snap3 = session3.commit(
                f"Met Office UK 2km — {run_stamp} {zarr_key} ({n_levels} levels)"
            )
            logger.info(f"  Committed {zarr_key}: {snap3}")
            snapshot_id = snap3
            loaded_3d.append(zarr_key)

        except Exception as e:
            logger.warning(f"  {zarr_key}: failed (non-fatal): {e}")

    return {
        "snapshot_id": snapshot_id,
        "run_stamp":   run_stamp,
        "variables":   loaded_surface + loaded_3d,
        "cloud_3d":    bool(loaded_3d),
        "grid": {
            "nrows":     nrows,
            "ncols":     ncols,
            "lat_range": [round(float(lat2d.min()), 4), round(float(lat2d.max()), 4)],
            "lon_range": [round(float(lon2d.min()), 4), round(float(lon2d.max()), 4)],
        },
        "message": (
            f"Loaded {len(loaded_surface)} surface + {len(loaded_3d)} 3D "
            f"variable(s) at {nrows}×{ncols} grid (~2km UK)"
        ),
    }
