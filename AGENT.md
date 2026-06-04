# IceChunk Accelerator — Project Context

## What This Is

A weather data visualisation app running on Snowflake Container Services (SPCS).
Real-time Met Office Global Deterministic 10km forecast data is stored in an
IceChunk Zarr store on S3 and queried via Snowflake service functions into a
DeckGL map with H3 hexagon or scatter-point rendering.

---

## Architecture

```
Browser
  └── icechunk-accelerator (SPCS, port 3001)
        React/Vite + Express proxy
        DeckGL + H3HexagonLayer / ScatterplotLayer
        CARTO dark basemap (tiles proxied via Express)
            │
            │  Snowflake REST API  (/api/query → POST /api/v2/statements)
            ▼
       Snowflake Warehouse (XSMALL, sized SMALL)
        ICECHUNK_SLICE_H3(var, lat, lat, lon, lon, snapshot_id, h3_res)  ← fast
        ICECHUNK_SLICE(var, lat, lat, lon, lon, snapshot_id)              ← raw points
        ICECHUNK_META()  ICECHUNK_SEED()  ICECHUNK_HEALTH()
            │
            │  Snowflake service function  (http-endpoint, port 8080)
            ▼
       icechunk-service (SPCS, port 8080)
        Python FastAPI
        IceChunk v2 (Zarr store on S3)
        Met Office ASDI ingest (9 surface variables, ~70 MB, parallel downloads)
        H3 aggregation via h3-py (C bindings)
            │
            ▼
        s3://icechunk-ro/met_office_global/  (us-west-2)
        1920 × 2560 grid  (~10km resolution)
        9 variables: air_temperature, wind_speed_at_10m, relative_humidity,
                     air_pressure_at_sea_level, lwe_precipitation_rate,
                     cloud_amount_{total,high,medium,low}_cloud
```

---

## Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Python backend container (icechunk-service) |
| `app/main.py` | FastAPI endpoints including `/snowflake/slice_h3` |
| `app/ingest.py` | Met Office ASDI downloader (parallel, 8 workers) |
| `app/requirements.txt` | Python deps — h3, h5py, icechunk, xarray |
| `icechunk-accelerator/` | React/Vite frontend + Express proxy |
| `icechunk-accelerator/server/index.ts` | SPCS auth, Snowflake REST API, parallel partition fetch, tile proxy |
| `icechunk-accelerator/src/components/WeatherViewer.tsx` | DeckGL map, H3/points toggle, region presets, snapshot selector |
| `icechunk-accelerator/src/types.ts` | VARIABLES, BBOX_PRESETS (30 regions), BBoxPreset |
| `service-spec.yaml` | Backend SPCS spec (reference) |
| `icechunk-accelerator/accelerator-service-spec.yaml` | Frontend SPCS spec (reference) |
| `build.sh` | `bash build.sh --bump patch` — builds both images, tags `:VERSION` + `:latest` |
| `VERSION` | Semver file (current: 1.0.5) |

---

## Snowflake Connection

- **Connection name**: `internal-marketplace`
- **Account**: `SFSEHOL-INTERNAL_MARKETPLACE`
- **Database/Schema**: `ICECHUNK_DB.ICECHUNK`
- **Warehouse**: `XSMALL` (sized SMALL)
- **Compute pool**: `ICECHUNK_COMPUTE_POOL` (CPU_X64_XS)
- **App ingress**: `https://nza42cpb-sfsehol-internal-marketplace.snowflakecomputing.app`

## SPCS Services

| Service | Image | Port | Endpoint |
|---------|-------|------|----------|
| `ICECHUNK_SERVICE` | `icechunk-service:latest` | 8080 | `http-endpoint` (private) |
| `ICECHUNK_ACCELERATOR_SERVICE` | `icechunk-accelerator:latest` | 3001 | `ui` (public) |

## Image Registry

```
sfsehol-internal-marketplace.registry.snowflakecomputing.com/icechunk_db/icechunk/icechunk_repo/
  icechunk-service:latest      (+ pinned versions e.g. :1.0.4)
  icechunk-accelerator:latest  (+ pinned versions e.g. :1.0.5)
```

---

## Common Commands

