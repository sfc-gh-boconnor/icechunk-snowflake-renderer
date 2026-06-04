---
name: icechunk-accelerator
description: "Deploy the IceChunk Accelerator on Snowflake Container Services (SPCS). Covers AWS S3 and IAM setup, Snowflake object creation (database, compute pool, secrets, EAIs, external functions), building/pushing Docker images with patch versioning, deploying two SPCS services (Python FastAPI backend + React/Express frontend), and loading Met Office ASDI weather data into an IceChunk Zarr store. Use when: deploying IceChunk Accelerator, setting up IceChunk SPCS, deploying Met Office weather data pipeline, reproducing IceChunk deployment, icechunk accelerator, weather data SPCS, IceChunk zarr snowflake."
---

# IceChunk Accelerator — SPCS Deployment

End-to-end deployment of a weather data visualisation app on Snowflake Container Services.

**Architecture:**
- `icechunk-service` — Python FastAPI backend: reads/writes IceChunk Zarr store on S3, serves slice queries and Met Office ASDI ingest via Snowflake service functions
- `icechunk-accelerator` — React/Vite + Express frontend: DeckGL map with H3 hexagon or scatter-point rendering, CARTO dark basemap, snapshot date picker, region presets

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
Step 1: Snowflake setup (DB, pool, secrets, EAIs, functions)
    ↓
Step 2: Build & push Docker images
    ↓
Step 3: Deploy SPCS services
    ↓
Step 4: Load Met Office data
    ↓
Step 5: Verify
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

Before running, fill in the two AWS secrets at the top of the file with the keys from Step 0:
```sql
CREATE SECRET ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID     TYPE = GENERIC_STRING SECRET_STRING = '<key id>';
CREATE SECRET ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY  TYPE = GENERIC_STRING SECRET_STRING = '<secret>';
```

This creates:
- `ICECHUNK_DB` database and `ICECHUNK` schema
- `XSMALL` warehouse (SMALL size)
- `ICECHUNK_COMPUTE_POOL` (CPU_X64_XS)
- `ICECHUNK_REPO` image repository
- `ICECHUNK_S3_EAI`, `MET_OFFICE_ASDI_EAI`, `FLEET_INTEL_MAP_TILES_EAI` network rules and EAIs
- All 6 service functions: `ICECHUNK_HEALTH`, `ICECHUNK_META`, `ICECHUNK_SEED`, `ICECHUNK_SLICE`, `ICECHUNK_SLICE_H3`, `ICECHUNK_CLOUD_AT_LEVEL`

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

**Goal:** Build both containers and push them to the Snowflake registry with a versioned tag.

From the project root (where `build.sh` and `VERSION` live):

```bash
# First time — authenticate with the registry
snow spcs image-registry login --connection <CONNECTION>

# Build and push both images, bumping the patch version
bash build.sh --bump patch
```

This tags each image as both `:latest` and `:<VERSION>` (e.g. `:1.0.5`).

To rebuild only one service after a targeted change:
```bash
bash build.sh --service-only --bump patch   # Python backend only
bash build.sh --accel-only  --bump patch   # React frontend only
```

**If h5py build fails:** Ensure the Dockerfile has `libhdf5-dev pkg-config` in the apt install step before `pip install --prefer-binary -r requirements.txt`.

---

### Step 3: Deploy SPCS Services

**Run** `scripts/03_deploy_services.sql`:
```bash
snow sql -f scripts/03_deploy_services.sql -c <CONNECTION>
```

This creates both services and applies the EAIs.

**⚠️ CRITICAL — EAIs ALWAYS reset on spec change:**
`ALTER SERVICE FROM SPECIFICATION` silently drops `EXTERNAL_ACCESS_INTEGRATIONS`. The script handles this, but if you ever manually alter a spec, always re-run:
```sql
ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, MET_OFFICE_ASDI_EAI);
ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE
  SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI);
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

### Step 4: Load Met Office Data

**Run** `scripts/04_load_data.sql`:
```bash
snow sql -f scripts/04_load_data.sql -c <CONNECTION>
```

Or trigger manually:
```sql
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_SEED() AS result;
```

Downloads 9 surface variables (~70 MB total) from the public Met Office ASDI S3 bucket and writes them to `s3://icechunk-ro/met_office_global/` as a versioned IceChunk Zarr store. Takes 2-5 minutes.

