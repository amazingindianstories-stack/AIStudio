"""Port of src/lib/providers/omni.js — Gemini Omni Flash video via
Google's Interactions API. See that file's header for the full
probe-verified contract (2026-07-11): no `task`/`delivery` fields, exact
snake_case `mime_type`, `response_format.duration` as a protobuf-Duration
string, aspect ratio restricted to 16:9/9:16, video inlined as base64
under steps[].content rather than a model_output wrapper. Overrides public
docs and anything said elsewhere — re-probe with scripts/probe-omni.js
before trusting memory here.
"""

import base64
import json
import os
import re
from urllib.parse import urlparse

import requests

from ..omni_input import build_omni_input

OMNI_ASPECT_RATIOS = ("16:9", "9:16")


def _model_id() -> str:
    return os.environ.get("OMNI_MODEL", "gemini-omni-flash-preview")


def is_omni_model(model: str) -> bool:
    return bool(re.search(r"omni", model, re.IGNORECASE))


def assert_google_host(url: str) -> None:
    """Refuses to attach any credential to a host that isn't a Google API
    host — guards a video-download path against a malicious/rebound URI
    siphoning the API key or bearer token to an arbitrary host."""
    hostname = urlparse(url).hostname or ""
    if hostname != "googleapis.com" and not hostname.endswith(".googleapis.com"):
        raise ValueError(f"Refusing to attach Omni credentials to unexpected host: {hostname}")


def build_omni_endpoint(vertex: bool, project: str | None = None, location: str | None = None) -> str:
    if vertex:
        if not project:
            raise ValueError("Vertex Omni requires a GCP project id.")
        loc = location or "global"
        return f"https://aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{loc}/interactions"
    return "https://generativelanguage.googleapis.com/v1beta/interactions"


def build_omni_payload(input_parts: list, aspect_ratio: str, duration: int) -> dict:
    """Throws on an unsupported aspect ratio BEFORE any network call."""
    if aspect_ratio not in OMNI_ASPECT_RATIOS:
        raise ValueError(f'Gemini Omni Flash only supports 16:9/9:16 aspect ratios (got "{aspect_ratio}").')
    return {
        "model": _model_id(),
        "input": input_parts,
        "background": True,
        "response_format": {"type": "video", "aspect_ratio": aspect_ratio, "duration": f"{duration}s"},
    }


def map_omni_status(raw: str | None) -> str:
    """Maps every documented Interactions API status onto
    running|succeeded|failed; unknown values fall back to "running" so a
    not-yet-seen status doesn't fail a job outright."""
    if raw == "completed":
        return "succeeded"
    if raw == "in_progress":
        return "running"
    if raw in ("failed", "cancelled", "incomplete", "budget_exceeded", "requires_action"):
        return "failed"
    return "running"


def _omni_error_message(status: int, body: str) -> str:
    try:
        parsed = json.loads(body)
        return (parsed.get("error") or {}).get("message") or parsed.get("message") or f"Omni status error ({status})."
    except (ValueError, TypeError, AttributeError):
        return f"Omni status error ({status}): {body[:400]}" if body.strip() else f"Omni status error ({status})."


def terminal_omni_status_http_error(status: int, body: str) -> dict | None:
    """Task-scoped non-retryable 4xx responses are terminal provider answers."""
    # Authentication/authorization failures are deployment-wide faults and
    # must remain visible as poll errors instead of failing one task at a time.
    if status not in (400, 404, 409, 410, 422):
        return None
    message = _omni_error_message(status, body)
    return {
        "status": "failed",
        "error": message,
        "moderationBlocked": bool(re.search(r"input blocked|polic|safety|moderat|block", message, re.IGNORECASE)),
    }


