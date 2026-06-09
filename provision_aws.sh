#!/usr/bin/env bash
# =============================================================================
# IceChunk Weather — AWS provisioner (per-prefix isolation)
# =============================================================================
# Namespaces this deployment's S3 storage and gives it a dedicated IAM user
# scoped to its prefix only, so multiple deployers can share one bucket without
# ever touching each other's objects:
#   bucket:   s3://<S3_BUCKET>/<DEPLOY_PREFIX>/{met_office_global,met_office_uk_2km}/
#   IAM user: <DEPLOY_PREFIX>_icechunk_user   (read/write on <prefix>/* only)
#
# Weather uses pure IceChunk Zarr (no Iceberg external volume), so there is no
# IAM role / trust-policy step — just a user with an access key.
#
# AWS auth: uses your ambient AWS CLI credentials (env vars / SSO / profile).
# If ./secrets/credentials exists and no AWS creds are otherwise configured, it
# is used as the shared credentials file (its [default] profile).
#
# Usage:
#   bash provision_aws.sh        # bucket (if missing) + IAM user (+ access key)
#
# Idempotent: re-running skips objects that already exist and won't mint a 2nd key.
# =============================================================================
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

[[ -f ./config.env ]] || { echo "ERROR: config.env not found (cp config.env.example config.env)." >&2; exit 1; }
# shellcheck disable=SC1091
source ./config.env

: "${DEPLOY_PREFIX:?set in config.env}"
: "${S3_BUCKET:?set in config.env}"
: "${AWS_REGION:?set in config.env}"

if [[ ! "$DEPLOY_PREFIX" =~ ^[a-z0-9_]+$ ]]; then
  echo "ERROR: DEPLOY_PREFIX must match ^[a-z0-9_]+\$ (got '$DEPLOY_PREFIX')." >&2; exit 1
fi

command -v aws >/dev/null || { echo "ERROR: aws CLI not found." >&2; exit 1; }

# AWS auth for PROVISIONING uses admin creds — NOT config.env's AWS_ACCESS_KEY_ID
# (those are the OUTPUT: the per-prefix user's keys this script writes). Sourcing
# config.env above clobbered any ambient creds with a placeholder, so load real
# admin creds from ./secrets/credentials (export-style or INI). If absent, drop the
# placeholder so the CLI falls back to AWS_PROFILE / SSO.
if [[ -f ./secrets/credentials ]]; then
  if grep -q '^[[:space:]]*export[[:space:]]\+AWS_' ./secrets/credentials; then
    # shellcheck disable=SC1091
    set -a; source ./secrets/credentials; set +a
    echo "  sourced AWS admin creds from ./secrets/credentials"
  else
    export AWS_SHARED_CREDENTIALS_FILE="$PWD/secrets/credentials"
    echo "  using ./secrets/credentials (INI) for AWS auth"
  fi
elif [[ "${AWS_ACCESS_KEY_ID:-}" == TO_BE_FILLED* ]]; then
  unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
fi

USER_NAME="${DEPLOY_PREFIX}_icechunk_user"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || { echo "ERROR: AWS credentials not working (check secrets/credentials / SSO / env vars)." >&2; exit 1; }

echo "== Provisioning for prefix '${DEPLOY_PREFIX}' in AWS account ${ACCOUNT_ID} =="

echo "== 1. Bucket s3://${S3_BUCKET} (${AWS_REGION}) — created if missing =="
if aws s3api head-bucket --bucket "$S3_BUCKET" 2>/dev/null; then
  echo "  bucket already exists — reusing"
else
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" 2>&1 | grep -v -i 'already' || true
  else
    aws s3api create-bucket --bucket "$S3_BUCKET" --region "$AWS_REGION" \
      --create-bucket-configuration LocationConstraint="$AWS_REGION" 2>&1 | grep -v -i 'already' || true
  fi
fi
# best-effort (org SCP may deny) — buckets are private by default anyway
aws s3api put-public-access-block --bucket "$S3_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true >/dev/null 2>&1 \
  && echo "  public access blocked" || echo "  (public-access-block skipped — org SCP; non-fatal)"

echo "== 2. IAM user ${USER_NAME} =="
aws iam create-user --user-name "$USER_NAME" >/dev/null 2>&1 \
  && echo "  created" || echo "  already exists — reusing"

echo "== 3. User S3 policy (read/write s3://${S3_BUCKET}/${DEPLOY_PREFIX}/* only) =="
USER_POLICY="$(python3 - "$S3_BUCKET" "$DEPLOY_PREFIX" <<'PY'
import json, sys
b, p = sys.argv[1], sys.argv[2]
print(json.dumps({"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":["s3:ListBucket","s3:GetBucketLocation"],
   "Resource":f"arn:aws:s3:::{b}","Condition":{"StringLike":{"s3:prefix":[f"{p}/*"]}}},
  {"Effect":"Allow","Action":["s3:GetObject","s3:PutObject","s3:DeleteObject"],
   "Resource":f"arn:aws:s3:::{b}/{p}/*"}]}))
PY
)"
aws iam put-user-policy --user-name "$USER_NAME" \
  --policy-name icechunk-zarr-s3 --policy-document "$USER_POLICY" && echo "  applied"

echo "== 4. Access key for ${USER_NAME} (secret -> config.env, never printed) =="
if grep -qE '^AWS_ACCESS_KEY_ID="AKIA' config.env 2>/dev/null; then
  echo "  config.env already has a durable key — skipping (avoids IAM 2-key limit)"
else
  if aws iam create-access-key --user-name "$USER_NAME" --output json > /tmp/icechunk_ak.json 2>/tmp/icechunk_ak_err.txt; then
    python3 - <<'PY'
import json, re, pathlib
ak = json.load(open("/tmp/icechunk_ak.json"))["AccessKey"]
kid, sec = ak["AccessKeyId"], ak["SecretAccessKey"]
p = pathlib.Path("config.env"); t = p.read_text()
t = re.sub(r'AWS_ACCESS_KEY_ID="[^"]*"',     f'AWS_ACCESS_KEY_ID="{kid}"', t)
t = re.sub(r'AWS_SECRET_ACCESS_KEY="[^"]*"', f'AWS_SECRET_ACCESS_KEY="{sec}"', t)
p.write_text(t)
print(f"  wrote durable key {kid[:8]}... into config.env (secret not shown)")
PY
    shred -u /tmp/icechunk_ak.json 2>/dev/null || rm -f /tmp/icechunk_ak.json
  else
    echo "  !! create-access-key FAILED:"; cat /tmp/icechunk_ak_err.txt; rm -f /tmp/icechunk_ak_err.txt
    echo "  (does this AWS identity have iam:CreateAccessKey? you may need an admin profile)" >&2
  fi
fi

cat <<EOF

== AWS provisioning done ==
  IAM user: ${USER_NAME} (scoped to s3://${S3_BUCKET}/${DEPLOY_PREFIX}/*)
Next:
  bash setup.sh                 # prefixed Snowflake objects + AWS secrets + functions
  bash build.sh --bump patch    # build + push images
  bash deploy.sh                # deploy services + print app URL
EOF
