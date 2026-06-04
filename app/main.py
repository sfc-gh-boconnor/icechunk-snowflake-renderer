"""
main.py — Icechunk SPCS FastAPI service (data-agnostic)

Works with any Icechunk repository structure:
  - 2D arrays (lat × lon)    — e.g. Met Office single-timestep files
  - 3D arrays (time × lat × lon) — e.g. synthetic climate data

Variables and coordinate arrays are discovered dynamically from the Zarr group.

Endpoints:
  POST /seed              write synthetic sample data → commit
  POST /slice             live slice query → rows for external function
  GET|POST /meta          repo metadata, variables, snapshot, branches, tags
  GET  /branches          list branches
  GET|POST /health        readiness probe
  POST /snowflake/slice      Snowflake service function format wrapper
  POST /snowflake/slice_h3   H3-aggregated slice (Python computes cells, fewer rows)
"""
import os
import logging
import numpy as np
import zarr
import h3 as h3lib
from collections import defaultdict
from contextlib import asynccontextmanager
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from icechunk_client import open_or_create_repo, open_repo
from seeder import YEAR_START, LATS, LONS, TIMES

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Coordinate array names to exclude from the variable list
COORD_NAMES = {"latitude", "longitude", "lat", "lon", "time", "projection_x_coordinate",
               "projection_y_coordinate", "latitude_longitude"}


# ── lifespan ──────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Service starting — connecting to Icechunk repo")
    yield
    logger.info("Service shutting down")


app = FastAPI(
    title="Icechunk Climate Service",
    description="SPCS service exposing Icechunk tensor data to Snowflake",
    version="2.0.0",
    lifespan=lifespan,
)


# ── helpers ───────────────────────────────────────────────────────────────────

def _discover_variables(root: zarr.Group) -> list[str]:
    """Return variable names (exclude coordinate arrays)."""
    return sorted(
        k for k in root.keys()
        if k.lower() not in COORD_NAMES and hasattr(root[k], "shape")
    )


def _get_coords(root: zarr.Group):
    """Return (lat_array, lon_array) from the Zarr group."""
    # Try common names
    lat = None
    lon = None
    for lat_name in ("latitude", "lat", "projection_y_coordinate"):
        if lat_name in root:
            lat = np.array(root[lat_name][:])
            break
    for lon_name in ("longitude", "lon", "projection_x_coordinate"):
        if lon_name in root:
            lon = np.array(root[lon_name][:])
            break
    return lat, lon


def _find_index_range(coords: np.ndarray, lo: float, hi: float):
    """Return (start_idx, end_idx) for values in [lo, hi]."""
    if coords is None:
        return 0, 1
    # coords may be ascending or descending
    if coords[0] <= coords[-1]:
        idx = np.where((coords >= lo) & (coords <= hi))[0]
    else:
        idx = np.where((coords <= hi) & (coords >= lo))[0]
    if len(idx) == 0:
        return None, None
    return int(idx[0]), int(idx[-1]) + 1


def _rows_from_2d(arr: np.ndarray, variable: str,
                  lat_vals: np.ndarray, lon_vals: np.ndarray) -> list[dict]:
    """Convert a 2D (lat × lon) numpy slice to row dicts."""
    rows = []
    for li in range(arr.shape[0]):
        for loi in range(arr.shape[1]):
            val = float(arr[li, loi])
            if not np.isnan(val):
                rows.append({
                    "lat":      round(float(lat_vals[li]), 6),
                    "lon":      round(float(lon_vals[loi]), 6),
                    "variable": variable,
                    "value":    round(val, 6),
                })
    return rows


def _rows_from_3d(arr: np.ndarray, variable: str,
                  lat_vals: np.ndarray, lon_vals: np.ndarray,
                  time_offset_days: int) -> list[dict]:
    """Convert a 3D (time × lat × lon) numpy slice to row dicts."""
    rows = []
    for ti in range(arr.shape[0]):
        ts = YEAR_START + timedelta(days=time_offset_days + ti)
        for li in range(arr.shape[1]):
            for loi in range(arr.shape[2]):
                val = float(arr[ti, li, loi])
                if not np.isnan(val):
                    rows.append({
                        "time":     ts.isoformat(),
                        "lat":      round(float(lat_vals[li]), 6),
                        "lon":      round(float(lon_vals[loi]), 6),
                        "variable": variable,
                        "value":    round(val, 6),
                    })
    return rows


# ── schemas ───────────────────────────────────────────────────────────────────

class SliceRequest(BaseModel):
    variable: str
    time_start: Optional[str] = None   # ignored for 2D arrays
    time_end:   Optional[str] = None
    lat_min: float = -10.0
    lat_max: float =  10.0
    lon_min: float = -10.0
    lon_max: float =  10.0
    snapshot_id: Optional[str] = None
    max_cells: int = 500_000


# ── endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
@app.post("/health")
def health(payload: dict = None):
    return {"data": [[0, {"status": "ok"}]]}


