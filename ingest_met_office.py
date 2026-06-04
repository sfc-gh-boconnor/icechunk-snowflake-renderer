"""
ingest_met_office.py — download Met Office Global Deterministic 10km NetCDF files
from the public ASDI S3 bucket and write them as a real Icechunk (Zarr) repository
to s3://icechunk-ro/met_office_global/

Variables ingested (T+0 surface fields from today's 0000Z run):
  - air_temperature         (temperature_at_screen_level)
  - precipitation_rate      (lwe_precipitation_rate)
  - air_pressure            (pressure_at_mean_sea_level)
  - relative_humidity       (relative_humidity_at_screen_level)

Dimensions: time x latitude x longitude  (~1920 x 2560 at ~10km resolution)
"""
import os
import io
import boto3
import numpy as np
import xarray as xr
import zarr
import icechunk
from icechunk.storage import s3_storage
from datetime import datetime, timezone
from botocore import UNSIGNED
from botocore.config import Config

# ── config ────────────────────────────────────────────────────────────────────
DEST_BUCKET  = os.environ.get("ICECHUNK_BUCKET", "icechunk-ro")
DEST_PREFIX  = "met_office_global"
DEST_REGION  = os.environ.get("AWS_DEFAULT_REGION", "us-west-2")
AWS_KEY      = os.environ.get("AWS_ACCESS_KEY_ID")
AWS_SECRET   = os.environ.get("AWS_SECRET_ACCESS_KEY")

SRC_BUCKET   = "met-office-atmospheric-model-data"
SRC_PREFIX   = "global-deterministic-10km"
RUN_DT       = datetime(2026, 6, 2, 0, 0, tzinfo=timezone.utc)
RUN_STAMP    = RUN_DT.strftime("%Y%m%dT%H%MZ")   # 20260602T0000Z

# Surface T+0 files to ingest
FILES = [
    f"{RUN_STAMP}-PT0000H00M-temperature_at_screen_level.nc",
    f"{RUN_STAMP}-PT0000H00M-precipitation_rate.nc",
    f"{RUN_STAMP}-PT0000H00M-pressure_at_mean_sea_level.nc",
    f"{RUN_STAMP}-PT0000H00M-relative_humidity_at_screen_level.nc",
]


def download_nc(s3_anon, key: str) -> xr.Dataset:
    """Download a NetCDF from the public ASDI bucket into memory."""
    print(f"  Downloading s3://{SRC_BUCKET}/{key} ...")
    obj = s3_anon.get_object(Bucket=SRC_BUCKET, Key=key)
    raw = obj["Body"].read()
    print(f"    {len(raw)/1e6:.1f} MB")
    return xr.open_dataset(io.BytesIO(raw), engine="h5netcdf")


def open_or_create_icechunk_repo():
    kwargs = dict(bucket=DEST_BUCKET, prefix=DEST_PREFIX, region=DEST_REGION)
    if AWS_KEY and AWS_SECRET:
        kwargs["access_key_id"] = AWS_KEY
        kwargs["secret_access_key"] = AWS_SECRET
    else:
        kwargs["from_env"] = True
    storage = s3_storage(**kwargs)
    try:
        return icechunk.Repository.open(storage=storage)
    except Exception:
        print("  Creating new Icechunk repository...")
        return icechunk.Repository.create(storage=storage)


def main():
    print(f"=== Met Office Global Deterministic 10km → Icechunk ===")
    print(f"Run: {RUN_STAMP}")
    print(f"Destination: s3://{DEST_BUCKET}/{DEST_PREFIX}/\n")

    # ── anonymous read from public ASDI bucket ────────────────────────────────
    s3_anon = boto3.client(
        "s3",
        region_name="eu-west-2",   # Met Office bucket is in eu-west-2
        config=Config(signature_version=UNSIGNED)
    )

    # ── download all 4 files ──────────────────────────────────────────────────
    datasets = {}
    for fname in FILES:
        key = f"{SRC_PREFIX}/{RUN_STAMP}/{fname}"
        ds = download_nc(s3_anon, key)
        # pick the first data variable name
        var = list(ds.data_vars)[0]
        datasets[var] = ds
        print(f"    variable: {var}, shape: {ds[var].shape}, dtype: {ds[var].dtype}")

    # ── open / create Icechunk repo ───────────────────────────────────────────
    print("\nOpening Icechunk repository...")
    repo   = open_or_create_icechunk_repo()
    session = repo.writable_session("main")
    store  = session.store
    root   = zarr.open_group(store, mode="w")

    # ── extract shared coordinates from first dataset ─────────────────────────
    first_ds = next(iter(datasets.values()))
    lat = first_ds["latitude"].values.astype("float32")
    lon = first_ds["longitude"].values.astype("float32")

    # store coordinates
    root.create_array("latitude",  shape=lat.shape, chunks=lat.shape, dtype="float32")
    root["latitude"][:] = lat
    root["latitude"].attrs["units"] = "degrees_north"
    root["latitude"].attrs["long_name"] = "Latitude"

    root.create_array("longitude", shape=lon.shape, chunks=lon.shape, dtype="float32")
    root["longitude"][:] = lon
    root["longitude"].attrs["units"] = "degrees_east"
    root["longitude"].attrs["long_name"] = "Longitude"

    # store run metadata
    root.attrs["model"]       = "global-deterministic-10km"
    root.attrs["run"]         = RUN_STAMP
    root.attrs["source"]      = f"s3://{SRC_BUCKET}/{SRC_PREFIX}/{RUN_STAMP}/"
    root.attrs["created_at"]  = datetime.now(timezone.utc).isoformat()
    root.attrs["resolution"]  = "~10km"
    root.attrs["forecast_horizon"] = "T+0"

    # ── write each variable as a chunked Zarr array ─────────────────────────
    # Files are 2D (lat × lon) — single T+0 timestep, no time dimension in array
    # Chunks: (192, 256) → ~10° lat strips
    CHUNKS = (192, 256)
    for var_name, ds in datasets.items():
        arr_data = ds[var_name].values.astype("float32")   # (time, lat, lon)
        print(f"\nWriting {var_name} {arr_data.shape} ...")
        arr = root.create_array(
            var_name,
            shape=arr_data.shape,
            chunks=CHUNKS,
            dtype="float32",
        )
        arr.attrs["units"]     = str(ds[var_name].attrs.get("units", ""))
        arr.attrs["long_name"] = str(ds[var_name].attrs.get("long_name", var_name))
        arr.attrs["source_file"] = f"{RUN_STAMP}-PT0000H00M-{var_name.replace(' ', '_')}.nc"
        arr[:] = arr_data
        print(f"  Done — {arr_data.nbytes / 1e6:.1f} MB written")

    # ── commit ────────────────────────────────────────────────────────────────
    snapshot_id = session.commit(
        f"Met Office Global Deterministic 10km — run {RUN_STAMP} T+0 surface fields"
    )
    repo.create_tag("met_office_2026-06-02_T0000Z", snapshot_id=snapshot_id)

    print(f"\n=== Done ===")
    print(f"Snapshot ID : {snapshot_id}")
    print(f"Tag         : met_office_2026-06-02_T0000Z")
    print(f"Variables   : {list(datasets.keys())}")
    print(f"Grid        : {lat.shape[0]} lat × {lon.shape[0]} lon")


if __name__ == "__main__":
    main()
