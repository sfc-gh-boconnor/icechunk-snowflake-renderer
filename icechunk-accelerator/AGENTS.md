# IceChunk Accelerator — Agent Context

When you first respond after loading this file, start with: 🧊 ICECHUNK MODE ACTIVATED

You are helping build and maintain the IceChunk Accelerator — a Vite + React 18 + TypeScript
geospatial app with Express backend, deployed as a Snowpark Container Service (SPCS).
It visualises Met Office weather data (Global 10km and UK 2km) stored in IceChunk Zarr
stores on S3, queried through Snowflake service functions with H3 or native-grid rendering.

## Stack

- Vite 5 + React 18 + TypeScript SPA
- deck.gl 9.2 — `H3HexagonLayer` (H3 mode) + `SolidPolygonLayer` (grid mode)
- Express.js backend — SQL proxy, tile proxy, Cortex Agent SSE, ingest endpoints
- Docker → SPCS deployment (`icechunk-accelerator:1.0.43`)

## Snowflake Connection

- Account: SFSEHOL-INTERNAL_MARKETPLACE
- Connection: `internal-marketplace`
- Database/Schema: `ICECHUNK_DB.ICECHUNK`
- Warehouse: `XSMALL` (sized SMALL)

## Service Functions

### Global 10km
- `ICECHUNK_META()` → `{variables, grid, latest_snapshot, tags}` — `grid` has `lat_count`, `lon_count`, `lat_range`, `lon_range`
- `ICECHUNK_SLICE(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` → raw grid rows
- `ICECHUNK_SLICE_H3(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` → H3 cells
- `ICECHUNK_CLOUD_AT_LEVEL(level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id)` → cloud at height (raw)
- `ICECHUNK_CLOUD_AT_LEVEL_H3(level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` → cloud at height (H3)
- `ICECHUNK_HEALTH()` → `{status: "ok"}`
- `ICECHUNK_SEED()` → triggers Met Office ASDI global ingest

### UK 2km
- `ICECHUNK_META_UK()` → same structure as ICECHUNK_META()
- `ICECHUNK_SLICE_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` → raw UK grid rows
- `ICECHUNK_SLICE_H3_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` → UK H3 cells
- `ICECHUNK_LEVEL_SLICE_UK(var, level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id)` → any 3D var at level (raw)
- `ICECHUNK_LEVEL_SLICE_H3_UK(var, level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` → any 3D var at level (H3)
- `ICECHUNK_SEED_UK()` → ingest UK surface vars
- `ICECHUNK_SEED_UK_VARS(vars_json VARCHAR)` → ingest selected UK vars (JSON array string)

All functions: `RETURNS VARIANT`, `ENDPOINT = 'http-endpoint'`
Result rows: `LATERAL FLATTEN(input => result:data)`

## Datasets

### Global 10km (`met_office_global`)
- Grid: 1920 × 2560 (~10km, ~0.09°) — step computed from `meta.grid`, NOT hardcoded
- 9 surface variables via `ICECHUNK_SEED()`: air_temperature, lwe_precipitation_rate, wind_speed_at_10m, air_pressure_at_sea_level, relative_humidity, cloud_amount_of_total_cloud, cloud_amount_of_high_cloud, cloud_amount_of_low_cloud, cloud_amount_of_medium_cloud
- 3D cloud (`cloud_amount_on_height_levels`) stored in a **separate snapshot** tagged `met_office_cloud_*` — user MUST select this snapshot from the picker to view it

### UK 2km (`met_office_uk_2km`)
- Grid: 970 × 1042 (~2km, LAEA reprojected to WGS84 at ingest)
- **Surface (2D, 15 vars):** air_temperature, lwe_precipitation_rate, wind_speed_at_10m, air_pressure_at_sea_level, relative_humidity, cloud_amount_of_total_cloud, visibility_at_screen_level, cloud_amount_of_high_cloud, cloud_amount_of_low_cloud, cloud_amount_of_medium_cloud, wind_gust_at_10m, dew_point_temperature, snowfall_rate, rainfall_rate, fog_fraction
- **3D height levels:** cloud_amount_on_height_levels, temperature_on_height_levels, wind_speed_on_height_levels
- **3D pressure levels (33 levels, 1000→10 hPa):** temperature_on_pressure_levels, relative_humidity_on_pressure_levels, wind_speed_on_pressure_levels, wind_direction_on_pressure_levels

## Variable Transforms