@app.post("/seed")
def seed_data(payload: dict = None):
    """
    Load real Met Office Global Deterministic 10km data from the ASDI S3 bucket
    and commit it to the Icechunk repository.

    Called by the Snowflake ICECHUNK_SEED() external function.
    Uses yesterday's 0000Z run by default (reliably available).
    Tags are created idempotently — no crash on repeat calls.
    """
    logger.info("ICECHUNK_SEED called — starting Met Office ingest")
    try:
        from ingest import ingest
        result = ingest()
        logger.info(f"Ingest complete: {result['grid']['lat_count']}×{result['grid']['lon_count']} grid, "
                    f"{len(result['variables'])} variables, snapshot={result['snapshot_id']}")
        return {"data": [[0, result]]}
    except Exception as e:
        logger.exception("Met Office ingest failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/meta")
@app.post("/meta")
def repo_meta(payload: dict = None):
    """Return repository metadata — latest snapshot, branches, tags, variables."""
    try:
        repo    = open_repo()
        session = repo.readonly_session("main")
        root    = zarr.open_group(session.store, mode="r")

        variables = _discover_variables(root)
        lat, lon  = _get_coords(root)

        result = {
            "latest_snapshot": session.snapshot_id,
            "branches":        list(repo.list_branches()),
            "tags":            list(repo.list_tags()),
            "variables":       variables,
            "grid": {
                "lat_count":  int(len(lat)) if lat is not None else None,
                "lon_count":  int(len(lon)) if lon is not None else None,
                "lat_range":  [round(float(lat.min()), 4), round(float(lat.max()), 4)] if lat is not None else None,
                "lon_range":  [round(float(lon.min()), 4), round(float(lon.max()), 4)] if lon is not None else None,
            },
        }
        return {"data": [[0, result]]}
    except Exception as e:
        logger.exception("Meta failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/branches")
def list_branches():
    try:
        repo = open_repo()
        return {"branches": list(repo.list_branches())}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/slice")
