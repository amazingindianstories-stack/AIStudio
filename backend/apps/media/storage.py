"""Port of src/lib/storage.js. Backend switch (S3 default / GCS) mirrors the
Next.js app exactly so both apps can point at the same bucket during the
strangler migration.

**GCS auth note (deviates from the TS file's assumptions):** the TS
`gcp-auth.js` signs via Workload Identity Federation using Vercel's built-in
OIDC token minting — that mechanism is Vercel-specific and has no Railway
equivalent. On this backend, GCS auth is whatever `google-cloud-storage`'s
default client resolves (`GOOGLE_APPLICATION_CREDENTIALS` service-account
JSON, or ADC) and `getSignedUrl`/V4 signing require an actual private key
(a JSON key file), not just ambient credentials. If GCS signing isn't
available in this environment, `sign_stored_ref` falls back to the
AUTH_SECRET-signed media grant (media_grant.py) exactly as the TS side
does when WIF signing has no key — so provider handoffs keep working
either way; only `get_signed_read_url`/`browser_media_url` (browser-facing,
session-gated) are affected, and *those* fall back to proxying the bytes.
"""

import io
import mimetypes
import os
import re
import time
import uuid
from urllib.parse import quote

import requests

from . import media_derivatives as md

MEDIA_BUCKET = "media"

PRESIGN_DENY = re.compile(r"^(settings|migrations)/", re.IGNORECASE)

SIGNED_URL_TTL_SECONDS = 15 * 60
SIGNED_BROWSER_URL_BUCKET_MS = int(os.environ.get("MEDIA_SIGNED_URL_BUCKET_HOURS", "6")) * 3600_000

_browser_url_cache: dict[str, dict] = {}
_known_objects: set[str] = set()
MAX_REMEMBERED_OBJECTS = 5000


def _get_bucket_name() -> str:
    return os.environ.get("GCP_MEDIA_BUCKET") or os.environ.get("GCS_BUCKET_NAME") or "aistudio-media-bucket"


def _legacy_bucket_name() -> str:
    return os.environ.get("AWS_S3_BUCKET_NAME") or "aistudio-media-bucket"


def primary_is_gcs() -> bool:
    return os.environ.get("MEDIA_BACKEND") == "gcs"


_s3_client = None
_gcs_client = None


def _s3():
    global _s3_client
    if _s3_client is None:
        import boto3

        _s3_client = boto3.client(
            "s3",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
            aws_access_key_id=os.environ.get("AWS_ACCESS_KEY_ID"),
            aws_secret_access_key=os.environ.get("AWS_SECRET_ACCESS_KEY"),
        )
    return _s3_client


def _gcs():
    global _gcs_client
    if _gcs_client is None:
        from google.cloud import storage as gcs_storage

        _gcs_client = gcs_storage.Client(project=os.environ.get("GCP_PROJECT_ID"))
    return _gcs_client


def _ext_to_mime(ext: str) -> str:
    e = ext.lower()
    if e in ("jpg", "jpeg"):
        return "image/jpeg"
    if e == "mp4":
        return "video/mp4"
    if e == "webm":
        return "video/webm"
    if e == "webp":
        return "image/webp"
    if e == "gif":
        return "image/gif"
    if e == "json":
        return "application/json"
    return f"image/{e or 'png'}"


def _encode_key(key: str) -> str:
    return "/".join(quote(part) for part in key.split("/"))


def media_key_from_ref(ref: str) -> str | None:
    if ref.startswith("/api/media/"):
        return ref[len("/api/media/") :]
    cdn = os.environ.get("GCP_MEDIA_CDN_URL", "").rstrip("/")
    if cdn and ref.startswith(f"{cdn}/"):
        from urllib.parse import unquote

        return unquote(ref[len(cdn) + 1 :])
    return None


def is_protected_media_key(key: str) -> bool:
    if PRESIGN_DENY.match(key):
        return True
    original = md.original_key_from_thumb(key)
    return bool(original and PRESIGN_DENY.match(original["key"]))


def get_media_redirect_url(key: str) -> str | None:
    if not primary_is_gcs():
        return None
    base = os.environ.get("GCP_MEDIA_CDN_URL", "").rstrip("/")
    return f"{base}/{_encode_key(key)}" if base else None


