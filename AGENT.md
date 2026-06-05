# IceChunk Accelerator — Project Context

## What This Is

A weather data visualisation app running on Snowflake Container Services (SPCS).
Met Office forecast data (Global 10km and UK 2km) is stored as versioned IceChunk
Zarr stores on S3 and queried via Snowflake service functions into a DeckGL map
with H3 hexagon or grid-cell rendering, 3D level sliders for height and pressure
level variables, and a Cortex Agent (WEATHER_AGENT) that answers natural-language
weather questions and auto-focuses the map.

---

## Architecture

```
Browser
  └── icechunk-accelerator (SPCS, port 3001)
        React/Vite + Express proxy
        DeckGL + H3HexagonLayer / SolidPolygonLayer
        CARTO dark basemap (tiles proxied via Express)
        AgentChat panel — SSE stream to Cortex Agent API
            │
            │  Snowflake REST API  (/api/query → POST /api/v2/statements)
            │  Cortex Agent API   (/api/agent → POST /api/v2/agents/…/messages SSE)
            │  /api/ingest   /api/ingest_uk (with selectedFiles body)
            ▼
       Snowflake Warehouse (XSMALL, sized SMALL)
        ── Global 10km ──
        ICECHUNK_SLICE_H3(var, bbox, snapshot_id, h3_res)         ← fast default
        ICECHUNK_SLICE(var, bbox, snapshot_id)                     ← grid mode
        ICECHUNK_CLOUD_AT_LEVEL_H3(level, bbox, snapshot_id, h3_res)
        ICECHUNK_META()  ICECHUNK_SEED()  ICECHUNK_HEALTH()
        ── UK 2km ──
        ICECHUNK_SLICE_H3_UK(var, bbox, snapshot_id, h3_res)
        ICECHUNK_SLICE_UK(var, bbox, snapshot_id)
        ICECHUNK_LEVEL_SLICE_H3_UK(var, level, bbox, snapshot_id, h3_res)  ← any 3D var
        ICECHUNK_LEVEL_SLICE_UK(var, level, bbox, snapshot_id)
        ICECHUNK_META_UK()  ICECHUNK_SEED_UK()  ICECHUNK_SEED_UK_VARS(json)
        ── Cortex Agent ──
        WEATHER_AGENT  +  TOOL_WEATHER_META / TOOL_WEATHER_SLICE / TOOL_WEATHER_SUMMARY
            │
            │  Snowflake service function  (http-endpoint, port 8080)
            ▼
       icechunk-service (SPCS, port 8080)
        Python FastAPI
        IceChunk v2 (Zarr store on S3)
        Global ingest: 9 surface vars + 3D cloud (ingest.py)
        UK ingest: 15 surface + 3D height/pressure level vars (ingest_uk.py, LAEA→WGS84)
        H3 aggregation via h3-py (C bindings)
            │
            ▼
        s3://icechunk-ro/  (us-west-2)
          met_office_global/   — 1920×2560 grid, 9 surface + cloud-on-height-levels
          met_office_uk_2km/   — 970×1042 grid, 15 surface + height/pressure 3D vars
```

---

## Key Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Python backend container (icechunk-service) |
| `app/main.py` | FastAPI: all slice, level_slice, meta, seed endpoints for global + UK |
| `app/ingest.py` | Met Office ASDI global 10km downloader (9 surface vars) |
| `app/ingest_uk.py` | UK 2km downloader: accepts selected_vars list, handles surface + 3D height/pressure level vars |
| `app/requirements.txt` | `icechunk==2.0.5`, `zarr>=3.1.0`, `h3>=4.0.0`, `h5py`, `xarray`, `boto3`, `pyproj` |
| `icechunk-accelerator/server/index.ts` | Express: Snowflake REST API, parallel partitions, tile proxy, Cortex Agent SSE, ingest endpoints |
| `icechunk-accelerator/src/App.tsx` | Root — agentFocusBbox state, wires AgentChat ↔ WeatherViewer |
| `icechunk-accelerator/src/components/WeatherViewer.tsx` | DeckGL map: dataset/variable/level/bbox/snapshot controls; routes to correct function per dataset + var type |
| `icechunk-accelerator/src/components/AgentChat.tsx` | SSE streaming chat; fires onMapFocus(bbox) on tool result |
| `icechunk-accelerator/src/components/DataLoader.tsx` | Global + UK ingest UI with per-variable checkbox selection |
| `icechunk-accelerator/src/types.ts` | VARIABLES (all surface + 3D), UK_INGEST_FILES, BBOX_PRESETS |
| `build.sh` | `bash build.sh --bump patch` — builds both images |
| `VERSION` | Semver (current: 1.0.43) |
| `.cortex/skills/icechunk-accelerator/scripts/05_create_agent.sql` | WEATHER_AGENT + 3 tool procedures + grants |

