---
name: icechunk-accelerator
description: "Deploy the IceChunk Accelerator on Snowflake Container Services (SPCS). Covers AWS S3 and IAM setup, Snowflake object creation (database, compute pool, secrets, EAIs, service functions), building/pushing Docker images with patch versioning, deploying two SPCS services (Python FastAPI backend + React/Express frontend), loading Met Office ASDI weather data (Global 10km + UK 2km with surface and 3D pressure/height level variables) into IceChunk Zarr stores, and creating a Cortex Agent for natural-language weather Q&A. Use when: deploying IceChunk Accelerator, setting up IceChunk SPCS, deploying Met Office weather data pipeline, reproducing IceChunk deployment, icechunk accelerator, weather data SPCS, IceChunk zarr snowflake."
---

# IceChunk Accelerator — SPCS Deployment

End-to-end deployment of a weather data visualisation app on Snowflake Container Services.

**Architecture:**
- `icechunk-service` — Python FastAPI backend: reads/writes IceChunk Zarr stores on S3, serves global and UK slice queries, 3D level slices (height + pressure), Met Office ASDI ingest
- `icechunk-accelerator` — React/Vite + Express frontend: DeckGL map with H3 hexagon and native grid rendering, level slider for 3D vars, dataset toggle (Global 10km / UK 2km), DataLoader with per-variable selector, Cortex Agent chat panel

---

## Shared-account safe: `config.env` + `DEPLOY_PREFIX` (READ FIRST)

The target may be a **shared** Snowflake account (e.g. an SE builders workshop) where
many people deploy this app. A single knob, `DEPLOY_PREFIX`, namespaces **both** S3
objects and **all** Snowflake objects so nothing collides:

| Thing | Without prefix (collides) | With `DEPLOY_PREFIX=<p>` |
|-------|---------------------------|--------------------------|
| Database | `ICECHUNK_DB` | `ICECHUNK_DB_<P>` (namespaces schema, image repo, secrets, functions, services, agent) |
| Warehouse | `XSMALL` (generic!) | `ICECHUNK_WH_<P>` |
| Compute pool | `ICECHUNK_COMPUTE_POOL` | `ICECHUNK_POOL_<P>` |
| EAIs | `ICECHUNK_S3_EAI`, … | `ICECHUNK_S3_EAI_<P>`, `MET_OFFICE_ASDI_EAI_<P>`, `FLEET_INTEL_MAP_TILES_EAI_<P>` |
| Role / User | `ICECHUNK_DB` / `ICECHUNK` | `ICECHUNK_ROLE_<P>` / `ICECHUNK_<P>` |
| S3 Zarr | `s3://<bucket>/met_office_global/` | `s3://<bucket>/<p>/met_office_global/`, `<p>/met_office_uk_2km/` |
| IAM user | shared | `<p>_icechunk_user` scoped to `s3://<bucket>/<p>/*` |

`<P>` = uppercased `DEPLOY_PREFIX`. Schema stays `ICECHUNK` and the service objects keep
their names (`ICECHUNK_SERVICE` / `ICECHUNK_ACCELERATOR_SERVICE`) — the unique DB isolates
them, and intra-schema service DNS (`http://icechunk-service:8080`) is unaffected.

### Config-driven deploy (canonical — supersedes manual SQL edits)

