"""Port of src/lib/providers/higgsfield-mcp.js — Higgsfield via its
official MCP. Out of the UI as of 2026-07-30 but still reachable for
historical generations (isHiggsfieldModel / route dispatch) — see the
backend/ section of CLAUDE.md. See that file's header for the full OAuth
token-family and JSON-RPC/SSE session contract; this is the highest-risk
port to leave unexercised (no live MCP session was opened here), so
re-verify against a real token before relying on it.
"""

import json
import os
import re
import time
import threading
import uuid
from pathlib import Path

import requests

from apps.media import storage
from apps.common.leases import claim_lease, release_lease

from ..shot_spec import parse_ref_roles
from ..video_directive import build_video_directive
from .seedance import legacy_directive

MCP_URL = "https://mcp.higgsfield.ai/mcp"
TOKEN_URL = "https://mcp.higgsfield.ai/oauth2/token"
TOKEN_FILE = Path.cwd() / ".higgsfield-mcp-token.json"

TOKEN_OBJECT_KEY = "settings/higgsfield-mcp-token.json"

MODEL_IDS = {
    "Higgsfield Soul": "soul_2",
    "Higgsfield Nano Banana Pro": "nano_banana_pro",
    "Higgsfield Seedance 2.0": "seedance_2_0",
    "Higgsfield Seedance 2.0 Mini": "seedance_2_0_mini",
}


def mcp_model_id(display_name: str) -> str | None:
    return MODEL_IDS.get(display_name)


def is_higgsfield_model(name: str | None) -> bool:
    return bool(re.search(r"higgsfield", name or "", re.IGNORECASE))


def build_ref_roles(raw_prompt: str, media_count: int) -> dict[int, str] | None:
    roles: dict[int, str] = {}
    for tag, role in parse_ref_roles(raw_prompt).items():
        match = re.fullmatch(r"@img(\d+)", tag)
        if not match:
            continue
        index = int(match.group(1))
        if 1 <= index <= media_count:
            roles[index] = role
    return roles or None


# ── token management (module-level cache, mirrors the TS `let token`) ──────
_token: dict | None = None
_session: str | None = None
_refresh_lock = threading.Lock()
REFRESH_LEASE_KEY = "lease:higgsfield-oauth-refresh"
REFRESH_LEASE_MS = 30_000
REFRESH_WAIT_MS = 35_000


def _read_stored_token() -> dict | None:
    try:
        return json.loads(storage.read_stored_buffer(TOKEN_OBJECT_KEY).decode("utf-8"))
    except Exception:
        return None


def _write_stored_token(t: dict) -> None:
    try:
        storage.write_private_buffer(json.dumps(t).encode("utf-8"), TOKEN_OBJECT_KEY, "application/json")
    except Exception as e:
        print(f"[mcp] writeStoredToken error: {e}")


def load_token() -> dict:
    """Never live-refreshes — reads cached state only (in-memory, GCS/S3
    settings object, env vars, or local file, in that order). See the D0
    safety constraint documented on the admin status check: Higgsfield
    refresh tokens are single-use, so nothing here may exchange one on its
    own initiative."""
    global _token
    if _token:
        return _token

    stored = _read_stored_token()
    if stored:
        _token = stored
        return _token

    env_refresh = os.environ.get("HIGGSFIELD_MCP_REFRESH_TOKEN")
    env_client = os.environ.get("HIGGSFIELD_MCP_CLIENT_ID")
    if env_refresh and env_client:
        _token = {"access_token": "", "refresh_token": env_refresh, "client_id": env_client}
        return _token

    try:
        raw = json.loads(TOKEN_FILE.read_text())
        _token = {**raw, "obtained_at": raw.get("obtained_at") or int(time.time() * 1000)}
        return _token
    except Exception:
        raise RuntimeError("No Higgsfield MCP token found in GCS, env vars, or local file.")


