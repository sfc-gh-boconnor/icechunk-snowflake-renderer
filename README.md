# IceChunk Accelerator

Real-time global weather data on a DeckGL map, powered by Snowflake Container Services and IceChunk.

Met Office Global Deterministic 10km forecast data (~5 million grid points worldwide) is stored as a versioned IceChunk Zarr store on S3 and queried through Snowflake service functions with H3 hexagonal aggregation.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           User's Browser                                │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                    React / DeckGL App                             │  │
│  │                                                                   │  │
│  │   Variable picker    H3 ⬡ / Points • toggle    Region presets    │  │
│  │   Snapshot date      Opacity slider             Bounding box      │  │
│  │                                                                   │  │
│  │   H3HexagonLayer ────── Python-aggregated cells (fast)           │  │
│  │   ScatterplotLayer ──── Raw 10km grid points (exact)             │  │
│  │   CARTO dark basemap ── Tile proxy via Express                   │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  HTTPS  /api/query  /api/tiles
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            SPCS: icechunk-accelerator  (port 3001)                      │
│                                                                         │
│  Express proxy server                                                   │
│  • Forwards SQL → Snowflake REST API v2  (Bearer token auth)            │
│  • Fetches all result partitions in parallel  (Promise.all)             │
│  • Proxies CARTO basemap tiles  (dark_all style)                        │
│  • SNOWFLAKE_HOST auto-injected by SPCS (never set explicitly)          │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  Snowflake REST API v2
                        │  POST /api/v2/statements
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│              Snowflake  (ICECHUNK_DB.ICECHUNK)                          │
│                                                                         │
│  ICECHUNK_SLICE_H3(var, bbox, snapshot_id, h3_res)  ◄── default        │
│  ICECHUNK_SLICE(var, bbox, snapshot_id)             ◄── points mode    │
│  ICECHUNK_META()   ICECHUNK_SEED()   ICECHUNK_HEALTH()                  │
│  ICECHUNK_CLOUD_AT_LEVEL(level, bbox, snapshot_id)                      │
│                                                                         │
│  All functions: RETURNS VARIANT, ENDPOINT = 'http-endpoint'            │
│  Result rows via: LATERAL FLATTEN(input => result:data)                 │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  Snowflake service function call
                        │  (internal SPCS routing, no public network)
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            SPCS: icechunk-service  (port 8080)                          │
│                                                                         │
│  Python FastAPI                                                         │
│                                                                         │
│  /snowflake/slice_h3 ──► H3 aggregation (h3-py C bindings)             │
│    • groups 10km grid points into H3 cells                              │
│    • returns mean value per cell  (~5-55× fewer rows)                  │
│                                                                         │
│  /snowflake/slice ──────► raw lat/lon/value rows                        │
│  /meta  /health  /seed                                                  │
│                                                                         │
│  /seed ─────────────────► ingest.py                                     │
│    • downloads 9 NetCDF files from Met Office ASDI S3  (parallel)       │
│    • writes to IceChunk Zarr store  (versioned snapshot)               │
│    • tags snapshot: met_office_YYYYMMDDTHHMMZ                          │
└───────────────────────┬─────────────────────────────────────────────────┘
                        │  boto3  (AWS_ACCESS_KEY_ID / AWS_SECRET via secrets)
                        │  AWS_DEFAULT_REGION = us-west-2
                        ▼
┌─────────────────────────────────────────────────────────────────────────┐
│            S3: s3://icechunk-ro/met_office_global/                      │
│                                                                         │
│  IceChunk Zarr store  (versioned, transactional)                        │
│                                                                         │
│  Grid:  1920 × 2560  (~10km resolution, ~0.09°)                        │
│  Variables (9):                                                         │
│    air_temperature            lwe_precipitation_rate                    │
│    air_pressure_at_sea_level  relative_humidity                         │
│    wind_speed_at_10m                                                    │
│    cloud_amount_of_{total,high,medium,low}_cloud                        │
│                                                                         │
│  Source: Met Office ASDI  s3://met-office-atmospheric-model-data/       │
│          global-deterministic-10km/{run_stamp}/                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Data Flow: H3 Query (default)

