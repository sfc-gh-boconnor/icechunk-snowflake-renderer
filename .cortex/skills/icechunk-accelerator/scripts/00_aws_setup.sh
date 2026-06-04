#!/usr/bin/env bash
# =============================================================================
# IceChunk Accelerator — AWS Setup  v1.1
# =============================================================================
# Creates the S3 bucket and IAM user that the SPCS icechunk-service needs to
# read and write the IceChunk Zarr store.
#
# Usage:
#   bash 00_aws_setup.sh \
#     --bucket    icechunk-ro \
#     --region    us-west-2 \
#     --user-name icechunk-spcs-user
#
# The script will prompt you for temporary AWS credentials obtained via Okta.
#
# Prerequisites:
#   - AWS CLI installed  (brew install awscli)
#   - Access to your company AWS account via Okta SSO
# =============================================================================
set -euo pipefail

BUCKET_NAME="icechunk-ro"
REGION="us-west-2"
USER_NAME="icechunk-spcs-user"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)    BUCKET_NAME="$2"; shift 2 ;;
    --region)    REGION="$2";      shift 2 ;;
    --user-name) USER_NAME="$2";   shift 2 ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# =============================================================================
# Prompt for AWS credentials
# =============================================================================
echo ""
echo "=== AWS Credentials ==="
echo ""
echo "This script needs AWS credentials with permissions to create S3 buckets"
echo "and IAM users. You can provide either:"
echo ""
echo "  Option A — Temporary credentials (recommended)"
echo "    If your organisation uses SSO (Okta, Azure AD, etc.) or AWS IAM Identity"
echo "    Center, log in to the AWS Console through your SSO portal, then:"
echo "      1. Click your account name (top-right) → 'Security credentials'"
echo "      2. Under 'AWS IAM Identity Center', click 'Create access key'"
echo "      OR: In AWS IAM Identity Center / Access Portal, open the account,"
echo "          click 'Access keys', and copy the three values shown."
echo "    Temp credentials have an Access Key starting with ASIA..."
echo "    and require a Session Token. They expire after 1–12 hours."
echo ""
echo "  Option B — Long-term credentials"
echo "    If you have a permanent IAM user, go to:"
echo "      AWS Console → IAM → Users → <your user> → Security credentials"
echo "      → Create access key"
echo "    Long-term keys start with AKIA... and have no Session Token."
echo ""
echo "  Option C — AWS CLI already configured"
echo "    If 'aws sts get-caller-identity' already works in your terminal,"
echo "    just press Enter for all three prompts to use your existing config."
echo ""

read -rp "AWS Access Key ID     (or Enter to use existing CLI config): " INPUT_ACCESS_KEY_ID

if [[ -n "${INPUT_ACCESS_KEY_ID}" ]]; then
  read -rsp "AWS Secret Access Key: " INPUT_SECRET_ACCESS_KEY
  echo ""
  read -rp "AWS Session Token     (press Enter if using long-term keys): " INPUT_SESSION_TOKEN
  echo ""

  export AWS_ACCESS_KEY_ID="${INPUT_ACCESS_KEY_ID}"
  export AWS_SECRET_ACCESS_KEY="${INPUT_SECRET_ACCESS_KEY}"
  [[ -n "${INPUT_SESSION_TOKEN}" ]] && export AWS_SESSION_TOKEN="${INPUT_SESSION_TOKEN}"
else
  echo "  Using existing AWS CLI configuration."
  echo ""
fi

AWS="aws"

# Verify the credentials work before proceeding
echo ">>> Verifying credentials..."
CALLER_IDENTITY=$($AWS sts get-caller-identity 2>&1) || {
  echo "ERROR: AWS credentials are invalid or expired."
  echo "  ${CALLER_IDENTITY}"
  exit 1
}
ACCOUNT_ID=$(echo "${CALLER_IDENTITY}" | python3 -c "import json,sys; print(json.load(sys.stdin)['Account'])")
echo "  Authenticated as account: ${ACCOUNT_ID}"
echo ""

# =============================================================================
# 1. Create S3 bucket
# =============================================================================
echo ">>> Creating S3 bucket s3://${BUCKET_NAME} in ${REGION}..."

if [[ "$REGION" == "us-east-1" ]]; then
  # us-east-1 uses a different create-bucket syntax (no LocationConstraint)
  $AWS s3api create-bucket \
    --bucket "${BUCKET_NAME}" \
    --region "${REGION}" 2>/dev/null || echo "  Bucket already exists — continuing"
else
  $AWS s3api create-bucket \
    --bucket "${BUCKET_NAME}" \
    --region "${REGION}" \
    --create-bucket-configuration LocationConstraint="${REGION}" 2>/dev/null \
    || echo "  Bucket already exists — continuing"