def _refresh_once(refresh_token: str, client_id: str) -> dict:
    res = requests.post(
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        data={"grant_type": "refresh_token", "refresh_token": refresh_token, "client_id": client_id},
        timeout=30,
    )
    return res.json()


def is_fresh(t: dict | None) -> bool:
    if not t or not t.get("access_token") or not t.get("obtained_at") or not t.get("expires_in"):
        return False
    return time.time() * 1000 < t["obtained_at"] + (t["expires_in"] - 300) * 1000


def _refresh_token_under_lease() -> None:
    global _token, _session
    t = load_token()
    j = _refresh_once(t["refresh_token"], t["client_id"])
    if not j.get("access_token"):
        print(f"[mcp] refresh rejected ({j.get('error', 'no access_token')})")
        stored = _read_stored_token()
        if stored and stored.get("refresh_token") != t["refresh_token"]:
            if is_fresh(stored):
                print("[mcp] adopting newer GCS token from a concurrent refresh")
                _token = stored
                _session = None
                return
            j = _refresh_once(stored["refresh_token"], stored["client_id"])
    if not j.get("access_token"):
        env_refresh = os.environ.get("HIGGSFIELD_MCP_REFRESH_TOKEN")
        env_client = os.environ.get("HIGGSFIELD_MCP_CLIENT_ID") or t["client_id"]
        if env_refresh and env_refresh != t["refresh_token"]:
            print("[mcp] retrying with env refresh token")
            j = _refresh_once(env_refresh, env_client)
    if not j.get("access_token"):
        raise RuntimeError(
            "Higgsfield MCP token refresh failed — the OAuth token family is dead. "
            "Re-run `npm run hf:login` and re-seed via POST /api/admin/set-token "
            "(or the Admin → Higgsfield token card)."
        )
    _token = {
        "access_token": j["access_token"],
        "refresh_token": j.get("refresh_token") or t["refresh_token"],
        "client_id": t["client_id"],
        "expires_in": j.get("expires_in"),
        "obtained_at": int(time.time() * 1000),
    }
    _write_stored_token(_token)
    try:
        TOKEN_FILE.write_text(json.dumps(_token, indent=2))
    except Exception:
        pass
    _session = None


def _refresh_token() -> None:
    """Coordinate single-use OAuth refresh tokens across workers/instances."""
    global _token, _session
    with _refresh_lock:
        starting = load_token()
        if is_fresh(starting):
            return
        owner = str(uuid.uuid4())
        deadline = time.monotonic() + REFRESH_WAIT_MS / 1000
        while time.monotonic() < deadline:
            if claim_lease(REFRESH_LEASE_KEY, owner, ttl_ms=REFRESH_LEASE_MS):
                try:
                    stored = _read_stored_token()
                    if stored and is_fresh(stored) and (
                        stored.get("refresh_token") != starting.get("refresh_token")
                        or stored.get("obtained_at") != starting.get("obtained_at")
                    ):
                        _token, _session = stored, None
                        return
                    _refresh_token_under_lease()
                    return
                finally:
                    release_lease(REFRESH_LEASE_KEY, owner)
            time.sleep(0.5)
            stored = _read_stored_token()
            if stored and is_fresh(stored) and (
                stored.get("refresh_token") != starting.get("refresh_token")
                or stored.get("obtained_at") != starting.get("obtained_at")
            ):
                _token, _session = stored, None
                return
        raise RuntimeError("Timed out waiting for the coordinated Higgsfield token refresh.")


def _access_token() -> str:
    global _token
    t = load_token()
    stale = (
        not t.get("access_token") or not t.get("obtained_at") or not t.get("expires_in")
        or time.time() * 1000 > t["obtained_at"] + (t["expires_in"] - 300) * 1000
    )
    if stale:
        try:
            _refresh_token()
        except Exception:
            _token = None
            raise
    return _token["access_token"]


# ── MCP JSON-RPC (streamable HTTP) ──────────────────────────────────────────