```bash
cp config.env.example config.env     # set DEPLOY_PREFIX, S3_BUCKET, AWS_REGION, ICECHUNK_CONNECTION
bash provision_aws.sh                # bucket (if missing) + per-prefix IAM user; writes AWS keys into config.env
bash setup.sh                        # renders prefixed templates, creates secrets inline, runs setup SQL
snow spcs image-registry login -c <CONNECTION>
bash build.sh --bump patch           # build + push both images to ICECHUNK_DB_<P>.ICECHUNK.ICECHUNK_REPO
bash deploy.sh                        # CREATE-or-ALTER both services, re-apply EAIs, print app URL
# functions MUST be created AFTER the services exist (service functions reference the running service):
snow sql -c <CONNECTION> -f sql/_rendered/02_functions.sql
# then seed (global + UK) + agent:
snow sql -c <CONNECTION> -q "SELECT ICECHUNK_DB_<P>.ICECHUNK.ICECHUNK_SEED();"
snow sql -c <CONNECTION> -q "SELECT ICECHUNK_DB_<P>.ICECHUNK.ICECHUNK_SEED_UK();"
# OPTIONAL — add global 3D cloud (cloud_amount_on_height_levels) + surface cloud
# fields. Run AFTER ICECHUNK_SEED() (seed uses zarr mode="w" and would wipe it).
# Writes directly to S3 with the per-prefix IAM creds; needs Python 3.12 + icechunk==2.0.5:
ICECHUNK_BUCKET="$S3_BUCKET" ICECHUNK_PREFIX="${DEPLOY_PREFIX}/met_office_global" \
  AWS_DEFAULT_REGION="$AWS_REGION" python add_cloud_variables.py
snow sql -c <CONNECTION> -f sql/_rendered/05_create_agent.sql
```

- `names.sh` derives every prefixed name from `config.env`; `build.sh`/`deploy.sh`/`setup.sh` all source it so names never drift.
- `build.sh` resolves the registry + repo path live from `SHOW IMAGE REPOSITORIES` (account-correct, no hardcoded registry).
- Secrets are created inline by `setup.sh` from `config.env` and are NEVER written to a rendered file. `config.env` and `sql/_rendered/` are gitignored.
- **Function ordering:** `setup.sh`/`01_snowflake_setup.sql` create infra + identity only (no functions). The 14 service functions (7 global + 7 UK) live in `02_functions.sql` and **must be run after `deploy.sh`** because Snowflake rejects a `SERVICE=` function before the service exists.
- The `scripts/*.sql` files below remain as **reference**; the `.tmpl` versions are what `setup.sh` renders.

---

## Prerequisites

- AWS CLI installed and configured
- `snow` CLI authenticated: `snow connection test -c <CONNECTION>`
- Docker with `buildx` (or Rancher Desktop)
- SYSADMIN + ACCOUNTADMIN on the target Snowflake account

---

## Parameters

| Parameter | Example |
|-----------|---------|
| `<CONNECTION>` | `internal-marketplace` |
| `<REGISTRY>` | `<account>.registry.snowflakecomputing.com/icechunk_db/icechunk/icechunk_repo` |
| `<S3_BUCKET>` | `icechunk-ro` |
| `<S3_REGION>` | `us-west-2` — must match the bucket's actual AWS region |

---

## Workflow

```
Step 0: AWS setup (S3 bucket + IAM user + access keys)
    ↓
Step 1: Snowflake setup (DB, pool, secrets, EAIs, all service functions)
    ↓
Step 2: Build & push Docker images
    ↓
Step 3: Deploy SPCS services
    ↓
Step 4: Load global Met Office data
    ↓
Step 5: Create Cortex Agent (WEATHER_AGENT)
    ↓
Step 6: Verify
    ↓
Step 7: (Optional) Load UK 2km data with variable selector
```

---

### Step 0: AWS Setup

**Goal:** Create the S3 bucket for the IceChunk store and an IAM user with read/write access.

**Run** `scripts/00_aws_setup.sh`:
```bash
bash scripts/00_aws_setup.sh \
  --bucket    icechunk-ro \
  --region    us-west-2 \
  --user-name icechunk-spcs-user \
  --profile   <aws-profile>   # optional
```

This creates:
- S3 bucket `icechunk-ro` with public access blocked
- IAM policy granting GetObject/PutObject/DeleteObject/ListBucket on that bucket
- IAM user `icechunk-spcs-user` with the policy attached
- Access key pair — **copy the Secret Access Key from the output, it's shown only once**

**⚠️ STOP**: Copy the Access Key ID and Secret Access Key before continuing.

---

### Step 1: Snowflake Setup

**Run** `scripts/01_snowflake_setup.sql`:
```bash
snow sql -f scripts/01_snowflake_setup.sql -c <CONNECTION>
```

> **Note:** `01` creates infra + identity only. The 14 service functions (7 global + 7 UK) are in `scripts/02_functions.sql` and must be run **after** Step 3 (deploy services) — Snowflake rejects a `SERVICE=` function before the service exists.