def _save_buffer(buffer: bytes, key: str, content_type: str, cache_control: str) -> None:
    if not primary_is_gcs():
        _s3().put_object(
            Bucket=_legacy_bucket_name(),
            Key=key,
            Body=buffer,
            ContentType=content_type,
            CacheControl=cache_control,
        )
        return
    blob = _gcs().bucket(_get_bucket_name()).blob(key)
    blob.cache_control = cache_control
    blob.upload_from_string(buffer, content_type=content_type)


def write_thumbnails(buffer: bytes, key: str) -> None:
    """Best-effort — a thumbnail that fails to render must never fail the
    upload whose result this is."""
    if not md.is_thumbnailable(key):
        return
    from PIL import Image

    try:
        for width in md.THUMB_LADDER:
            with Image.open(io.BytesIO(buffer)) as im:
                im = im.convert("RGB") if im.mode in ("P", "CMYK") else im
                if im.width > width:
                    height = round(im.height * (width / im.width))
                    im = im.resize((width, height), Image.LANCZOS)
                out = io.BytesIO()
                im.save(out, format="WEBP", quality=75)
                _save_buffer(
                    out.getvalue(),
                    md.thumb_key(key, width),
                    "image/webp",
                    "public, max-age=31536000, immutable",
                )
    except Exception as e:  # noqa: BLE001 — deliberately swallowed, see docstring
        print(f"writeThumbnails failed for {key}: {e}")


def upload_buffer(buffer: bytes, key: str, ext: str) -> str:
    _save_buffer(buffer, key, _ext_to_mime(ext), "public, max-age=31536000, immutable")
    write_thumbnails(buffer, key)
    return f"/api/media/{key}"


def write_private_buffer(buffer: bytes, key: str, content_type: str = "application/octet-stream") -> None:
    _save_buffer(buffer, key, content_type, "private, no-store")


def upload_base64(b64_data: str, key: str, ext: str) -> str:
    import base64

    return upload_buffer(base64.b64decode(b64_data), key, ext)


ALLOWED_DATA_URL_MIME_EXT = {"jpeg": "jpg", "jpg": "jpg", "png": "png", "webp": "webp", "gif": "gif"}

_DATA_URL_RE = re.compile(r"^data:image/([a-zA-Z0-9.+-]+);base64,(.*)$", re.DOTALL)


def split_data_url(data_url: str) -> tuple[str, str]:
    m = _DATA_URL_RE.match(data_url)
    subtype = m.group(1).lower() if m else None
    ext = ALLOWED_DATA_URL_MIME_EXT.get(subtype) if subtype else None
    if not m or not ext:
        raise ValueError("Unsupported image type. Use JPEG, PNG, WebP, or GIF.")
    return ext, m.group(2)


def upload_from_url(url: str, key: str, ext: str) -> str:
    res = requests.get(url, timeout=30)
    if not res.ok:
        raise RuntimeError(f"Failed to download media ({res.status_code})")
    return upload_buffer(res.content, key, ext)


def _is_not_found(exc: Exception) -> bool:
    code = getattr(exc, "response", {}).get("Error", {}).get("Code") if hasattr(exc, "response") else None
    return code in ("404", "NoSuchKey") or getattr(exc, "code", None) == 404


def read_stored_buffer(key: str) -> bytes:
    if not primary_is_gcs():
        obj = _s3().get_object(Bucket=_legacy_bucket_name(), Key=key)
        return obj["Body"].read()
    blob = _gcs().bucket(_get_bucket_name()).blob(key)
    return blob.download_as_bytes()


def read_as_base64(ref: str) -> tuple[str, str]:
    """Returns (mime_type, base64_data)."""
    import base64

    if ref.startswith("data:"):
        m = re.match(r"^data:([^;]+);base64,(.*)$", ref, re.DOTALL)
        if m:
            return m.group(1), m.group(2)
        return "image/png", ref

    key = media_key_from_ref(ref)
    if key:
        if not primary_is_gcs():
            obj = _s3().get_object(Bucket=_legacy_bucket_name(), Key=key)
            body = obj["Body"].read()
            return obj.get("ContentType") or _ext_to_mime(key.rsplit(".", 1)[-1]), base64.b64encode(body).decode()
        blob = _gcs().bucket(_get_bucket_name()).blob(key)
        body = blob.download_as_bytes()
        blob.reload()
        return blob.content_type or "image/png", base64.b64encode(body).decode()

    if ref.startswith("http"):
        res = requests.get(ref, timeout=30)
        if not res.ok:
            raise RuntimeError(f"Failed to read media ({res.status_code})")
        mime = res.headers.get("content-type") or "image/png"
        return mime, base64.b64encode(res.content).decode()

    raise ValueError(f"Unsupported media reference format: {ref}")