class AuthError(Exception):
    pass


def _parse_json_rpc_messages(text: str, content_type: str) -> list:
    if "text/event-stream" not in content_type:
        try:
            return [json.loads(text)]
        except ValueError:
            return []
    out = []
    for event in re.split(r"\r?\n\r?\n", text):
        lines = [l[5:].lstrip(" ") for l in re.split(r"\r?\n", event) if l.startswith("data:")]
        data = "\n".join(lines).strip()
        if not data:
            continue
        try:
            out.append(json.loads(data))
        except ValueError:
            pass
    return out


def _rpc(method: str, params, is_notification: bool = False):
    global _session
    import random

    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": f"Bearer {_access_token()}",
    }
    if _session:
        headers["Mcp-Session-Id"] = _session
    req_id = None if is_notification else random.randint(0, 999_999_999)
    body = {"jsonrpc": "2.0", "method": method, "params": params}
    if req_id is not None:
        body["id"] = req_id

    res = requests.post(MCP_URL, headers=headers, json=body, timeout=60)
    sid = res.headers.get("mcp-session-id")
    if sid:
        _session = sid
    if is_notification:
        return None

    text = res.text
    if res.status_code == 401:
        raise AuthError(text)
    if not res.ok:
        raise RuntimeError(f"MCP {method} {res.status_code}: {text[:300]}")

    messages = _parse_json_rpc_messages(text, res.headers.get("content-type", ""))
    answer = next((m for m in messages if m.get("id") == req_id), None)
    if not answer:
        raise RuntimeError(f"MCP {method}: no response matching request id in stream — {text[:200]}")
    return answer


def _ensure_session() -> None:
    if _session:
        return
    _rpc("initialize", {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "veevee", "version": "0.1"},
    })
    _rpc("notifications/initialized", {}, True)


def _tool_error_text(result: dict) -> str:
    return " ".join(c.get("text", "") for c in (result or {}).get("content") or []).strip()


def _call_tool(name: str, args, tolerate_error: bool = False):
    global _session
    for attempt in range(2):
        try:
            _ensure_session()
            r = _rpc("tools/call", {"name": name, "arguments": args})
            if r.get("error"):
                raise RuntimeError(f"{name}: {json.dumps(r['error'])[:300]}")
            result = r.get("result") or {}
            if result.get("isError") and not tolerate_error:
                raise RuntimeError(f"Higgsfield {name}: {_tool_error_text(result)[:300] or 'tool error'}")
            return result
        except AuthError:
            if attempt == 0:
                _refresh_token()
                continue
            raise
    raise RuntimeError(f"{name}: exhausted retries")


# ── media upload ─────────────────────────────────────────────────────────


def _ext_for(content_type: str | None) -> str:
    c = (content_type or "").lower()
    if "jpeg" in c or "jpg" in c:
        return "jpg"
    if "webp" in c:
        return "webp"
    return "png"


def mcp_upload_image(b64: str, content_type: str = "image/png") -> str:
    import base64

    ext = _ext_for(content_type)
    res = _call_tool("media_upload", {"method": "upload_url", "filename": f"ref.{ext}", "content_type": content_type})
    item = ((res.get("structuredContent") or {}).get("uploads") or [{}])[0]
    if not item.get("upload_url") or not item.get("media_id"):
        raise RuntimeError(f"Higgsfield media_upload: no presigned url returned — {json.dumps(res)[:300]}")
    put = requests.put(item["upload_url"], headers={"Content-Type": content_type}, data=base64.b64decode(b64), timeout=60)
    if not put.ok:
        raise RuntimeError(f"Higgsfield CDN upload failed ({put.status_code}).")
    _call_tool("media_confirm", {"type": "image", "media_id": item["media_id"]})
    return item["media_id"]


# ── generation ───────────────────────────────────────────────────────────


