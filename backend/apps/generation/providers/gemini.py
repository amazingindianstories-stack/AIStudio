"""Port of src/lib/providers/gemini.js — Nano Banana Pro (gemini-3-pro-image),
the app's image engine. See that file's header for the measured endpoint
choice (generativelanguage over Vertex — Vertex gates 2K/4K to 1K) and the
best-of-N rationale (face-fix second passes are disproven; best-of-N is
the lever that works). Hard model limit: 14 images per prompt — user
reference images are never dropped to fit, only tiles yield.
"""

import json
import os
import random
import re
import time

import requests

from ..shot_spec import build_cast_policy

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
MODEL = "gemini-3-pro-image"
MAX_IMAGES = 14


def build_parts(assembled: dict) -> list[dict]:
    """Build the multimodal parts in the probe-winning shape: each
    reference group as [header text, images…, identity tiles…], then the
    literal SCENE, then a short identity FINAL CHECK when any identity ref
    exists."""
    instruction = assembled["instruction"]
    shot_instruction = assembled.get("shotInstruction")
    groups = assembled["groups"]

    user_images = sum(len(g["images"]) for g in groups)
    if user_images > MAX_IMAGES:
        raise ValueError(
            f"Too many reference images: {user_images}. Nano Banana Pro accepts at "
            f"most {MAX_IMAGES} images per prompt — remove {user_images - MAX_IMAGES}."
        )

    budget = MAX_IMAGES - user_images
    parts: list[dict] = []
    has_identity = False

    for group in groups:
        parts.append({"text": group["header"]})
        for img in group["images"]:
            parts.append({"inlineData": {"mimeType": img["mimeType"], "data": img["data"]}})
        if group.get("identity"):
            has_identity = True
        for tile in group.get("tiles") or []:
            if budget <= 0:
                break
            parts.append({"inlineData": {"mimeType": tile["mimeType"], "data": tile["data"]}})
            budget -= 1

    parts.append({"text": shot_instruction if shot_instruction else (f"SCENE: {instruction}" if groups else instruction)})

    cast_policy = build_cast_policy(instruction, has_identity)
    if cast_policy:
        parts.append({"text": cast_policy})
    if has_identity:
        parts.append({
            "text": (
                "FINAL CHECK: every person referenced above must be a 1:1 photographic "
                "match to their reference images (bone structure, eyes, nose, lips, "
                "jawline, skin tone, apparent age). If not, correct it."
            )
        })
    return parts


_RETRY_INFO_DURATION_RE = re.compile(r"^([\d.]+)s$")


def retry_delay_ms(err_text: str) -> int | None:
    """Pull Google's own "wait this long" hint out of an error body. See
    the TS docstring: a RetryInfo detail's retryDelay beats any backoff
    curve we invent. Returns None when unparseable/absent."""
    try:
        details = json.loads(err_text).get("error", {}).get("details")
        if not isinstance(details, list):
            return None
        for d in details:
            type_ = d.get("@type")
            if isinstance(type_, str) and type_.endswith("RetryInfo"):
                m = _RETRY_INFO_DURATION_RE.match(str(d.get("retryDelay") or ""))
                if m:
                    return min(max(int(float(m.group(1)) * 1000), 1000), 60_000)
    except (ValueError, AttributeError, TypeError):
        pass
    return None


RETRY_BUDGET_MS = 90_000


def generate_image_gemini(assembled: dict, aspect_ratio: str | None = None, image_size: str | None = None) -> dict:
    """Returns {"base64", "mimeType"}."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError("GOOGLE_API_KEY is not set.")

    body = {
        "contents": [{"role": "user", "parts": build_parts(assembled)}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": {"aspectRatio": aspect_ratio or "1:1", "imageSize": image_size or "1K"},
        },
    }

    last_error = ""
    slept_ms = 0
    for attempt in range(1, 5):
        res = requests.post(
            f"{API_ROOT}/models/{MODEL}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json=body,
            timeout=120,
        )
        if not res.ok:
            err_text = res.text
            last_error = f"Gemini image error ({res.status_code}): {err_text[:400]}"
            if res.status_code == 429 or res.status_code >= 500:
                backoff = 4000 * 2 ** (attempt - 1)
                hint = retry_delay_ms(err_text)
                wait = min(hint if hint is not None else backoff * (0.75 + random.random() * 0.5), RETRY_BUDGET_MS - slept_ms)
                if wait > 0:
                    slept_ms += wait
                    time.sleep(wait / 1000)
                    continue
            raise RuntimeError(last_error)

        data = res.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts") or []
        part = next((p for p in parts if p.get("inlineData", {}).get("data")), None)
        if not part:
            reason = (data.get("candidates") or [{}])[0].get("finishReason", "no candidates")
            last_error = f"Gemini returned no image ({reason})."
            if attempt == 1:
                continue
            raise RuntimeError(last_error)
        return {"base64": part["inlineData"]["data"], "mimeType": part["inlineData"].get("mimeType", "image/png")}

    raise RuntimeError(last_error or "Gemini image generation failed.")