def delete_by_urls(urls: list[str]) -> None:
    for ref in urls:
        key = media_key_from_ref(ref)
        if not key:
            continue
        try:
            if primary_is_gcs():
                _gcs().bucket(_get_bucket_name()).blob(key).delete()
            else:
                _s3().delete_object(Bucket=_legacy_bucket_name(), Key=key)
        except Exception:
            pass


def check_storage_connectivity() -> str:
    if not primary_is_gcs():
        _s3().head_bucket(Bucket=_legacy_bucket_name())
        return f"S3 bucket {_legacy_bucket_name()}"
    bucket = _gcs().bucket(_get_bucket_name())
    if not bucket.exists():
        raise RuntimeError(f"GCS bucket {_get_bucket_name()} does not exist")
    return f"GCS bucket {_get_bucket_name()}"


def _sign_read_url(key: str, expires_in_seconds: int) -> str:
    if is_protected_media_key(key):
        raise ValueError(f"Refusing to sign a URL for a protected prefix: {key}")
    if primary_is_gcs():
        blob = _gcs().bucket(_get_bucket_name()).blob(key)
        return blob.generate_signed_url(version="v4", expiration=expires_in_seconds, method="GET")
    return _s3().generate_presigned_url(
        "get_object",
        Params={"Bucket": _legacy_bucket_name(), "Key": key},
        ExpiresIn=max(1, expires_in_seconds),
    )


def get_signed_read_url(key: str, ttl_seconds: int = SIGNED_URL_TTL_SECONDS) -> str:
    if is_protected_media_key(key):
        raise ValueError(f"Refusing to sign a URL for a protected prefix: {key}")
    cdn = get_media_redirect_url(key)
    if cdn:
        return cdn
    return _sign_read_url(key, ttl_seconds)


