#!/usr/bin/env bash
# =============================================================================
# build.sh — Build and push IceChunk Accelerator Docker images with patch versioning
#
# Tags each image with BOTH the patch version (from VERSION file) AND :latest
#
# Usage:
#   bash build.sh [--service-only | --accel-only] [--bump patch|minor|major] [--deploy]
#
# Examples:
#   bash build.sh                               # build both with current VERSION
#   bash build.sh --bump patch                  # bump patch, then build both
#   bash build.sh --accel-only --bump patch     # bump patch, rebuild frontend only
#   bash build.sh --accel-only --bump patch --deploy  # build + deploy + print URL
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
# shellcheck disable=SC1091
source ./names.sh          # config.env -> ICECHUNK_CONNECTION, DB, SCHEMA, REPO_PATH ...

VERSION_FILE="${SCRIPT_DIR}/VERSION"
CONNECTION="$ICECHUNK_CONNECTION"
REPO_URL_OVERRIDE=""
BUILD_SERVICE=true
BUILD_ACCEL=true
BUMP=""
DEPLOY=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connection)   CONNECTION="$2"; shift 2 ;;
    --repo-url)     REPO_URL_OVERRIDE="$2"; shift 2 ;;
    --service-only) BUILD_ACCEL=false;   shift ;;
    --accel-only)   BUILD_SERVICE=false; shift ;;
    --bump)         BUMP="$2";           shift 2 ;;
    --deploy)       DEPLOY=true;         shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Optional version bump ────────────────────────────────────────────────────
if [[ -n "$BUMP" ]]; then
  CURRENT=$(cat "$VERSION_FILE" | tr -d '[:space:]')
  IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"
  case "$BUMP" in
    patch) PATCH=$((PATCH + 1)) ;;
    minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
    major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
    *) echo "Unknown bump type: $BUMP (use patch|minor|major)"; exit 1 ;;
  esac
  NEW_VERSION="${MAJOR}.${MINOR}.${PATCH}"
  echo "$NEW_VERSION" > "$VERSION_FILE"
  echo "Version bumped: $CURRENT → $NEW_VERSION"
fi

VERSION=$(cat "$VERSION_FILE" | tr -d '[:space:]')
echo "=== IceChunk Accelerator Build — v${VERSION} ==="
echo "  Connection: $CONNECTION"
echo "  DB / repo:  ${DB}.${SCHEMA}.ICECHUNK_REPO"
echo ""

# ── Login ────────────────────────────────────────────────────────────────────
echo ">>> Authenticating with Snowflake registry..."
snow spcs image-registry login --connection "$CONNECTION"
echo ""

# ── Resolve the prefixed image-repository URL from Snowflake ──────────────────
# repository_url is "<host>/<db_lower>/<schema_lower>/icechunk_repo" — exactly
# the prefixed path created by setup.sh. Derive it live so it's account-correct.
if [[ -n "$REPO_URL_OVERRIDE" ]]; then
  REPO_URL="$REPO_URL_OVERRIDE"
else
  REPO_URL="$(snow sql -c "$CONNECTION" --format json \
    -q "SHOW IMAGE REPOSITORIES IN SCHEMA ${DB}.${SCHEMA};" 2>/dev/null | python3 -c "
import sys, json
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
for r in rows:
    r = {k.lower(): v for k, v in r.items()}
    if str(r.get('name','')).upper() == 'ICECHUNK_REPO':
        print(r.get('repository_url',''))
        break
")"
fi
if [[ -z "${REPO_URL:-}" ]]; then
  echo "ERROR: could not resolve ICECHUNK_REPO url in ${DB}.${SCHEMA}." >&2
  echo "       Run 'bash setup.sh' first (it creates the image repository)." >&2
  exit 1
fi
echo "  Repo URL:   $REPO_URL"
echo ""

# ── Build helper: tags both :VERSION and :latest ──────────────────────────────
build_and_push() {
  local name="$1"
  local dockerfile="$2"
  local context="$3"
  local versioned_tag="${REPO_URL}/${name}:${VERSION}"
  local latest_tag="${REPO_URL}/${name}:latest"

  echo ">>> Building ${name}:${VERSION}"
  docker buildx build \
    --platform linux/amd64 \
    --push \
    -t "$versioned_tag" \
    -t "$latest_tag" \
    -f "$dockerfile" \
    "$context"
  echo ">>> Pushed: ${name}:${VERSION} + ${name}:latest"
  echo ""
}

# ── Builds ───────────────────────────────────────────────────────────────────
if $BUILD_SERVICE; then
  build_and_push "icechunk-service" \
    "${SCRIPT_DIR}/Dockerfile" \
    "${SCRIPT_DIR}"
fi

if $BUILD_ACCEL; then
  build_and_push "icechunk-accelerator" \
    "${SCRIPT_DIR}/icechunk-accelerator/Dockerfile" \
    "${SCRIPT_DIR}/icechunk-accelerator"
fi

echo "=== Done: v${VERSION} pushed ==="

# ── Optional deploy + URL print ──────────────────────────────────────────────
if [[ "$DEPLOY" == "true" ]]; then
  echo ""
  DEPLOY_FLAGS=""
  $BUILD_SERVICE || DEPLOY_FLAGS="$DEPLOY_FLAGS --accel-only"
  $BUILD_ACCEL   || DEPLOY_FLAGS="$DEPLOY_FLAGS --service-only"
  bash "${SCRIPT_DIR}/deploy.sh" --connection "$CONNECTION" --version "$VERSION" $DEPLOY_FLAGS
fi
