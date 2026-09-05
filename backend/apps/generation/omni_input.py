"""Port of src/lib/omni-input.js — turns an AssembledPrompt into Gemini
Omni Flash's Interactions API `input` array. Mirrors providers/gemini.py's
build_parts (header -> images -> tiles-under-budget -> SCENE -> FINAL
CHECK). Same contract: user reference images are NEVER dropped to fit a
budget — only identity tiles yield, and exceeding the cap on user images
is a loud error, not a silent truncation."""

OMNI_MAX_IMAGES = 14


def build_omni_input(assembled: dict) -> list[dict]:
    instruction = assembled["instruction"]
    shot_instruction = assembled.get("shotInstruction")
    groups = assembled["groups"]

    user_images = sum(len(g["images"]) for g in groups)
    if user_images > OMNI_MAX_IMAGES:
        raise ValueError(
            f"Too many reference images: {user_images}. Gemini Omni Flash accepts "
            f"at most {OMNI_MAX_IMAGES} images per prompt — remove {user_images - OMNI_MAX_IMAGES}."
        )

    budget = OMNI_MAX_IMAGES - user_images
    parts: list[dict] = []
    has_identity = False

    for group in groups:
        parts.append({"type": "text", "text": group["header"]})
        for img in group["images"]:
            parts.append({"type": "image", "mime_type": img["mimeType"], "data": img["data"]})
        if group.get("identity"):
            has_identity = True
        for tile in group.get("tiles") or []:
            if budget <= 0:
                break
            parts.append({"type": "image", "mime_type": tile["mimeType"], "data": tile["data"]})
            budget -= 1

    parts.append({
        "type": "text",
        "text": shot_instruction if shot_instruction else (f"SCENE: {instruction}" if groups else instruction),
    })

    if has_identity:
        parts.append({
            "type": "text",
            "text": (
                "FINAL CHECK: every person referenced above must be a 1:1 photographic "
                "match to their reference images (bone structure, eyes, nose, lips, "
                "jawline, skin tone, apparent age) in every frame of the video. If "
                "not, correct it."
            ),
        })

    return parts
