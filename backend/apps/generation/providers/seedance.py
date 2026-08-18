"""Port of src/lib/providers/seedance.js — Seedance 2.0/2.5 via BytePlus
ModelArk. See that file's header for the full probe-verified contract:
async create+poll, video-to-video content-item shape (role is MANDATORY,
unlike the image item), Edit/Extend's ratio:"adaptive" requirement, and
the "provider reports its own billing" pattern via usage.total_tokens.
"""

import os
import re

import requests

from ..video_directive import build_video_directive


def legacy_directive() -> bool:
    return os.environ.get("SEEDANCE_LEGACY_DIRECTIVE") == "1"


def _legacy_hero_directive(ref_count: int) -> str:
    if not ref_count:
        return ""
    plural = "s" if ref_count > 1 else ""
    return (
        f"IDENTITY LOCK: the reference image{plural} define "
        "the MAIN CHARACTER's exact, fixed appearance. In EVERY frame keep this "
        "exact same person — identical face (bone structure, jawline, hairline, "
        "eye shape and color, eyebrows, nose, lips, skin tone and texture with "
        "its moles/scars/freckles, facial hair, apparent age), plus the same "
        "hairstyle, body build and worn outfit/jewelry unless the prompt "
        "explicitly changes them — unmistakably the SAME individual, never a "
        "lookalike, never beautified or idealized, with zero identity or "
        "wardrobe drift between frames. Keep the main character in sharp "
        "foreground focus as the clear focal point. Every other person (crowd, "
        "bystanders, dancers, background figures) is a DIFFERENT anonymous "
        "individual who must NOT share or resemble the main character's face; "
        "render the crowd softer and out of focus so it never competes with or "
        "is mistaken for the main character. Never duplicate the main character. "
        'LITERAL PROMPT: execute the prompt exactly as written — every stated '
        "subject, count, wardrobe item, color, action, camera move and lighting "
        "appears precisely as specified; add nothing, drop nothing, reinterpret "
        'nothing. Anything under "NEGATIVE PROMPT" or phrased as "no …" is '
        "strictly forbidden in every frame. "
    )


class SeedanceError(Exception):
    def __init__(self, message: str, code: str = "seedance_error", status: int | None = None):
        super().__init__(message)
        self.code = code
        self.status = status


def _ark_base() -> str:
    return os.environ.get("ARK_BASE_URL", "https://ark.ap-southeast.bytepluses.com/api/v3").rstrip("/")


def _ark_key() -> str:
    key = os.environ.get("ARK_API_KEY")
    if not key:
        raise RuntimeError("ARK_API_KEY is not set. Add it to .env.local (Seedance / BytePlus ModelArk).")
    return key


def _standard_model() -> str:
    return os.environ.get("SEEDANCE_MODEL", "dreamina-seedance-2-0-260128")


def _fast_model() -> str:
    return os.environ.get("SEEDANCE_MODEL_FAST", "dreamina-seedance-2-0-fast-260128")


def _model_25() -> str:
    return os.environ.get("SEEDANCE_MODEL_25", "dreamina-seedance-2-5-260628")


def _pick_model(model_display: str | None) -> str:
    if model_display and re.search(r"2\.5", model_display):
        return _model_25()
    if model_display and re.search(r"\b(mini|fast|lite)\b", model_display, re.IGNORECASE):
        return _fast_model()
    return _standard_model()


def _tags_to_image_refs(prompt: str) -> str:
    prompt = re.sub(r"@img(\d+)", lambda m: f"[image {m.group(1)}]", prompt, flags=re.IGNORECASE)
    prompt = re.sub(r"@vid(\d+)", lambda m: f"[video {m.group(1)}]", prompt, flags=re.IGNORECASE)
    return prompt


MODERATION_MESSAGE = (
    "BytePlus rejected the reference image — its privacy / anti-deepfake filter flags photorealistic "
    "faces (it can't tell an AI-generated face from a real one). Retry as text-to-video, or use a "
    "clearly stylized reference."
)


def is_moderation_message(text: str) -> bool:
    return bool(re.search(r"SensitiveContent|Privacy|real person|portrait|sensitive", text or "", re.IGNORECASE))