Before running, fill in the two AWS secrets at the top of the file:
```sql
CREATE SECRET ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID     TYPE = GENERIC_STRING SECRET_STRING = '<key id>';
CREATE SECRET ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY  TYPE = GENERIC_STRING SECRET_STRING = '<secret>';
```

This creates:
- `ICECHUNK_DB` database and `ICECHUNK` schema
- `XSMALL` warehouse (SMALL size)
- `ICECHUNK_COMPUTE_POOL` (CPU_X64_XS)
- `ICECHUNK_REPO` image repository
- `ICECHUNK_S3_EAI`, `MET_OFFICE_ASDI_EAI`, `FLEET_INTEL_MAP_TILES_EAI` network rules + EAIs
- **All service functions** for global + UK 2km (see function list below)

Get the image registry URL (needed for Step 2):
```sql
SHOW IMAGE REPOSITORIES IN SCHEMA ICECHUNK_DB.ICECHUNK;
-- → repository_url column
```

**⚠️ STOP**: Wait for compute pool to reach IDLE/ACTIVE before Step 3.
```sql
SHOW COMPUTE POOLS LIKE 'ICECHUNK_COMPUTE_POOL';
```

---

### Step 2: Build & Push Docker Images

From the project root (where `build.sh` and `VERSION` live):

```bash
# First time — authenticate with the registry
snow spcs image-registry login --connection <CONNECTION>

# Build and push both images, bumping the patch version
bash build.sh --bump patch
```

To rebuild only one service:
```bash
bash build.sh --service-only --bump patch   # Python backend only
bash build.sh --accel-only  --bump patch    # React frontend only
```

**If h5py build fails:** Ensure the Dockerfile has `libhdf5-dev pkg-config` before `pip install --prefer-binary -r requirements.txt`.

---

### Step 3: Deploy SPCS Services

**Run** `scripts/03_deploy_services.sql`:
```bash
snow sql -f scripts/03_deploy_services.sql -c <CONNECTION>
```

**⚠️ CRITICAL — EAIs ALWAYS reset on spec change. Use `deploy.sh` which handles this automatically and prints the new URL:**
```bash
bash deploy.sh --accel-only    # frontend only (most common)
bash deploy.sh                 # both services
```

Or manually:
```sql
ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, MET_OFFICE_ASDI_EAI);
ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI);
```

**⚠️ IMPORTANT — The ingress URL changes after every spec update.** `deploy.sh` always fetches and prints the new URL. If you ran `ALTER SERVICE` manually, run:
```sql
SHOW ENDPOINTS IN SERVICE ICECHUNK_ACCELERATOR_SERVICE;
```

**Wait for RUNNING:**
```sql
CALL SYSTEM$GET_SERVICE_STATUS('ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE');
CALL SYSTEM$GET_SERVICE_STATUS('ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE');
```

**Get the app URL:**
```sql
SHOW ENDPOINTS IN SERVICE ICECHUNK_ACCELERATOR_SERVICE;
-- → ingress_url column
```

**⚠️ STOP**: Both services must show RUNNING before proceeding.

---

### Step 4: Load Global Met Office Data

**Run** `scripts/04_load_data.sql`:
```bash
snow sql -f scripts/04_load_data.sql -c <CONNECTION>
```

Or trigger manually:
```sql
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED() AS result;
```

Downloads 9 surface variables from the public Met Office ASDI S3 bucket and writes them to `s3://icechunk-ro/met_office_global/`. Takes 2-5 minutes.

Expected result: `"Loaded 9 variables at 1920×2560 grid points (~10km global)"`

---

### Step 5: Create Cortex Agent

**Run** `scripts/05_create_agent.sql`:
```bash
snow sql -f scripts/05_create_agent.sql -c <CONNECTION>
```

Creates:
- `TOOL_WEATHER_META()` — returns available variables, snapshot, grid
- `TOOL_WEATHER_SLICE(region, variable, snapshot_id)` — geocodes region via AI_COMPLETE, queries H3 stats
- `TOOL_WEATHER_SUMMARY(region, snapshot_id)` — full weather summary for a region
- `WEATHER_AGENT` — Cortex Agent with `models: orchestration: auto`
- Grants to SYSADMIN, ICECHUNK_DB role, `SNOWFLAKE.CORTEX_USER`

