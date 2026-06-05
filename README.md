# IceChunk Accelerator

Real-time global and UK weather data on a DeckGL map, powered by Snowflake Container Services and IceChunk.

Met Office forecast data is stored as a versioned IceChunk Zarr store on S3 and queried through Snowflake service functions with H3 hexagonal aggregation. A Cortex Agent answers natural-language weather questions and auto-focuses the map on the region it analyses.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           User's Browser                                │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    React / DeckGL App                             │  │
│  │                                                                   │  │
│  │   Dataset toggle (Global 10km / UK 2km)                          │  │
│  │   Variable picker (surface + 3D height/pressure level vars)      │  │
│  │   Height / Pressure Level slider  (for 3D variables)            │  │
│  │   H3 ⬡ / ▦ Grid toggle   Snapshot selector   Region presets    │  │
│  │   AgentChat panel ── SSE stream to Cortex WEATHER_AGENT          │  │
│  │                                                                   │  │
│  │   H3HexagonLayer ────── Python-aggregated cells (fast)           │  │
│  │   SolidPolygonLayer ─── Native grid cells (10km or 2km)          │  │
│  │   CARTO dark basemap ── Tile proxy via Express                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  HTTPS  /api/query  /api/tiles  /api/agent
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            SPCS: icechunk-accelerator  (port 3001)                      │
│                                                                         │
│  Express proxy server                                                   │
│  • Forwards SQL → Snowflake REST API v2  (Bearer token auth)            │
│  • Fetches all result partitions in parallel  (Promise.all)             │
│  • Proxies CARTO basemap tiles  (dark_all style)                        │
│  • Proxies Cortex Agent SSE stream  (/api/agent)                        │
│  • /api/ingest  /api/ingest_uk (selective vars)  /api/snapshots         │
│  • SNOWFLAKE_HOST auto-injected by SPCS (never set explicitly)          │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  Snowflake REST API v2
                        │  POST /api/v2/statements
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Snowflake  (ICECHUNK_DB.ICECHUNK)                          │
│                                                                         │
│  ── Global 10km ────────────────────────────────────────────────────   │
│  ICECHUNK_SLICE_H3(var, bbox, snapshot_id, h3_res)   ← default         │
│  ICECHUNK_SLICE(var, bbox, snapshot_id)               ← grid mode       │
│  ICECHUNK_CLOUD_AT_LEVEL_H3(level, bbox, snapshot_id, h3_res)          │
│  ICECHUNK_META()   ICECHUNK_SEED()   ICECHUNK_HEALTH()                  │
│                                                                         │
│  ── UK 2km ─────────────────────────────────────────────────────────   │
│  ICECHUNK_SLICE_H3_UK(var, bbox, snapshot_id, h3_res)                  │
│  ICECHUNK_SLICE_UK(var, bbox, snapshot_id)                              │
│  ICECHUNK_LEVEL_SLICE_H3_UK(var, level, bbox, snapshot_id, h3_res)     │
│  ICECHUNK_LEVEL_SLICE_UK(var, level, bbox, snapshot_id)                 │
│  ICECHUNK_META_UK()   ICECHUNK_SEED_UK()   ICECHUNK_SEED_UK_VARS(json) │
│                                                                         │
│  ── Cortex Agent ───────────────────────────────────────────────────   │
│  WEATHER_AGENT  +  TOOL_WEATHER_META / TOOL_WEATHER_SLICE / SUMMARY    │
│                                                                         │
│  All functions: RETURNS VARIANT, ENDPOINT = 'http-endpoint'            │
│  Result rows via: LATERAL FLATTEN(input => result:data)                 │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  Snowflake service function (internal SPCS)
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            SPCS: icechunk-service  (port 8080)                          │
│                                                                         │
│  Python FastAPI                                                         │
│                                                                         │
│  /snowflake/slice_h3 ──────► H3 aggregation, global 10km               │
│  /snowflake/slice ─────────► raw lat/lon rows, global 10km              │
│  /snowflake/cloud_level_h3 ► H3 cloud by height, global                 │
│  /snowflake/slice_h3_uk ───► H3 aggregation, UK 2km (LAEA → WGS84)     │
│  /snowflake/slice_uk ──────► raw rows, UK 2km                           │
│  /snowflake/level_slice_h3_uk ► generic 3D level H3, UK 2km            │
│  /snowflake/level_slice_uk ──► generic 3D level raw, UK 2km            │
│  /snowflake/seed_uk_vars ──► selective UK ingest with var list          │
│  /meta  /meta_uk  /seed  /seed_uk  /health  /branches                  │
│                                                                         │
│  UK 2km: LAEA projection reprojected to WGS84 at ingest time           │
│  3D vars: chunked (1, 128, 128) for fast per-level reads                │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  boto3  (AWS_ACCESS_KEY_ID / AWS_SECRET via secrets)
                        │  AWS_DEFAULT_REGION = us-west-2
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            S3: s3://icechunk-ro/  (us-west-2)                           │
│                                                                         │
│  met_office_global/  — Global Deterministic 10km                        │
│    Grid: 1920 × 2560  (~10km, ~0.09°)                                   │
│    9 surface vars: air_temperature, lwe_precipitation_rate, …           │
│    3D cloud: cloud_amount_on_height_levels (height × 1920 × 2560)       │
│    Source: s3://met-office-atmospheric-model-data/global-deterministic   │
│                                                                         │
│  met_office_uk_2km/  — UK Deterministic 2km                             │
│    Grid: 970 × 1042  (~2km, LAEA reprojected)                           │
│    Surface: air_temperature, lwe_precipitation_rate, wind_speed_at_10m, │
│      air_pressure_at_sea_level, relative_humidity, visibility,           │
│      cloud_amount_{total,high,medium,low}, wind_gust, dew_point,        │
│      snowfall_rate, rainfall_rate, fog_fraction                         │
│    3D height levels: cloud_amount_on_height_levels,                     │
│      temperature_on_height_levels, wind_speed_on_height_levels          │
│    3D pressure levels: temperature_on_pressure_levels,                  │
│      relative_humidity_on_pressure_levels, wind_speed_on_pressure_levels,│
│      wind_direction_on_pressure_levels  (33 levels, 1000→10 hPa)        │
│    Source: s3://met-office-atmospheric-model-data/uk-deterministic-2km  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Datasets

