#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy IceChunk SPCS services and print the live app URL.
#
# Reads all object names from config.env via names.sh, so every object is
# namespaced by DEPLOY_PREFIX (shared-account safe). Creates the services on
# first run and ALTERs them to the pinned image version on subsequent runs,
# re-applying EAIs (which ALTER FROM SPECIFICATION always drops).
#
# Usage:
#   bash deploy.sh                                # deploy both (reads VERSION)
#   bash deploy.sh --accel-only                   # frontend only
#   bash deploy.sh --service-only                 # backend only
#   bash deploy.sh --version 1.0.62               # pin both image tags
#   bash deploy.sh --accel-version 1.0.62
#   bash deploy.sh --service-version 1.0.62
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck disable=SC1091
source ./names.sh          # config.env -> ICECHUNK_CONNECTION, DB, SCHEMA, WH, POOL, EAIs, REPO_PATH, prefixed S3

CONNECTION="$ICECHUNK_CONNECTION"
DEPLOY_SERVICE=true
DEPLOY_ACCEL=true
ACCEL_VERSION=""
SERVICE_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connection)       CONNECTION="$2";       shift 2 ;;
    --service-only)     DEPLOY_ACCEL=false;    shift ;;
    --accel-only)       DEPLOY_SERVICE=false;  shift ;;
    --version)          ACCEL_VERSION="$2"; SERVICE_VERSION="$2"; shift 2 ;;
    --accel-version)    ACCEL_VERSION="$2";    shift 2 ;;
    --service-version)  SERVICE_VERSION="$2";  shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

CURRENT_VERSION=$(cat "${SCRIPT_DIR}/VERSION" 2>/dev/null | tr -d '[:space:]' || echo "latest")
[[ -z "$ACCEL_VERSION" ]]   && ACCEL_VERSION="$CURRENT_VERSION"
[[ -z "$SERVICE_VERSION" ]] && SERVICE_VERSION="latest"   # backend only rebuilt when Python changes

echo "=== IceChunk Deploy ==="
echo "  Connection:  $CONNECTION"
echo "  Database:    ${DB}.${SCHEMA}   pool: ${POOL}"
$DEPLOY_SERVICE && echo "  Backend:     icechunk-service:${SERVICE_VERSION}"
$DEPLOY_ACCEL   && echo "  Frontend:    icechunk-accelerator:${ACCEL_VERSION}"
echo ""

# ── Backend ────────────────────────────────────────────────────────────────────
if $DEPLOY_SERVICE; then
  echo ">>> Deploying ${DB}.${SCHEMA}.ICECHUNK_SERVICE:${SERVICE_VERSION}..."
  BACKEND_SPEC="spec:
  containers:
  - name: icechunk-service
    image: /${REPO_PATH}/icechunk-service:${SERVICE_VERSION}
    env:
      ICECHUNK_BUCKET: ${S3_BUCKET}
      ICECHUNK_PREFIX: ${DEPLOY_PREFIX}/met_office_global
      ICECHUNK_UK_PREFIX: ${DEPLOY_PREFIX}/met_office_uk_2km
      AWS_DEFAULT_REGION: ${AWS_REGION}
    secrets:
    - snowflakeSecret:
        objectName: ${DB}.${SCHEMA}.AWS_ACCESS_KEY_ID
      envVarName: AWS_ACCESS_KEY_ID
    - snowflakeSecret:
        objectName: ${DB}.${SCHEMA}.AWS_SECRET_ACCESS_KEY
      envVarName: AWS_SECRET_ACCESS_KEY
    readinessProbe:
      port: 8080
      path: /health
  endpoints:
  - name: http-endpoint
    port: 8080
    public: false"
  snow sql -c "$CONNECTION" -q "
CREATE SERVICE IF NOT EXISTS ${DB}.${SCHEMA}.ICECHUNK_SERVICE
  IN COMPUTE POOL ${POOL}
  FROM SPECIFICATION \$\$
${BACKEND_SPEC}
\$\$
  MIN_READY_INSTANCES = 1;
ALTER SERVICE ${DB}.${SCHEMA}.ICECHUNK_SERVICE FROM SPECIFICATION \$\$
${BACKEND_SPEC}
\$\$;"
  echo ">>> Re-applying backend EAIs..."
  snow sql -c "$CONNECTION" -q \
    "ALTER SERVICE ${DB}.${SCHEMA}.ICECHUNK_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (${S3_EAI}, ${ASDI_EAI});"
  echo ">>> Backend deployed."
  echo ""
fi

# ── Frontend ───────────────────────────────────────────────────────────────────
if $DEPLOY_ACCEL; then
  echo ">>> Deploying ${DB}.${SCHEMA}.ICECHUNK_ACCELERATOR_SERVICE:${ACCEL_VERSION}..."
  FRONTEND_SPEC="spec:
  containers:
  - name: icechunk-accelerator
    image: /${REPO_PATH}/icechunk-accelerator:${ACCEL_VERSION}
    env:
      ICECHUNK_SERVICE_URL: http://icechunk-service:8080
      SNOWFLAKE_DATABASE: ${DB}
      SNOWFLAKE_SCHEMA: ${SCHEMA}
      SNOWFLAKE_WAREHOUSE: ${WH}
    readinessProbe:
      port: 3001
      path: /healthz
  endpoints:
  - name: http-endpoint
    port: 3001
    public: true"
  snow sql -c "$CONNECTION" -q "
CREATE SERVICE IF NOT EXISTS ${DB}.${SCHEMA}.ICECHUNK_ACCELERATOR_SERVICE
  IN COMPUTE POOL ${POOL}
  FROM SPECIFICATION \$\$
${FRONTEND_SPEC}
\$\$
  MIN_READY_INSTANCES = 1;
ALTER SERVICE ${DB}.${SCHEMA}.ICECHUNK_ACCELERATOR_SERVICE FROM SPECIFICATION \$\$
${FRONTEND_SPEC}
\$\$;"
  echo ">>> Re-applying frontend EAI..."
  snow sql -c "$CONNECTION" -q \
    "ALTER SERVICE ${DB}.${SCHEMA}.ICECHUNK_ACCELERATOR_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (${TILES_EAI});"
  echo ">>> Frontend deployed."
  echo ""
fi

# ── Print live app URL ─────────────────────────────────────────────────────────
echo ">>> Fetching live app URL..."
APP_URL=$(snow sql -c "$CONNECTION" --format json \
  -q "SHOW ENDPOINTS IN SERVICE ${DB}.${SCHEMA}.ICECHUNK_ACCELERATOR_SERVICE;" \
  2>/dev/null | \
  python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    for row in data:
        url = row.get('ingress_url') or row.get('INGRESS_URL') or ''
        pub = str(row.get('is_public') or row.get('IS_PUBLIC') or '').upper()
        if url and pub in ('TRUE', 'Y', 'YES', '1'):
            print(url.strip())
            break
except Exception:
    pass
" 2>/dev/null || true)

echo ""
if [[ -n "$APP_URL" ]]; then
  echo "┌──────────────────────────────────────────────────────────────────────┐"
  printf "│  App URL: https://%-52s│\n" "$APP_URL"
  echo "└──────────────────────────────────────────────────────────────────────┘"
else
  snow sql -c "$CONNECTION" \
    -q "SHOW ENDPOINTS IN SERVICE ${DB}.${SCHEMA}.ICECHUNK_ACCELERATOR_SERVICE;"
fi
echo ""
echo "=== Deploy complete ==="
