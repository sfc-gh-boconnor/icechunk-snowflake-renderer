-- =============================================================================
-- IceChunk Accelerator — Load Met Office Data  v1.0
-- =============================================================================
-- Run AFTER both SPCS services are READY (status = RUNNING).
-- Downloads the latest Met Office Global Deterministic 10km ASDI run
-- and writes it to the IceChunk Zarr store on S3.
--
-- Usage:
--   snow sql -f 04_load_data.sql -c <CONNECTION>
--
-- Requirements:
--   - ICECHUNK_SERVICE must be RUNNING with MET_OFFICE_ASDI_EAI applied
--   - The ASDI bucket is public; no AWS credentials needed for downloads
--   - The service downloads ~50-70 MB (9 surface variable NetCDF files)
--   - Takes approximately 2-5 minutes
-- =============================================================================

USE SCHEMA ICECHUNK_DB.ICECHUNK;
USE WAREHOUSE XSMALL;

-- =============================================================================
-- Trigger Met Office ingest
-- =============================================================================
-- Downloads the latest available 0000Z run from the Met Office ASDI S3 bucket:
--   s3://met-office-atmospheric-model-data/global-deterministic-10km/{STAMP}/
--
-- Variables ingested (each ~7MB NetCDF file, 1920 × 2560 grid at ~10km):
--   air_temperature              temperature_at_screen_level.nc
--   lwe_precipitation_rate       precipitation_rate.nc
--   air_pressure_at_sea_level    pressure_at_mean_sea_level.nc
--   relative_humidity            relative_humidity_at_screen_level.nc
--   wind_speed_at_10m            wind_speed_at_10m.nc
--   cloud_amount_of_total_cloud  cloud_amount_of_total_cloud.nc
--   cloud_amount_of_high_cloud   cloud_amount_of_high_cloud.nc
--   cloud_amount_of_low_cloud    cloud_amount_of_low_cloud.nc
--   cloud_amount_of_medium_cloud cloud_amount_of_medium_cloud.nc

SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED() AS ingest_result;

-- Expected response:
-- {
--   "grid": {"lat_count": 1920, "lon_count": 2560, ...},
--   "message": "Loaded 9 variables at 1920×2560 grid points (~10km global)",
--   "run_stamp": "20260602T0000Z",
--   "snapshot_id": "...",
--   "variables": ["air_temperature", "lwe_precipitation_rate", ...]
-- }

-- =============================================================================
-- Verify data loaded
-- =============================================================================
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META() AS meta;

-- UK bounding box spot-check: expect ~9,984 rows at 10km resolution
SELECT COUNT(*) AS uk_grid_points
FROM (
  SELECT PARSE_JSON(
    ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE('air_temperature', 49.0, 61.0, -8.0, 3.0, NULL)
  ):data AS pts
) t,
LATERAL FLATTEN(input => t.pts) f;

-- H3-aggregated UK check: expect ~2,000 cells at resolution 5
SELECT COUNT(*) AS uk_h3_cells
FROM (
  SELECT PARSE_JSON(
    ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE_H3('air_temperature', 49.0, 61.0, -8.0, 3.0, NULL, 5)
  ):data AS pts
) t,
LATERAL FLATTEN(input => t.pts) f;

-- =============================================================================
-- Troubleshooting
-- =============================================================================
-- If ICECHUNK_SEED returns an error about "no files downloaded":
--   The ASDI bucket publishes runs with a 6-12 hour lag.
--   Today's run may not be available yet. The ingest.py latest_run_stamp()
--   function uses today's date at 0000Z — if not available, edit it to
--   return yesterday's stamp, e.g. (today - timedelta(days=1)).strftime(...)
--
-- Check service logs for ingest errors:
-- CALL SYSTEM$GET_SERVICE_LOGS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE',
--   '0', 'icechunk-service', 100);