**Model note:** Uses `orchestration: auto`. Never hardcode a model name — it silently returns 0 chars if unavailable.

**Map focus:** Both tool procedures return a `bbox` field in their result. The Express server emits a `map_focus` SSE event which causes the frontend to auto-zoom to the agent's region.

---

### Step 6: Verify

```sql
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_HEALTH();
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META();

-- UK bounding box, global dataset: expect ~9,984 rows
SELECT COUNT(*) FROM (
  SELECT PARSE_JSON(ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE(
    'air_temperature', 49.0, 61.0, -8.0, 3.0, NULL)):data AS d
) t, LATERAL FLATTEN(input => t.d) f;

-- Test agent tool
CALL ICECHUNK_DB.ICECHUNK.TOOL_WEATHER_META();
```

Open the ingress URL in a browser. The DeckGL map should show weather hexagons, the `⬡ H3` / `▦ Grid` toggle should be visible, and asking the agent "What's the weather in London?" should return values and auto-zoom the map.

---

### Step 7: Load UK 2km Data (Optional)

The UK 2km dataset covers the British Isles at ~2km resolution with surface and 3D pressure/height level variables.

**In the app**: go to Data Loader → UK 2km tab → select desired variables → click Seed.

**From SQL** (surface only, default):
```sql
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED_UK();
```

**With specific variables** (pass zarr_key names as JSON array):
```sql
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED_UK_VARS(
  '["air_temperature","cloud_amount_on_height_levels","temperature_on_pressure_levels"]'
);
```

**UK variable catalog** (UK_INGEST_FILES in `types.ts`):

Surface (2D): `air_temperature`, `lwe_precipitation_rate`, `wind_speed_at_10m`, `air_pressure_at_sea_level`, `relative_humidity`, `cloud_amount_of_total_cloud`, `visibility_at_screen_level`, `cloud_amount_of_high_cloud`, `cloud_amount_of_low_cloud`, `cloud_amount_of_medium_cloud`, `wind_gust_at_10m`, `dew_point_temperature`, `snowfall_rate`, `rainfall_rate`, `fog_fraction`

Height levels (3D, ~70 MB each): `cloud_amount_on_height_levels`, `temperature_on_height_levels`, `wind_speed_on_height_levels`

Pressure levels (3D, ~70 MB each): `temperature_on_pressure_levels`, `relative_humidity_on_pressure_levels`, `wind_speed_on_pressure_levels`, `wind_direction_on_pressure_levels`

---

## Snowflake Service Functions

### Global 10km

| Function | Endpoint | Use case |
|----------|----------|---------|
| `ICECHUNK_HEALTH()` | `/health` | Readiness |
| `ICECHUNK_META()` | `/meta` | Variables, snapshot, grid |
| `ICECHUNK_SEED()` | `/seed` | Ingest latest global run |
| `ICECHUNK_SLICE(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/slice` | Raw grid points |
| `ICECHUNK_SLICE_H3(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/slice_h3` | H3 cells |
| `ICECHUNK_CLOUD_AT_LEVEL(level, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/cloud_level` | Cloud at height (raw) |
| `ICECHUNK_CLOUD_AT_LEVEL_H3(level, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/cloud_level_h3` | Cloud at height (H3) |

### UK 2km

| Function | Endpoint | Use case |
|----------|----------|---------|
| `ICECHUNK_META_UK()` | `/meta_uk` | UK variables, snapshot, grid |
| `ICECHUNK_SEED_UK()` | `/seed_uk` | Ingest UK surface vars |
| `ICECHUNK_SEED_UK_VARS(vars_json)` | `/seed_uk_vars` | Ingest selected UK vars |
| `ICECHUNK_SLICE_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/slice_uk` | UK raw grid points |
| `ICECHUNK_SLICE_H3_UK(var, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/slice_h3_uk` | UK H3 cells |
| `ICECHUNK_LEVEL_SLICE_UK(var, level, lat_min, lat_max, lon_min, lon_max, snapshot_id)` | `/snowflake/level_slice_uk` | Any UK 3D var at level (raw) |
| `ICECHUNK_LEVEL_SLICE_H3_UK(var, level, lat_min, lat_max, lon_min, lon_max, snapshot_id, h3_res)` | `/snowflake/level_slice_h3_uk` | Any UK 3D var at level (H3) |

