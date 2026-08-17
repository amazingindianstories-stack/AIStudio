"""Port of src/lib/providers/kling.js — Kling image generation (KlingAI
Open Platform). See that file's header for the full contract (auth scheme,
host, the one-reference-image limitation, parameters deliberately not
sent, the aspect_ratio-ignored-in-image-to-image measurement). Every rule
here came from the docs or a probe, not from guessing — re-verify against
scripts/probe-kling-image.js before changing anything.
"""

import base64
import io
import math
import os
import re
import time

import requests
from PIL import Image

DEFAULT_HOST = "https://api-singapore.klingai.com"

KLING_PROMPT_MAX = 2500

REF_MAX_BYTES = 10 * 1024 * 1024
REF_MIN_DIM = 300
REF_MAX_ASPECT = 2.5

KLING_MODELS = [
    {
        "modelName": "kling-v3",
        "display": "Kling Image 3.0",
        "resolutions": ["1K", "2K"],
        "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
    },
    {
        "modelName": "kling-v2-1",
        "display": "Kling Image 2.1",
        # 1K only — measured, not read. Kling's capability map claims 1K/2K for
        # both models and this used to say so, but /v1/images/generations answers
        # `resolution: "2k"` on kling-v2-1 with
        #   http 400, code 1201: resolution value '2k' is not supported
        # while the byte-identical request on kling-v3 succeeds (production rows,
        # 2026-08-17). The wire casing is not the problem — lowercase `2k` is
        # exactly what kling-v3 accepts. Keep in sync with providers/kling.js.
        "resolutions": ["1K"],
        "aspectRatios": ["16:9", "9:16", "1:1", "4:3", "3:4", "3:2", "2:3", "21:9"],
    },
]


def is_kling_model(model: str) -> bool:
    return bool(re.match(r"^kling\b", model.strip(), re.IGNORECASE))


def kling_spec(model: str) -> dict | None:
    wanted = model.strip().lower()
    return next((m for m in KLING_MODELS if m["display"].lower() == wanted), None)


def nearest_kling_aspect_ratio(width: int, height: int) -> str | None:
    """Kling ignores aspect_ratio in image-to-image and rounds to pixel
    multiples even in text-to-image, so an exact string match never hits —
    nearest by log-distance is the right comparison (ratio error is
    multiplicative)."""
    if not width or not height:
        return None
    target = math.log(width / height)
    best = None
    best_delta = float("inf")
    for label in KLING_MODELS[0]["aspectRatios"]:
        w_str, h_str = label.split(":")
        w, h = int(w_str), int(h_str)
        if not w or not h:
            continue
        delta = abs(math.log(w / h) - target)
        if delta < best_delta:
            best_delta = delta
            best = label
    return best


def _api_key() -> str:
    key = os.environ.get("KLING_API")
    if not key:
        raise RuntimeError(
            "KLING_API is not set, so Kling models cannot be called. Create an API "
            "key in the Kling console and set KLING_API."
        )
    return key


def _host() -> str:
    return os.environ.get("KLING_API_HOST", DEFAULT_HOST).rstrip("/")


def build_kling_payload(
    model: str, prompt: str, aspect_ratio: str | None = None, resolution: str | None = None,
    references: list[dict] | None = None,
) -> dict:
    """Pure. references: [{"mimeType", "data"}, ...] base64, no data: prefix."""
    spec = kling_spec(model)
    if not spec:
        known = ", ".join(m["display"] for m in KLING_MODELS)
        raise ValueError(f"{model} is not a Kling model this app knows. Known: {known}")

    prompt = prompt.strip()
    if not prompt:
        raise ValueError("Prompt is required.")
    if len(prompt) > KLING_PROMPT_MAX:
        raise ValueError(
            f"{spec['display']} accepts prompts up to {KLING_PROMPT_MAX} characters; "
            f"this one is {len(prompt)}. Shorten the prompt (or use Nano Banana "
            "Pro, which has no such limit)."
        )

    references = references or []
    if len(references) > 1:
        raise ValueError(
            f"{spec['display']} accepts one reference image; {len(references)} were "
            "provided. Kling's multi-reference model is Kling Image 3.0 Omni on a "
            "separate endpoint, which is not wired up yet — use Nano Banana Pro for "
            "multi-reference work, or reduce this to a single @tag."
        )

    resolution = resolution or "1K"
    if resolution not in spec["resolutions"]:
        # Name the model that CAN do what was asked — 2K and 4K have different
        # answers, and one shared parenthetical pointed a 2K request at Omni,
        # which is not where 2K lives.
        if resolution == "2K":
            where = " Use Kling Image 3.0 for 2K."
        elif resolution == "4K":
            where = " 4K is Kling Image 3.0 Omni only, which is not wired up here."
        else:
            where = ""
        raise ValueError(
            f"{spec['display']} supports {'/'.join(spec['resolutions'])} only; "
            f"{resolution} was requested.{where}"
        )

    aspect_ratio = aspect_ratio or "1:1"
    if aspect_ratio not in spec["aspectRatios"]:
        raise ValueError(
            f"{spec['display']} does not support {aspect_ratio}. Supported: "
            + ", ".join(spec["aspectRatios"])
        )

    payload = {
        "model_name": spec["modelName"],
        "prompt": prompt,
        "n": 1,
        "aspect_ratio": aspect_ratio,
        "resolution": resolution.lower(),
    }
    if references:
        payload["image"] = references[0]["data"]
    return payload


