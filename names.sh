#!/usr/bin/env bash
# =============================================================================
# names.sh — derive prefixed object names from config.env.
# Source this AFTER cd-ing to the project root:  source ./names.sh
# Every deploy script uses this so the names never drift.
# =============================================================================
[[ -f ./config.env ]] || { echo "ERROR: config.env not found (cp config.env.example config.env)." >&2; exit 1; }
# shellcheck disable=SC1091
source ./config.env

: "${DEPLOY_PREFIX:?set in config.env}"
: "${S3_BUCKET:?set in config.env}"
: "${AWS_REGION:?set in config.env}"
: "${ICECHUNK_CONNECTION:?set in config.env}"

if [[ ! "$DEPLOY_PREFIX" =~ ^[a-z0-9_]+$ ]]; then
  echo "ERROR: DEPLOY_PREFIX must match ^[a-z0-9_]+\$ (got '$DEPLOY_PREFIX')." >&2; exit 1
fi

OBJ="$(printf '%s' "$DEPLOY_PREFIX" | tr '[:lower:]' '[:upper:]')"
SCHEMA="ICECHUNK"
DB="ICECHUNK_DB_${OBJ}"
WH="ICECHUNK_WH_${OBJ}"
POOL="ICECHUNK_POOL_${OBJ}"
S3_EAI="ICECHUNK_S3_EAI_${OBJ}"
ASDI_EAI="MET_OFFICE_ASDI_EAI_${OBJ}"
TILES_EAI="FLEET_INTEL_MAP_TILES_EAI_${OBJ}"
ROLE="ICECHUNK_ROLE_${OBJ}"
SVC_USER="ICECHUNK_${OBJ}"
DB_LOWER="$(printf '%s' "$DB" | tr '[:upper:]' '[:lower:]')"
REPO_PATH="${DB_LOWER}/icechunk/icechunk_repo"

export DEPLOY_PREFIX S3_BUCKET AWS_REGION ICECHUNK_CONNECTION \
       OBJ SCHEMA DB WH POOL S3_EAI ASDI_EAI TILES_EAI ROLE SVC_USER \
       DB_LOWER REPO_PATH AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