All functions return VARIANT. Use `LATERAL FLATTEN(input => result:data)` to expand rows.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Map background is black | CARTO `dark_matter_nolabels` deprecated (502) | Use `dark_all` in tile proxy (`server/index.ts`) |
| `ENOTFOUND <account>.snowflakecomputing.com` | `SNOWFLAKE_HOST` set in accelerator spec | Remove it — SPCS auto-injects the internal hostname |
| S3 DNS error / `ENOTFOUND s3.us-east-1.amazonaws.com` | Wrong `AWS_DEFAULT_REGION` | Set `AWS_DEFAULT_REGION: "us-west-2"` in backend spec |
| `Endpoint 'api' does not exist` | Old endpoint name in service function | Recreate with `ENDPOINT = 'http-endpoint'` |
| Tag conflict from ICECHUNK_SEED | IceChunk tags are immutable | Handled by `_create_tag_safe()` — safe to ignore |
| No files downloaded for run stamp | ASDI lags 6-12 h | Backend auto-falls back up to 6 hours |
| Only 6 data points visible | Old synthetic data in latest snapshot | Run `ICECHUNK_SEED()` to overwrite |
| Agent returns 0 chars | Hardcoded model not available | Set `models: orchestration: auto` in `05_create_agent.sql` |
| Ingress URL stopped working / 404 | URL changed after `ALTER SERVICE FROM SPECIFICATION` | Run `SHOW ENDPOINTS IN SERVICE ICECHUNK_ACCELERATOR_SERVICE;` or `bash deploy.sh --accel-only` to get the new URL |
| `ICECHUNK_DB` lacks `CORTEX_USER` | Agent tool fails with Cortex permission error | `GRANT DATABASE ROLE SNOWFLAKE.CORTEX_USER TO ROLE ICECHUNK_DB;` |
| Agent tool: `Service ... ICECHUNK_SERVICE ... does not exist or not authorized` or `Service Endpoint 'http-endpoint' ... not authorized` | `05` creates `TOOL_WEATHER_*` procs as SYSADMIN (`USE ROLE SYSADMIN`), so EXECUTE AS OWNER = SYSADMIN — which lacks service/endpoint/function USAGE | Grant the backend service + its endpoint role + the tool functions to SYSADMIN (done by `02_functions.sql`): `GRANT USAGE ON SERVICE <db>.<schema>.ICECHUNK_SERVICE TO ROLE SYSADMIN; GRANT SERVICE ROLE <db>.<schema>.ICECHUNK_SERVICE!ALL_ENDPOINTS_USAGE TO ROLE SYSADMIN; GRANT USAGE ON FUNCTION ...ICECHUNK_META()/ICECHUNK_SLICE_H3(...) TO ROLE SYSADMIN;` |
| EAI dropped after spec update | ALTER FROM SPECIFICATION resets EAIs | Re-run `ALTER SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS` |
| UK 3D var not found in repo | 3D var not ingested (large files, opt-in) | Use DataLoader UK tab or `ICECHUNK_SEED_UK_VARS(json)` |
| `Cloud by height (3D)` missing from Global variable selector | Global 3D cloud not ingested, OR the var isn't in the frontend `VARIABLES` array | (1) Run `add_cloud_variables.py` with `ICECHUNK_PREFIX=<prefix>/met_office_global` to add `cloud_amount_on_height_levels` to the repo; (2) ensure `cloud_amount_on_height_levels` (is3D:true) is in `src/types.ts` `VARIABLES` — the global selector filter is `(!v.is3D \|\| v.key === 'cloud_amount_on_height_levels')` |
| Global cloud shows nothing after selecting var | `cloud_amount_on_height_levels` lives in a separate snapshot if seeded after `ICECHUNK_SEED()` wiped main | `add_cloud_variables.py` commits to main (append) so it usually works; if a later `ICECHUNK_SEED()` wiped it, select the `met_office_cloud_*` snapshot from the top-right Snapshot picker (or re-run `add_cloud_variables.py`) |
| Global grid cells wrong size | Old hardcoded 0.09° — fixed in v1.0.43 | Redeploy; grid step now from `meta.grid.lat_count` / `lat_range` |
| Partition rows empty | Missing `knownCols` in partition GET | `fetchPartition()` in `server/index.ts` must pass column metadata |
| h5py pip install fails | Missing HDF5 libraries | Add `libhdf5-dev pkg-config` to Dockerfile apt install |

