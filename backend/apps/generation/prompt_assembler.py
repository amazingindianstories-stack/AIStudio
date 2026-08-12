"""Port of src/lib/prompt-assembler.js — context engineering for asset
consistency (server-only). See that file's header for the full design
rationale: role-labeled reference GROUPS bound to @tags via headers, plus
identity TILES (face crops sent as extra images) so Gemini — which ingests
every image as one flat ~258-token tile — gets real facial bandwidth.

This is the single most measured file in the migration. Every branch here
mirrors the TS file's branch for branch; if you change one side, change
the other in the same change.
"""

import os

from apps.media import storage

from . import shot_spec as ss
from .image_prep import analyze_identity_reference, detect_reference_role, prep_reference
from .mentions import parse_asset_slugs, parse_mention_indices

KIND_LABEL = {
    "character": "CHARACTER",
    "outfit": "OUTFIT",
    "location": "LOCATION",
    "style": "STYLE",
    "prop": "PROP",
}

ASSET_KIND_TO_ROLE = {
    "character": "person",
    "outfit": "outfit",
    "location": "location",
    "style": "style",
    "prop": "prop",
}

KIND_RULE = {
    "character": (
        "reproduce this exact person with exact fidelity to the reference, in the SAME medium and rendering "
        "style as the reference (photographic, illustrated, anime, cel-shaded, 3D, painterly or otherwise — "
        "never convert it to a different medium, and never add realism the reference does not have) — identical "
        "face shape and bone structure, jawline, cheekbones, hairline, eye shape/size/spacing and color, "
        "eyebrows, nose, lips, ears, facial hair, hairstyle, body build and apparent age, plus the same "
        "distinguishing marks the reference shows; where the reference is photographic, also keep real skin "
        "tone and texture (moles, scars, freckles, wrinkles); unmistakably the SAME individual, never a "
        "lookalike, and never beautified, slimmed, de-aged or idealized relative to the reference"
    ),
    "outfit": (
        "reproduce this exact outfit — same garments, cut, fit, fabric, colors, patterns, trims and details, "
        "plus any jewelry/accessories shown with it"
    ),
    "location": "reproduce this exact place — same architecture, layout, materials, signage, furnishing and mood",
    "style": "match this exact visual style — same rendering, palette, grain and lighting treatment",
    "prop": "reproduce this exact object — same shape, colors, materials, markings and wear",
}


def _read_all(refs: list[str]) -> list[dict]:
    out = []
    for ref in refs:
        try:
            mime_type, data = storage.read_as_base64(ref)
            out.append(prep_reference(mime_type, data))
        except Exception:
            pass
    return out


def _face_crops(images: list[dict], tag: str, limit: int = 2) -> list[dict]:
    return _analyze_face_crops(images, tag, limit)["tiles"]


def _analyze_face_crops(images: list[dict], tag: str, limit: int = 2) -> dict:
    out: list[dict] = []
    saw_person = saw_non_person = saw_unknown = False
    for img in images[:limit]:
        if len(out) >= 3:
            break
        analysis = analyze_identity_reference(img["mimeType"], img["data"], 3 - len(out))
        out.extend(analysis["crops"])
        if analysis["personReference"] is True:
            saw_person = True
        elif analysis["personReference"] is False:
            saw_non_person = True
        else:
            saw_unknown = True
    print(f"[middleware] {tag}: identity tile{'s' if len(out) != 1 else ''} "
          f"{f'added ({len(out)})' if out else 'none (not a person ref / no face)'}")
    person_reference = True if saw_person else (None if saw_unknown else (False if saw_non_person else None))
    return {"tiles": out, "personReference": person_reference}


def _resolve_upload_role(
    tag: str, first_image: dict, tiles: list[dict], text_roles: dict, role_detect_on: bool
) -> str:
    text_role = text_roles.get(tag)
    if text_role:
        # Cross-check is diagnostic only in the TS version (fire-and-forget,
        # logged on mismatch). Not worth the synchronous latency here either,
        # and we don't have a background-task facility to fire it into — the
        # prompt-text role is authoritative regardless, so skipping the
        # cross-check changes no behavior, only drops a WARN log line.
        return text_role
    detected = detect_reference_role(first_image["mimeType"], first_image["data"]) if role_detect_on else None
    return detected or ("person" if tiles else "object")


