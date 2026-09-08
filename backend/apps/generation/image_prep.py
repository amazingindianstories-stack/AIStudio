"""Port of src/lib/middleware/image-prep.js — reference-image middleware.
See that file's header for the full R&D context (Higgsfield ref-preprocessing
parity, the identity-tiling rationale). Everything here is fail-open: any
error returns the original image / a null detection, never raises to the
caller.

Uses Pillow where the TS file uses sharp. `crispen()` is a deliberate
exception: its exact sharpen parameters were A/B-validated against sharp's
specific unsharp-mask implementation (POST_CRISPEN's header in CLAUDE.md).
Pillow's UnsharpMask is not the same algorithm, so this port is a
reasonable equivalent, NOT a validated match — POST_CRISPEN is off by
default and this should be re-probed before ever turning it on here.
"""

import base64
import io
import json
import os
import time

import requests
from PIL import Image

API_ROOT = "https://generativelanguage.googleapis.com/v1beta"

MAX_REF_DIM = 2048


def prep_reference(mime_type: str, b64: str) -> dict:
    """Cap the longest side of a reference image (Higgsfield-style
    `_resize`). Returns {"mimeType", "data"} (base64, no data: prefix)."""
    try:
        buf = base64.b64decode(b64)
        with Image.open(io.BytesIO(buf)) as im:
            width, height = im.size
            if max(width, height) <= MAX_REF_DIM:
                return {"mimeType": mime_type, "data": b64}
            im = im.convert("RGB") if im.mode in ("P", "CMYK", "RGBA") else im
            im.thumbnail((MAX_REF_DIM, MAX_REF_DIM), Image.LANCZOS)
            out = io.BytesIO()
            im.save(out, format="JPEG", quality=92)
            return {"mimeType": "image/jpeg", "data": base64.b64encode(out.getvalue()).decode()}
    except Exception:
        return {"mimeType": mime_type, "data": b64}


def crispen(mime_type: str, b64: str) -> dict:
    """See module docstring — not a validated match for sharp's recipe."""
    try:
        from PIL import ImageFilter

        buf = base64.b64decode(b64)
        with Image.open(io.BytesIO(buf)) as im:
            out_im = im.filter(ImageFilter.UnsharpMask(radius=1, percent=50, threshold=3))
            out = io.BytesIO()
            out_im.save(out, format=im.format or "PNG")
            return {"mimeType": mime_type, "data": base64.b64encode(out.getvalue()).decode()}
    except Exception:
        return {"mimeType": mime_type, "data": b64}


def _parse_box(b) -> dict | None:
    if not isinstance(b, list) or len(b) != 4:
        return None
    try:
        ymin, xmin, ymax, xmax = (float(v) for v in b)
    except (TypeError, ValueError):
        return None
    if any(not _is_finite(v) for v in (ymin, xmin, ymax, xmax)):
        return None
    if ymax <= ymin or xmax <= xmin:
        return None
    return {"ymin": ymin, "xmin": xmin, "ymax": ymax, "xmax": xmax}


def _is_finite(v: float) -> bool:
    return v == v and v not in (float("inf"), float("-inf"))


