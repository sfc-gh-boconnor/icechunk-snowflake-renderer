"""
icechunk_client.py — open/create the Icechunk repository on S3
Uses icechunk v2.x API: credentials passed directly to s3_storage().
"""
import os
import icechunk
from icechunk.storage import s3_storage

BUCKET = os.environ.get("ICECHUNK_BUCKET", "icechunk-ro")
PREFIX = os.environ.get("ICECHUNK_PREFIX", "climate_repo")
REGION = os.environ.get("AWS_DEFAULT_REGION", "us-west-2")


def _storage() -> icechunk.Storage:
    """Build an S3 storage backend using permanent IAM user credentials."""
    aws_key    = os.environ.get("AWS_ACCESS_KEY_ID")
    aws_secret = os.environ.get("AWS_SECRET_ACCESS_KEY")

    kwargs: dict = dict(bucket=BUCKET, prefix=PREFIX, region=REGION)

    if aws_key and aws_secret:
        # Permanent IAM user credentials — no session token required
        kwargs["access_key_id"]    = aws_key
        kwargs["secret_access_key"] = aws_secret
    else:
        kwargs["from_env"] = True

    return s3_storage(**kwargs)


def open_or_create_repo() -> icechunk.Repository:
    """Return the repository, creating it if it doesn't exist yet."""
    storage = _storage()
    try:
        return icechunk.Repository.open(storage=storage)
    except Exception:
        return icechunk.Repository.create(storage=storage)


def open_repo() -> icechunk.Repository:
    """Return an existing repository (raises if not found)."""
    return icechunk.Repository.open(storage=_storage())