| Variable | Raw unit | Display | Transform |
|----------|----------|---------|-----------|
| air_temperature | K | °C | `v - 273.15` |
| lwe_precipitation_rate | kg/m²/s | mm/hr | `v × 3,600,000` |
| air_pressure_at_sea_level | Pa | hPa | `v ÷ 100` |
| relative_humidity | fraction | % | `v × 100` |
| cloud_amount_* | fraction | % | `v × 100` |
| temperature_on_pressure_levels | K | °C | `v - 273.15` |
| wind_direction_on_pressure_levels | rad | degrees | `v × 180/π` |

## Rendering

- **H3 mode** (`H3HexagonLayer`): Python aggregates grid → H3 cells; `coverage: 1.001` to close seams; resolution 2–6 driven by zoom
- **Grid mode** (`SolidPolygonLayer`): each point rendered as its lat/lon cell rectangle; half-extents derived from `meta.grid` (`latStep/2`, `lonStep/2`); overlap 1.015 (global) / 1.001 (UK); UK requests auto-strided by backend when bbox too large
- **Palette selector**: 9 named colour schemes (`viridis`, `plasma`, `magma`, `inferno`, `coolwarm`, `rdbu`, `spectral`, `rainbow`, `greys`) in `src/shared/format.ts`; selected via `colorScheme` state; `'auto'` uses variable-specific default

## 3D Variable Routing

- **Global + cloud var**: `ICECHUNK_CLOUD_AT_LEVEL_H3` (H3) or `ICECHUNK_CLOUD_AT_LEVEL` (grid) — requires cloud snapshot to be selected
- **UK + any 3D var**: `ICECHUNK_LEVEL_SLICE_H3_UK` (H3) or `ICECHUNK_LEVEL_SLICE_UK` (grid) — generic, passes variable name
- Level cache: all N levels pre-fetched in parallel (batches of 8) on variable selection; slider reads from `levelCache` Map instantly without re-fetching
- If prefetch returns nothing: error shown — global cloud hint says to select the cloud snapshot

## Global vs UK Variable Dropdown

- **Global**: `VARIABLES` list filtered to surface vars + `cloud_amount_on_height_levels` only. UK-only 3D pressure/height vars are excluded.
- **UK**: `UK_VARIABLES` list (all 23 vars including 3D).
- Do NOT add UK pressure/height-level vars to the global dropdown — they don't exist in the global repo.

## Snapshot Guard

- `validSnapshot = selectedSnapshot && snapshots.find(s => s.snapshotId === selectedSnapshot) ? selectedSnapshot : null`
- This prevents passing a stale global snapshot ID to UK endpoints (or vice versa) when switching datasets.

## Grid Cell Size — Critical

- Cell extents are computed from `meta.grid` at render time:
  ```typescript
  const latStep = (meta.grid.lat_range[1] - meta.grid.lat_range[0]) / (meta.grid.lat_count - 1)
  const lonStep = (meta.grid.lon_range[1] - meta.grid.lon_range[0]) / (meta.grid.lon_count - 1)
  const halfDegLat = (latStep / 2) * stride * overlap
  const halfDegLon = (lonStep / 2) * stride * overlap
  ```
- **Never hardcode 0.045 or 0.09** for global, or 0.019/0.032 for UK. Use meta.

## Key Implementation Rules

1. **`sfQuery(sql)`** sends to Snowflake via `POST /api/query`
2. **Never set `SNOWFLAKE_HOST`** in accelerator service spec — SPCS auto-injects it
3. **`AWS_DEFAULT_REGION: "us-west-2"`** in backend spec (bucket is in us-west-2)
4. **EAIs must be re-applied** after every `ALTER SERVICE FROM SPECIFICATION`
5. **CARTO tile style: `dark_all`** — not `dark_matter_nolabels` (returns 502)
6. **H3 cell indices computed by Python backend** — no client-side h3-js
7. **Agent model: `orchestration: auto`** — never hardcode a model name
8. **UK 3D vars use `ICECHUNK_LEVEL_SLICE_H3_UK`** (generic), not cloud-specific endpoints
9. **Global cloud (`cloud_amount_on_height_levels`) needs the cloud snapshot** — `met_office_cloud_*` tag
10. **Grid sizing from meta** — `latStep = (lat_range[1]-lat_range[0])/(lat_count-1)`

## Design Tokens

- primary/accent: `#29B5E8` (Snowflake blue)
- dark background: `#0D1117`
- surface: `#161B22`
- border: `#2D3F53`
- text: `#F0F4F8`
- font: Inter

## Common Build Commands

```bash
# Frontend only (most common)
bash build.sh --accel-only --bump patch

# Both services
bash build.sh --bump patch

# Deploy frontend + re-apply EAI
snow sql -c internal-marketplace -q "ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE FROM SPECIFICATION $$ spec: ... $$"
snow sql -c internal-marketplace -q "ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI)"
```