---

## Files in This Skill

```
scripts/
  00_aws_setup.sh           AWS S3 bucket + IAM user + access keys (legacy; see provision_aws.sh)
  01_snowflake_setup.sql     DB, warehouse, pool, secrets, EAIs, role, user — infra + identity only (NO functions)
  02_functions.sql           14 service functions (7 global + 7 UK) + grants — run AFTER services exist
  03_deploy_services.sql    SPCS CREATE SERVICE specs + mandatory EAI application
  04_load_data.sql          ICECHUNK_SEED() global trigger + verification
  05_create_agent.sql       WEATHER_AGENT + 3 tool procedures + grants
  *.sql.tmpl                Prefixed templates rendered by setup.sh into sql/_rendered/ (DEPLOY_PREFIX flow)

Project root (not in skill):
  config.env.example        Template for config.env (DEPLOY_PREFIX, S3_BUCKET, AWS_REGION, ICECHUNK_CONNECTION)
  names.sh                  Derives every prefixed object name from config.env (sourced by the scripts below)
  provision_aws.sh          S3 bucket (if missing) + per-prefix IAM user scoped to <bucket>/<prefix>/*
  setup.sh                  Renders prefixed .tmpl SQL, creates secrets inline, runs 01 infra
  deploy.sh                 CREATE-or-ALTER both services, re-apply EAIs, print live app URL
  build.sh                  Docker buildx wrapper with --bump patch versioning
  VERSION                   Semver file (updated by build.sh)
  Dockerfile                Python FastAPI backend (icechunk-service)
  icechunk-accelerator/     React/Vite/Express frontend (icechunk-accelerator)
  app/                      Python FastAPI source:
    main.py                 All endpoints (global + UK slice, level_slice, seed_uk_vars)
    ingest.py               Global 10km ASDI downloader
    ingest_uk.py            UK 2km ASDI downloader (surface + 3D height/pressure levels)
    icechunk_client.py      IceChunk repo open/create helpers
    requirements.txt        Python deps
  service-spec.yaml         Backend SPCS spec (reference)
  icechunk-accelerator/accelerator-service-spec.yaml  Frontend SPCS spec (reference)
```

## Success Criteria

- `ICECHUNK_HEALTH()` returns `{"status": "ok"}`
- `ICECHUNK_META()` returns `variables` array with 9 entries and `lat_count: 1920`
- `ICECHUNK_SLICE('air_temperature', 49, 61, -8, 3, NULL)` row count > 1000
- App ingress URL loads with CARTO dark map and weather hexagons
- `⬡ H3` / `▦ Grid` toggle visible in top-left panel
- UK dataset toggle loads UK 2km data and zooms to UK
- `CALL TOOL_WEATHER_META()` returns variables array
- Asking agent "What's the weather in London?" auto-zooms map and returns values
- DataLoader UK tab shows variable selector grouped by Surface / Height / Pressure levels

## Stopping Points

- ✋ Step 0: Copy AWS Secret Access Key before it disappears
- ✋ Step 1: Fill in actual AWS keys before running SQL
- ✋ Step 1: Compute pool must reach IDLE before Step 3
- ✋ Step 3: Both services must show RUNNING before Step 4
- ✋ Step 5: Services must be RUNNING before creating the agent
- ✋ Step 7: 3D pressure-level files are ~70 MB each — allow 5-10 min per variable
