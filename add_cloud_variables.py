"""
add_cloud_variables.py — download Met Office cloud NetCDF files and add them
as new variables to the EXISTING Icechunk repository at met_office_global.

Creates a new commit (snapshot) with all cloud variables added.

New variables:
  2D surface cloud fields (~15 MB total):
    cloud_amount_below_1000ft         (lat × lon)
    cloud_amount_of_high_cloud        (lat × lon)
    cloud_amount_of_low_cloud         (lat × lon)
    cloud_amount_of_medium_cloud      (lat × lon)
    cloud_amount_of_total_cloud       (lat × lon)
    cloud_amount_of_total_convective_cloud (lat × lon)

  3D height-level cloud field (~67 MB):
    cloud_amount_on_height_levels     (height × lat × lon)
    cloud_height_levels               coordinate: array of height level values

All in units of oktas (0-8) or fraction (0-1), depending on variable.
"""
import os
import io
import boto3
import numpy as np
import xarray as xr
import zarr
import icechunk
from icechunk.storage import s3_storage
from botocore import UNSIGNED
from botocore.config import Config

# ── config ────────────────────────────────────────────────────────────────────
DEST_BUCKET = os.environ.get("ICECHUNK_BUCKET", "icechunk-ro")
DEST_PREFIX = "met_office_global"
DEST_REGION = os.environ.get("AWS_DEFAULT_REGION", "us-west-2")
AWS_KEY     = os.environ.get("AWS_ACCESS_KEY_ID")
AWS_SECRET  = os.environ.get("AWS_SECRET_ACCESS_KEY")

SRC_BUCKET  = "met-office-atmospheric-model-data"
SRC_PREFIX  = "global-deterministic-10km"
RUN_STAMP   = "20260602T0000Z"

# 2D surface cloud files
CLOUD_2D = [
    (f"{RUN_STAMP}-PT0000H00M-cloud_amount_below_1000ft_ASL.nc",
     "cloud_amount_below_1000ft"),
    (f"{RUN_STAMP}-PT0000H00M-cloud_amount_of_high_cloud.nc",
     "cloud_amount_of_high_cloud"),
    (f"{RUN_STAMP}-PT0000H00M-cloud_amount_of_low_cloud.nc",
     "cloud_amount_of_low_cloud"),
    (f"{RUN_STAMP}-PT0000H00M-cloud_amount_of_medium_cloud.nc",
     "cloud_amount_of_medium_cloud"),
    (f"{RUN_STAMP}-PT0000H00M-cloud_amount_of_total_cloud.nc",
     "cloud_amount_of_total_cloud"),
    (f"{RUN_STAMP}-PT0000H00M-cloud_amount_of_total_convective_cloud.nc",
     "cloud_amount_of_total_convective_cloud"),
]

# 3D height-level cloud file
CLOUD_3D_FILE  = f"{RUN_STAMP}-PT0000H00M-cloud_amount_on_height_levels.nc"
CLOUD_3D_VNAME = "cloud_amount_on_height_levels"


def download_nc(s3_anon, fname: str) -> xr.Dataset:
    key = f"{SRC_PREFIX}/{RUN_STAMP}/{fname}"
    print(f"  Downloading {fname} ...")
    obj = s3_anon.get_object(Bucket=SRC_BUCKET, Key=key)
    raw = obj["Body"].read()
    print(f"    {len(raw)/1e6:.1f} MB")
    return xr.open_dataset(io.BytesIO(raw), engine="h5netcdf")


def open_repo() -> icechunk.Repository:
    kwargs = dict(bucket=DEST_BUCKET, prefix=DEST_PREFIX, region=DEST_REGION)
    if AWS_KEY and AWS_SECRET:
        kwargs["access_key_id"]     = AWS_KEY
        kwargs["secret_access_key"] = AWS_SECRET
    else:
        kwargs["from_env"] = True
    return icechunk.Repository.open(storage=s3_storage(**kwargs))