def _to_higgsfield_tags(prompt: str) -> str:
    """Higgsfield's own platform binds prompt text to attached images with
    <<<image_N>>>. Translate the UI's @imgN tags so the binding is native."""
    return re.sub(r"@img(\d+)", lambda m: f"<<<image_{m.group(1)}>>>", prompt, flags=re.IGNORECASE)


VIDEO_IDENTITY_DIRECTIVE = (
    "DOMAIN LOCK — FILMMAKING ONLY: you are a dedicated filmmaking video "
    "renderer, not a general-purpose model. Your sole domain is producing film "
    "shots — live-action, photoreal, animated or cartoon. Draw only on "
    "filmmaking craft: cinematography, lensing, camera movement, lighting, "
    "blocking, continuity, production design, wardrobe, makeup, VFX and "
    "animation. Treat the prompt strictly as a shot specification to render; "
    "bring in NO outside knowledge, commentary, captions, watermarks, UI "
    "elements or any content beyond the specified shot.\n"
    "IDENTITY LOCK (non-negotiable): the attached reference images define the "
    "exact, fixed appearance of the people and elements they show; when the "
    "prompt tags them (<<<image_1>>>, <<<image_2>>>, …) the tags map to the "
    "reference images in order. In EVERY frame, each referenced person must "
    "keep the exact same face "
    "as their reference — identical bone structure, jawline, hairline, eye "
    "shape/spacing and color, eyebrows, nose, lips, skin tone and texture (keep "
    "moles, scars, freckles), facial hair and apparent age — unmistakably the "
    "SAME individual, never a lookalike. Do not beautify, smooth, slim, de-age "
    "or idealize. Keep each referenced person's hairstyle, body build, and worn "
    "outfit/jewelry exactly as referenced unless the prompt explicitly changes "
    "them, with zero identity or wardrobe drift between frames. Never blend or "
    "swap features between different references, and never duplicate a "
    "referenced person. Everyone else on screen is a DIFFERENT anonymous "
    "individual who must not resemble any referenced face; keep background "
    "people softer and out of focus so they never compete with the referenced "
    "subjects.\n"
    "LITERAL PROMPT (non-negotiable): the prompt below is a binding "
    "specification — execute it exactly as written. Every stated subject, "
    "count, wardrobe item, color, action, spatial position, camera move, "
    "framing and lighting appears precisely as specified; add nothing, drop "
    "nothing, substitute nothing, reinterpret nothing. Anything under "
    '"NEGATIVE PROMPT" or phrased as "no …" is strictly forbidden in every '
    "frame.\n"
    "PROMPT:\n"
)


def _preset_notice_id(res: dict) -> str | None:
    text = "\n".join(c.get("text", "") for c in (res.get("content") or []))
    m = re.search(r"Preset id:\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", text)
    return m.group(1) if m else None


def _call_generate(tool: str, params: dict) -> dict:
    res = _call_tool(tool, {"params": params})
    preset = _preset_notice_id(res)
    if preset and not ((res.get("structuredContent") or {}).get("results") or []):
        print(f"[higgsfield] {tool}: declining preset {preset}, retrying literal")
        res = _call_tool(tool, {"params": {**params, "declined_preset_id": preset}})
    return res


def _job_id_from(res: dict) -> str | None:
    results = (res.get("structuredContent") or {}).get("results") or []
    if results and results[0].get("id"):
        return results[0]["id"]
    text = "\n".join(c.get("text", "") for c in (res.get("content") or []))
    m = re.search(
        r"^-\s*([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})", text, re.MULTILINE
    )
    return m.group(1) if m else None


