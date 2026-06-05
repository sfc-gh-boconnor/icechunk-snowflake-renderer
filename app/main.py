"""
main.py — Icechunk SPCS FastAPI service (data-agnostic)

Works with any Icechunk repository structure:
  - 2D arrays (lat × lon)    — e.g. Met Office single-timestep files
  - 3D arrays (time × lat × lon) — e.g. synthetic climate data

Variables and coordinate arrays are discovered dynamically from the Zarr group.

Endpoints:
  POST /seed              write synthetic sample data → commit
  POST /seed_uk           ingest UK 2km data from ASDI
  POST /slice             live slice query → rows for external function
  GET|POST /meta          global repo metadata
  GET|POST /meta_uk       UK repo metadata
  GET  /branches          list branches
  GET|POST /health        readiness probe
  POST /snowflake/slice      Snowflake service function format wrapper
  POST /snowflake/slice_h3   H3-aggregated slice (Python computes cells, fewer rows)
  POST /snowflake/slice_uk      UK 2km raw point slice
  POST /snowflake/slice_h3_uk   UK 2km H3-aggregated slice (2D curvilinear coords)
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

from icechunk_client import open_or_create_repo, open_repo, open_or_create_uk_repo, open_uk_repo
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
    """
    Return (lat_array, lon_array) from the Zarr group.
    Handles both 1D (global 10km) and 2D (UK 2km, curvilinear) coordinate arrays.
    """
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


MAX_RAW_UK_CELLS = 250_000  # Snowflake external functions have a 20 MB response limit.
                            # At ~55 bytes/cell JSON, 250K cells ≈ 14 MB — safe margin.
                            # Full UK (~1,011,000 cells) triggers stride=2 → 252K cells.
                            # Zoomed-in views below 250K are returned at native 2km.


def _slice_2d_curvilinear(
    root: zarr.Group,
    variable: str,
    lat_min: float, lat_max: float,
    lon_min: float, lon_max: float,
    h3_res: Optional[int] = None,
) -> dict:
    """
    Slice a variable from a curvilinear (2D coordinate) Zarr group.
    Used for UK 2km data where lat/lon are 2D arrays.

    For raw-point mode (h3_res=None), if the masked cell count exceeds
    MAX_RAW_UK_CELLS the grid is uniformly subsampled by a computed stride
    so the response stays within Snowflake's ~10 MB external-function limit.
    Both backend and frontend use the same formula so SolidPolygonLayer
    cell sizes are scaled to match the effective resolution.
    """
    lat2d = np.array(root["latitude"][:])
    lon2d = np.array(root["longitude"][:])

    mask = ((lat2d >= lat_min) & (lat2d <= lat_max) &
            (lon2d >= lon_min) & (lon2d <= lon_max))

    n_cells = int(mask.sum())
    if n_cells == 0:
        return {"data": [], "row_count": 0, "variable": variable,
                "message": "No data in requested lat/lon range"}
    if n_cells > 1_500_000:
        raise HTTPException(status_code=400,
            detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range.")

    variables = _discover_variables(root)
    if variable not in variables:
        raise HTTPException(status_code=400,
            detail=f"Unknown variable '{variable}'. Available: {variables}")

    arr = np.array(root[variable][:])
    while arr.ndim > 2:
        arr = arr[0]

    if h3_res is None:
        # Auto-stride: subsample the 2D grid uniformly so we stay under the
        # Snowflake external-function response size limit (~10 MB).
        # stride = ceil(sqrt(n_cells / target)) keeps output ≤ target cells.
        stride = 1
        if n_cells > MAX_RAW_UK_CELLS:
            stride = max(1, int(np.ceil(np.sqrt(n_cells / MAX_RAW_UK_CELLS))))

        if stride > 1:
            lat_use  = lat2d[::stride, ::stride]
            lon_use  = lon2d[::stride, ::stride]
            arr_use  = arr[::stride, ::stride]
            mask_use = mask[::stride, ::stride]
        else:
            lat_use, lon_use, arr_use, mask_use = lat2d, lon2d, arr, mask

        rows_idx, cols_idx = np.where(mask_use & ~np.isnan(arr_use))
        source_rows = [
            {"lat": round(float(lat_use[ri, ci]), 6),
             "lon": round(float(lon_use[ri, ci]), 6),
             "variable": variable,
             "value": round(float(arr_use[ri, ci]), 6)}
            for ri, ci in zip(rows_idx.tolist(), cols_idx.tolist())
        ]
        return {
            "data":      source_rows,
            "row_count": len(source_rows),
            "variable":  variable,
            "stride":    stride,
        }
    else:
        rows_idx, cols_idx = np.where(mask & ~np.isnan(arr))
        cells: dict[str, list[float]] = defaultdict(list)
        for ri, ci in zip(rows_idx.tolist(), cols_idx.tolist()):
            cell = h3lib.latlng_to_cell(float(lat2d[ri, ci]), float(lon2d[ri, ci]), h3_res)
            cells[cell].append(float(arr[ri, ci]))
        aggregated = [{"h3index": cell, "value": round(float(np.mean(vals)), 6)}
                      for cell, vals in cells.items()]
        return {"data": aggregated, "variable": variable, "h3_res": h3_res,
                "source_rows": len(rows_idx), "h3_cells": len(aggregated),
                "row_count": len(aggregated)}


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
    max_cells: int = 1_500_000


# ── endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
@app.post("/health")
def health(payload: dict = None):
    return {"data": [[0, {"status": "ok"}]]}


@app.post("/seed_uk")
def seed_uk_data(payload: dict = None):
    """Load Met Office UK 2km data from ASDI S3 and commit to the UK Icechunk repo.
    Default: all surface-only variables. Called by ICECHUNK_SEED_UK()."""
    logger.info("ICECHUNK_SEED_UK called — starting UK 2km ingest")
    try:
        from ingest_uk import ingest_uk
        result = ingest_uk()
        logger.info(f"UK ingest complete: {result['grid']['nrows']}×{result['grid']['ncols']} grid")
        return {"data": [[0, result]]}
    except Exception as e:
        logger.exception("UK 2km ingest failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/seed_uk_vars")
def seed_uk_vars(payload: dict = None):
    """Load selected UK 2km variables from ASDI S3.
    Payload: {"data": [[0, vars_json]]} where vars_json is a JSON array of zarr_key names.
    Called by ICECHUNK_SEED_UK_VARS()."""
    logger.info("ICECHUNK_SEED_UK_VARS called")
    try:
        import json
        from ingest_uk import ingest_uk
        selected_vars = None
        if payload and "data" in payload:
            row = payload["data"][0] if payload["data"] else []
            vars_json = str(row[1]) if len(row) > 1 and row[1] else None
            if vars_json:
                selected_vars = json.loads(vars_json)
                logger.info(f"  Selected vars: {selected_vars}")
        result = ingest_uk(selected_vars=selected_vars)
        logger.info(f"UK ingest complete: {len(result['variables'])} variables")
        return {"data": [[0, result]]}
    except Exception as e:
        logger.exception("UK 2km vars ingest failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/meta_uk")
@app.post("/meta_uk")
def uk_repo_meta(payload: dict = None):
    """Return UK 2km repository metadata."""
    try:
        repo    = open_uk_repo()
        session = repo.readonly_session("main")
        root    = zarr.open_group(session.store, mode="r")
        variables = _discover_variables(root)
        lat2d = np.array(root["latitude"][:]) if "latitude" in root else None
        lon2d = np.array(root["longitude"][:]) if "longitude" in root else None
        result = {
            "latest_snapshot": session.snapshot_id,
            "branches":   list(repo.list_branches()),
            "tags":       list(repo.list_tags()),
            "variables":  variables,
            "dataset":    "uk-deterministic-2km",
            "resolution": "~2km",
            "grid": {
                "nrows":     int(lat2d.shape[0]) if lat2d is not None else None,
                "ncols":     int(lat2d.shape[1]) if lat2d is not None else None,
                "lat_range": [round(float(lat2d.min()), 4), round(float(lat2d.max()), 4)] if lat2d is not None else None,
                "lon_range": [round(float(lon2d.min()), 4), round(float(lon2d.max()), 4)] if lon2d is not None else None,
            },
        }
        return {"data": [[0, result]]}
    except Exception as e:
        logger.exception("UK meta failed")
        raise HTTPException(status_code=500, detail=str(e))


# ── Direct API endpoints (no Snowflake function wire format, no 20 MB cap) ────
# These are called by the Express frontend directly, bypassing Snowflake external
# functions entirely.  MAX_RAW_DIRECT is much higher since the 20 MB constraint
# does not apply to direct HTTP calls.

MAX_RAW_DIRECT = 1_200_000  # full UK grid (~1,011,000 cells) at native 2km

class DirectSliceRequest(BaseModel):
    variable:    str
    lat_min:     float
    lat_max:     float
    lon_min:     float
    lon_max:     float
    snapshot_id: Optional[str] = None

class DirectLevelSliceRequest(BaseModel):
    variable:    str
    level_idx:   int
    lat_min:     float
    lat_max:     float
    lon_min:     float
    lon_max:     float
    snapshot_id: Optional[str] = None

@app.post("/direct/slice_uk")
def direct_slice_uk(req: DirectSliceRequest):
    """Direct UK 2km grid slice — bypasses Snowflake 20 MB external-function cap.
    Accepts simple JSON body; returns {data:[{lat,lon,value}...], row_count, stride}."""
    try:
        repo    = open_uk_repo()
        session = (repo.readonly_session(snapshot_id=req.snapshot_id)
                   if req.snapshot_id else repo.readonly_session("main"))
        root    = zarr.open_group(session.store, mode="r")

        lat2d = np.array(root["latitude"][:])
        lon2d = np.array(root["longitude"][:])
        mask  = ((lat2d >= req.lat_min) & (lat2d <= req.lat_max) &
                 (lon2d >= req.lon_min) & (lon2d <= req.lon_max))

        n_cells = int(mask.sum())
        if n_cells == 0:
            return {"data": [], "row_count": 0, "stride": 1}

        variables = _discover_variables(root)
        if req.variable not in variables:
            raise HTTPException(status_code=400,
                detail=f"Unknown variable '{req.variable}'. Available: {variables}")

        arr = np.array(root[req.variable][:])
        while arr.ndim > 2:
            arr = arr[0]

        # Auto-stride to stay within MAX_RAW_DIRECT (native 2km for full UK)
        stride = 1
        if n_cells > MAX_RAW_DIRECT:
            stride = max(1, int(np.ceil(np.sqrt(n_cells / MAX_RAW_DIRECT))))

        if stride > 1:
            lat_use  = lat2d[::stride, ::stride]
            lon_use  = lon2d[::stride, ::stride]
            arr_use  = arr[::stride, ::stride]
            mask_use = mask[::stride, ::stride]
        else:
            lat_use, lon_use, arr_use, mask_use = lat2d, lon2d, arr, mask

        rows_idx, cols_idx = np.where(mask_use & ~np.isnan(arr_use))
        rows = [
            {"lat": round(float(lat_use[ri, ci]), 6),
             "lon": round(float(lon_use[ri, ci]), 6),
             "value": round(float(arr_use[ri, ci]), 6)}
            for ri, ci in zip(rows_idx.tolist(), cols_idx.tolist())
        ]
        return {"data": rows, "row_count": len(rows), "stride": stride,
                "snapshot_id": session.snapshot_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Direct UK slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/direct/level_slice_uk")
def direct_level_slice_uk(req: DirectLevelSliceRequest):
    """Direct UK 2km 3D level slice — bypasses Snowflake 20 MB cap.
    Accepts simple JSON body; returns {data:[{lat,lon,value,height_m}...], total_levels, level_units}."""
    try:
        repo    = open_uk_repo()
        session = (repo.readonly_session(snapshot_id=req.snapshot_id)
                   if req.snapshot_id else repo.readonly_session("main"))
        root    = zarr.open_group(session.store, mode="r")

        if req.variable not in root:
            raise HTTPException(status_code=400, detail=f"Variable '{req.variable}' not found.")
        if root[req.variable].ndim != 3:
            raise HTTPException(status_code=400, detail=f"Variable '{req.variable}' is not 3D.")

        level_value, level_units, n_levels = _get_level_meta(root, req.variable, req.level_idx)
        if req.level_idx < 0 or req.level_idx >= n_levels:
            raise HTTPException(status_code=400,
                detail=f"level_idx must be 0–{n_levels-1}, got {req.level_idx}")

        lat2d = np.array(root["latitude"][:])
        lon2d = np.array(root["longitude"][:])
        mask  = ((lat2d >= req.lat_min) & (lat2d <= req.lat_max) &
                 (lon2d >= req.lon_min) & (lon2d <= req.lon_max))

        arr = root[req.variable][req.level_idx]

        # Stride to keep per-level response manageable in the browser level cache
        MAX_LEVEL_DIRECT = 300_000
        n_cells = int(mask.sum())
        stride = 1
        if n_cells > MAX_LEVEL_DIRECT:
            stride = max(1, int(np.ceil(np.sqrt(n_cells / MAX_LEVEL_DIRECT))))

        if stride > 1:
            lat_use  = lat2d[::stride, ::stride]
            lon_use  = lon2d[::stride, ::stride]
            arr_use  = arr[::stride, ::stride]
            mask_use = mask[::stride, ::stride]
        else:
            lat_use, lon_use, arr_use, mask_use = lat2d, lon2d, arr, mask

        rows_idx, cols_idx = np.where(mask_use & ~np.isnan(arr_use))
        rows = [
            {"lat":      round(float(lat_use[ri, ci]), 6),
             "lon":      round(float(lon_use[ri, ci]), 6),
             "value":    round(float(arr_use[ri, ci]), 6),
             "height_m": round(float(level_value), 4)}
            for ri, ci in zip(rows_idx.tolist(), cols_idx.tolist())
        ]
        return {"data": rows, "row_count": len(rows), "stride": stride,
                "total_levels": n_levels, "level_units": level_units,
                "snapshot_id": session.snapshot_id}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Direct UK level slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/slice_uk")
def snowflake_slice_uk(payload: dict):
    """Raw point slice from UK 2km repo. Same wire format as /snowflake/slice."""
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx         = row[0]
            variable    = str(row[1])
            lat_min, lat_max = float(row[2]), float(row[3])
            lon_min, lon_max = float(row[4]), float(row[5])
            snapshot_id = str(row[6]) if len(row) > 6 and row[6] else None
            repo    = open_uk_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")
            result  = _slice_2d_curvilinear(root, variable, lat_min, lat_max, lon_min, lon_max)
            result["snapshot_id"] = session.snapshot_id
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Snowflake UK slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/slice_h3_uk")
def snowflake_slice_h3_uk(payload: dict):
    """H3-aggregated slice from UK 2km repo. Same wire format as /snowflake/slice_h3."""
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx         = row[0]
            variable    = str(row[1])
            lat_min, lat_max = float(row[2]), float(row[3])
            lon_min, lon_max = float(row[4]), float(row[5])
            snapshot_id = str(row[6]) if len(row) > 6 and row[6] else None
            h3_res      = int(row[7]) if len(row) > 7 and row[7] is not None else 6
            repo    = open_uk_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")
            result  = _slice_2d_curvilinear(root, variable, lat_min, lat_max, lon_min, lon_max, h3_res)
            result["snapshot_id"] = session.snapshot_id
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Snowflake UK H3 slice failed")
        raise HTTPException(status_code=500, detail=str(e))


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

            # Guard cell count (200K per level keeps 3D pre-fetch manageable)
            n_cells = (li_end - li_start) * (loi_end - loi_start)
            if n_cells > 200_000:
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


@app.post("/snowflake/cloud_level_h3")
def snowflake_cloud_level_h3(payload: dict):
    """
    H3-aggregated Snowflake service function for height-level cloud queries.
    Same as /snowflake/cloud_level but aggregates raw points into H3 cells.

    Input:  {"data": [[0, height_level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res]]}
    Output: {"data": [[0, {"data": [{"h3index": "...", "value": <fraction>, "cloud_pct": <pct>}...],
                           "height_m": ..., "total_levels": N, "row_count": N}]]}

    height_level_idx: 0–(n_levels-1), 0 = lowest level ~20m
    h3_res:           H3 resolution 2–6 (default 5 ≈ 60km)
    value:            cloud fraction 0–1
    cloud_pct:        value × 100 (percentage, 0–100)
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
            h3_res      = int(row[7]) if len(row) > 7 and row[7] is not None else 5

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

            # Guard source cell count (pre-aggregation)
            n_cells = (li_end - li_start) * (loi_end - loi_start)
            if n_cells > 500_000:
                raise HTTPException(
                    status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range."
                )

            arr = cloud_arr[level_idx, li_start:li_end, loi_start:loi_end]

            # Aggregate raw grid points into H3 cells
            cells: dict[str, list[float]] = defaultdict(list)
            for li in range(arr.shape[0]):
                for loi in range(arr.shape[1]):
                    val = float(arr[li, loi])
                    if not np.isnan(val):
                        cell = h3lib.latlng_to_cell(
                            float(lat[li_start + li]),
                            float(lon[loi_start + loi]),
                            h3_res,
                        )
                        cells[cell].append(val)

            aggregated = []
            for cell, vals in cells.items():
                mean_val = float(np.mean(vals))
                aggregated.append({
                    "h3index":   cell,
                    "value":     round(mean_val, 6),
                    "cloud_pct": round(mean_val * 100, 2),
                })
                if height_m is not None:
                    aggregated[-1]["height_m"] = height_m

            result = {
                "data":         aggregated,
                "snapshot_id":  session.snapshot_id,
                "variable":     "cloud_amount_on_height_levels",
                "height_level": level_idx,
                "height_m":     height_m,
                "h3_res":       h3_res,
                "source_rows":  n_cells,
                "h3_cells":     len(aggregated),
                "row_count":    len(aggregated),
                "total_levels": n_levels,
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("Cloud level H3 slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/cloud_level_uk")
def snowflake_cloud_level_uk(payload: dict):
    """
    Snowflake service function for UK 2km height-level cloud queries — raw lat/lon points.
    UK grid uses 2D curvilinear lat/lon (Lambert Azimuthal Equal Area reprojected to WGS84).

    Input:  {"data": [[0, height_level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id]]}
    Output: {"data": [[0, {"data": [{lat, lon, value, cloud_pct, height_m}...],
                           "height_m": ..., "total_levels": N}]]}
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

            repo    = open_uk_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")

            if "cloud_amount_on_height_levels" not in root:
                raise HTTPException(status_code=400,
                    detail="cloud_amount_on_height_levels not found in UK repo. Run ICECHUNK_SEED_UK() first.")

            cloud_arr = root["cloud_amount_on_height_levels"]
            n_levels  = cloud_arr.shape[0]

            if level_idx < 0 or level_idx >= n_levels:
                raise HTTPException(status_code=400,
                    detail=f"height_level_idx must be 0–{n_levels-1}, got {level_idx}")

            height_m = None
            if "cloud_height_levels" in root:
                height_m = float(root["cloud_height_levels"][level_idx])

            # UK uses 2D curvilinear lat/lon arrays
            lat2d = np.array(root["latitude"][:])
            lon2d = np.array(root["longitude"][:])
            mask  = ((lat2d >= lat_min) & (lat2d <= lat_max) &
                     (lon2d >= lon_min) & (lon2d <= lon_max))

            n_cells = int(mask.sum())
            if n_cells > 200_000:  # 200K per level keeps 3D pre-fetch manageable
                raise HTTPException(status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range.")

            arr = cloud_arr[level_idx]  # (nrows, ncols)
            rows = []
            ri_arr, ci_arr = np.where(mask & ~np.isnan(arr))
            for ri, ci in zip(ri_arr.tolist(), ci_arr.tolist()):
                val = float(arr[ri, ci])
                row_dict = {
                    "lat":       round(float(lat2d[ri, ci]), 6),
                    "lon":       round(float(lon2d[ri, ci]), 6),
                    "value":     round(val, 6),
                    "cloud_pct": round(val * 100, 2),
                }
                if height_m is not None:
                    row_dict["height_m"] = height_m
                rows.append(row_dict)

            result = {
                "data":         rows,
                "snapshot_id":  session.snapshot_id,
                "variable":     "cloud_amount_on_height_levels",
                "height_level": level_idx,
                "height_m":     height_m,
                "row_count":    len(rows),
                "total_levels": n_levels,
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("UK cloud level slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/cloud_level_h3_uk")
def snowflake_cloud_level_h3_uk(payload: dict):
    """
    H3-aggregated UK 2km height-level cloud queries.

    Input:  {"data": [[0, height_level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res]]}
    Output: {"data": [[0, {"data": [{"h3index": "...", "value": ..., "cloud_pct": ..., "height_m": ...}...],
                           "height_m": ..., "total_levels": N}]]}
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
            h3_res      = int(row[7]) if len(row) > 7 and row[7] is not None else 6

            repo    = open_uk_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")

            if "cloud_amount_on_height_levels" not in root:
                raise HTTPException(status_code=400,
                    detail="cloud_amount_on_height_levels not found in UK repo. Run ICECHUNK_SEED_UK() first.")

            cloud_arr = root["cloud_amount_on_height_levels"]
            n_levels  = cloud_arr.shape[0]

            if level_idx < 0 or level_idx >= n_levels:
                raise HTTPException(status_code=400,
                    detail=f"height_level_idx must be 0–{n_levels-1}, got {level_idx}")

            height_m = None
            if "cloud_height_levels" in root:
                height_m = float(root["cloud_height_levels"][level_idx])

            lat2d = np.array(root["latitude"][:])
            lon2d = np.array(root["longitude"][:])
            mask  = ((lat2d >= lat_min) & (lat2d <= lat_max) &
                     (lon2d >= lon_min) & (lon2d <= lon_max))

            n_cells = int(mask.sum())
            if n_cells > 500_000:
                raise HTTPException(status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range.")

            arr = cloud_arr[level_idx]
            cells: dict[str, list[float]] = defaultdict(list)
            ri_arr, ci_arr = np.where(mask & ~np.isnan(arr))
            for ri, ci in zip(ri_arr.tolist(), ci_arr.tolist()):
                val  = float(arr[ri, ci])
                cell = h3lib.latlng_to_cell(float(lat2d[ri, ci]), float(lon2d[ri, ci]), h3_res)
                cells[cell].append(val)

            aggregated = []
            for cell, vals in cells.items():
                mean_val = float(np.mean(vals))
                entry = {
                    "h3index":   cell,
                    "value":     round(mean_val, 6),
                    "cloud_pct": round(mean_val * 100, 2),
                }
                if height_m is not None:
                    entry["height_m"] = height_m
                aggregated.append(entry)

            result = {
                "data":         aggregated,
                "snapshot_id":  session.snapshot_id,
                "variable":     "cloud_amount_on_height_levels",
                "height_level": level_idx,
                "height_m":     height_m,
                "h3_res":       h3_res,
                "source_rows":  n_cells,
                "h3_cells":     len(aggregated),
                "row_count":    len(aggregated),
                "total_levels": n_levels,
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("UK cloud level H3 slice failed")
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────────────────────────────
# Generic 3D level slice endpoints (UK) — work for any 3D variable
# (cloud / temperature / wind on height levels OR pressure levels)
# ─────────────────────────────────────────────────────────────────────────────

# Maps zarr variable name → (level_coord_zarr_key, level_units)
# level_units: "m" for height, "Pa" for pressure
LEVEL_COORD_MAP: dict[str, tuple[str, str]] = {
    "cloud_amount_on_height_levels":            ("cloud_height_levels", "m"),
    "temperature_on_height_levels":             ("height_levels",       "m"),
    "wind_speed_on_height_levels":              ("height_levels",       "m"),
    "wind_direction_on_height_levels":          ("height_levels",       "m"),
    "temperature_on_pressure_levels":           ("pressure_levels",     "Pa"),
    "relative_humidity_on_pressure_levels":     ("pressure_levels",     "Pa"),
    "wind_speed_on_pressure_levels":            ("pressure_levels",     "Pa"),
    "wind_direction_on_pressure_levels":        ("pressure_levels",     "Pa"),
    "wet_bulb_potential_temperature_on_pressure_levels": ("pressure_levels", "Pa"),
}


def _get_level_meta(root: zarr.Group, variable: str, level_idx: int):
    """
    Return (level_value, level_units, n_levels) for a 3D variable.
    level_value is None if the coordinate array is not stored.
    """
    n_levels = root[variable].shape[0]
    coord_name, units = LEVEL_COORD_MAP.get(variable, ("", ""))

    # Try stored coord from LEVEL_COORD_MAP
    level_value = None
    if coord_name and coord_name in root:
        level_value = float(root[coord_name][level_idx])
    elif "level_coord" in (root[variable].attrs or {}):
        # Fallback: read coord name from variable attrs (set at ingest time)
        coord_name = root[variable].attrs["level_coord"]
        units      = root[variable].attrs.get("level_units", units)
        if coord_name in root:
            level_value = float(root[coord_name][level_idx])

    if not units and "level_units" in (root[variable].attrs or {}):
        units = root[variable].attrs["level_units"]

    return level_value, units, n_levels


@app.post("/snowflake/level_slice_uk")
def snowflake_level_slice_uk(payload: dict):
    """
    Generic 3D level slice for the UK 2km repo — raw lat/lon points.
    Works for any 3D variable (cloud/temp/wind on height or pressure levels).

    Input:  {"data": [[0, variable, level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id]]}
    Output: {"data": [[0, {"data": [{lat, lon, value, level_value, level_units}...],
                           "total_levels": N, "level_units": "m"|"Pa", ...}]]}
    """
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx         = row[0]
            variable    = str(row[1])
            level_idx   = int(row[2])
            lat_min     = float(row[3])
            lat_max     = float(row[4])
            lon_min     = float(row[5])
            lon_max     = float(row[6])
            snapshot_id = str(row[7]) if len(row) > 7 and row[7] else None

            repo    = open_uk_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")

            if variable not in root:
                raise HTTPException(status_code=400,
                    detail=f"Variable '{variable}' not found in UK repo.")
            if root[variable].ndim != 3:
                raise HTTPException(status_code=400,
                    detail=f"Variable '{variable}' is not 3D (shape: {root[variable].shape}).")

            level_value, level_units, n_levels = _get_level_meta(root, variable, level_idx)

            if level_idx < 0 or level_idx >= n_levels:
                raise HTTPException(status_code=400,
                    detail=f"level_idx must be 0–{n_levels-1}, got {level_idx}")

            lat2d = np.array(root["latitude"][:])
            lon2d = np.array(root["longitude"][:])
            mask  = ((lat2d >= lat_min) & (lat2d <= lat_max) &
                     (lon2d >= lon_min) & (lon2d <= lon_max))

            n_cells = int(mask.sum())
            if n_cells > 200_000:  # 200K per level keeps 3D pre-fetch manageable
                raise HTTPException(status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range.")

            arr = root[variable][level_idx]
            rows = []
            ri_arr, ci_arr = np.where(mask & ~np.isnan(arr))
            for ri, ci in zip(ri_arr.tolist(), ci_arr.tolist()):
                row_dict = {
                    "lat":   round(float(lat2d[ri, ci]), 6),
                    "lon":   round(float(lon2d[ri, ci]), 6),
                    "value": round(float(arr[ri, ci]), 6),
                }
                if level_value is not None:
                    row_dict["level_value"] = level_value
                    row_dict["level_units"] = level_units
                rows.append(row_dict)

            result = {
                "data":         rows,
                "snapshot_id":  session.snapshot_id,
                "variable":     variable,
                "level_idx":    level_idx,
                "level_value":  level_value,
                "level_units":  level_units,
                "total_levels": n_levels,
                "row_count":    len(rows),
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("UK generic level slice failed")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/snowflake/level_slice_h3_uk")
def snowflake_level_slice_h3_uk(payload: dict):
    """
    Generic 3D level H3-aggregated slice for the UK 2km repo.

    Input:  {"data": [[0, variable, level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res]]}
    Output: {"data": [[0, {"data": [{"h3index": "...", "value": ..., "level_value": ...}...],
                           "total_levels": N, "level_units": "m"|"Pa", ...}]]}
    """
    try:
        rows_out = []
        for row in payload.get("data", []):
            idx         = row[0]
            variable    = str(row[1])
            level_idx   = int(row[2])
            lat_min     = float(row[3])
            lat_max     = float(row[4])
            lon_min     = float(row[5])
            lon_max     = float(row[6])
            snapshot_id = str(row[7]) if len(row) > 7 and row[7] else None
            h3_res      = int(row[8]) if len(row) > 8 and row[8] is not None else 6

            repo    = open_uk_repo()
            session = (repo.readonly_session(snapshot_id=snapshot_id)
                       if snapshot_id else repo.readonly_session("main"))
            root    = zarr.open_group(session.store, mode="r")

            if variable not in root:
                raise HTTPException(status_code=400,
                    detail=f"Variable '{variable}' not found in UK repo.")
            if root[variable].ndim != 3:
                raise HTTPException(status_code=400,
                    detail=f"Variable '{variable}' is not 3D (shape: {root[variable].shape}).")

            level_value, level_units, n_levels = _get_level_meta(root, variable, level_idx)

            if level_idx < 0 or level_idx >= n_levels:
                raise HTTPException(status_code=400,
                    detail=f"level_idx must be 0–{n_levels-1}, got {level_idx}")

            lat2d = np.array(root["latitude"][:])
            lon2d = np.array(root["longitude"][:])
            mask  = ((lat2d >= lat_min) & (lat2d <= lat_max) &
                     (lon2d >= lon_min) & (lon2d <= lon_max))

            n_cells = int(mask.sum())
            if n_cells > 500_000:
                raise HTTPException(status_code=400,
                    detail=f"Slice too large ({n_cells} cells). Narrow lat/lon range.")

            arr = root[variable][level_idx]
            cells: dict[str, list[float]] = defaultdict(list)
            ri_arr, ci_arr = np.where(mask & ~np.isnan(arr))
            for ri, ci in zip(ri_arr.tolist(), ci_arr.tolist()):
                cell = h3lib.latlng_to_cell(float(lat2d[ri, ci]), float(lon2d[ri, ci]), h3_res)
                cells[cell].append(float(arr[ri, ci]))

            aggregated = []
            for cell, vals in cells.items():
                entry = {
                    "h3index": cell,
                    "value":   round(float(np.mean(vals)), 6),
                }
                if level_value is not None:
                    entry["level_value"] = level_value
                    entry["level_units"] = level_units
                aggregated.append(entry)

            result = {
                "data":         aggregated,
                "snapshot_id":  session.snapshot_id,
                "variable":     variable,
                "level_idx":    level_idx,
                "level_value":  level_value,
                "level_units":  level_units,
                "h3_res":       h3_res,
                "source_rows":  n_cells,
                "h3_cells":     len(aggregated),
                "total_levels": n_levels,
                "row_count":    len(aggregated),
            }
            rows_out.append([idx, result])
        return {"data": rows_out}
    except HTTPException:
        raise
    except Exception as e:
        logger.exception("UK generic level H3 slice failed")
        raise HTTPException(status_code=500, detail=str(e))
