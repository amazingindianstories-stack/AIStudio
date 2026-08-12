"""Port of src/lib/config.js — model picker options and per-model
capability rules. MODELS/DEFAULTS mirrors the frontend's list exactly;
these two must never drift (defaultsAreOfferedModels in config.test.js
pins the TS side)."""

import re

MODELS = [
    {"id": "nano-banana-pro", "name": "Nano Banana Pro", "kind": "image", "badge": "BEST"},
    {
        "id": "kling-image-3",
        "name": "Kling Image 3.0",
        "kind": "image",
        "badge": "NEW",
        "hint": "Strong prompt adherence, 1K/2K — takes a single reference image",
    },
    {
        "id": "kling-image-21",
        "name": "Kling Image 2.1",
        "kind": "image",
        "badge": "BUDGET",
        "hint": "Cheapest text-to-image here (~$0.014) — takes a single reference image",
    },
    {
        "id": "seedance",
        "name": "Seedance 2.0",
        "kind": "video",
        "badge": "DIRECT",
        "hint": "BytePlus ModelArk direct — its content filter rejects photorealistic faces",
    },
    {
        "id": "seedance-25",
        "name": "Seedance 2.5",
        "kind": "video",
        "badge": "NEW",
        "hint": "BytePlus ModelArk direct — 480p/720p, up to 30s; can edit or extend an attached clip",
    },
    {
        "id": "gemini-omni-flash",
        "name": "Gemini Omni Flash",
        "kind": "video",
        "badge": "NEW",
        "hint": "Google Interactions API — full NBP-style reference scaffolding, 16:9/9:16 only",
    },
]

MODES = [
    {"id": "image", "label": "AI Image", "icon": "Image", "enabled": True},
    {"id": "video", "label": "AI Video", "icon": "Clapperboard", "enabled": True},
]

ASPECT_RATIOS = {
    "image": ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
    "video": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
}

RESOLUTIONS = {
    "image": ["1K", "2K", "4K"],
    "video": ["480p", "720p", "1080p"],
}

DURATIONS = [4, 5, 8, 10, 15]

HISTORY_PAGE_SIZE = 20


def durations_for_model(model: str) -> list[int]:
    if re.search(r"omni", model, re.IGNORECASE):
        return [4, 6, 8]
    if re.search(r"higgsfield", model, re.IGNORECASE):
        return [3, 4, 5, 6, 8, 10, 12]
    if re.search(r"seedance 2\.5", model, re.IGNORECASE):
        return [4, 5, 8, 10, 15, 20, 25, 30]
    return DURATIONS


def resolutions_for_model(model: str, kind: str) -> list[str]:
    if re.search(r"omni", model, re.IGNORECASE):
        return ["720p"]
    if re.search(r"seedance.*mini", model, re.IGNORECASE):
        return ["480p", "720p"]
    if re.search(r"seedance 2\.5", model, re.IGNORECASE):
        return ["480p", "720p"]
    if is_kling_image_model(model):
        return ["1K", "2K"]
    return RESOLUTIONS[kind]


def aspect_ratios_for_model(model: str, kind: str) -> list[str]:
    if re.search(r"omni", model, re.IGNORECASE):
        return ["16:9", "9:16"]
    if is_kling_image_model(model):
        return ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"]
    return ASPECT_RATIOS[kind]


def is_kling_image_model(model: str) -> bool:
    return bool(re.match(r"^kling image", model.strip(), re.IGNORECASE))


KLING_MAX_REFERENCE_IMAGES = 1


def supports_video_reference(model: str) -> bool:
    """Probe-verified against BytePlus ModelArk on 2026-07-29. The
    higgsfield-before-seedance ordering matters — Higgsfield model names
    also contain "seedance"."""
    if re.search(r"higgsfield", model, re.IGNORECASE):
        return False
    if re.search(r"omni", model, re.IGNORECASE):
        return False
    return bool(re.search(r"seedance", model, re.IGNORECASE))


MAX_REFERENCE_VIDEOS = 3


def supports_audio(model: str) -> bool:
    """Only the native BytePlus ModelArk path. Matching 'higgsfield' first
    matters — 'Higgsfield Seedance 2.0' also contains 'seedance'."""
    if re.search(r"higgsfield", model, re.IGNORECASE):
        return False
    if re.search(r"omni", model, re.IGNORECASE):
        return False
    return bool(re.search(r"seedance", model, re.IGNORECASE))


VIDEO_TASK_MODES = ["generate", "edit", "extend"]


def supports_video_edit_extend(model: str) -> bool:
    """Seedance 2.5 only — exact-name match, unlike the bare /seedance/i
    used elsewhere, because this is NOT a capability 2.0 also has."""
    return bool(re.search(r"seedance 2\.5", model, re.IGNORECASE))


DEFAULTS = {
    "image": {"model": "Nano Banana Pro", "aspectRatio": "1:1", "resolution": "2K"},
    "video": {"model": "Seedance 2.0", "aspectRatio": "16:9", "resolution": "1080p", "duration": 5},
}