def _friendly_error(status: int, body: str) -> SeedanceError:
    code = ""
    message = ""
    try:
        import json as _json

        j = _json.loads(body)
        code = (j.get("error") or {}).get("code") or ""
        message = (j.get("error") or {}).get("message") or ""
    except ValueError:
        pass
    if is_moderation_message(code + message):
        return SeedanceError(MODERATION_MESSAGE, "moderation", status)
    if code:
        return SeedanceError(f"Seedance error ({status} {code}): {message or body[:300]}", "seedance_error", status)
    return SeedanceError(f"Seedance create error {status}: {body[:400]}", "seedance_error", status)


EDIT_TRIGGER = "Edit the attached reference video as follows: "
EXTEND_TRIGGER = "Extend the attached reference video forward in time: "


def create_video_task(
    prompt: str, model_display: str | None = None, ratio: str | None = None, resolution: str | None = None,
    duration: int | None = None, references: list[dict] | None = None, reference_video_urls: list[str] | None = None,
    generate_audio: bool = False, task_mode: str = "generate", seed: int | None = None,
) -> str:
    """references: [{"dataUrl": "..."}] (already resolved LabeledRef dicts,
    only .dataUrl is used here). Returns the created task id."""
    model = _pick_model(model_display)
    refs = references or []
    ref_role = os.environ.get("SEEDANCE_IMAGE_ROLE", "reference_image")

    if task_mode == "edit":
        text = EDIT_TRIGGER + _tags_to_image_refs(prompt.strip())
    elif task_mode == "extend":
        text = EXTEND_TRIGGER + _tags_to_image_refs(prompt.strip())
    else:
        tagged_prompt = _tags_to_image_refs(prompt.strip())
        text = (
            _legacy_hero_directive(len(refs)) + tagged_prompt
            if legacy_directive()
            else build_video_directive(tagged_prompt, len(refs), "bracket")
        )

    content: list[dict] = [{"type": "text", "text": text}]
    for ref in refs:
        content.append({"type": "image_url", "image_url": {"url": ref["dataUrl"]}, "role": ref_role})
    for url in (reference_video_urls or [])[:3]:
        content.append({"type": "video_url", "video_url": {"url": url}, "role": "reference_video"})

    body: dict = {"model": model, "content": content, "generate_audio": generate_audio is True}
    if task_mode in ("edit", "extend"):
        body["ratio"] = "adaptive"
        body["duration"] = -1 if task_mode == "edit" else (duration or -1)
    else:
        if ratio:
            body["ratio"] = ratio
        if duration:
            body["duration"] = duration
    if resolution:
        body["resolution"] = resolution
    # Real, documented ModelArk field (Phase 3.1) — mirrors seedance.js's
    # identical convention, omitted entirely when the caller has no seed.
    if isinstance(seed, int):
        body["seed"] = seed

    res = requests.post(
        f"{_ark_base()}/contents/generations/tasks",
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {_ark_key()}"},
        json=body,
        timeout=30,
    )
    if not res.ok:
        raise _friendly_error(res.status_code, res.text)
    data = res.json()
    task_id = data.get("id") or data.get("task_id") or (data.get("data") or {}).get("id")
    if not task_id:
        raise RuntimeError("Seedance create: no task id in response.")
    return task_id


def get_video_task(task_id: str) -> dict:
    from urllib.parse import quote

    res = requests.get(
        f"{_ark_base()}/contents/generations/tasks/{quote(task_id)}",
        headers={"Authorization": f"Bearer {_ark_key()}"},
        timeout=30,
    )
    if not res.ok:
        raise RuntimeError(f"Seedance poll error {res.status_code}: {res.text[:500]}")
    data = res.json()

    raw_status = (data.get("status") or "").lower()
    if raw_status == "succeeded":
        status = "succeeded"
    elif raw_status in ("failed", "cancelled"):
        status = "failed"
    elif raw_status == "queued":
        status = "queued"
    else:
        status = "running"

    content = data.get("content")
    video_url = None
    if isinstance(content, dict):
        video_url = content.get("video_url")
    elif isinstance(content, list) and content:
        video_url = content[0].get("video_url")
    video_url = video_url or data.get("video_url")

    error = None
    if status == "failed":
        err = data.get("error")
        error = (err.get("message") if isinstance(err, dict) else err) or "Generation failed"

    total_tokens_raw = (data.get("usage") or {}).get("total_tokens")
    total_tokens = total_tokens_raw if isinstance(total_tokens_raw, (int, float)) else None

    return {"status": status, "videoUrl": video_url, "error": error, "raw": data, "totalTokens": total_tokens}
