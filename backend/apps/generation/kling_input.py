"""Port of src/lib/kling-input.js — pure builder turning an AssembledPrompt
into Kling's one-image, one-string endpoint shape. See that file's header
for the three faults it fixes (dropped @slug assets, literal @imgN tokens
reaching Kling, ignored shotInstruction) — this port must keep fixing all
three the same way.
"""

import re

from .config import KLING_MAX_REFERENCE_IMAGES
from .mentions import MENTION_RE, TAG_RE

REFERENCE_PHRASE = "the reference image"

PERSON_RULE = (
    "reproduce this exact person — same face and bone structure, jawline, "
    "hairline, eyes, nose, lips, facial hair, hairstyle, build and apparent age, "
    "plus the distinguishing marks shown, and the same medium and rendering "
    "style as the reference. The same individual, never a lookalike, and never "
    "beautified, slimmed or de-aged relative to the reference"
)

SUBJECT_RULE = (
    "reproduce exactly what this shows — same shapes, colours, materials, "
    "patterns and detailing, in the same medium and rendering style"
)


def _escape_re(s: str) -> str:
    return re.escape(s)


def build_kling_input(assembled: dict, model_display: str) -> dict:
    """assembled: the AssembledPrompt dict from prompt_assembler.assemble_prompt.
    Returns {"prompt": str, "reference": AssembledImage | None}."""
    groups = [g for g in assembled["groups"] if g["images"]]
    total = sum(len(g["images"]) for g in groups)

    if total > KLING_MAX_REFERENCE_IMAGES:
        named = ", ".join(g["tag"] for g in groups)
        raise ValueError(
            f"{model_display} accepts {KLING_MAX_REFERENCE_IMAGES} reference image, "
            f"but this prompt resolved to {total} ({named}). Kling's "
            "multi-reference mode is a different model (kling-v3-omni) that is not "
            "available here — use Nano Banana Pro for multi-reference prompts, or "
            "reduce this one to a single reference."
        )

    group = groups[0] if groups else None
    reference = group["images"][0] if group else None

    text = assembled.get("shotInstruction") or assembled["instruction"]

    if group:
        tag = re.sub(r"^@", "", group["tag"])
        text = re.sub(rf"@{_escape_re(tag)}\b", REFERENCE_PHRASE, text, flags=re.IGNORECASE)

    leftover_img_tags = [m.group(0) for m in MENTION_RE.finditer(text)]
    if leftover_img_tags:
        if not reference:
            # dict.fromkeys preserves first-seen order/case, matching `new Set()`.
            unique = list(dict.fromkeys(leftover_img_tags))
            raise ValueError(
                f"This prompt tags {', '.join(unique)} but no "
                "reference image is attached. Attach the image, or remove the tag "
                "from the prompt."
            )
        text = MENTION_RE.sub(REFERENCE_PHRASE, text)

    text = TAG_RE.sub(lambda m: m.group(1), text)

    if group and not assembled.get("shotInstruction"):
        rule = PERSON_RULE if group.get("identity") else SUBJECT_RULE
        text = f"REFERENCE IMAGE — {rule}.\n\n{text}"

    return {"prompt": text, "reference": reference}