```bash
# Build and push both images with patch version bump
bash build.sh --bump patch

# Backend only (Python changes)
bash build.sh --service-only --bump patch

# Frontend only (React/Express changes)
bash build.sh --accel-only --bump patch

# Deploy both services after a new build
snow sql -c internal-marketplace -f .cortex/skills/icechunk-accelerator/scripts/03_deploy_services.sql

# Check service status
snow sql -c internal-marketplace -q "CALL SYSTEM\$GET_SERVICE_STATUS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE');"

# View backend logs
snow sql -c internal-marketplace -q "CALL SYSTEM\$GET_SERVICE_LOGS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE', '0', 'icechunk-service', 100);"

# View frontend logs
snow sql -c internal-marketplace -q "CALL SYSTEM\$GET_SERVICE_LOGS('ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE', '0', 'icechunk-accelerator', 100);"

# Trigger Met Office data ingest
snow sql -c internal-marketplace -q "SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED();"

# Quick health check
snow sql -c internal-marketplace -q "SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_HEALTH();"
```

---

## Critical Rules — Read Before Changing Anything

1. **Never set `SNOWFLAKE_HOST` in the accelerator service spec.**
   SPCS auto-injects the correct internal hostname. If you set it explicitly to
   `<account>.snowflakecomputing.com`, the container fails with ENOTFOUND because
   the public hostname is not resolvable from inside the compute pool.

2. **`AWS_DEFAULT_REGION` must be `us-west-2`** in the backend service spec.
   The `icechunk-ro` bucket is in us-west-2 and the `ICECHUNK_S3_NETWORK_RULE`
   only allows that regional endpoint. Using `us-east-1` causes a DNS failure.

3. **EAIs must be re-applied after every spec change.**
   `ALTER SERVICE FROM SPECIFICATION` silently drops `EXTERNAL_ACCESS_INTEGRATIONS`.
   After any spec update, always run:
   ```sql
   ALTER SERVICE ICECHUNK_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, MET_OFFICE_ASDI_EAI);
   ALTER SERVICE ICECHUNK_ACCELERATOR_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI);
   ```

4. **All service functions use `ENDPOINT = 'http-endpoint'`**, not `'api'`.
   The backend service spec defines the endpoint as `http-endpoint`.

5. **CARTO tile style: use `dark_all`, not `dark_matter_nolabels`.**
   `dark_matter_nolabels` returns HTTP 502 as of mid-2026. The `dark_all` style
   (same appearance, with labels) still works. See `server/index.ts` tile proxy.

6. **`h3-js` is NOT needed client-side.** H3 cell indices are computed by the
   Python backend via `h3.latlng_to_cell()` and returned as strings in the
   `ICECHUNK_SLICE_H3` response. The frontend uses them directly via
   `H3HexagonLayer.getHexagon: d => d.h3index`.

7. **Partition fetching is parallel** in `server/index.ts`. All partition GETs
   fire simultaneously via `Promise.all` — do not revert to a sequential loop.

---

## Snowflake Service Functions

| Function | Endpoint | Returns | Use case |
|----------|----------|---------|----------|
| `ICECHUNK_HEALTH()` | `/health` | VARIANT | Readiness check |
| `ICECHUNK_META()` | `/meta` | VARIANT | Variables, snapshot, grid info |
| `ICECHUNK_SEED()` | `/seed` | VARIANT | Download + ingest latest Met Office run |
| `ICECHUNK_SLICE(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/slice` | VARIANT | Raw grid points — for points mode |
| `ICECHUNK_SLICE_H3(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/slice_h3` | VARIANT | H3-aggregated cells — for hex mode (default, faster) |
| `ICECHUNK_CLOUD_AT_LEVEL(level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/cloud_level` | VARIANT | 3D cloud cover at height |

All functions return VARIANT. Use `LATERAL FLATTEN(input => result:data)` to expand rows.

---

## Deployment Runbook

Full step-by-step instructions are in:
`.cortex/skills/icechunk-accelerator/SKILL.md`

Scripts:
```
.cortex/skills/icechunk-accelerator/scripts/
  00_aws_setup.sh           S3 bucket + IAM user
  01_snowflake_setup.sql    DB, pool, secrets, EAIs, functions
  03_deploy_services.sql    CREATE SERVICE + EAI application
  04_load_data.sql          ICECHUNK_SEED + verification
```