def assemble_prompt(prompt: str, assets: list[dict], uploads: list[str], aspect_ratio: str | None = None, medium: str = "image") -> dict:
    """assets: [{"slug","kind","name","description","images"}, ...] (already
    dicts, not ORM instances — callers pass the serialized asset shape).

    Returns {"instruction", "shotInstruction", "groups", "judgeFace"}.
    """
    groups: list[dict] = []
    asset_lines: list[str] = []

    shot_spec_on = os.environ.get("PROMPT_SHOT_SPEC") == "1"
    role_detect_on = os.environ.get("PROMPT_ROLE_DETECT") == "1"
    text_roles = ss.parse_ref_roles(prompt) if shot_spec_on else {}
    legend_entries: list[dict] = []

    # 1) Named asset references (@slug).
    slugs = parse_asset_slugs(prompt)
    by_slug = {a["slug"]: a for a in assets}
    for slug in slugs:
        asset = by_slug.get(slug)
        if not asset or not asset.get("images"):
            continue
        images = _read_all(asset["images"])
        if not images:
            continue
        label = KIND_LABEL[asset["kind"]]
        desc = f" — {asset['description']}" if asset.get("description") else ""
        asset_lines.append(f"- @{asset['slug']} → {label} \"{asset['name']}\"{desc}. Rule: {KIND_RULE[asset['kind']]}.")
        is_character = asset["kind"] == "character"
        tag = f"@{asset['slug']}"
        header = (
            f"@{asset['slug']} — {label} \"{asset['name']}\" "
            f"({len(images)} reference image{'s' if len(images) > 1 else ''}; {KIND_RULE[asset['kind']]}):"
        )
        if shot_spec_on:
            role = ASSET_KIND_TO_ROLE[asset["kind"]]
            header = ss.role_header(tag, role, len(images))
            legend_entries.append({"tag": tag, "role": role, "isPerson": role == "person"})
        groups.append({
            "tag": tag, "header": header, "images": images, "identity": is_character,
            "tiles": _face_crops(images, tag) if is_character else None,
        })

    # 2) Ad-hoc uploads.
    if uploads:
        tagged = [n for n in parse_mention_indices(prompt) if n <= len(uploads)]

        def push_legacy_subject(images: list[dict], prepared_tiles: list[dict] | None = None) -> None:
            if not images:
                return
            many = len(images) > 1
            asset_lines.append(
                f"- SUBJECT → the person in the reference image{'s' if many else ''} below. "
                "Rule: the main subject in the output MUST be this exact same person — "
                "identical face, hairstyle, build and visible outfit/jewelry unless "
                "the SCENE explicitly changes them, rendered in the same medium and "
                "style as the reference."
            )
            tiles = prepared_tiles if prepared_tiles is not None else _face_crops(images, "SUBJECT")
            if many:
                header = (
                    f"SUBJECT — {len(images)} reference images of the SAME person "
                    "(different angles/lighting). Reconstruct ONE consistent identity "
                    "from all of them; the generated person's face MUST match exactly — "
                    "same bone structure, jawline, hairline, eye shape/spacing and color, "
                    "eyebrows, nose, lips, facial hair and apparent age, and where the "
                    "references are photographic also their skin tone/texture (keep "
                    "moles, scars, freckles). Keep their hairstyle, "
                    "build and worn outfit/jewelry unless the SCENE explicitly changes "
                    "them, and render in the same medium and style as the references. "
                    "A recognizable match, never a lookalike — never beautified "
                    "or idealized relative to the references:"
                )
            else:
                header = (
                    "SUBJECT — reference image of the person. The generated person's face "
                    "MUST be this exact same individual — same bone structure, jawline, "
                    "hairline, eye shape/spacing and color, eyebrows, nose, lips, facial "
                    "hair and apparent age, and where the reference is photographic also "
                    "their skin tone/texture (keep moles, scars, freckles). "
                    "Keep their hairstyle, build and worn outfit/jewelry "
                    "unless the SCENE explicitly changes them, and render in the same "
                    "medium and style as the reference. A recognizable match, "
                    "not a lookalike — never beautified or idealized relative to the reference:"
                )
            if shot_spec_on:
                header = ss.role_header("SUBJECT", "person", len(images))
                legend_entries.append({"tag": "SUBJECT", "role": "person", "isPerson": True})
            groups.append({
                "tag": "SUBJECT", "tiles": tiles if tiles else None, "header": header,
                "images": images, "identity": True,
            })

        def push_non_person_group(tag: str, role: str, images: list[dict]) -> None:
            asset_lines.append(f"- {tag} → {role.upper()} REFERENCE.")
            header = ss.role_header(tag, role, len(images))
            legend_entries.append({"tag": tag, "role": role, "isPerson": False})
            groups.append({"tag": tag, "header": header, "images": images, "identity": False})

        if len(tagged) > 1:
            for n in tagged:
                images = _read_all([uploads[n - 1]])
                if not images:
                    continue
                tag = f"@img{n}"
                asset_lines.append(
                    f"- @img{n} → REFERENCE. Rule: reproduce the tagged subject from this "
                    "image exactly — if it is a person, the identical face (bone "
                    "structure, eyes, nose, lips, skin tone/texture, marks, hairline, "
                    "facial hair, apparent age), hairstyle, build and visible "
                    f"outfit/jewelry, changed only where the SCENE explicitly says so. "
                    f"Never blend @img{n} with any other reference."
                )
                tiles = _face_crops(images, tag, 1)
                header = (
                    f"{tag} — REFERENCE (reproduce this subject exactly; if a person, "
                    "the same individual — identical facial features, never a lookalike):"
                )
                identity = len(tiles) > 0
                if shot_spec_on:
                    role = "person" if tiles else _resolve_upload_role(tag, images[0], tiles, text_roles, role_detect_on)
                    header = ss.role_header(tag, role, len(images))
                    legend_entries.append({"tag": tag, "role": role, "isPerson": role == "person"})
                    identity = role == "person"
                groups.append({
                    "tag": tag, "header": header, "images": images, "identity": identity,
                    "tiles": tiles if (identity and tiles) else None,
                })
        elif len(tagged) == 1 and shot_spec_on:
            n = tagged[0]
            tag = f"@img{n}"
            images = _read_all([uploads[n - 1]])
            if images:
                text_role = text_roles.get(tag)
                tiles = _face_crops(images, tag, 1)
                explicit_text_role = text_role is not None and ss.has_explicit_ref_role(prompt, tag, text_role)
                detected_role = None
                if text_role != "person" and not tiles and not explicit_text_role:
                    detected_role = detect_reference_role(images[0]["mimeType"], images[0]["data"])
                role = (
                    "person" if (text_role == "person" or tiles)
                    else (text_role if explicit_text_role else (detected_role or "person"))
                )
                if role == "person":
                    if len(uploads) == 1:
                        push_legacy_subject(images, tiles)
                    else:
                        push_legacy_subject(_read_all(uploads))
                else:
                    push_non_person_group(tag, role, images)
        else:
            images = _read_all(uploads)
            if not shot_spec_on or not images:
                push_legacy_subject(images)
            else:
                tiles = _face_crops(images, "SUBJECT")
                if ss.has_visible_people(prompt) or tiles:
                    push_legacy_subject(images, tiles)
                else:
                    detected_role = detect_reference_role(images[0]["mimeType"], images[0]["data"])
                    if detected_role and detected_role != "person":
                        push_non_person_group("REFERENCE", detected_role, images)
                    else:
                        push_legacy_subject(images, tiles)

    judge_face = None
    for g in groups:
        if g.get("identity") and g.get("tiles"):
            judge_face = g["tiles"][0]
            break

    shot_instruction = None
    if shot_spec_on:
        legend = ss.build_reference_legend(legend_entries)
        shot_instruction = ss.build_shot_instruction(
            raw_prompt=prompt,
            legend=legend,
            aspect_ratio=aspect_ratio or "1:1",
            medium=medium,
            has_person_reference=any(e["isPerson"] for e in legend_entries),
        )

    return {"instruction": prompt, "shotInstruction": shot_instruction, "groups": groups, "judgeFace": judge_face}