def prep_kling_reference(mime_type: str, b64: str) -> dict:
    """Coerce a stored reference into something Kling will accept: JPEG or
    PNG, >=300px, <=10MB, aspect ratio within 1:2.5-2.5:1."""
    buf = base64.b64decode(b64)
    with Image.open(io.BytesIO(buf)) as im:
        width, height = im.size
        fmt = (im.format or "").lower()

        if width < REF_MIN_DIM or height < REF_MIN_DIM:
            raise ValueError(
                f"Kling needs reference images at least {REF_MIN_DIM}px on both sides; "
                f"this one is {width}×{height}."
            )
        aspect = width / height
        if aspect > REF_MAX_ASPECT or aspect < 1 / REF_MAX_ASPECT:
            raise ValueError(
                f"Kling needs a reference aspect ratio between 1:2.5 and 2.5:1; this one "
                f"is {width}×{height}."
            )

        out = buf
        out_mime = mime_type
        accepted = fmt in ("jpeg", "png")
        if not accepted or len(out) > REF_MAX_BYTES:
            enc = io.BytesIO()
            rgb = im.convert("RGB") if im.mode in ("P", "CMYK", "RGBA") else im
            rgb.save(enc, format="JPEG", quality=90)
            out = enc.getvalue()
            out_mime = "image/jpeg"
        if len(out) > REF_MAX_BYTES:
            with Image.open(io.BytesIO(out)) as im2:
                im2.thumbnail((2048, 2048), Image.LANCZOS)
                enc = io.BytesIO()
                rgb2 = im2.convert("RGB") if im2.mode in ("P", "CMYK", "RGBA") else im2
                rgb2.save(enc, format="JPEG", quality=85)
                out = enc.getvalue()
        if len(out) > REF_MAX_BYTES:
            raise ValueError(
                f"The reference image is {len(out) / 1024 / 1024:.1f}MB "
                "after compression; Kling's limit is 10MB."
            )
        return {"mimeType": out_mime, "data": base64.b64encode(out).decode()}


def _kling_fetch(path: str, method: str = "GET", body: dict | None = None) -> dict:
    res = requests.request(
        method,
        f"{_host()}{path}",
        headers={"Authorization": f"Bearer {_api_key()}", "Content-Type": "application/json"},
        json=body,
        timeout=30,
    )
    try:
        data = res.json()
    except ValueError:
        raise RuntimeError(f"Kling returned a non-JSON {res.status_code} response: {res.text[:300]}")
    if not res.ok or data.get("code") != 0:
        raise RuntimeError(
            f"Kling {path} failed (http {res.status_code}, code {data.get('code')}): "
            f"{data.get('message') or 'no message'}"
        )
    return data


def create_kling_image_task(
    model: str, prompt: str, aspect_ratio: str | None = None, resolution: str | None = None,
    references: list[dict] | None = None,
) -> str:
    payload = build_kling_payload(model, prompt, aspect_ratio, resolution, references)
    data = _kling_fetch("/v1/images/generations", "POST", payload)
    task_id = (data.get("data") or {}).get("task_id")
    if not task_id:
        raise RuntimeError("Kling accepted the request but returned no task_id.")
    return task_id


def get_kling_image_task(task_id: str) -> dict:
    from urllib.parse import quote

    data = _kling_fetch(f"/v1/images/generations/{quote(task_id)}")
    return data["data"]


def generate_image_kling(
    model: str, prompt: str, aspect_ratio: str | None = None, resolution: str | None = None,
    references: list[dict] | None = None, timeout_ms: int = 240_000, poll_ms: int = 3_000,
) -> dict:
    """Create a task and poll it to completion. Returns {"url", "unitDeduction"}."""
    task_id = create_kling_image_task(model, prompt, aspect_ratio, resolution, references)
    deadline = time.time() * 1000 + timeout_ms

    while time.time() * 1000 < deadline:
        time.sleep(poll_ms / 1000)
        task = get_kling_image_task(task_id)
        if task.get("task_status") == "succeed":
            images = (task.get("task_result") or {}).get("images") or []
            if not images:
                raise RuntimeError("Kling reported success but returned no image URL.")
            return {"url": images[0]["url"], "unitDeduction": task.get("final_unit_deduction")}
        if task.get("task_status") == "failed":
            msg = task.get("task_status_msg")
            raise RuntimeError(f"Kling generation failed: {msg}" if msg else "Kling generation failed with no reason given.")

    raise RuntimeError(f"Kling task {task_id} did not finish within {round(timeout_ms / 1000)}s.")