def main():
    print("=== Adding cloud variables to Met Office Icechunk repo ===\n")

    s3_anon = boto3.client(
        "s3",
        region_name="eu-west-2",
        config=Config(signature_version=UNSIGNED)
    )

    # ── open existing repo for writing ───────────────────────────────────────
    repo    = open_repo()
    session = repo.writable_session("main")
    root    = zarr.open_group(session.store, mode="a")   # append mode

    # ── 2D surface cloud fields ───────────────────────────────────────────────
    CHUNKS_2D = (192, 256)
    for fname, zarr_name in CLOUD_2D:
        ds  = download_nc(s3_anon, fname)
        var = list(ds.data_vars)[0]
        arr = ds[var].values.squeeze().astype("float32")  # ensure 2D
        print(f"    {var} → {zarr_name}  shape={arr.shape}")

        z = root.create_array(zarr_name, shape=arr.shape,
                              chunks=CHUNKS_2D, dtype="float32",
                              overwrite=True)
        z.attrs["units"]       = str(ds[var].attrs.get("units", ""))
        z.attrs["long_name"]   = str(ds[var].attrs.get("long_name", zarr_name))
        z.attrs["source_file"] = fname
        z[:] = arr
        print(f"    Done — {arr.nbytes/1e6:.1f} MB")

    # ── 3D height-level cloud field ───────────────────────────────────────────
    print(f"\n  Processing 3D file: {CLOUD_3D_FILE}")
    ds3 = download_nc(s3_anon, CLOUD_3D_FILE)
    var3 = list(ds3.data_vars)[0]
    arr3 = ds3[var3].values.astype("float32")   # (height, lat, lon)
    print(f"    {var3} shape={arr3.shape}  dtype={arr3.dtype}")
    print(f"    Raw size: {arr3.nbytes/1e6:.1f} MB")

    # store height coordinate if present
    height_coord = None
    for hname in ("height", "pressure", "model_level_number", "level_height",
                  "atmosphere_hybrid_height_coordinate", "height_levels"):
        if hname in ds3.coords:
            height_coord = ds3.coords[hname].values.astype("float32")
            print(f"    Height coordinate: '{hname}'  {height_coord.shape}")
            hc = root.create_array(
                "cloud_height_levels",
                shape=height_coord.shape,
                chunks=height_coord.shape,
                dtype="float32",
                overwrite=True
            )
            hc.attrs["units"]     = str(ds3.coords[hname].attrs.get("units", "m"))
            hc.attrs["long_name"] = "Height levels for cloud amount"
            hc[:] = height_coord
            break

    # chunks: (1 height_level, 192 lat, 256 lon)
    n_levels = arr3.shape[0]
    CHUNKS_3D = (1, 192, 256)
    z3 = root.create_array(
        CLOUD_3D_VNAME,
        shape=arr3.shape,
        chunks=CHUNKS_3D,
        dtype="float32",
        overwrite=True
    )
    z3.attrs["units"]       = str(ds3[var3].attrs.get("units", ""))
    z3.attrs["long_name"]   = str(ds3[var3].attrs.get("long_name", CLOUD_3D_VNAME))
    z3.attrs["source_file"] = CLOUD_3D_FILE
    z3.attrs["dims"]        = ["height_level", "latitude", "longitude"]
    z3.attrs["n_levels"]    = n_levels
    z3[:] = arr3
    print(f"    Done — {arr3.nbytes/1e6:.1f} MB written across {n_levels} height levels")

    # ── commit ────────────────────────────────────────────────────────────────
    snapshot_id = session.commit(
        f"Added cloud variables: 6 surface fields + height-level cloud — {RUN_STAMP}"
    )
    repo.create_tag("met_office_cloud_20260602_T0000Z", snapshot_id=snapshot_id)

    print(f"\n=== Done ===")
    print(f"Snapshot ID : {snapshot_id}")
    print(f"Tag         : met_office_cloud_20260602_T0000Z")
    new_vars = [v for _, v in CLOUD_2D] + [CLOUD_3D_VNAME]
    print(f"New variables: {new_vars}")


if __name__ == "__main__":
    main()
