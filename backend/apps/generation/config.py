"""Port of src/lib/config.js — model picker options and per-model
capability rules. MODELS/DEFAULTS mirrors the frontend's list exactly;
these two must never drift (defaultsAreOfferedModels in config.test.js
pins the TS side)."""

import re

# Stamped on every depth-map generation row (depth_views.py) and the one
# MODELS entry with kind="depth" below — see that entry's comment. Declared
# ahead of MODELS because the entry below references it, mirroring config.js.
DEPTH_MODEL_NAME = "Depth Anything (Local)"

# vits = fastest/lowest quality, vitb = balanced (default), vitl = slowest/
# highest quality — see config.js's DEPTH_ENCODERS comment.
DEPTH_ENCODERS = ["vits", "vitb", "vitl"]

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
    # The only "depth" entry — see config.js's matching MODELS entry comment.
    {
        "id": "depth-anything-local",
        "name": DEPTH_MODEL_NAME,
        "kind": "depth",
        "badge": "LOCAL",
        "hint": "Runs on a local worker machine, not the cloud — offline if nobody's machine is running it",
    },
]

MODES = [
    {"id": "image", "label": "AI Image", "icon": "Image", "enabled": True},
    {"id": "video", "label": "AI Video", "icon": "Clapperboard", "enabled": True},
    {"id": "depth", "label": "Depth Map", "icon": "Layers", "enabled": True},
]

ASPECT_RATIOS = {
    "image": ["1:1", "3:4", "4:3", "9:16", "16:9", "21:9"],
    "video": ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    "depth": [],
}

RESOLUTIONS = {
    "image": ["1K", "2K", "4K"],
    "video": ["480p", "720p", "1080p"],
    "depth": [],
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


# Mirrors config.js's durationRangeForModel. Native BytePlus Seedance (2.0
# and 2.5) takes any integer duration within a bounded range rather than a
# fixed enum; Higgsfield's MCP and Omni's Interactions API are true enums,
# so this only ever applies to the two direct-BytePlus models — see the
# comment on the JS side for the source of the 4-15/4-30 bounds.
def duration_range_for_model(model: str) -> dict | None:
    if re.search(r"higgsfield", model, re.IGNORECASE) or re.search(r"omni", model, re.IGNORECASE):
        return None
    if re.search(r"seedance 2\.5", model, re.IGNORECASE):
        return {"min": 4, "max": 30, "step": 1}
    if re.search(r"seedance", model, re.IGNORECASE):
        return {"min": 4, "max": 15, "step": 1}
    return None


def resolutions_for_model(model: str, kind: str) -> list[str]:
    if re.search(r"omni", model, re.IGNORECASE):
        return ["720p"]
    if re.search(r"seedance.*mini", model, re.IGNORECASE):
        return ["480p", "720p"]
    if re.search(r"seedance 2\.5", model, re.IGNORECASE):
        return ["480p", "720p"]
    # 2K is Kling Image 3.0 only — the endpoint rejects `2k` on kling-v2-1 even
    # though the capability map lists it. See providers/kling.py's KLING_MODELS.
    if is_kling_image_model(model):
        return ["1K", "2K"] if is_kling_2k_model(model) else ["1K"]
    return RESOLUTIONS[kind]


def aspect_ratios_for_model(model: str, kind: str) -> list[str]:
    if re.search(r"omni", model, re.IGNORECASE):
        return ["16:9", "9:16"]
    if is_kling_image_model(model):
        return ["1:1", "3:4", "4:3", "9:16", "16:9", "3:2", "2:3", "21:9"]
    return ASPECT_RATIOS[kind]


def is_kling_image_model(model: str) -> bool:
    return bool(re.match(r"^kling image", model.strip(), re.IGNORECASE))


def is_kling_2k_model(model: str) -> bool:
    """Which Kling image models accept `resolution: "2k"`. Only 3.0 does.

    Matches on the major version rather than the exact display name so a future
    "Kling Image 3.x" inherits 2K instead of being silently downgraded to 1K.
    Mirrors isKling2KModel in src/lib/config.js.
    """
    return bool(re.match(r"^kling image 3\b", model.strip(), re.IGNORECASE))


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
    "depth": {"model": DEPTH_MODEL_NAME, "aspectRatio": "16:9", "resolution": DEPTH_ENCODERS[1]},
}
