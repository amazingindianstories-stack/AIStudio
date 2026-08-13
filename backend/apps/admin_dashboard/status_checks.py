"""Port of src/lib/status-checks.js — Admin Status tab health checks.

Hard safety constraint (unchanged from the TS side): the Higgsfield check
may ONLY call load_token()/is_fresh() — it must never trigger a
refresh-token exchange. Refresh tokens are single-use and reuse revokes
the whole token family with no automated recovery.
"""

import os
import time

import requests
from django.db import connection

from apps.generation.providers import higgsfield_mcp as hf
from apps.media import storage

CHECK_TIMEOUT_MS = 5000

GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_MODEL = "gemini-3-pro-image"


def _check_gemini(timeout_s: float) -> dict:
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return {"status": "unknown", "detail": "GOOGLE_API_KEY not set"}
    res = requests.get(f"{GEMINI_API_ROOT}/models/{GEMINI_MODEL}", headers={"x-goog-api-key": api_key}, timeout=timeout_s)
    if res.ok:
        return {"status": "ok", "detail": "HTTP 200"}
    return {"status": "error", "detail": f"HTTP {res.status_code}"}


def _check_higgsfield(_timeout_s: float) -> dict:
    try:
        t = hf.load_token()  # reads storage backend/env/file; NEVER refreshes
        if hf.is_fresh(t):
            return {"status": "ok", "detail": "Cached access token fresh"}
        return {"status": "unknown", "detail": "Token present but access token not fresh — refresh not triggered"}
    except Exception:
        return {"status": "unknown", "detail": "No Higgsfield token found (storage backend/env/local file)"}


def check_seedance(_timeout_s: float = 0) -> dict:
    if os.environ.get("ARK_API_KEY"):
        return {"status": "ok", "detail": "ARK_API_KEY set (config-presence only)"}
    return {"status": "unknown", "detail": "ARK_API_KEY not set"}


def check_kling(_timeout_s: float = 0) -> dict:
    """Config-presence only, like its neighbours — deliberately offline so
    opening the Status tab can never cost money. Kling does have a free
    read-only endpoint that would prove the key live; use
    scripts/probe-kling-image.js to verify for real."""
    if os.environ.get("KLING_API"):
        return {"status": "ok", "detail": "KLING_API set (config-presence only)"}
    return {"status": "unknown", "detail": "KLING_API not set"}


def check_omni(_timeout_s: float = 0) -> dict:
    if os.environ.get("OMNI_USE_VERTEX") == "1":
        if os.environ.get("GOOGLE_CLOUD_PROJECT"):
            return {"status": "ok", "detail": "Vertex configured (config-presence only)"}
        return {"status": "unknown", "detail": "OMNI_USE_VERTEX=1 but GOOGLE_CLOUD_PROJECT not set"}
    if os.environ.get("GOOGLE_API_KEY"):
        return {"status": "ok", "detail": "generativelanguage configured (config-presence only)"}
    return {"status": "unknown", "detail": "GOOGLE_API_KEY not set"}


def _check_postgres(_timeout_s: float) -> dict:
    with connection.cursor() as c:
        c.execute("SELECT 1")
    return {"status": "ok", "detail": "select 1 ok"}


def _check_storage(_timeout_s: float) -> dict:
    detail = storage.check_storage_connectivity()
    return {"status": "ok", "detail": f"{detail} reachable"}


def _check_media_delivery(_timeout_s: float) -> dict:
    """The one thing about the media path that cannot be established from
    config alone: signing runs through IAM signBlob using WIF credentials
    that only exist inside a production deploy. When it fails the route
    silently falls back to proxying bytes — exactly the state that
    produced the 2026-08-04 timeout alert — so it needs to be visible
    rather than inferred from a latency graph."""
    probe_key = "healthcheck/media-delivery-probe"
    cdn = storage.get_media_redirect_url(probe_key)
    if cdn:
        return {"status": "ok", "detail": f"Public CDN — {os.environ.get('GCP_MEDIA_CDN_URL', 'GCP_MEDIA_CDN_URL')}"}
    try:
        storage.get_signed_read_url(probe_key, 60)
        detail = (
            f"GCS V4 via IAM signBlob ({os.environ.get('GCP_SERVICE_ACCOUNT_EMAIL', 'runtime SA')})"
            if storage.primary_is_gcs()
            else f"S3 presigned ({os.environ.get('AWS_S3_BUCKET_NAME', 'bucket')})"
        )
        return {"status": "ok", "detail": f"Signed URLs — {detail}"}
    except Exception as e:
        return {"status": "error", "detail": f"Proxying bytes through the function — {e}"}


CHECKS = [
    {"id": "gemini", "name": "Gemini / Nano Banana Pro", "fn": _check_gemini},
    {"id": "higgsfield", "name": "Higgsfield MCP", "fn": _check_higgsfield},
    {"id": "seedance", "name": "BytePlus ModelArk / Seedance", "fn": check_seedance},
    {"id": "kling", "name": "KlingAI Image", "fn": check_kling},
    {"id": "omni", "name": "Gemini Omni Flash", "fn": check_omni},
    {"id": "postgres", "name": "Postgres", "fn": _check_postgres},
    {"id": "storage", "name": "Media Storage", "fn": _check_storage},
    {"id": "media-delivery", "name": "Media Delivery", "fn": _check_media_delivery},
]


def run_check(check_def: dict, timeout_ms: int = CHECK_TIMEOUT_MS) -> dict:
    """Wrap one check: measure latency, enforce the timeout, never raise."""
    start = time.time() * 1000
    try:
        outcome = check_def["fn"](timeout_ms / 1000)
        return {
            **outcome, "id": check_def["id"], "name": check_def["name"],
            "latencyMs": int(time.time() * 1000 - start), "checkedAt": int(time.time() * 1000),
        }
    except requests.Timeout:
        return {
            "id": check_def["id"], "name": check_def["name"], "status": "error",
            "detail": f"Timed out after {timeout_ms}ms", "latencyMs": int(time.time() * 1000 - start),
            "checkedAt": int(time.time() * 1000),
        }
    except Exception as e:
        return {
            "id": check_def["id"], "name": check_def["name"], "status": "error", "detail": str(e),
            "latencyMs": int(time.time() * 1000 - start), "checkedAt": int(time.time() * 1000),
        }


def run_all_checks(checks: list[dict] | None = None, timeout_ms: int = CHECK_TIMEOUT_MS) -> dict:
    """Runs every check IN PARALLEL (thread pool — these are blocking
    HTTP/DB calls, not async) and assembles the response."""
    import concurrent.futures

    checks = checks if checks is not None else CHECKS
    checked_at = int(time.time() * 1000)

    # A generous outer bound on top of each check's own inner timeout — the
    # inner one covers the HTTP/DB call itself, this one is the caller-side
    # backstop matching the TS Promise.race behavior (the underlying thread
    # can't be aborted the way JS's AbortController can, but the caller
    # still gets a bounded response either way).
    outer_timeout_s = (timeout_ms / 1000) + 2

    with concurrent.futures.ThreadPoolExecutor(max_workers=len(checks)) as executor:
        futures = [executor.submit(run_check, d, timeout_ms) for d in checks]
        results = []
        for i, f in enumerate(futures):
            try:
                results.append(f.result(timeout=outer_timeout_s))
            except Exception:
                results.append({
                    "id": checks[i]["id"], "name": checks[i]["name"], "status": "error",
                    "detail": "internal check error", "latencyMs": 0, "checkedAt": int(time.time() * 1000),
                })

    return {"checkedAt": checked_at, "checks": results}
