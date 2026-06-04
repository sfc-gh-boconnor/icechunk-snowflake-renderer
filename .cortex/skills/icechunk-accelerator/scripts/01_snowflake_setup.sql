-- =============================================================================
-- IceChunk Accelerator — Snowflake Infrastructure Setup  v1.0
-- =============================================================================
-- Creates ALL Snowflake objects required before deploying containers.
-- Run once per account. Safe to re-run (IF NOT EXISTS / OR REPLACE).
--
-- Usage:
--   snow sql -f 01_snowflake_setup.sql -c <CONNECTION>
--
-- Prerequisites: SYSADMIN + ACCOUNTADMIN (or a role with CREATE DATABASE).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- EDIT THESE before running
-- ---------------------------------------------------------------------------
-- S3 bucket + region for the IceChunk store (must match the bucket location)
SET ICECHUNK_S3_BUCKET = 'icechunk-ro';
SET ICECHUNK_S3_REGION = 'us-west-2';     -- MUST match bucket region exactly
SET ICECHUNK_S3_PREFIX = 'met_office_global';

-- ---------------------------------------------------------------------------
-- 1. DATABASE / SCHEMA
-- ---------------------------------------------------------------------------
USE ROLE SYSADMIN;

CREATE DATABASE IF NOT EXISTS ICECHUNK_DB;
CREATE SCHEMA  IF NOT EXISTS ICECHUNK_DB.ICECHUNK;
USE SCHEMA ICECHUNK_DB.ICECHUNK;

-- ---------------------------------------------------------------------------
-- 2. WAREHOUSE  (SMALL gives better service-function throughput)
-- ---------------------------------------------------------------------------
CREATE WAREHOUSE IF NOT EXISTS XSMALL
  WITH WAREHOUSE_SIZE  = 'SMALL'
       AUTO_SUSPEND    = 60
       AUTO_RESUME     = TRUE;

-- ---------------------------------------------------------------------------
-- 3. IMAGE REPOSITORY (for SPCS Docker images)
-- ---------------------------------------------------------------------------
CREATE IMAGE REPOSITORY IF NOT EXISTS ICECHUNK_REPO;

-- After creation get the registry URL for docker buildx -t:
--   SHOW IMAGE REPOSITORIES IN SCHEMA ICECHUNK_DB.ICECHUNK;
--   → column: repository_url
--   e.g. sfsehol-internal-marketplace.registry.snowflakecomputing.com/icechunk_db/icechunk/icechunk_repo

-- ---------------------------------------------------------------------------
-- 4. COMPUTE POOL  (CPU_X64_XS is smallest/cheapest; scale up if needed)
-- ---------------------------------------------------------------------------
CREATE COMPUTE POOL IF NOT EXISTS ICECHUNK_COMPUTE_POOL
  MIN_NODES         = 1
  MAX_NODES         = 1
  INSTANCE_FAMILY   = CPU_X64_XS
  AUTO_RESUME       = TRUE
  AUTO_SUSPEND_SECS = 600;

-- Wait for IDLE/ACTIVE before deploying services:
--   SHOW COMPUTE POOLS LIKE 'ICECHUNK_COMPUTE_POOL';

-- ---------------------------------------------------------------------------
-- 5. SECRETS  (AWS credentials for the IceChunk S3 store)
-- ---------------------------------------------------------------------------
-- Replace the placeholder values before running.
-- These are stored encrypted; they never appear in query results.

CREATE SECRET IF NOT EXISTS ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID
  TYPE          = GENERIC_STRING
  SECRET_STRING = '<YOUR_AWS_ACCESS_KEY_ID>';    -- replace

CREATE SECRET IF NOT EXISTS ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY
  TYPE          = GENERIC_STRING
  SECRET_STRING = '<YOUR_AWS_SECRET_ACCESS_KEY>'; -- replace

-- ---------------------------------------------------------------------------
-- 6. NETWORK RULES
-- ---------------------------------------------------------------------------
USE ROLE ACCOUNTADMIN;

-- 6a. IceChunk S3 store  (read/write Zarr data)
--     Value list must include both bucket-specific and regional S3 endpoints
--     because the AWS SDK can call either depending on SDK version.
CREATE NETWORK RULE IF NOT EXISTS ICECHUNK_DB.ICECHUNK.ICECHUNK_S3_NETWORK_RULE
  TYPE       = HOST_PORT
  MODE       = EGRESS
  VALUE_LIST = (
    'icechunk-ro.s3.us-west-2.amazonaws.com:443',
    'icechunk-ro.s3.amazonaws.com:443',
    's3.us-west-2.amazonaws.com:443',
    's3.amazonaws.com:443'
  );
-- If using a different bucket, replace 'icechunk-ro' with your bucket name.

-- 6b. Met Office ASDI  (download public NetCDF source files during ingest)
CREATE NETWORK RULE IF NOT EXISTS ICECHUNK_DB.ICECHUNK.MET_OFFICE_ASDI_RULE
  TYPE       = HOST_PORT
  MODE       = EGRESS
  VALUE_LIST = (
    'met-office-atmospheric-model-data.s3.eu-west-2.amazonaws.com:443',
    's3.eu-west-2.amazonaws.com:443'
  );