| Dataset | Resolution | Grid | Source |
|---------|-----------|------|--------|
| Global Deterministic 10km | ~10km / ~0.09° (step from metadata) | 1920 × 2560 | Met Office ASDI |
| UK Deterministic 2km | ~2km | 970 × 1042 | Met Office ASDI |

### Global 10km variables
9 surface variables: air temperature, precipitation rate, wind speed (10m), sea-level pressure, relative humidity, total/high/low/medium cloud cover.
3D cloud by height: `cloud_amount_on_height_levels` (separate snapshot, tagged `met_office_cloud_*`).

### UK 2km variables
**Surface (2D):** 15 variables including temperature, precipitation, wind speed, pressure, humidity, visibility, cloud (total/high/low/medium), wind gust, dew point, snowfall, rainfall, fog.

**3D height levels:** cloud by height, temperature by height, wind speed by height.

**3D pressure levels:** temperature, relative humidity, wind speed, wind direction at 33 isobaric levels (100,000 → 1,000 Pa = 1000 → 10 hPa).

---

## Data Flow: H3 Query (default)

```
1. User selects variable + bbox + zoom level
2. Frontend computes H3 resolution from zoom  (res 2-6)
3. SQL sent to Snowflake  (e.g. ICECHUNK_SLICE_H3_UK or LEVEL_SLICE_H3_UK)
4. Snowflake routes to icechunk-service
5. Python reads Zarr slice from S3
6. Python aggregates: h3.latlng_to_cell(lat, lon, res) → H3 cells
7. Returns {h3index, value} per cell
8. Express fetches all partitions in parallel (Promise.all)
9. DeckGL H3HexagonLayer renders filled hexagons coloured by value
```

For 3D level queries, level_idx selects the height (metres) or pressure (Pa) slice.

---

## Components

### `icechunk-service` — Python FastAPI backend

| File | Purpose |
|------|---------|
| `app/main.py` | FastAPI endpoints: slice, level_slice, meta, seed, health |
| `app/ingest.py` | Met Office ASDI global 10km downloader (parallel, 8 workers) |
| `app/ingest_uk.py` | UK 2km downloader: surface + 3D height/pressure levels, LAEA→WGS84 reproject |
| `app/icechunk_client.py` | Opens/creates IceChunk repos (global + UK) |
| `app/requirements.txt` | `icechunk==2.0.5`, `zarr>=3.1.0`, `h3>=4.0.0`, `h5py`, `xarray`, `boto3`, `pyproj` |
| `Dockerfile` | `python:3.12-slim` + `libhdf5-dev` + `--prefer-binary` pip install |

### `icechunk-accelerator` — React/Express frontend

| File | Purpose |
|------|---------|
| `server/index.ts` | Express: Snowflake REST API proxy (parallel partitions), CARTO tile proxy, Cortex Agent SSE proxy, ingest endpoints |
| `src/App.tsx` | Root: agentFocusBbox state, wires AgentChat ↔ WeatherViewer |
| `src/components/WeatherViewer.tsx` | DeckGL map: H3/Grid toggle, dataset/variable/snapshot/bbox/level controls, palette selector |
| `src/components/AgentChat.tsx` | SSE streaming chat; fires onMapFocus(bbox) on tool results |
| `src/components/DataLoader.tsx` | Global + UK ingest UI with per-variable selection |
| `src/components/Home.tsx` | Home/landing screen |
| `src/types.ts` | VARIABLES (surface + 3D), UK_INGEST_FILES, BBOX_PRESETS, DatasetConfig |
| `src/shared/format.ts` | `PALETTES` (9 named colour schemes), value formatters |

