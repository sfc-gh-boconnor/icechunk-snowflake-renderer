-- =============================================================================
-- IceChunk Accelerator — Deploy SPCS Services  v1.0
-- =============================================================================
-- Run AFTER:
--   1. 01_snowflake_setup.sql completed (DB, compute pool, secrets, EAIs)
--   2. Docker images built and pushed (run build.sh --bump patch)
--
-- Usage:
--   snow sql -f 03_deploy_services.sql -c <CONNECTION>
--
-- CRITICAL RULES:
--   1. The Python backend spec MUST set AWS_DEFAULT_REGION to the region where
--      the IceChunk S3 bucket lives (us-west-2 for icechunk-ro).
--      Using the wrong region causes DNS resolution failure against the S3 EAI
--      network rule (which only allows the correct regional endpoint).
--
--   2. The accelerator spec MUST NOT set SNOWFLAKE_HOST or SNOWFLAKE_ACCOUNT.
--      SPCS auto-injects SNOWFLAKE_HOST with the correct internal hostname.
--      If you set it explicitly to the public hostname (.snowflakecomputing.com),
--      DNS resolution fails inside the compute pool with ENOTFOUND.
--
--   3. ALTER SERVICE FROM SPECIFICATION silently drops EXTERNAL_ACCESS_INTEGRATIONS.
--      Always re-run the ALTER SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS commands
--      at the bottom after EVERY spec change.
-- =============================================================================

USE ROLE SYSADMIN;
USE SCHEMA ICECHUNK_DB.ICECHUNK;

-- =============================================================================
-- SERVICE 1: icechunk-service  (Python FastAPI + IceChunk Zarr + ASDI ingest)
-- =============================================================================
-- Port: 8080  |  Endpoint: http-endpoint (private — called via Snowflake functions)
-- Container name: icechunk-service  (used in SYSTEM$GET_SERVICE_LOGS calls)

CREATE SERVICE IF NOT EXISTS ICECHUNK_SERVICE
  IN COMPUTE POOL ICECHUNK_COMPUTE_POOL
  FROM SPECIFICATION $$
    spec:
      containers:
      - name: icechunk-service
        image: /icechunk_db/icechunk/icechunk_repo/icechunk-service:latest
        env:
          ICECHUNK_BUCKET: "icechunk-ro"
          ICECHUNK_PREFIX: "met_office_global"
          AWS_DEFAULT_REGION: "us-west-2"
        secrets:
        - snowflakeSecret:
            objectName: ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID
          envVarName: AWS_ACCESS_KEY_ID
        - snowflakeSecret:
            objectName: ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY
          envVarName: AWS_SECRET_ACCESS_KEY
        resources:
          requests:
            memory: 2Gi
            cpu: 500m
          limits:
            memory: 4Gi
            cpu: 1000m
        readinessProbe:
          port: 8080
          path: /health
      endpoints:
      - name: http-endpoint
        port: 8080
        public: false
  $$
  MIN_READY_INSTANCES = 1;

-- =============================================================================
-- SERVICE 2: icechunk-accelerator  (React + Express + DeckGL map)
-- =============================================================================
-- Port: 3001  |  Endpoint: ui (public — accessible via ingress URL)
-- Container name: icechunk-accelerator  (used in SYSTEM$GET_SERVICE_LOGS calls)
--
-- DO NOT set SNOWFLAKE_HOST — SPCS auto-injects the correct internal hostname.
-- DO NOT set SNOWFLAKE_ACCOUNT — not needed; service token handles auth.

CREATE SERVICE IF NOT EXISTS ICECHUNK_ACCELERATOR_SERVICE
  IN COMPUTE POOL ICECHUNK_COMPUTE_POOL
  FROM SPECIFICATION $$
    spec:
      containers:
      - name: icechunk-accelerator
        image: /icechunk_db/icechunk/icechunk_repo/icechunk-accelerator:latest
        env:
          PORT: "3001"
          SNOWFLAKE_DATABASE: "ICECHUNK_DB"
          SNOWFLAKE_SCHEMA: "ICECHUNK"
          SNOWFLAKE_WAREHOUSE: "XSMALL"
        resources:
          requests:
            memory: 1Gi
            cpu: 500m
          limits:
            memory: 2Gi
            cpu: 1000m
        readinessProbe:
          port: 3001
          path: /api/health
      endpoints:
      - name: ui
        port: 3001
        public: true
  $$
  MIN_READY_INSTANCES = 1;

-- =============================================================================
-- MANDATORY: Apply External Access Integrations
-- =============================================================================
-- These must be set separately EVERY TIME a spec change is made.
-- ALTER SERVICE FROM SPECIFICATION silently drops EAIs.

ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, MET_OFFICE_ASDI_EAI);

ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI);

-- =============================================================================
-- Wait for services to reach RUNNING state
-- =============================================================================
-- Rerun until both show status = RUNNING:
-- CALL SYSTEM$GET_SERVICE_STATUS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE');
-- CALL SYSTEM$GET_SERVICE_STATUS('ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE');

-- Get the public ingress URL:
SHOW ENDPOINTS IN SERVICE ICECHUNK_ACCELERATOR_SERVICE;
-- Copy ingress_url and share with app users.

-- =============================================================================
-- Troubleshooting: check container logs
-- =============================================================================
-- CALL SYSTEM$GET_SERVICE_LOGS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE',
--   '0', 'icechunk-service', 100);
-- CALL SYSTEM$GET_SERVICE_LOGS('ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE',
--   '0', 'icechunk-accelerator', 100);

-- =============================================================================
-- Updating an existing service after a new image build
-- =============================================================================
-- After bash build.sh --bump patch, run:
--
-- ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
--   FROM SPECIFICATION $$ spec: ... $$;
-- ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
--   SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, MET_OFFICE_ASDI_EAI);
--
-- ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE
--   FROM SPECIFICATION $$ spec: ... $$;
-- ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE
--   SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI);