def slice_data(req: SliceRequest):
    """
    Slice a variable and return rows.
    Handles both 2D (lat × lon) and 3D (time × lat × lon) arrays.
    """
    try:
        repo = open_repo()
        if req.snapshot_id:
            session = repo.readonly_session(snapshot_id=req.snapshot_id)
        else:
            session = repo.readonly_session("main")

        root      = zarr.open_group(session.store, mode="r")
        variables = _discover_variables(root)

        if req.variable not in variables:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown variable '{req.variable}'. Available: {variables}"
            )

        lat, lon = _get_coords(root)
        if lat is None or lon is None:
            raise HTTPException(status_code=500, detail="Coordinate arrays not found in repo")

        # lat/lon index ranges
        li_start, li_end = _find_index_range(lat, req.lat_min, req.lat_max)
        loi_start, loi_end = _find_index_range(lon, req.lon_min, req.lon_max)
        if li_start is None or loi_start is None:
            return {"data": [], "snapshot_id": session.snapshot_id,
                    "variable": req.variable, "row_count": 0,
                    "message": "No data in requested lat/lon range"}

        arr_meta = root[req.variable]
        ndim = len(arr_meta.shape)

        if ndim == 2:
            # 2D: (lat × lon)
            n_cells = (li_end - li_start) * (loi_end - loi_start)
            if n_cells > req.max_cells:
                raise HTTPException(
                    status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range or increase max_cells."
                )
            arr = arr_meta[li_start:li_end, loi_start:loi_end]
            rows = _rows_from_2d(arr, req.variable,
                                  lat[li_start:li_end], lon[loi_start:loi_end])

        elif ndim == 3:
            # 3D: (time × lat × lon) — use YEAR_START + day-based time index
            t_start_dt = datetime.fromisoformat(req.time_start or "2024-01-01T00:00:00")
            t_end_dt   = datetime.fromisoformat(req.time_end   or "2024-01-07T00:00:00")
            ti_start   = max(0, int((t_start_dt.replace(tzinfo=timezone.utc) - YEAR_START).days))
            ti_end     = min(arr_meta.shape[0],
                             int((t_end_dt.replace(tzinfo=timezone.utc) - YEAR_START).days) + 1)

            n_cells = (ti_end - ti_start) * (li_end - li_start) * (loi_end - loi_start)
            if n_cells > req.max_cells:
                raise HTTPException(
                    status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow range or increase max_cells."
                )
            arr = arr_meta[ti_start:ti_end, li_start:li_end, loi_start:loi_end]
            rows = _rows_from_3d(arr, req.variable,
                                  lat[li_start:li_end], lon[loi_start:loi_end],
                                  ti_start)
        else:
            raise HTTPException(status_code=400,
                                detail=f"Unsupported array shape: {arr_meta.shape}")

        return {
            "data":        rows,
            "snapshot_id": session.snapshot_id,
            "variable":    req.variable,
            "row_count":   len(rows),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/slice")
def snowflake_slice(payload: dict):
    """
    Snowflake service function wrapper.
    Input:  {"data": [[0, variable, lat_min, lat_max, lon_min, lon_max]]}
    Output: {"data": [[0, result]]}
    """
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx = row[0]
            req = SliceRequest(
                variable=str(row[1]),
                lat_min=float(row[2]),
                lat_max=float(row[3]),
                lon_min=float(row[4]),
                lon_max=float(row[5]),
                snapshot_id=str(row[6]) if len(row) > 6 and row[6] else None,
            )
            result = slice_data(req)
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Snowflake slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/slice_h3")
def snowflake_slice_h3(payload: dict):
    """
    H3-aggregated Snowflake service function.
    Computes H3 cell indices in Python (C bindings, very fast) and returns one
    row per H3 cell with the mean value of all grid points that fall within it.
    This eliminates per-row H3_LATLNG_TO_CELL calls in Snowflake SQL and
    dramatically reduces the number of rows returned.

    Input:  {"data": [[0, variable, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res]]}
    Output: {"data": [[0, {"data": [{"h3index": "...", "value": ...}, ...], "row_count": N}]]}
    """
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx         = row[0]
            req = SliceRequest(
                variable    = str(row[1]),
                lat_min     = float(row[2]),
                lat_max     = float(row[3]),
                lon_min     = float(row[4]),
                lon_max     = float(row[5]),
                snapshot_id = str(row[6]) if len(row) > 6 and row[6] else None,
            )
            h3_res = int(row[7]) if len(row) > 7 and row[7] is not None else 5

            # Get the raw slice result
            raw = slice_data(req)
            source_rows = raw.get("data", [])

            # Aggregate: group values by H3 cell, take the mean
            cells: dict[str, list[float]] = defaultdict(list)
            for r in source_rows:
                cell = h3lib.latlng_to_cell(r["lat"], r["lon"], h3_res)
                cells[cell].append(r["value"])

            aggregated = [
                {"h3index": cell, "value": round(float(np.mean(vals)), 6)}
                for cell, vals in cells.items()
            ]

            result = {
                "data":        aggregated,
                "snapshot_id": raw.get("snapshot_id"),
                "variable":    req.variable,
                "h3_res":      h3_res,
                "source_rows": len(source_rows),
                "h3_cells":    len(aggregated),
                "row_count":   len(aggregated),
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Snowflake H3 slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/cloud_level")
def snowflake_cloud_level(payload: dict):
    """
    Snowflake service function for height-level cloud queries.
    Input:  {"data": [[0, height_level_idx, lat_min, lat_max, lon_min, lon_max]]}
    Output: {"data": [[0, {data:[{lat, lon, height_m, value}...], ...}]]}
    height_level_idx: 0-32 (0 = lowest level ~20m, 32 = highest ~40km)
    """
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx         = row[0]
            level_idx   = int(row[1])
            lat_min     = float(row[2])
            lat_max     = float(row[3])
            lon_min     = float(row[4])
            lon_max     = float(row[5])
            snapshot_id = str(row[6]) if len(row) > 6 and row[6] else None

            repo    = open_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")

            lat, lon = _get_coords(root)
            li_start, li_end   = _find_index_range(lat, lat_min, lat_max)
            loi_start, loi_end = _find_index_range(lon, lon_min, lon_max)

            cloud_arr = root["cloud_amount_on_height_levels"]
            n_levels  = cloud_arr.shape[0]

            if level_idx < 0 or level_idx >= n_levels:
                raise HTTPException(
                    status_code=400,
                    detail=f"height_level_idx must be 0–{n_levels-1}, got {level_idx}"
                )

            # Read height coordinate value for this level
            height_m = None
            if "cloud_height_levels" in root:
                height_m = float(root["cloud_height_levels"][level_idx])

            # Guard cell count
            n_cells = (li_end - li_start) * (loi_end - loi_start)
            if n_cells > 100_000:
                raise HTTPException(
                    status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range."
                )

            arr = cloud_arr[level_idx, li_start:li_end, loi_start:loi_end]
            rows = []
            for li in range(arr.shape[0]):
                for loi in range(arr.shape[1]):
                    val = float(arr[li, loi])
                    if not np.isnan(val):
                        row_dict = {
                            "lat":       round(float(lat[li_start + li]), 6),
                            "lon":       round(float(lon[loi_start + loi]), 6),
                            "value":     round(val, 6),
                            "cloud_pct": round(val * 100, 2),
                        }
                        if height_m is not None:
                            row_dict["height_m"] = height_m
                        rows.append(row_dict)

            result = {
                "data":           rows,
                "snapshot_id":    session.snapshot_id,
                "variable":       "cloud_amount_on_height_levels",
                "height_level":   level_idx,
                "height_m":       height_m,
                "row_count":      len(rows),
                "total_levels":   n_levels,
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Cloud level slice failed")
        raise HTTPException(status_code=500, detail=str(e))