---

## Snowflake Connection

- **Connection name**: `internal-marketplace`
- **Account**: `SFSEHOL-INTERNAL_MARKETPLACE`
- **Database/Schema**: `ICECHUNK_DB.ICECHUNK`
- **Warehouse**: `XSMALL` (sized SMALL)
- **Compute pool**: `ICECHUNK_COMPUTE_POOL` (CPU_X64_XS)
- **App ingress**: `https://jza42cpb-sfsehol-internal-marketplace.snowflakecomputing.app`

## SPCS Services

| Service | Image | Port | Endpoint |
|---------|-------|------|----------|
| `ICECHUNK_SERVICE` | `icechunk-service:latest` | 8080 | `http-endpoint` (private) |
| `ICECHUNK_ACCELERATOR_SERVICE` | `icechunk-accelerator:latest` | 3001 | `ui` (public) |

## Image Registry

```
sfsehol-internal-marketplace.registry.snowflakecomputing.com/icechunk_db/icechunk/icechunk_repo/
  icechunk-service:latest      (+ pinned :1.0.43)
  icechunk-accelerator:latest  (+ pinned :1.0.43)
```

---

## Datasets

### Global 10km (`met_office_global`)
- Grid: 1920 × 2560 (~10km, 0.09°)
- 9 surface variables ingested by `ICECHUNK_SEED()`
- `cloud_amount_on_height_levels` in separate snapshot (tag `met_office_cloud_*`)

### UK 2km (`met_office_uk_2km`)
- Grid: 970 × 1042 (~2km, LAEA reprojected to WGS84)
- **Surface (2D)** — 15 variables:
  - air_temperature, lwe_precipitation_rate, wind_speed_at_10m, air_pressure_at_sea_level, relative_humidity, cloud_amount_of_total_cloud, visibility_at_screen_level, cloud_amount_of_high_cloud, cloud_amount_of_low_cloud, cloud_amount_of_medium_cloud, wind_gust_at_10m, dew_point_temperature, snowfall_rate, rainfall_rate, fog_fraction
- **3D height levels** — cloud_amount_on_height_levels, temperature_on_height_levels, wind_speed_on_height_levels
- **3D pressure levels** — temperature_on_pressure_levels, relative_humidity_on_pressure_levels, wind_speed_on_pressure_levels, wind_direction_on_pressure_levels (33 levels, 100,000–1,000 Pa = 1000–10 hPa)

Default UK seed (`ICECHUNK_SEED_UK()`) loads surface-only. Use `ICECHUNK_SEED_UK_VARS(json)` or the DataLoader UI for 3D vars.

---

## 3D Variable Support

Both datasets support 3D variables with a level index slider:

- **Height levels**: level coordinate in metres, slider labels "Surface (~5m)" → "Upper (~40km)"
- **Pressure levels**: level coordinate in Pa, display as hPa (Pa ÷ 100), labels "Surface (1000 hPa)" → "Upper atm (10 hPa)"

The `LEVEL_COORD_MAP` in `main.py` maps each 3D variable to its zarr coordinate array:
- `cloud_amount_on_height_levels` → `cloud_height_levels` (m)
- `temperature_on_height_levels` → `height_levels` (m)
- `temperature_on_pressure_levels` → `pressure_levels` (Pa)
- etc.

**Level cache:** All N levels are pre-fetched in parallel (batches of 8) when a 3D variable is selected. The level slider reads from an in-memory `Map<levelIdx, WeatherPoint[]>` — no per-level re-fetch on slider movement.

**Global cloud requires snapshot:** `cloud_amount_on_height_levels` on the global dataset is stored in a separate IceChunk snapshot tagged `met_office_cloud_*`. Users must select this snapshot from the top-right picker before the data will appear.