def _detect_identity_boxes_once(mime_type: str, b64: str) -> dict | None | str:
    """Returns a detection dict, None, or "retryable"."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    model = os.environ.get("GEMINI_DETECT_MODEL", "gemini-2.5-flash")
    try:
        res = requests.post(
            f"{API_ROOT}/models/{model}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json={
                "contents": [
                    {
                        "role": "user",
                        "parts": [
                            {"inlineData": {"mimeType": mime_type, "data": b64}},
                            {
                                "text": (
                                    "You are helping build a face-identity pipeline. Look at this image and "
                                    'answer as JSON: {"person_reference": <bool>, "face_box_2d": '
                                    "[ymin, xmin, ymax, xmax] | null, \"panel_boxes\": [[ymin, xmin, ymax, xmax], "
                                    '...] | null}. "person_reference" is true if the image is primarily a '
                                    "reference of ONE specific person — a portrait, headshot, character sheet, or "
                                    "a photo whose clear main subject is a single person. IMPORTANT: Even if the "
                                    "image is a character sheet where some panels have faces blanked out, hidden, "
                                    "or anonymized (e.g. with white boxes), if there is AT LEAST ONE clear, "
                                    'visible face of the subject in any panel, "person_reference" MUST be true. '
                                    "It is false ONLY for locations, sets, crowds, objects, style frames, or "
                                    "images where ALL faces are hidden/anonymized. When true, \"face_box_2d\" is "
                                    "the tight bounding box of that person's CLEAR face (largest/clearest "
                                    'instance if shown multiple times; ignore blanked out faces). "panel_boxes" '
                                    "applies ONLY when the image is a character sheet / collage of several "
                                    "distinct panels showing the same person (e.g. front view, profile, full "
                                    "body): give one box per panel (even if the face is blanked out in that "
                                    "panel), up to 4, most identity-relevant first; otherwise null. All "
                                    "coordinates normalized to 0-1000."
                                )
                            },
                        ],
                    }
                ],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 0,
                    "thinkingConfig": {"thinkingBudget": 0},
                },
            },
            timeout=30,
        )
    except requests.RequestException:
        return "retryable"

    if not res.ok:
        return "retryable" if res.status_code == 429 or res.status_code >= 500 else None

    try:
        data = res.json()
        text = next(
            (p["text"] for p in data["candidates"][0]["content"]["parts"] if isinstance(p.get("text"), str)), None
        )
    except (KeyError, IndexError, ValueError):
        return "retryable"
    if not text:
        return "retryable"

    try:
        parsed = json.loads(text)
        face = _parse_box(parsed.get("face_box_2d"))
        panels = [b for b in (_parse_box(p) for p in (parsed.get("panel_boxes") or [])) if b] if isinstance(
            parsed.get("panel_boxes"), list
        ) else []

        is_person = parsed.get("person_reference") is True or bool(face) or len(panels) > 0
        if not is_person:
            return {"personReference": False, "boxes": None}
        if not face and not panels:
            return {"personReference": True, "boxes": None}
        return {"personReference": True, "boxes": {"face": face, "panels": panels}}
    except (ValueError, TypeError, KeyError):
        return "retryable"


def _detect_identity_boxes(mime_type: str, b64: str) -> dict | None:
    for attempt in (1, 2):
        out = _detect_identity_boxes_once(mime_type, b64)
        if out != "retryable":
            return out
        if attempt == 1:
            time.sleep(1.5)
    print("[image-prep] WARN: face detection failed twice — no identity tiles this run")
    return None


def _to_pixels(box: dict, img_w: int, img_h: int, pad: float) -> dict | None:
    w = ((box["xmax"] - box["xmin"]) / 1000) * img_w
    h = ((box["ymax"] - box["ymin"]) / 1000) * img_h
    left = max(0, round((box["xmin"] / 1000) * img_w - w * pad))
    top = max(0, round((box["ymin"] / 1000) * img_h - h * pad))
    right = min(img_w, round((box["xmin"] / 1000) * img_w + w * (1 + pad)))
    bottom = min(img_h, round((box["ymin"] / 1000) * img_h + h * (1 + pad)))
    cw = right - left
    ch = bottom - top
    if cw < 64 or ch < 64:
        return None
    return {"left": left, "top": top, "width": cw, "height": ch}


def _covered_by(a: dict, b: dict) -> float:
    ix = min(a["left"] + a["width"], b["left"] + b["width"]) - max(a["left"], b["left"])
    iy = min(a["top"] + a["height"], b["top"] + b["height"]) - max(a["top"], b["top"])
    if ix <= 0 or iy <= 0:
        return 0
    return (ix * iy) / (a["width"] * a["height"])


def _render_crop(buf: bytes, rect: dict) -> dict:
    with Image.open(io.BytesIO(buf)) as im:
        box = (rect["left"], rect["top"], rect["left"] + rect["width"], rect["top"] + rect["height"])
        cropped = im.crop(box)
        if max(rect["width"], rect["height"]) > 1536:
            cropped.thumbnail((1536, 1536), Image.LANCZOS)
        cropped = cropped.convert("RGB") if cropped.mode in ("P", "CMYK", "RGBA") else cropped
        out = io.BytesIO()
        cropped.save(out, format="JPEG", quality=95)
        return {"mimeType": "image/jpeg", "data": base64.b64encode(out.getvalue()).decode()}


def analyze_identity_reference(mime_type: str, b64: str, max_crops: int = 3) -> dict:
    """Identity classification + tiling in one detector call. Returns
    {"personReference": bool|None, "crops": [...]}. Disable via
    FACE_CROP_MIDDLEWARE=0."""
    if os.environ.get("FACE_CROP_MIDDLEWARE") == "0":
        return {"personReference": None, "crops": []}

    try:
        detection = _detect_identity_boxes(mime_type, b64)
        if not detection:
            return {"personReference": None, "crops": []}
        if not detection["personReference"] or not detection["boxes"]:
            return {"personReference": detection["personReference"], "crops": []}

        face = detection["boxes"]["face"]
        panels = detection["boxes"]["panels"]
        buf = base64.b64decode(b64)
        with Image.open(io.BytesIO(buf)) as im:
            img_w, img_h = im.size
        area = img_w * img_h

        rects: list[dict] = []
        if face:
            raw_area = ((face["xmax"] - face["xmin"]) / 1000) * img_w * (((face["ymax"] - face["ymin"]) / 1000) * img_h)
            r = _to_pixels(face, img_w, img_h, 0.45)
            if r and raw_area <= area * 0.5:
                rects.append(r)

        for p in panels:
            if len(rects) >= max_crops:
                break
            r = _to_pixels(p, img_w, img_h, 0.04)
            if not r:
                continue
            if r["width"] * r["height"] > area * 0.85:
                continue
            if any(_covered_by(r, prev) > 0.6 or _covered_by(prev, r) > 0.6 for prev in rects):
                continue
            rects.append(r)

        out = [_render_crop(buf, rect) for rect in rects[:max_crops]]
        return {"personReference": True, "crops": out}
    except Exception:
        return {"personReference": None, "crops": []}


def identity_crops(mime_type: str, b64: str, max_crops: int = 3) -> list[dict]:
    return analyze_identity_reference(mime_type, b64, max_crops)["crops"]


ROLE_DETECT_PROMPT = (
    "Classify the PRIMARY subject of this reference image for a photo "
    'generation pipeline. Answer JSON: {"role": "person"|"outfit"|"location"|"style"|"prop"|"object"}. '
    '"person" = the main subject is a specific individual\'s face/identity '
    '(portrait, headshot, character sheet). "outfit" = the main subject is '
    "clothing/garments/jewelry meant to be worn, not a specific person's "
    'identity. "location" = a place, set, room, venue or backdrop. "style" = a '
    "mood board / color palette / lighting or rendering reference, not a "
    'concrete scene or object. "prop" = a specific physical object meant to be '
    'reproduced (e.g. a car, a phone, a piece of furniture). "object" = none of '
    "the above fit clearly."
)

VALID_ROLES = {"person", "outfit", "location", "style", "prop", "object"}


def detect_reference_role(mime_type: str, b64: str) -> str | None:
    """Extended-schema role classifier — PROMPT_ROLE_DETECT fallback/cross-
    check only. Fail-open: None when unavailable."""
    api_key = os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    model = os.environ.get("GEMINI_DETECT_MODEL", "gemini-2.5-flash")
    try:
        res = requests.post(
            f"{API_ROOT}/models/{model}:generateContent",
            headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
            json={
                "contents": [
                    {"role": "user", "parts": [{"inlineData": {"mimeType": mime_type, "data": b64}}, {"text": ROLE_DETECT_PROMPT}]}
                ],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "temperature": 0,
                    "thinkingConfig": {"thinkingBudget": 0},
                },
            },
            timeout=30,
        )
        if not res.ok:
            return None
        data = res.json()
        text = next(
            (p["text"] for p in data["candidates"][0]["content"]["parts"] if isinstance(p.get("text"), str)), None
        )
        if not text:
            return None
        role = json.loads(text).get("role")
        return role if role in VALID_ROLES else None
    except Exception:
        return None
