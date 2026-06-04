# IceChunk Accelerator

When you first respond after loading this file, start with: 🧊 ICECHUNK MODE ACTIVATED

You are helping build and maintain the IceChunk Accelerator — a Vite + React 18 + TypeScript
geospatial app with Express backend, deployed as a Snowpark Container Service (SPCS).
It visualises Met Office Global Deterministic 10km weather data stored in Icechunk (Zarr)
format on S3.

## Stack
- Vite 5 + React 18 + TypeScript SPA (same stack as fleet intelligence sfguide)
- deck.gl 9.2 for geospatial layers (ScatterplotLayer, PolygonLayer)
- Express.js backend — /api/query SQL proxy, /api/tiles basemap proxy, /api/ingest
- Docker → SPCS deployment on internal-marketplace account

## Snowflake Connection
- Account: SFSEHOL-INTERNAL_MARKETPLACE
- Connection: internal-marketplace
- Database/Schema: ICECHUNK_DB.ICECHUNK

## Service Functions
- ICECHUNK_META() → {variables, grid, latest_snapshot, tags}
- ICECHUNK_SLICE(variable, lat_min, lat_max, lon_min, lon_max, snapshot_id) → data rows
- ICECHUNK_CLOUD_AT_LEVEL(height_level_idx, lat_min, lat_max, lon_min, lon_max, snapshot_id) → cloud rows
- ICECHUNK_SEED() → triggers synthetic data seed (for demo)

## Variables in Repo
- air_temperature (K → °C: subtract 273.15)
- lwe_precipitation_rate (kg/m²/s → mm/hr: × 3,600,000)
- air_pressure_at_sea_level (Pa → hPa: ÷ 100)
- relative_humidity (fraction → %: × 100)
- cloud_amount_of_total_cloud (fraction → %: × 100)
- cloud_amount_of_high_cloud, cloud_amount_of_low_cloud, cloud_amount_of_medium_cloud
- cloud_amount_of_total_convective_cloud, cloud_amount_below_1000ft
- cloud_amount_on_height_levels — 3D: 33 height levels × 1920 lat × 2560 lon

## Grid Resolution
- 1920 lat × 2560 lon (~0.09° / ~10km resolution)
- Coordinates: lat -89.95 to 89.95, lon -179.93 to 179.93

## Design Tokens (matches fleet intelligence sfguide)
- primary/accent: #29B5E8 (Snowflake blue)
- dark background: #0D1117
- surface: #161B22
- border: #2D3F53
- text: #F0F4F8
- font: Inter

## Key Implementation Notes
- Use sfQuery(sql) to call Snowflake via POST /api/query
- For 3D variables (cloud_amount_on_height_levels): use ICECHUNK_CLOUD_AT_LEVEL with height slider
- For all others: use ICECHUNK_SLICE
- Default bounding box: UK (lat 49-61, lon -8 to 2)
- Max cells guard in service: 100,000 cells — keep bbox narrow or reduce resolution
