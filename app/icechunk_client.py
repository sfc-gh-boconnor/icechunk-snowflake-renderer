"""
icechunk_client.py — open/create Icechunk repositories on S3.

Bucket and prefixes come from the SPCS service spec (set by deploy.sh from
config.env). They are namespaced by DEPLOY_PREFIX so multiple deployments never
collide on shared storage, e.g.:
  ICECHUNK_BUCKET    = icechunk-ro
  ICECHUNK_PREFIX    = <deploy_prefix>/met_office_global   (Global 10km)
  ICECHUNK_UK_PREFIX = <deploy_prefix>/met_office_uk_2km   (UK 2km)

The defaults below are only a local-dev fallback; in SPCS the spec always
supplies these env vars.
"""
import os
import icechunk
from icechunk.storage import s3_storage

BUCKET     = os.environ.get("ICECHUNK_BUCKET", "icechunk-ro")
PREFIX     = os.environ.get("ICECHUNK_PREFIX", "met_office_global")
UK_PREFIX  = os.environ.get("ICECHUNK_UK_PREFIX", "met_office_uk_2km")
REGION     = os.environ.get("AWS_DEFAULT_REGION", "us-west-2")


def _storage(prefix: str) -> icechunk.Storage:
    """Build an S3 storage backend for the given prefix."""
    aws_key    = os.environ.get("AWS_ACCESS_KEY_ID")
    aws_secret = os.environ.get("AWS_SECRET_ACCESS_KEY")

    kwargs: dict = dict(bucket=BUCKET, prefix=prefix, region=REGION)

    if aws_key and aws_secret:
        kwargs["access_key_id"]     = aws_key
        kwargs["secret_access_key"] = aws_secret
    else:
        kwargs["from_env"] = True

    return s3_storage(**kwargs)


# ── Global 10km ───────────────────────────────────────────────────────────────

def open_or_create_repo() -> icechunk.Repository:
    """Return the global repo, creating it if it doesn't exist yet."""
    storage = _storage(PREFIX)
    try:
        return icechunk.Repository.open(storage=storage)
    except Exception:
        return icechunk.Repository.create(storage=storage)


def open_repo() -> icechunk.Repository:
    """Return the existing global repository (raises if not found)."""
    return icechunk.Repository.open(storage=_storage(PREFIX))


# ── UK 2km ────────────────────────────────────────────────────────────────────

def open_or_create_uk_repo() -> icechunk.Repository:
    """Return the UK 2km repo, creating it if it doesn't exist yet."""
    storage = _storage(UK_PREFIX)
    try:
        return icechunk.Repository.open(storage=storage)
    except Exception:
        return icechunk.Repository.create(storage=storage)


def open_uk_repo() -> icechunk.Repository:
    """Return the existing UK 2km repository (raises if not found)."""
    return icechunk.Repository.open(storage=_storage(UK_PREFIX))