-- 6c. CARTO basemap tiles  (dark map background in the React frontend)
--     Note: dark_matter_nolabels path returns 502 as of mid-2026.
--     The tile proxy in server/index.ts uses dark_all which still works.
CREATE NETWORK RULE IF NOT EXISTS ICECHUNK_DB.ICECHUNK.CARTO_TILES_RULE
  TYPE       = HOST_PORT
  MODE       = EGRESS
  VALUE_LIST = (
    'a.basemaps.cartocdn.com:443',
    'b.basemaps.cartocdn.com:443',
    'c.basemaps.cartocdn.com:443',
    'd.basemaps.cartocdn.com:443'
  );

-- ---------------------------------------------------------------------------
-- 7. EXTERNAL ACCESS INTEGRATIONS  (must be ACCOUNTADMIN)
-- ---------------------------------------------------------------------------

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS ICECHUNK_S3_EAI
  ALLOWED_NETWORK_RULES              = (ICECHUNK_DB.ICECHUNK.ICECHUNK_S3_NETWORK_RULE)
  ALLOWED_AUTHENTICATION_SECRETS     = (
    ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID,
    ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY
  )
  ENABLED = TRUE;

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS MET_OFFICE_ASDI_EAI
  ALLOWED_NETWORK_RULES = (ICECHUNK_DB.ICECHUNK.MET_OFFICE_ASDI_RULE)
  ENABLED = TRUE;

CREATE EXTERNAL ACCESS INTEGRATION IF NOT EXISTS FLEET_INTEL_MAP_TILES_EAI
  ALLOWED_NETWORK_RULES = (ICECHUNK_DB.ICECHUNK.CARTO_TILES_RULE)
  ENABLED = TRUE;

USE ROLE SYSADMIN;

-- ---------------------------------------------------------------------------
-- 8. SNOWFLAKE SERVICE FUNCTIONS
-- ---------------------------------------------------------------------------
-- These call the Python FastAPI backend running in ICECHUNK_SERVICE.
-- They can be created now but will return errors until the service is deployed.
--
-- ALL functions return VARIANT (not TABLE).  The frontend and SQL use
-- LATERAL FLATTEN over the returned JSON to get rows.
--
-- The endpoint name MUST be 'http-endpoint' (matches the service spec).
-- ---------------------------------------------------------------------------

-- Health check
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_HEALTH()
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/health';

-- Store metadata: variables, latest_snapshot, tags, grid info
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_META()
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/meta';

-- Seed/ingest: downloads latest Met Office ASDI run → writes to IceChunk
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED()
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/seed';

-- Raw data slice: returns all grid points in bbox as {lat, lon, value} rows.
-- Use for points mode or when exact grid positions are needed.
-- Query pattern:
--   SELECT f.value:lat::FLOAT, f.value:lon::FLOAT, f.value:value::FLOAT
--   FROM (SELECT ICECHUNK_SLICE(...) AS r) t, LATERAL FLATTEN(input => t.r:data) f
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE(
  VARIABLE    VARCHAR,
  LAT_MIN     FLOAT,
  LAT_MAX     FLOAT,
  LON_MIN     FLOAT,
  LON_MAX     FLOAT,
  SNAPSHOT_ID VARCHAR    -- pass NULL for latest snapshot
)
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/snowflake/slice';

-- H3-aggregated slice: Python groups grid points into H3 cells and returns
-- one row per cell with the mean value. Faster than ICECHUNK_SLICE because:
--   1. Python computes H3 cells (fast C bindings, no SQL per-row functions)
--   2. Returns far fewer rows (e.g. 9,984 source pts → ~2,000 H3 cells at res 5)
-- Use for H3 hexagon rendering in the React frontend.
-- Query pattern:
--   SELECT f.value:h3index::VARCHAR, f.value:value::FLOAT
--   FROM (SELECT ICECHUNK_SLICE_H3(...) AS r) t, LATERAL FLATTEN(input => t.r:data) f
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE_H3(
  VARIABLE    VARCHAR,
  LAT_MIN     FLOAT,
  LAT_MAX     FLOAT,
  LON_MIN     FLOAT,
  LON_MAX     FLOAT,
  SNAPSHOT_ID VARCHAR,   -- pass NULL for latest snapshot
  H3_RES      INT        -- H3 resolution 2-6 (6 = ~20km, best for 10km Met Office grid)
)
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/snowflake/slice_h3';

-- 3D cloud-cover at height level — raw lat/lon points
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_CLOUD_AT_LEVEL(
  LEVEL_IDX   FLOAT,     -- 0 = surface (~5m), 32 = upper troposphere (~40km)
  LAT_MIN     FLOAT,
  LAT_MAX     FLOAT,
  LON_MIN     FLOAT,
  LON_MAX     FLOAT,
  SNAPSHOT_ID VARCHAR
)
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/snowflake/cloud_level';