def mcp_generate_video(
    model: str, media_ids: list[str], prompt: str | None = None, aspect_ratio: str | None = None,
    duration: int | None = None, resolution: str | None = None,
) -> str:
    """Submit a Seedance video; returns the job id (async — poll mcp_job_status)."""
    mcp_model = mcp_model_id(model)
    if not mcp_model:
        raise ValueError(f"Unknown Higgsfield model: {model}")
    params: dict = {
        "model": mcp_model,
        "medias": [{"value": mid, "role": "image_references"} for mid in media_ids],
    }
    if prompt:
        tagged = _to_higgsfield_tags(prompt)
        if legacy_directive():
            params["prompt"] = (VIDEO_IDENTITY_DIRECTIVE + tagged) if media_ids else tagged
        else:
            params["prompt"] = build_video_directive(
                tagged, len(media_ids), "angle", build_ref_roles(prompt, len(media_ids))
            )
    if aspect_ratio:
        params["aspect_ratio"] = aspect_ratio
    if duration:
        params["duration"] = duration
    if resolution:
        params["resolution"] = resolution.lower()

    res = _call_generate("generate_video", params)
    print(f"[higgsfield] generate_video → {json.dumps(res)[:400]}")
    job_id = _job_id_from(res)
    if not job_id:
        raise RuntimeError(f"Higgsfield generate_video: no job id returned — {json.dumps(res)[:300]}")
    return job_id


def mcp_generate_image(
    model: str, prompt: str, aspect_ratio: str | None = None, quality: str | None = None,
    resolution: str | None = None, media_ids: list[str] | None = None,
) -> str:
    """Submit an image job (Soul / Nano Banana Pro); returns the job id."""
    mcp_model = mcp_model_id(model)
    if not mcp_model:
        raise ValueError(f"Unknown Higgsfield model: {model}")
    params: dict = {"model": mcp_model, "prompt": _to_higgsfield_tags(prompt)}
    if aspect_ratio:
        params["aspect_ratio"] = aspect_ratio
    if quality:
        params["quality"] = quality
    if resolution:
        params["resolution"] = resolution
    if media_ids:
        params["medias"] = [{"value": mid, "role": "image"} for mid in media_ids]

    res = _call_generate("generate_image", params)
    print(f"[higgsfield] generate_image → {json.dumps(res)[:400]}")
    job_id = _job_id_from(res)
    if not job_id:
        raise RuntimeError(f"Higgsfield generate_image: no job id returned — {json.dumps(res)[:300]}")
    return job_id


# ── status ───────────────────────────────────────────────────────────────

MODERATION = (
    "Higgsfield moderation flagged this generation (nsfw). Realistic-face moderation is probabilistic — "
    "try again or adjust the reference."
)


def mcp_job_status(job_id: str) -> dict:
    res = _call_tool("job_status", {"jobId": job_id, "sync": False}, tolerate_error=True)
    if res.get("isError"):
        msg = f"Higgsfield job_status: {_tool_error_text(res)[:200] or 'error'}"
        if (res.get("structuredContent") or {}).get("retryable") is False:
            return {"status": "failed", "error": msg}
        raise RuntimeError(msg)

    g = (res.get("structuredContent") or {}).get("generation") or {}
    status = g.get("status")
    if status == "completed":
        results = g.get("results") or {}
        return {"status": "succeeded", "url": results.get("rawUrl") or results.get("minUrl")}
    if status in ("failed", "canceled"):
        return {"status": "failed", "error": "Higgsfield generation failed."}
    if status == "nsfw":
        return {"status": "failed", "error": MODERATION}
    if status in ("ip_detected", "ip_detect"):
        return {"status": "failed", "error": "Higgsfield flagged possible IP in the content."}
    if status == "in_progress":
        return {"status": "running"}
    return {"status": "queued"}  # pending | waiting | queued


def mcp_await_job(job_id: str, timeout_ms: int = 4 * 60 * 1000) -> dict:
    """Block until a job reaches a terminal state (used for synchronous
    image gen)."""
    deadline = time.time() * 1000 + timeout_ms
    while time.time() * 1000 < deadline:
        s = mcp_job_status(job_id)
        if s["status"] in ("succeeded", "failed"):
            return s
        time.sleep(4)
    return {"status": "failed", "error": "Higgsfield generation timed out."}