fi

# Block public access (the IceChunk store should not be publicly readable)
$AWS s3api put-public-access-block \
  --bucket "${BUCKET_NAME}" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,\
BlockPublicPolicy=true,RestrictPublicBuckets=true

echo "  Bucket ready: s3://${BUCKET_NAME}"
echo ""

# =============================================================================
# 2. Create IAM policy for S3 access
# =============================================================================
echo ">>> Creating IAM policy for s3://${BUCKET_NAME}..."

POLICY_NAME="icechunk-s3-policy"
# ACCOUNT_ID already set from credential verification above
POLICY_ARN="arn:aws:iam::${ACCOUNT_ID}:policy/${POLICY_NAME}"

# Policy grants full access to the IceChunk bucket only
POLICY_DOC=$(cat <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "IceChunkS3Access",
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:GetBucketLocation"
      ],
      "Resource": [
        "arn:aws:s3:::${BUCKET_NAME}",
        "arn:aws:s3:::${BUCKET_NAME}/*"
      ]
    }
  ]
}
EOF
)

# Create or get the policy
if $AWS iam get-policy --policy-arn "${POLICY_ARN}" &>/dev/null; then
  echo "  Policy already exists: ${POLICY_ARN}"
else
  $AWS iam create-policy \
    --policy-name "${POLICY_NAME}" \
    --policy-document "${POLICY_DOC}" \
    --description "Read/write access to IceChunk S3 store at s3://${BUCKET_NAME}" \
    > /dev/null
  echo "  Created policy: ${POLICY_ARN}"
fi
echo ""

# =============================================================================
# 3. Create IAM user
# =============================================================================
echo ">>> Creating IAM user ${USER_NAME}..."

if $AWS iam get-user --user-name "${USER_NAME}" &>/dev/null; then
  echo "  User already exists — skipping creation"
else
  $AWS iam create-user --user-name "${USER_NAME}" > /dev/null
  echo "  Created user: ${USER_NAME}"
fi

# Attach policy to user
$AWS iam attach-user-policy \
  --user-name "${USER_NAME}" \
  --policy-arn "${POLICY_ARN}"
echo "  Attached policy: ${POLICY_NAME}"
echo ""

# =============================================================================
# 4. Create access keys
# =============================================================================
echo ">>> Creating access keys for ${USER_NAME}..."
echo "    (permanent credentials — store these securely)"
echo ""

KEYS=$($AWS iam create-access-key --user-name "${USER_NAME}")

ACCESS_KEY_ID=$(echo "${KEYS}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['AccessKey']['AccessKeyId'])")
SECRET_KEY=$(echo "${KEYS}" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d['AccessKey']['SecretAccessKey'])")

echo "========================================================================="
echo "  ACCESS KEY ID:     ${ACCESS_KEY_ID}"
echo "  SECRET ACCESS KEY: ${SECRET_KEY}"
echo "========================================================================="
echo ""
echo "IMPORTANT: Copy these values now. The secret key is shown only once."
echo ""

# =============================================================================
# 5. Store in Snowflake secrets (optional — requires snow CLI)
# =============================================================================
echo ">>> To store these in Snowflake, run:"
echo ""
echo "  snow sql -c <CONNECTION> -q \\"
echo "    \"CREATE OR REPLACE SECRET ICECHUNK_DB.ICECHUNK.AWS_ACCESS_KEY_ID"
echo "       TYPE = GENERIC_STRING SECRET_STRING = '${ACCESS_KEY_ID}';\""
echo ""
echo "  snow sql -c <CONNECTION> -q \\"
echo "    \"CREATE OR REPLACE SECRET ICECHUNK_DB.ICECHUNK.AWS_SECRET_ACCESS_KEY"
echo "       TYPE = GENERIC_STRING SECRET_STRING = '${SECRET_KEY}';\""
echo ""

# =============================================================================
# 6. Verify bucket access
# =============================================================================
echo ">>> Verifying access to s3://${BUCKET_NAME}..."
if $AWS s3 ls "s3://${BUCKET_NAME}/" --region "${REGION}" > /dev/null 2>&1; then
  echo "  Access verified — bucket is readable"
else
  echo "  WARNING: Could not list bucket. Check permissions."
  echo "  The new IAM user credentials may take a few seconds to propagate."
fi

echo ""
echo "=== AWS setup complete ==="
echo ""
echo "Next steps:"
echo "  1. Store secrets in Snowflake (commands above)"
echo "  2. Run scripts/01_snowflake_setup.sql"
echo "  3. Run bash build.sh --bump patch"
echo "  4. Run scripts/03_deploy_services.sql"