-- 3D cloud-cover at height level — H3-aggregated (faster, fewer rows)
-- Returns one row per H3 cell with mean cloud fraction.
-- Usage:
--   SELECT f.value:h3index::VARCHAR, f.value:cloud_pct::FLOAT, f.value:height_m::FLOAT
--   FROM (SELECT ICECHUNK_CLOUD_AT_LEVEL_H3(5, 49, 61, -11, 2, NULL, 5) AS r) t,
--   LATERAL FLATTEN(input => t.r:data) f;
CREATE OR REPLACE FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_CLOUD_AT_LEVEL_H3(
  LEVEL_IDX   FLOAT,     -- 0 = surface (~5m), up to n_levels-1 (~40km)
  LAT_MIN     FLOAT,
  LAT_MAX     FLOAT,
  LON_MIN     FLOAT,
  LON_MAX     FLOAT,
  SNAPSHOT_ID VARCHAR,
  H3_RES      NUMBER     -- H3 resolution 2-6 (5 ≈ 60km cells, 6 ≈ 20km cells)
)
  RETURNS VARIANT
  SERVICE = ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  ENDPOINT = 'http-endpoint'
  AS '/snowflake/cloud_level_h3';

-- ---------------------------------------------------------------------------
-- 9. GRANTS
-- ---------------------------------------------------------------------------

-- ── SYSADMIN ──────────────────────────────────────────────────────────────────
GRANT USAGE ON DATABASE ICECHUNK_DB TO ROLE SYSADMIN;
GRANT USAGE ON SCHEMA   ICECHUNK_DB.ICECHUNK TO ROLE SYSADMIN;
GRANT USAGE ON COMPUTE POOL ICECHUNK_COMPUTE_POOL TO ROLE SYSADMIN;
GRANT READ  ON SECRET ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID     TO ROLE SYSADMIN;
GRANT READ  ON SECRET ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY TO ROLE SYSADMIN;

-- ── ICECHUNK_DB role (used by the ICECHUNK SPCS service identity user) ────────
-- This role is assigned to the ICECHUNK user that the accelerator service runs
-- as in SPCS. It needs access to the warehouse, schema, service functions, and
-- Cortex AI so the agent chat panel can call the Cortex Agent API.
USE ROLE ACCOUNTADMIN;

CREATE ROLE IF NOT EXISTS ICECHUNK_DB;
CREATE USER IF NOT EXISTS ICECHUNK
  DEFAULT_ROLE      = ICECHUNK_DB
  DEFAULT_WAREHOUSE = XSMALL;

GRANT ROLE ICECHUNK_DB TO USER ICECHUNK;

USE ROLE SYSADMIN;

GRANT USAGE ON DATABASE   ICECHUNK_DB           TO ROLE ICECHUNK_DB;
GRANT USAGE ON SCHEMA     ICECHUNK_DB.ICECHUNK  TO ROLE ICECHUNK_DB;
GRANT USAGE ON WAREHOUSE  XSMALL                TO ROLE ICECHUNK_DB;
GRANT USAGE ON SERVICE    ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE            TO ROLE ICECHUNK_DB;
GRANT USAGE ON SERVICE    ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE TO ROLE ICECHUNK_DB;
GRANT SERVICE ROLE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE!ALL_ENDPOINTS_USAGE
    TO ROLE ICECHUNK_DB;

-- Grant all Snowflake service functions to the ICECHUNK_DB role
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_HEALTH()                                                                            TO ROLE ICECHUNK_DB;
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_META()                                                                              TO ROLE ICECHUNK_DB;
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED()                                                                              TO ROLE ICECHUNK_DB;
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE(VARCHAR,FLOAT,FLOAT,FLOAT,FLOAT,VARCHAR)                                      TO ROLE ICECHUNK_DB;
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE_H3(VARCHAR,FLOAT,FLOAT,FLOAT,FLOAT,VARCHAR,NUMBER)                            TO ROLE ICECHUNK_DB;
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_CLOUD_AT_LEVEL(NUMBER,FLOAT,FLOAT,FLOAT,FLOAT,VARCHAR)                              TO ROLE ICECHUNK_DB;
GRANT USAGE ON FUNCTION ICECHUNK_DB.ICECHUNK.ICECHUNK_CLOUD_AT_LEVEL_H3(FLOAT,FLOAT,FLOAT,FLOAT,FLOAT,VARCHAR,NUMBER)                      TO ROLE ICECHUNK_DB;

-- Cortex AI access — required for the agent and tool procedures to call
-- AI_COMPLETE / CORTEX.COMPLETE. Without this the Cortex Agent API returns
-- an empty response (0 chars) without surfacing an error.
USE ROLE ACCOUNTADMIN;
GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ICECHUNK_DB;

USE ROLE SYSADMIN;

-- Note: agent + tool procedure grants are in 05_create_agent.sql
-- (those objects don't exist yet at this point in the setup sequence)

-- ---------------------------------------------------------------------------
SELECT 'Setup complete — next: run 02_build_push.sh then 03_deploy_services.sql' AS status;