---

## Snowflake Service Functions

### Global 10km

| Function | Purpose |
|----------|---------|
| `ICECHUNK_HEALTH()` | Readiness check |
| `ICECHUNK_META()` | Variables, snapshot, grid |
| `ICECHUNK_SEED()` | Ingest latest Met Office global run |
| `ICECHUNK_SLICE(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | Raw grid points |
| `ICECHUNK_SLICE_H3(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | H3 cells |
| `ICECHUNK_CLOUD_AT_LEVEL(level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | Cloud at height (raw) |
| `ICECHUNK_CLOUD_AT_LEVEL_H3(level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | Cloud at height (H3) |

### UK 2km

| Function | Purpose |
|----------|---------|
| `ICECHUNK_META_UK()` | Variables, snapshot, grid |
| `ICECHUNK_SEED_UK()` | Ingest latest UK run (default surface vars) |
| `ICECHUNK_SEED_UK_VARS(vars_json VARCHAR)` | Ingest selected UK vars (JSON array string) |
| `ICECHUNK_SLICE_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | Raw UK grid points |
| `ICECHUNK_SLICE_H3_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | UK H3 cells |
| `ICECHUNK_LEVEL_SLICE_UK(var, level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | Any 3D var at level (raw) |
| `ICECHUNK_LEVEL_SLICE_H3_UK(var, level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | Any 3D var at level (H3) |

### Cortex Agent

| Object | Purpose |
|--------|---------|
| `WEATHER_AGENT` | Cortex Agent — answers natural language weather questions |
| `TOOL_WEATHER_META()` | Agent tool: available variables, snapshot, grid |
| `TOOL_WEATHER_SLICE(region, variable, snapshot_id)` | Agent tool: stats for one var in a region |
| `TOOL_WEATHER_SUMMARY(region, snapshot_id)` | Agent tool: full weather summary for a region |

All functions return VARIANT. Use `LATERAL FLATTEN(input => result:data)` to expand rows.

---

## External Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| Met Office ASDI S3 (`eu-west-2`) | Source NetCDF files | Anonymous (public) |
| IceChunk store S3 (`us-west-2`) | Zarr tensor store (read + write) | IAM user access keys (Snowflake secrets) |
| CARTO basemap CDN | Dark map tile background (`dark_all` style) | None (free CDN) |
| Snowflake REST API v2 | SQL query execution from Express | SPCS service identity token |
| Cortex Agent API | Natural-language weather Q&A | SPCS service identity token |

---

## Colour Palette Selector

Nine named palettes available in the viewer below the legend:
`viridis`, `plasma`, `magma`, `inferno`, `coolwarm`, `rdbu`, `spectral`, `rainbow`, `greys`.
Selecting one overrides the variable-specific default colour scale. `auto` restores the default.
Palettes are defined in `src/shared/format.ts` as `PALETTES: Record<PaletteKey, Palette>`.

---

## Grid Cell Sizing

SolidPolygonLayer cell extents are derived from `meta.grid` at render time:
```
latStep = (lat_range[1] - lat_range[0]) / (lat_count - 1)
lonStep = (lon_range[1] - lon_range[0]) / (lon_count - 1)
halfDegLat = (latStep / 2) * ukStride * overlap   // overlap = 1.015 global, 1.001 UK
```
This is the same formula for both datasets. Falls back to 0.09° (global) / 0.019° lat (UK) only while metadata is loading on first render.

---

## Deployment

Full step-by-step in `.cortex/skills/icechunk-accelerator/SKILL.md`.

**Quick summary:**
```bash
# 1. AWS: create S3 bucket + IAM user
bash .cortex/skills/icechunk-accelerator/scripts/00_aws_setup.sh --bucket icechunk-ro --region us-west-2

# 2. Snowflake: DB, compute pool, secrets, EAIs, functions
snow sql -c <CONNECTION> -f .cortex/skills/icechunk-accelerator/scripts/01_snowflake_setup.sql

# 3. Build + push both Docker images (bumps VERSION 1.0.x → 1.0.x+1)
bash build.sh --bump patch

# 4. Deploy SPCS services
snow sql -c <CONNECTION> -f .cortex/skills/icechunk-accelerator/scripts/03_deploy_services.sql

# 5. Load global Met Office data (~5 min)
snow sql -c <CONNECTION> -f .cortex/skills/icechunk-accelerator/scripts/04_load_data.sql

# 6. Create Cortex Agent + tool procedures
snow sql -c <CONNECTION> -f .cortex/skills/icechunk-accelerator/scripts/05_create_agent.sql
```

---

## Requirements

- Snowflake account with SPCS enabled (SYSADMIN + ACCOUNTADMIN)
- AWS account with permissions to create S3 buckets and IAM users
- Docker with `buildx` support
- `snow` CLI (Snowflake CLI)
- Python 3.12+ (for local development only; containers are self-contained)
