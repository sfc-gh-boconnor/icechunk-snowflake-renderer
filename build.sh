#!/usr/bin/env bash
# =============================================================================
# build.sh — Build and push IceChunk Accelerator Docker images with patch versioning
#
# Tags each image with BOTH the patch version (from VERSION file) AND :latest
#
# Usage:
#   bash build.sh [--service-only | --accel-only] [--bump patch|minor|major]
#
# Examples:
#   bash build.sh                        # build both with current VERSION
#   bash build.sh --bump patch           # bump patch, then build both
#   bash build.sh --accel-only --bump patch  # bump patch, rebuild frontend only
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION_FILE="${SCRIPT_DIR}/VERSION"
CONNECTION="${SNOW_CONNECTION:-internal-marketplace}"
REGISTRY="sfsehol-internal-marketplace.registry.snowflakecomputing.com"
REPO="icechunk_db/icechunk/icechunk_repo"
BUILD_SERVICE=true
BUILD_ACCEL=true
BUMP=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --connection)   CONNECTION="$2"; shift 2 ;;
    --registry)     REGISTRY="$2";   shift 2 ;;
    --service-only) BUILD_ACCEL=false;   shift ;;
    --accel-only)   BUILD_SERVICE=false; shift ;;
    --bump)         BUMP="$2";           shift 2 ;;
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
echo "  Registry:   $REGISTRY/$REPO"
echo "  Connection: $CONNECTION"
echo ""

# ── Login ────────────────────────────────────────────────────────────────────
echo ">>> Authenticating with Snowflake registry..."
snow spcs image-registry login --connection "$CONNECTION"
echo ""

# ── Build helper: tags both :VERSION and :latest ──────────────────────────────
build_and_push() {
  local name="$1"
  local dockerfile="$2"
  local context="$3"
  local versioned_tag="${REGISTRY}/${REPO}/${name}:${VERSION}"
  local latest_tag="${REGISTRY}/${REPO}/${name}:latest"

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
