#!/usr/bin/env bash
# =============================================================================
# setup.sh — one-time Snowflake setup for the IceChunk weather accelerator.
# =============================================================================
# Renders the prefixed object template, creates the AWS secrets inline (values
# from config.env, never written to a rendered file), and runs the setup SQL.
# All objects are namespaced by DEPLOY_PREFIX so nothing collides on a shared
# Snowflake account.
#
# Run AFTER provision_aws.sh (which fills the AWS keys in config.env).
#
# Usage:  bash setup.sh
# Idempotent (IF NOT EXISTS / OR REPLACE throughout).
# =============================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
# shellcheck disable=SC1091
source ./names.sh

SCRIPTS=".cortex/skills/icechunk-accelerator/scripts"
OUT="sql/_rendered/01_snowflake_setup.sql"

if [[ "${AWS_ACCESS_KEY_ID:-}" == "TO_BE_FILLED_BY_provision_aws.sh" || -z "${AWS_ACCESS_KEY_ID:-}" \
   || "${AWS_SECRET_ACCESS_KEY:-}" == "TO_BE_FILLED_BY_provision_aws.sh" || -z "${AWS_SECRET_ACCESS_KEY:-}" ]]; then
  echo "ERROR: AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set in config.env." >&2
  echo "       Run 'bash provision_aws.sh' first (it fills them)." >&2
  exit 1
fi

echo "== Rendering templates for $DB =="
mkdir -p sql/_rendered
# Targeted-token renderer: replaces only the known ${NAME} tokens, so SQL
# dollar-quoting ($$ ... $$) and Python f-string braces are left untouched.
render() {
  python3 - "$1" "$2" <<'PY'
import os, sys
src, dst = sys.argv[1], sys.argv[2]
keys = ["DB","SCHEMA","WH","POOL","S3_EAI","ASDI_EAI","TILES_EAI","ROLE",
        "SVC_USER","S3_BUCKET","AWS_REGION","DEPLOY_PREFIX","REPO_PATH"]
t = open(src).read()
for k in keys:
    t = t.replace("${" + k + "}", os.environ[k])
import re
# fail if any known-shaped ${UPPER} token survived (typo guard)
leftover = sorted(set(re.findall(r"\$\{[A-Z_]+\}", t)))
assert not leftover, f"unresolved tokens in {dst}: {leftover}"
open(dst, "w").write(t)
print(f"  -> {dst}")
PY
}
render "${SCRIPTS}/01_snowflake_setup.sql.tmpl" "$OUT"
render "${SCRIPTS}/02_functions.sql.tmpl"       "sql/_rendered/02_functions.sql"
render "${SCRIPTS}/03_deploy_services.sql.tmpl" "sql/_rendered/03_deploy_services.sql"
render "${SCRIPTS}/05_create_agent.sql.tmpl"    "sql/_rendered/05_create_agent.sql"

echo "== 1. Database + schema =="
snow sql -c "$ICECHUNK_CONNECTION" -q \
  "USE ROLE SYSADMIN; CREATE DATABASE IF NOT EXISTS ${DB}; CREATE SCHEMA IF NOT EXISTS ${DB}.${SCHEMA};"

echo "== 2. AWS secrets (inline; values from config.env, not written to any file) =="
snow sql -c "$ICECHUNK_CONNECTION" -q "
USE ROLE SYSADMIN;
CREATE SECRET IF NOT EXISTS ${DB}.${SCHEMA}.AWS_ACCESS_KEY_ID
  TYPE = GENERIC_STRING SECRET_STRING = '${AWS_ACCESS_KEY_ID}';
CREATE SECRET IF NOT EXISTS ${DB}.${SCHEMA}.AWS_SECRET_ACCESS_KEY
  TYPE = GENERIC_STRING SECRET_STRING = '${AWS_SECRET_ACCESS_KEY}';
"

echo "== 3. Rendered setup (warehouse / repo / pool / network rules / EAIs / functions / grants) =="
snow sql -c "$ICECHUNK_CONNECTION" -f "$OUT"

cat <<EOF

== setup done for ${DB} ==
Next:
  snow spcs image-registry login -c ${ICECHUNK_CONNECTION}
  bash build.sh --bump patch       # build + push images to ${REPO_PATH}
  bash deploy.sh                   # deploy services + print app URL
EOF