```
1. User selects variable + bbox + zoom level
2. Frontend computes H3 resolution from zoom  (res 2-6)
3. SQL sent to Snowflake:
      SELECT f.value:h3index::VARCHAR, f.value:value::FLOAT
      FROM (SELECT ICECHUNK_SLICE_H3('air_temperature',
              49, 61, -8, 3, NULL, 5) AS r) t,
      LATERAL FLATTEN(input => t.r:data) f

4. Snowflake routes to icechunk-service /snowflake/slice_h3
5. Python reads Zarr array slice from S3 (~9,984 source points for UK)
6. Python aggregates: h3.latlng_to_cell(lat, lon, 5) → ~2,000 H3 cells
7. Returns {h3index: "85283473fffffff", value: 281.4} per cell
8. Snowflake flattens JSON, returns rows across N partitions
9. Express server fetches all partitions in parallel (Promise.all)
10. DeckGL H3HexagonLayer renders filled hexagons coloured by value
```

---

## Components

### `icechunk-service` — Python FastAPI backend

| File | Purpose |
|------|---------|
| `app/main.py` | FastAPI app: `/snowflake/slice`, `/snowflake/slice_h3`, `/snowflake/cloud_level`, `/meta`, `/seed`, `/health` |
| `app/ingest.py` | Downloads Met Office ASDI NetCDF files (8 parallel workers), writes to IceChunk |
| `app/icechunk_client.py` | Opens/creates IceChunk repo on S3 |
| `app/requirements.txt` | `icechunk==2.0.5`, `zarr>=3.1.0`, `h3>=4.0.0`, `h5py`, `xarray`, `boto3` |
| `Dockerfile` | `python:3.12-slim` + `libhdf5-dev` + `--prefer-binary` pip install |

### `icechunk-accelerator` — React/Express frontend

| File | Purpose |
|------|---------|
| `server/index.ts` | Express server: Snowflake REST API proxy (parallel partitions), CARTO tile proxy, `/api/snapshots`, `/api/ingest` |
| `src/components/WeatherViewer.tsx` | DeckGL map: H3HexagonLayer / ScatterplotLayer, variable/bbox/snapshot controls |
| `src/types.ts` | `VARIABLES` (9 entries), `BBOX_PRESETS` (30 global regions), `BBoxPreset`, `WeatherPoint` |
| `src/shared/helpers.ts` | `sfQuery()` — POST to `/api/query` |
| `src/shared/format.ts` | Value formatters, `estimateCellCount()`, `zoomToH3Res()` |

---

## External Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| Met Office ASDI S3 (`eu-west-2`) | Source NetCDF files for ingest | Anonymous (public bucket) |
| IceChunk store S3 (`us-west-2`) | Zarr tensor store (read + write) | IAM user access keys (Snowflake secrets) |
| CARTO basemap CDN | Dark map tile background (`dark_all` style) | None (free CDN) |
| Snowflake REST API v2 | SQL query execution from Express proxy | SPCS service identity token |

---

## Deployment

Full step-by-step in `.cortex/skills/icechunk-accelerator/SKILL.md`.

**Quick summary:**
```bash
# 1. AWS: create S3 bucket + IAM user
bash .cortex/skills/icechunk-accelerator/scripts/00_aws_setup.sh --bucket icechunk-ro --region us-west-2

# 2. Snowflake: DB, compute pool, secrets, EAIs, functions
snow sql -c internal-marketplace -f .cortex/skills/icechunk-accelerator/scripts/01_snowflake_setup.sql

# 3. Build + push both Docker images (bumps VERSION 1.0.x → 1.0.x+1)
bash build.sh --bump patch

# 4. Deploy SPCS services
snow sql -c internal-marketplace -f .cortex/skills/icechunk-accelerator/scripts/03_deploy_services.sql

# 5. Load Met Office data (~5 min)
snow sql -c internal-marketplace -f .cortex/skills/icechunk-accelerator/scripts/04_load_data.sql
```

---

## Requirements

- Snowflake account with SPCS enabled (SYSADMIN + ACCOUNTADMIN)
- AWS account with permissions to create S3 buckets and IAM users
- Docker with `buildx` support
- `snow` CLI (Snowflake CLI)
- Python 3.12+ (for local development only; containers are self-contained)