---

## Colour Palette Selector

9 named palettes defined in `src/shared/format.ts` as `PALETTES: Record<PaletteKey, Palette>`:
`viridis`, `plasma`, `magma`, `inferno`, `coolwarm`, `rdbu`, `spectral`, `rainbow`, `greys`.

`colorScheme` state in `WeatherViewer.tsx` defaults to `'auto'` (uses `varMeta.colorScale`). When a named palette is selected, `activeColorScale = PALETTES[colorScheme].scale` overrides the variable default. Palette swatches rendered below the legend.

---

## Cortex Agent: WEATHER_AGENT

| Procedure | Purpose |
|-----------|---------|
| `TOOL_WEATHER_META()` | Returns available variables, latest snapshot, grid info |
| `TOOL_WEATHER_SLICE(region, variable, snapshot_id)` | Stats (min/max/avg/std) for one variable in a geocoded region |
| `TOOL_WEATHER_SUMMARY(region, snapshot_id)` | Full weather summary (all surface vars) for a region |

**Model**: `orchestration: auto` — do NOT hardcode a specific model name.

**Map focus**: when agent calls a tool, both tool results include a `bbox` field. `server/index.ts` extracts it from SSE `tool_result` events and emits `map_focus` → `AgentChat.tsx` fires `onMapFocus(bbox)` → map auto-zooms.

**Recreate**: `snow sql -f .cortex/skills/icechunk-accelerator/scripts/05_create_agent.sql -c internal-marketplace`

---

## Common Commands

```bash
# Build + deploy + print URL in one step (most common workflow)
bash build.sh --accel-only --bump patch --deploy    # frontend only
bash build.sh --service-only --bump patch --deploy  # backend only
bash build.sh --bump patch --deploy                  # both

# Build only (no deploy)
bash build.sh --accel-only --bump patch
bash build.sh --service-only --bump patch

# Deploy only (already built) — always prints the new URL
bash deploy.sh --accel-only       # frontend
bash deploy.sh --service-only     # backend
bash deploy.sh                    # both

# Get the current live URL (run this after any deploy)
snow sql -c internal-marketplace -q "SHOW ENDPOINTS IN SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE;"

# Check service status
snow sql -c internal-marketplace -q "CALL SYSTEM\$GET_SERVICE_STATUS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE');"

# View backend logs
snow sql -c internal-marketplace -q "CALL SYSTEM\$GET_SERVICE_LOGS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE', '0', 'icechunk-service', 100);"

# Trigger global Met Office data ingest
snow sql -c internal-marketplace -q "SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED();"

# Trigger UK surface-only ingest
snow sql -c internal-marketplace -q "SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED_UK();"

# Trigger UK ingest with specific vars (JSON array of zarr_key names)
snow sql -c internal-marketplace -q "SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED_UK_VARS('[\"cloud_amount_on_height_levels\",\"temperature_on_pressure_levels\"]');"

# Quick health check
snow sql -c internal-marketplace -q "SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_HEALTH();"

# Create / update Cortex Agent
snow sql -c internal-marketplace -f .cortex/skills/icechunk-accelerator/scripts/05_create_agent.sql
```

---

## Critical Rules

1. **Never set `SNOWFLAKE_HOST` in the accelerator service spec.** SPCS auto-injects it. Setting it explicitly causes ENOTFOUND inside the compute pool.

2. **`AWS_DEFAULT_REGION` must be `us-west-2`** in the backend spec. The bucket is in us-west-2 and the EAI network rule only allows that endpoint.

3. **EAIs must be re-applied after every spec change.** `ALTER SERVICE FROM SPECIFICATION` silently drops `EXTERNAL_ACCESS_INTEGRATIONS`. Use `bash deploy.sh` which handles this automatically and always prints the new URL.

4. **The ingress URL changes after every `ALTER SERVICE FROM SPECIFICATION`.** Always run `SHOW ENDPOINTS IN SERVICE ICECHUNK_ACCELERATOR_SERVICE` after any deploy and give the user the new URL. The `deploy.sh` script does this automatically.

4. **All service functions use `ENDPOINT = 'http-endpoint'`**, not `'api'`.

