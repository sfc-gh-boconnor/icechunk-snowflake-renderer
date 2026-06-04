"""
icechunk_client.py — open/create Icechunk repositories on S3.

Two repos are supported:
  - Global 10km  (ICECHUNK_PREFIX, default met_office_global)
  - UK 2km       (ICECHUNK_UK_PREFIX, default met_office_uk_2km)
"""
import os
import icechunk
from icechunk.storage import s3_storage

BUCKET     = os.environ.get("ICECHUNK_BUCKET", "icechunk-ro")
PREFIX     = os.environ.get("ICECHUNK_PREFIX", "climate_repo")
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