def browser_media_url(key: str) -> str | None:
    if is_protected_media_key(key):
        return None
    cdn = get_media_redirect_url(key)
    if cdn:
        return cdn

    now_ms = time.time() * 1000
    cached = _browser_url_cache.get(key)
    if cached and cached["until"] > now_ms:
        return cached["url"]

    bucket_start = int(now_ms // SIGNED_BROWSER_URL_BUCKET_MS) * SIGNED_BROWSER_URL_BUCKET_MS
    try:
        url = _sign_read_url(key, int(2 * SIGNED_BROWSER_URL_BUCKET_MS / 1000))
        _browser_url_cache[key] = {"url": url, "until": bucket_start + SIGNED_BROWSER_URL_BUCKET_MS}
        return url
    except Exception as e:  # noqa: BLE001 — caller falls back to proxying
        print(f"browserMediaUrl: falling back to proxying {key}: {e}")
        return None


BROWSER_URL_REDIRECT_MAX_AGE_S = int((SIGNED_BROWSER_URL_BUCKET_MS / 1000) * 0.75)


def sign_stored_ref(ref: str, ttl_seconds: int | None = None) -> str | None:
    key = media_key_from_ref(ref)
    if not key:
        return None
    try:
        return get_signed_read_url(key, ttl_seconds) if ttl_seconds else get_signed_read_url(key)
    except Exception as cloud_error:
        from . import media_grant

        try:
            return media_grant.media_grant_url(key, ttl_seconds)
        except Exception as grant_error:
            raise RuntimeError(f"{grant_error} (cloud signing also failed: {cloud_error})") from grant_error


def object_exists(key: str) -> bool:
    if key in _known_objects:
        return True
    try:
        if primary_is_gcs():
            found = _gcs().bucket(_get_bucket_name()).blob(key).exists()
        else:
            _s3().head_object(Bucket=_legacy_bucket_name(), Key=key)
            found = True
    except Exception as e:
        if _is_not_found(e):
            return False
        raise
    if found:
        if len(_known_objects) >= MAX_REMEMBERED_OBJECTS:
            _known_objects.clear()
        _known_objects.add(key)
    return found


class MediaNotFoundError(Exception):
    pass


class InvalidMediaRangeError(Exception):
    pass


_RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


def parse_range(range_header: str, size: int) -> tuple[int, int]:
    """Direct port of parseRange() in storage.js."""
    m = _RANGE_RE.match(range_header)
    if not m or (not m.group(1) and not m.group(2)) or size <= 0:
        raise InvalidMediaRangeError()
    if not m.group(1):
        suffix = int(m.group(2))
        if suffix <= 0:
            raise InvalidMediaRangeError()
        start = max(0, size - suffix)
        end = size - 1
    else:
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else size - 1
    if start < 0 or start >= size or end < start:
        raise InvalidMediaRangeError()
    return start, min(end, size - 1)


def open_media_object(key: str, range_header: str | None = None) -> dict:
    """Returns {body: bytes, content_type, content_length, content_range,
    status}. Unlike storage.js's streaming version, this reads the (ranged)
    slice into memory in one round trip — Django here runs under gunicorn's
    sync worker model, not a per-request serverless invocation with its own
    abort signal, so there is no direct analogue of the TS route's
    AbortSignal-propagation trick. `MEDIA_OPEN_TIMEOUT_MS` still bounds the
    upstream connect/read via the client's own socket timeout, which is the
    Railway-appropriate version of the same protection (a stuck upstream
    read ties up a worker rather than a whole invocation, but it still
    can't hang forever)."""
    timeout_s = int(os.environ.get("MEDIA_OPEN_TIMEOUT_MS", "15000")) / 1000

    if not primary_is_gcs():
        try:
            kwargs = {"Bucket": _legacy_bucket_name(), "Key": key}
            if range_header:
                kwargs["Range"] = range_header
            obj = _s3().get_object(**kwargs)
        except Exception as e:
            if _is_not_found(e):
                raise MediaNotFoundError() from e
            raise
        body = obj["Body"].read()
        content_range = obj.get("ContentRange")
        return {
            "body": body,
            "content_type": obj.get("ContentType") or "application/octet-stream",
            "content_length": len(body),
            "content_range": content_range,
            "status": 206 if range_header and content_range else 200,
        }

    blob = _gcs().bucket(_get_bucket_name()).blob(key)
    if not blob.exists():
        raise MediaNotFoundError()
    blob.reload(timeout=timeout_s)
    size = blob.size or 0
    parsed = parse_range(range_header, size) if range_header else None
    if parsed:
        body = blob.download_as_bytes(start=parsed[0], end=parsed[1], timeout=timeout_s)
        content_range = f"bytes {parsed[0]}-{parsed[1]}/{size}"
        status = 206
    else:
        body = blob.download_as_bytes(timeout=timeout_s)
        content_range = None
        status = 200
    return {
        "body": body,
        "content_type": blob.content_type or "application/octet-stream",
        "content_length": len(body),
        "content_range": content_range,
        "status": status,
    }


def save_thumbnail_object(buffer: bytes, original_key: str, width: int) -> None:
    """Persist one already-rendered ladder derivative. Used by the read path
    when it has to fill a gap the write path left."""
    _save_buffer(buffer, md.thumb_key(original_key, width), "image/webp", "public, max-age=31536000, immutable")


def render_thumbnail(key: str, width: int) -> bytes | None:
    """Fill a missing ladder derivative: read the original, resize, persist,
    return the bytes. None if it can't be rendered (caller then serves the
    original — a large image beats a broken one). Runs at most once per
    (object, width) since the caller only reaches here on a cache miss and
    the result is persisted."""
    from PIL import Image

    try:
        source = open_media_object(key)
        if not source["content_type"].startswith("image/"):
            return None
        with Image.open(io.BytesIO(source["body"])) as im:
            im = im.convert("RGB") if im.mode in ("P", "CMYK") else im
            if im.width > width:
                height = round(im.height * (width / im.width))
                im = im.resize((width, height), Image.LANCZOS)
            out = io.BytesIO()
            im.save(out, format="WEBP", quality=75)
            data = out.getvalue()
        save_thumbnail_object(data, key, width)
        return data
    except MediaNotFoundError:
        raise
    except Exception as e:  # noqa: BLE001 — a derivative miss must degrade, not 500
        print(f"renderThumbnail failed for {key} @{width}: {e}")
        return None