5. **Use `bash deploy.sh` for all SPCS deployments** (not manual `snow sql` ALTER SERVICE). This guarantees EAIs are applied and the URL is always shown:
```bash
bash deploy.sh --accel-only          # frontend only
bash deploy.sh --service-only        # backend only
bash deploy.sh                       # both
bash build.sh --accel-only --bump patch --deploy  # build + deploy in one step
```

6. **The ingress URL changes after every `ALTER SERVICE FROM SPECIFICATION`.** Always print the new URL — `deploy.sh` does this automatically via `SHOW ENDPOINTS`.

7. **CARTO tile style: use `dark_all`**, not `dark_matter_nolabels` (returns 502 as of mid-2026).

8. **H3 cell indices are computed by the Python backend** — no client-side h3-js needed.

8. **Partition fetching is parallel** in `server/index.ts`. Do not revert to sequential.

9. **Agent model must be `orchestration: auto`** — do not hardcode `claude-sonnet-4-7` etc.

10. **`ICECHUNK_DB` role needs `CORTEX_USER`** for agent and tool procedures to call AI_COMPLETE.

11. **Global variable dropdown is filtered**: `VARIABLES.filter(v => !v.is3D || v.key === 'cloud_amount_on_height_levels')`. UK-only 3D pressure/height vars do NOT appear in the global dropdown — they have no data in the global repo.

12. **UK 3D variables route through `ICECHUNK_LEVEL_SLICE_H3_UK`** (generic), not the cloud-specific endpoints. `LEVEL_COORD_MAP` in `main.py` maps variable → coordinate array.

13. **Grid cell size is derived from `meta.grid`, never hardcoded.** Formula: `latStep = (lat_range[1] - lat_range[0]) / (lat_count - 1)`, `halfDegLat = (latStep / 2) * stride * overlap`. Falls back to 0.09° (global) / 0.019° lat (UK) only while meta is loading.

14. **Snapshot cross-dataset guard**: `validSnapshot = selectedSnapshot && snapshots.find(s => s.snapshotId === selectedSnapshot) ? selectedSnapshot : null`. Prevents passing a stale global snapshot ID to UK endpoints on dataset switch.

---

## Snowflake Service Functions — Full Reference

### Global 10km

| Function | Endpoint | Use case |
|----------|----------|---------|
| `ICECHUNK_HEALTH()` | `/health` | Readiness |
| `ICECHUNK_META()` | `/meta` | Variables, snapshot, grid |
| `ICECHUNK_SEED()` | `/seed` | Ingest latest global run |
| `ICECHUNK_SLICE(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/slice` | Raw points |
| `ICECHUNK_SLICE_H3(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/slice_h3` | H3 cells (default) |
| `ICECHUNK_CLOUD_AT_LEVEL(level, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/cloud_level` | Cloud at height (raw) |
| `ICECHUNK_CLOUD_AT_LEVEL_H3(level, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/cloud_level_h3` | Cloud at height (H3) |

### UK 2km

| Function | Endpoint | Use case |
|----------|----------|---------|
| `ICECHUNK_META_UK()` | `/meta_uk` | UK variables, snapshot, grid |
| `ICECHUNK_SEED_UK()` | `/seed_uk` | Ingest UK surface vars |
| `ICECHUNK_SEED_UK_VARS(vars_json)` | `/seed_uk_vars` | Ingest selected UK vars |
| `ICECHUNK_SLICE_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/slice_uk` | UK raw points |
| `ICECHUNK_SLICE_H3_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/slice_h3_uk` | UK H3 cells |
| `ICECHUNK_LEVEL_SLICE_UK(var, level, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/level_slice_uk` | Any UK 3D var at level (raw) |
| `ICECHUNK_LEVEL_SLICE_H3_UK(var, level, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/level_slice_h3_uk` | Any UK 3D var at level (H3) |

---

## Deployment Runbook

Full step-by-step in `.cortex/skills/icechunk-accelerator/SKILL.md`.

Scripts:
```
.cortex/skills/icechunk-accelerator/scripts/
  00_aws_setup.sh           S3 bucket + IAM user
  01_snowflake_setup.sql    DB, pool, secrets, EAIs, all service functions
  03_deploy_services.sql    CREATE SERVICE + EAI application
  04_load_data.sql          ICECHUNK_SEED + verification
  05_create_agent.sql       WEATHER_AGENT + 3 tool procedures + grants
```
