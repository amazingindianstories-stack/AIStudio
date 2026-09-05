"""Port of src/lib/pricing.js — cost model. DEFAULT_PRICING is the seed
data for the `pricing` table (admin-editable in production; this module's
copy is only the seed/fallback, matching the TS file's role). See that
file's header: costCents is computed and stored at generation time, so
editing a rate changes future generations only.
"""

DEFAULT_PRICING = [
    {"model": "Nano Banana 2", "unitCostCents": 5, "unit": "per_image",
     "notes": "Gemini 3.1 Flash Image (direct API); base = 1K, scaled by resolution factor"},
    {"model": "Nano Banana Pro", "unitCostCents": 14, "unit": "per_image",
     "notes": "Gemini 3 Pro Image; base = 1K, scaled by resolution factor"},
    {"model": "Seedance 2.0", "unitCostCents": 8, "unit": "per_second",
     "notes": "BytePlus Seedance standard — base rate at 720p; 480p/1080p scale by VIDEO_RESOLUTION_FACTOR"},
    {"model": "Seedance 2.0 Mini", "unitCostCents": 3, "unit": "per_second",
     "notes": "BytePlus Seedance fast/mini — base rate at 720p; 480p scales by VIDEO_RESOLUTION_FACTOR"},
    {"model": "Seedance 2.0 · audio", "unitCostCents": 2, "unit": "per_second",
     "notes": "PLACEHOLDER — audio surcharge added on top of Seedance 2.0; not yet verified against an invoice"},
    {"model": "Seedance 2.0 Mini · audio", "unitCostCents": 1, "unit": "per_second",
     "notes": "PLACEHOLDER — audio surcharge added on top of Seedance 2.0 Mini; not yet verified against an invoice"},
    {"model": "Seedance 2.5", "unitCostCents": 8, "unit": "per_second",
     "notes": "PLACEHOLDER enqueue-time estimate only, same rough shape as Seedance 2.0's rate — overwritten by "
              "the exact token-based cost (see the per-token rows below) the moment the task succeeds."},
    {"model": "Seedance 2.5 · per-token", "unitCostCents": 1070, "unit": "per_million_tokens",
     "notes": "Official BytePlus rate, no video input (text-to-video / image-to-video / reference-to-video with "
              "no attached clip): $10.70 per 1M tokens."},
    {"model": "Seedance 2.5 · per-token (video input)", "unitCostCents": 640, "unit": "per_million_tokens",
     "notes": "Official BytePlus rate when a reference clip is attached (video-to-video, Edit, Extend): $6.40 "
              "per 1M tokens, cheaper than the no-video-input rate."},
    {"model": "Kling Image 3.0", "unitCostCents": 3, "unit": "per_image",
     "notes": "kling-v3 — vendor list price 8 units ($0.028)/image at 1K and 2K alike; 3¢ is $0.028 rounded up "
              "to whole cents"},
    {"model": "Kling Image 2.1", "unitCostCents": 1, "unit": "per_image",
     "notes": "kling-v2-1 text-to-image — vendor list price 4 units ($0.014)/image at 1K and 2K alike; see the "
              "'· image-to-image' row for reference-image jobs"},
    {"model": "Kling Image 2.1 · image-to-image", "unitCostCents": 3, "unit": "per_image",
     "notes": "kling-v2-1 with a reference image — vendor list price 8 units ($0.028)/image, double the "
              "text-to-image rate"},
    {"model": "Higgsfield Nano Banana Pro", "unitCostCents": 14, "unit": "per_image",
     "notes": "Nano Banana Pro via Higgsfield MCP (comparison test vs direct Gemini)"},
    {"model": "Higgsfield Soul", "unitCostCents": 10, "unit": "per_image",
     "notes": "Higgsfield Soul (photoreal); base = 720p, scaled by resolution factor"},
    {"model": "Higgsfield Seedance 2.0", "unitCostCents": 8, "unit": "per_second",
     "notes": "Seedance 2.0 multi-image via Higgsfield MCP (~3 credits/s)"},
    {"model": "Higgsfield Seedance 2.0 Mini", "unitCostCents": 7, "unit": "per_second",
     "notes": "Seedance 2.0 Mini via Higgsfield MCP — measured 2.5 credits/s at 720p (1/s at 480p). The web "
              "'Mini Unlimited' offer does NOT apply to MCP/API jobs."},
    {"model": "Gemini Omni Flash", "unitCostCents": 10, "unit": "per_second",
     "notes": "gemini-omni-flash-preview (Interactions API); ~$0.10/s 720p output; duration prompt-driven, "
              "billed by requested seconds"},
]

RESOLUTION_FACTOR = {"1K": 1, "1080p": 1, "2K": 1.5, "4K": 3}

IMAGE_RESOLUTION_FLAT_PREFIXES = ("kling ",)


def _image_price_scales_with_resolution(model: str) -> bool:
    return not model.strip().lower().startswith(IMAGE_RESOLUTION_FLAT_PREFIXES)


KLING_UNIT_CENTS = 0.35


def kling_units_to_cents(units) -> int | None:
    """Returns None for anything unparseable, so the caller keeps its
    estimate rather than billing 0."""
    if units is None:
        return None
    if isinstance(units, (int, float)):
        n = float(units)
    else:
        trimmed = str(units).strip()
        if not trimmed:
            return None
        try:
            n = float(trimmed)
        except ValueError:
            return None
    if n != n or n < 0:  # NaN check
        return None
    return round(n * KLING_UNIT_CENTS)


def _seedance_token_row_model(model: str, had_video_input: bool) -> str:
    return f"{model} · per-token{' (video input)' if had_video_input else ''}"


def compute_seedance_token_cost_cents(
    model: str, total_tokens: int | None, had_video_input: bool, pricing: list[dict]
) -> int | None:
    if total_tokens is None or total_tokens < 0:
        return None
    row_model = _seedance_token_row_model(model, had_video_input)
    row = next((p for p in pricing if p["model"] == row_model), None)
    if not row:
        return None
    return round((row["unitCostCents"] * total_tokens) / 1_000_000)


def image_to_image_row_model(model: str) -> str:
    return f"{model} · image-to-image"


VIDEO_RESOLUTION_FACTOR = {"480p": 0.44, "720p": 1, "1080p": 2.46}


def audio_row_model(model: str) -> str:
    return f"{model} · audio"


def compute_cost_cents(input: dict, pricing: list[dict]) -> int:
    """input: {kind, model, resolution?, duration?, generateAudio?,
    hasReferenceImage?}."""
    row = next((p for p in pricing if p["model"] == input["model"]), None)
    if not row:
        return 0

    if row["unit"] == "per_second":
        seconds = input.get("duration") or 0
        resolution = input.get("resolution")
        factor = VIDEO_RESOLUTION_FACTOR.get(resolution, 1) if resolution else 1
        cents = row["unitCostCents"] * seconds * factor
        if input.get("generateAudio"):
            audio = next((p for p in pricing if p["model"] == audio_row_model(input["model"])), None)
            if audio:
                cents += audio["unitCostCents"] * seconds
        return round(cents)

    # per_image
    effective = row
    if input.get("hasReferenceImage"):
        i2i = next((p for p in pricing if p["model"] == image_to_image_row_model(input["model"])), None)
        if i2i:
            effective = i2i
    resolution = input.get("resolution")
    factor = RESOLUTION_FACTOR.get(resolution, 1) if resolution and _image_price_scales_with_resolution(input["model"]) else 1
    return round(effective["unitCostCents"] * factor)


def format_cost(cents: int) -> str:
    return f"${cents / 100:.2f}"
