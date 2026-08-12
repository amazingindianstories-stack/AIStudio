"""Port of src/lib/media-grant.js — short-lived HMAC-signed single-object
read permission so an external provider can fetch stored media without a
session. See that file's header for the full "why not a cloud presigned
URL" reasoning; it applies here too since Railway has no equivalent of
Vercel's WIF-via-OIDC signBlob trick either. AUTH_SECRET-signed, so it must
use the exact same secret as apps/common/session_auth.py."""

import base64
import hashlib
import hmac
import re
import time

from django.conf import settings

GRANT_DENY = re.compile(r"^(settings|migrations)/", re.IGNORECASE)
DEFAULT_TTL_SECONDS = 15 * 60


def _sign(payload: str) -> str:
    digest = hmac.new(settings.AUTH_SECRET.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def sign_media_grant(key: str, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> str:
    if GRANT_DENY.match(key):
        raise ValueError(f"Refusing to grant access to a protected prefix: {key}")
    exp = int(time.time() * 1000) + ttl_seconds * 1000
    encoded_key = base64.urlsafe_b64encode(key.encode("utf-8")).decode("ascii").rstrip("=")
    payload = f"{encoded_key}.{exp}"
    return f"{payload}.{_sign(payload)}"


def verify_media_grant(token: str | None) -> str | None:
    if not token:
        return None
    parts = token.split(".")
    if len(parts) != 3:
        return None
    encoded_key, exp_raw, sig = parts

    expected = _sign(f"{encoded_key}.{exp_raw}")
    if not hmac.compare_digest(sig, expected):
        return None

    try:
        exp = int(exp_raw)
    except ValueError:
        return None
    if time.time() * 1000 > exp:
        return None

    try:
        padded = encoded_key + "=" * (-len(encoded_key) % 4)
        key = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None

    if not key or GRANT_DENY.match(key):
        return None
    return key


def app_origin() -> str:
    import os

    explicit = os.environ.get("PUBLIC_APP_URL") or os.environ.get("NEXT_PUBLIC_APP_URL")
    if explicit:
        return explicit.rstrip("/")
    railway_domain = os.environ.get("RAILWAY_PUBLIC_DOMAIN")
    if railway_domain:
        return f"https://{railway_domain.rstrip('/')}"
    raise RuntimeError(
        "No public origin is configured, so a reference clip cannot be given a URL "
        "the provider can fetch. Set PUBLIC_APP_URL (e.g. https://api.veevee.ai)."
    )


def media_grant_url(key: str, ttl_seconds: int | None = None) -> str:
    from urllib.parse import quote

    token = sign_media_grant(key, ttl_seconds) if ttl_seconds else sign_media_grant(key)
    return f"{app_origin()}/api/media-grant/?t={quote(token)}"
