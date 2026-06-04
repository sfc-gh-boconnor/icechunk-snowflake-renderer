"""
seeder.py — generate synthetic climate data and write it to Icechunk.

Arrays created (demo-sized for fast seeding):
  temperature  (time=365, lat=37, lon=73)   K   (daily, 5° resolution)
  pressure     (time=365, lat=37, lon=73)  hPa
  humidity     (time=365, lat=37, lon=73)   %

Chunking: (30, 1, 1) — 1 month × 1° lat × 1° lon blocks.
"""
import numpy as np
import zarr
from datetime import datetime, timezone

from icechunk_client import open_or_create_repo

TIMES = 365           # daily steps in a year
LATS = 37             # -90 to 90 at 5° step
LONS = 73             # -180 to 180 at 5° step
CHUNKS = (30, 1, 1)
YEAR_START = datetime(2024, 1, 1, tzinfo=timezone.utc)


def _lat_array() -> np.ndarray:
    return np.linspace(-90, 90, LATS)


def _lon_array() -> np.ndarray:
    return np.linspace(-180, 180, LONS)


def seed(repo) -> str:
    """Write sample climate arrays and return the new snapshot id."""
    session = repo.writable_session("main")
    store = session.store
    root = zarr.open_group(store, mode="w")

    lat = _lat_array()
    lon = _lon_array()
    rng = np.random.default_rng(42)

    # --- coordinate arrays ---
    root.create_array("lat", shape=(LATS,), chunks=(LATS,), dtype="float32")
    root["lat"][:] = lat.astype("float32")
    root["lat"].attrs["units"] = "degrees_north"

    root.create_array("lon", shape=(LONS,), chunks=(LONS,), dtype="float32")
    root["lon"][:] = lon.astype("float32")
    root["lon"].attrs["units"] = "degrees_east"

    root.create_array("time", shape=(TIMES,), chunks=(TIMES,), dtype="int32")
    root["time"][:] = np.arange(TIMES, dtype="int32")
    root["time"].attrs["units"] = f"days since {YEAR_START.isoformat()}"

    # broadcast shapes
    lat_grid  = lat[np.newaxis, :, np.newaxis]               # (1, lat, 1)
    day_grid  = np.arange(TIMES)[:, np.newaxis, np.newaxis]  # (time, 1, 1)

    # --- temperature (K) ---
    temp_data = (
        288.0
        - 0.5 * np.abs(lat_grid)
        + 5.0 * np.sin(2 * np.pi * day_grid / 365)
        + rng.normal(0, 1.0, (TIMES, LATS, LONS))
    ).astype("float32")

    t = root.create_array("temperature", shape=(TIMES, LATS, LONS),
                          chunks=CHUNKS, dtype="float32")
    t.attrs["units"] = "K"
    t.attrs["long_name"] = "Air Temperature"
    t[:] = temp_data

    # --- pressure (hPa) ---
    pres_data = (
        1013.0
        - 0.02 * np.abs(lat_grid)
        + rng.normal(0, 2.0, (TIMES, LATS, LONS))
    ).astype("float32")

    p = root.create_array("pressure", shape=(TIMES, LATS, LONS),
                          chunks=CHUNKS, dtype="float32")
    p.attrs["units"] = "hPa"
    p.attrs["long_name"] = "Surface Pressure"
    p[:] = pres_data

    # --- humidity (%) ---
    hum_data = np.clip(
        70.0 - 0.3 * np.abs(lat_grid) + rng.normal(0, 8.0, (TIMES, LATS, LONS)),
        0, 100
    ).astype("float32")

    h = root.create_array("humidity", shape=(TIMES, LATS, LONS),
                          chunks=CHUNKS, dtype="float32")
    h.attrs["units"] = "%"
    h.attrs["long_name"] = "Relative Humidity"
    h[:] = hum_data

    snapshot_id = session.commit(
        "Initial climate data: temperature, pressure, humidity 2024 (daily, 5°)"
    )
    # v1.0 tag is idempotent — skip silently if already exists
    try:
        repo.create_tag("v1.0", snapshot_id=snapshot_id)
    except Exception as e:
        if "already exists" in str(e) or "immutable" in str(e):
            pass  # fine — tag is immutable, snapshot still committed
        else:
            raise
    return snapshot_id