def extract_omni_video(data: dict, omni_auth: dict | None = None) -> dict:
    """Extracts the finished video from a completed interaction. Returns
    {"base64", "mimeType"}."""
    for step in data.get("steps") or []:
        for part in step.get("content") or []:
            if part.get("type") == "video" and part.get("data"):
                return {"base64": part["data"], "mimeType": part.get("mime_type", "video/mp4")}

    uri = (data.get("output_video") or {}).get("uri")
    if uri:
        assert_google_host(uri)
        headers = {}
        if omni_auth and omni_auth.get("apiKey"):
            headers["x-goog-api-key"] = omni_auth["apiKey"]
        if omni_auth and omni_auth.get("bearerToken"):
            headers["Authorization"] = f"Bearer {omni_auth['bearerToken']}"
        res = requests.get(uri, headers=headers, timeout=60)
        if not res.ok:
            raise RuntimeError(f"Failed to download Omni video from uri ({res.status_code}).")
        return {
            "base64": base64.b64encode(res.content).decode(),
            "mimeType": res.headers.get("content-type", "video/mp4"),
        }

    raise RuntimeError("Omni completed but returned no video (no inline data or uri).")


def _resolve_vertex_auth() -> dict:
    import google.auth
    import google.auth.transport.requests

    project_id = os.environ.get("GOOGLE_CLOUD_PROJECT")
    try:
        credentials, discovered_project = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        project_id = project_id or discovered_project
        credentials.refresh(google.auth.transport.requests.Request())
        token = credentials.token
    except Exception:
        token = None
    if not project_id or not token:
        raise RuntimeError(
            "OMNI_USE_VERTEX=1 auth failed. Set GOOGLE_CLOUD_PROJECT and "
            "GOOGLE_APPLICATION_CREDENTIALS, or run `gcloud auth application-default login`."
        )
    return {"project": project_id, "token": token}


def create_omni_video_task(assembled: dict, aspect_ratio: str, duration: int) -> str:
    vertex = os.environ.get("OMNI_USE_VERTEX") == "1"
    parts = build_omni_input(assembled)
    payload = build_omni_payload(parts, aspect_ratio, duration)

    headers = {"Content-Type": "application/json"}
    if vertex:
        auth = _resolve_vertex_auth()
        endpoint = build_omni_endpoint(True, auth["project"])
        headers["Authorization"] = f"Bearer {auth['token']}"
    else:
        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GOOGLE_API_KEY is not set.")
        endpoint = build_omni_endpoint(False)
        headers["x-goog-api-key"] = api_key

    res = requests.post(endpoint, headers=headers, json=payload, timeout=120)
    if not res.ok:
        raise RuntimeError(f"Omni create error ({res.status_code}): {res.text[:400]}")
    data = res.json()
    task_id = data.get("id") or data.get("name")
    if not task_id:
        raise RuntimeError("Omni create returned no interaction id.")
    return task_id


def get_omni_video_status(task_id: str) -> dict:
    vertex = os.environ.get("OMNI_USE_VERTEX") == "1"
    headers = {}
    if vertex:
        auth = _resolve_vertex_auth()
        base = build_omni_endpoint(True, auth["project"])
        headers["Authorization"] = f"Bearer {auth['token']}"
        omni_auth = {"bearerToken": auth["token"]}
    else:
        api_key = os.environ.get("GOOGLE_API_KEY")
        if not api_key:
            raise RuntimeError("GOOGLE_API_KEY is not set.")
        base = build_omni_endpoint(False)
        headers["x-goog-api-key"] = api_key
        omni_auth = {"apiKey": api_key}

    res = requests.get(f"{base}/{task_id}", headers=headers, timeout=30)
    if not res.ok:
        terminal = terminal_omni_status_http_error(res.status_code, res.text)
        if terminal:
            return terminal
        raise RuntimeError(f"Omni status error ({res.status_code}): {res.text[:400]}")
    data = res.json()
    status = map_omni_status(data.get("status"))

    if status == "succeeded":
        video = extract_omni_video(data, omni_auth)
        return {"status": status, "videoBase64": video["base64"], "mimeType": video["mimeType"]}
    if status == "failed":
        message = (data.get("error") or {}).get("message") or f'Omni generation ended with status "{data.get("status")}".'
        return {
            "status": status,
            "error": message,
            "moderationBlocked": bool(re.search(r"polic|safety|moderat|block", message, re.IGNORECASE)),
        }
    return {"status": status}