Expected result: `"Loaded 9 variables at 1920×2560 grid points (~10km global)"`

---

### Step 5: Verify

```sql
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_HEALTH();
SELECT ICECHUNK_DB.ICECHUNK.ICECHUNK_META();

-- UK bounding box: expect ~9,984 rows
SELECT COUNT(*) FROM (
  SELECT PARSE_JSON(ICECHUNK_DB.ICECHUNK.ICECHUNK_SLICE(
    'air_temperature', 49.0, 61.0, -8.0, 3.0, NULL)):data AS d
) t, LATERAL FLATTEN(input => t.d) f;
```

Open the ingress URL in a browser and confirm the DeckGL map shows weather hexagons over the globe.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Map background is black | CARTO `dark_matter_nolabels` path deprecated (returns 502) | Tile proxy in `server/index.ts` must use `dark_all` path |
| `getaddrinfo ENOTFOUND <account>.snowflakecomputing.com` | `SNOWFLAKE_HOST` explicitly set in accelerator spec | Remove `SNOWFLAKE_HOST` from spec — SPCS auto-injects the correct internal hostname |
| `S3 DNS error / ENOTFOUND s3.us-east-1.amazonaws.com` | `AWS_DEFAULT_REGION` set to wrong region | Set `AWS_DEFAULT_REGION: "us-west-2"` in the backend service spec (matches bucket + EAI network rule) |
| `Endpoint 'api' does not exist` | Service functions reference old endpoint name | Recreate functions with `ENDPOINT = 'http-endpoint'` (not `'api'`) |
| `tag already exists / immutable` from ICECHUNK_SEED | IceChunk tags are immutable; repeat calls try to create `v1.0` again | Handled by `_create_tag_safe()` in `ingest.py` — can be safely ignored |
| `No files downloaded for run YYYYMMDDTHH00Z` | ASDI bucket lags 6-12 hours | Met Office publishes runs with a delay; try yesterday's date in `latest_run_stamp()` |
| Only 6 data points visible | IceChunk store has old 5° synthetic seeder data as latest snapshot | Run `ICECHUNK_SEED()` again to ingest real 10km data |
| Partition data shows empty rows | Snowflake partition GETs omit `resultSetMetaData` | `server/index.ts` `fetchPartition()` must pass `knownCols` to all partition GETs |
| `h5py pip install fails` (exit code 2) | Missing system HDF5 libraries in Docker image | Add `libhdf5-dev pkg-config` to apt install in Dockerfile; use `--prefer-binary` flag for pip |
| EAI not applying after spec update | `ALTER SERVICE FROM SPECIFICATION` resets EAIs | Always run `ALTER SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS` separately after every spec change |

---

## Files in This Skill

```
scripts/
  00_aws_setup.sh         AWS S3 bucket + IAM user + access keys
  01_snowflake_setup.sql  Database, compute pool, secrets, EAIs, service functions
  03_deploy_services.sql  SPCS CREATE SERVICE specs + mandatory EAI application
  04_load_data.sql        ICECHUNK_SEED() trigger + verification queries

Project root (not in skill):
  build.sh                Docker buildx wrapper with --bump patch versioning
  VERSION                 Semver file (e.g. 1.0.5) updated by build.sh
  Dockerfile              Python FastAPI backend (icechunk-service)
  icechunk-accelerator/   React/Vite/Express frontend (icechunk-accelerator)
  app/                    Python FastAPI source (main.py, ingest.py, requirements.txt)
  service-spec.yaml       Backend SPCS spec (reference copy)
  icechunk-accelerator/accelerator-service-spec.yaml  Frontend SPCS spec
```

## Success Criteria

- `ICECHUNK_HEALTH()` returns `{"status": "ok"}`
- `ICECHUNK_META()` returns `variables` array with 9 entries and `lat_count: 1920`
- `ICECHUNK_SLICE('air_temperature', 49, 61, -8, 3, NULL)` row count > 1000
- App ingress URL loads, shows CARTO dark map with weather hexagons
- `⬡ H3` / `• Points` toggle visible in top-left panel

## Stopping Points

- ✋ Step 0: Copy AWS Secret Access Key before it disappears
- ✋ Step 1: Fill in actual AWS keys in the SQL before running
- ✋ Step 1: Compute pool must be IDLE before Step 3
- ✋ Step 3: Both services must be RUNNING before Step 4
