#!/usr/bin/env bash
# =============================================================================
# deploy.sh — Deploy IceChunk SPCS services and print the live app URL
#
# Runs ALTER SERVICE FROM SPECIFICATION with a pinned version tag, re-applies
# EAIs, then fetches SHOW ENDPOINTS and prints the current app URL.
#
# Usage:
#   bash deploy.sh                      # deploy both services (reads VERSION file)
#   bash deploy.sh --accel-only        # frontend only
#   bash deploy.sh --service-only      # backend only
#   bash deploy.sh --version 1.0.43    # override version (default: reads ./VERSION)
#
# The URL is always printed at the end regardless of which service was deployed.
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="${SCRIPT_DIR}/VERSION"
CONNECTION="${SNOW_CONNECTION:-internal-marketplace}"
REPO="icechunk_db/icechunk/icechunk_repo"
DEPLOY_SERVICE=true
DEPLOY_ACCEL=true
VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connection)   CONNECTION="$2"; shift 2 ;;
    --service-only) DEPLOY_ACCEL=false;   shift ;;
    --accel-only)   DEPLOY_SERVICE=false; shift ;;
    --version)      VERSION="$2";        shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

[[ -z "$VERSION" ]] && VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')

echo "=== IceChunk Deploy — v${VERSION} ==="
echo "  Connection: $CONNECTION"
echo ""

# ── Backend ────────────────────────────────────────────────────────────────────
if $DEPLOY_SERVICE; then
  echo ">>> Deploying icechunk-service:${VERSION}..."
  snow sql -c "$CONNECTION" -q "
ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE FROM SPECIFICATION \$\$
spec:
  containers:
  - name: icechunk-service
    image: /${REPO}/icechunk-service:${VERSION}
    env:
      ICECHUNK_BUCKET: icechunk-ro
      ICECHUNK_PREFIX: met_office_global
      AWS_DEFAULT_REGION: us-west-2
    secrets:
    - snowflakeSecret:
        objectName: ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID
      envVarName: AWS_ACCESS_KEY_ID
    - snowflakeSecret:
        objectName: ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY
      envVarName: AWS_SECRET_ACCESS_KEY
    readinessProbe:
      port: 8080
      path: /health
  endpoints:
  - name: http-endpoint
    port: 8080
    public: false
\$\$"
  echo ">>> Re-applying backend EAIs..."
  snow sql -c "$CONNECTION" -q \
    "ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (ICECHUNK_S3_EAI, MET_OFFICE_ASDI_EAI);"
  echo ">>> Backend deployed."
  echo ""
fi

# ── Frontend ───────────────────────────────────────────────────────────────────
if $DEPLOY_ACCEL; then
  echo ">>> Deploying icechunk-accelerator:${VERSION}..."
  snow sql -c "$CONNECTION" -q "
ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE FROM SPECIFICATION \$\$
spec:
  containers:
  - name: icechunk-accelerator
    image: /${REPO}/icechunk-accelerator:${VERSION}
    env:
      ICECHUNK_SERVICE_URL: http://icechunk-service:8080
    readinessProbe:
      port: 3001
      path: /healthz
  endpoints:
  - name: http-endpoint
    port: 3001
    public: true
\$\$"
  echo ">>> Re-applying frontend EAI..."
  snow sql -c "$CONNECTION" -q \
    "ALTER SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE SET EXTERNAL_ACCESS_INTEGRATIONS = (FLEET_INTEL_MAP_TILES_EAI);"
  echo ">>> Frontend deployed."
  echo ""
fi

# ── Print live app URL ─────────────────────────────────────────────────────────
echo ">>> Fetching live app URL..."
APP_URL=$(snow sql -c "$CONNECTION" --format json \
  -q "SHOW ENDPOINTS IN SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE;" \
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
  # Fallback: show raw table so URL is visible somewhere
  snow sql -c "$CONNECTION" \
    -q "SHOW ENDPOINTS IN SERVICE ICECHUNK_DB.ICECHUNK.ICECHUNK_ACCELERATOR_SERVICE;"
fi
echo ""
echo "=== Deploy complete: v${VERSION} ==="
