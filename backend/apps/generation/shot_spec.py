"""Direct port of src/lib/shot-spec.js — deterministic shot-spec text
assembly (pure, no API calls). Everything here is templated/auditable,
never an LLM rewrite of the user's prompt — see the TS file's header for
why (the 2026-07 movie-camera incident, the higgsfield-nbp-parity
research). Consumed by prompt_assembler.py only when PROMPT_SHOT_SPEC=1.

Every string constant here must stay byte-identical to the TS side —
these are bake-off-measured wordings, not prose to improve.
"""

import re

RefRole = str  # "person" | "outfit" | "location" | "style" | "prop" | "object"

# Kept character-for-character in sync with KIND_RULE in prompt_assembler.py
# (duplicated, not shared — this module must stay import-free of anything
# with side effects, matching the TS module's design).
ROLE_RULE: dict[str, str] = {
    "person": (
        "reproduce this exact person with exact fidelity to the reference, in the SAME medium and rendering style "
        "as the reference (photographic, illustrated, anime, cel-shaded, 3D, painterly or otherwise — never convert "
        "it to a different medium, and never add realism the reference does not have) — identical face shape and "
        "bone structure, jawline, cheekbones, hairline, eye shape/size/spacing and color, eyebrows, nose, lips, "
        "ears, facial hair, hairstyle, body build and apparent age, plus the same distinguishing marks the "
        "reference shows; where the reference is photographic, also keep real skin tone and texture (moles, scars, "
        "freckles, wrinkles); unmistakably the SAME individual, never a lookalike, and never beautified, slimmed, "
        "de-aged or idealized relative to the reference"
    ),
    "outfit": (
        "reproduce this exact outfit — same garments, cut, fit, fabric, colors, patterns, trims and details, plus "
        "any jewelry/accessories shown with it"
    ),
    "location": "reproduce this exact place — same architecture, layout, materials, signage, furnishing and mood",
    "style": "match this exact visual style — same rendering, palette, grain and lighting treatment",
    "prop": "reproduce this exact object — same shape, colors, materials, markings and wear",
    "object": (
        "reproduce this exact object/element as shown — same shape, colors, materials and details, used exactly "
        "as the SCENE directs"
    ),
}


def role_rule(role: str) -> str:
    return ROLE_RULE[role]


ROLE_LABEL = {
    "person": "FACE/IDENTITY",
    "outfit": "OUTFIT",
    "location": "LOCATION",
    "style": "STYLE",
    "prop": "PROP",
    "object": "OBJECT",
}


def role_header(tag: str, role: str, image_count: int) -> str:
    plural = "image" if image_count == 1 else "images"
    return f"{tag} — {ROLE_LABEL[role]} reference ({image_count} {plural}): {role_rule(role)}."


ROLE_KEYWORDS: list[tuple[str, re.Pattern]] = [
    ("outfit", re.compile(
        r"\b(outfit|dress|garment|wearing|lehenga|saree|sari|suit|gown|jacket|attire|clothing|clothes|costume)\b",
        re.IGNORECASE,
    )),
    ("location", re.compile(
        r"\b(location|nightclub|club|place|background|room|set|environment|venue|backdrop|scene|school|classroom|"
        r"campus|corridor|hallway|building|interior|exterior|architecture|house|home|office|street|road|"
        r"landscape)\b",
        re.IGNORECASE,
    )),
    ("style", re.compile(r"\b(style|aesthetic|grade|palette|mood|tone|filter)\b", re.IGNORECASE)),
    ("person", re.compile(r"\b(face|identity|person|character|portrait|likeness|subject|individual)\b", re.IGNORECASE)),
]

TAG_TOKEN = re.compile(r"@([a-z][a-z0-9_-]*)", re.IGNORECASE)


def parse_ref_roles(prompt: str) -> dict[str, str]:
    """For each @imgN / @slug tag occurrence, scan a small word window
    around the mention for role keywords. First match wins. Tags with no
    inferable role are omitted from the map. Pure; case-insensitive."""
    result: dict[str, str] = {}
    tokens = [t for t in re.split(r"\s+", prompt) if t]
    window = 6

    for i, token in enumerate(tokens):
        m = TAG_TOKEN.match(token)
        if not m:
            continue
        tag = f"@{m.group(1).lower()}"
        if tag in result:
            continue

        start = max(0, i - window)
        end = min(len(tokens), i + window + 1)
        window_text = " ".join(tokens[start:end])
        for role, pattern in ROLE_KEYWORDS:
            if pattern.search(window_text):
                result[tag] = role
                break
    return result


def infer_non_person_role(prompt: str) -> str:
    for role, pattern in ROLE_KEYWORDS:
        if role != "person" and pattern.search(prompt):
            return role
    return "object"


EXPLICIT_ROLE_TERMS = {
    "person": "face|identity|person|character|portrait|likeness|subject|individual",
    "outfit": "outfit|dress|garment|lehenga|saree|sari|suit|gown|jacket|attire|clothing|clothes|costume",
    "location": (
        "location|nightclub|club|place|background|room|set|environment|venue|backdrop|school|classroom|campus|"
        "corridor|hallway|building|interior|exterior|architecture|house|home|office|street|road|landscape"
    ),
    "style": "style|aesthetic|grade|palette|mood|tone|filter",
    "prop": "prop|object|item",
    "object": "object|element|item",
}


def _escape_regexp(value: str) -> str:
    return re.escape(value)


def has_explicit_ref_role(prompt: str, tag: str, role: str) -> bool:
    """True only when prompt grammar binds a role directly to a tag, rather
    than merely mentioning a scene keyword inside parse_ref_roles' broad
    context window."""
    escaped_tag = _escape_regexp(tag)
    terms = EXPLICIT_ROLE_TERMS[role]
    tag_then_role = re.compile(
        rf"{escaped_tag}(?:\([^)]*\))?\s+(?:as|for|is|defines?|shows?)\s+(?:the\s+)?(?:exact\s+)?(?:{terms})\b",
        re.IGNORECASE,
    )
    role_then_tag = re.compile(
        rf"\b(?:{terms})\b\s+(?:reference\s+)?(?:from|using|of|at|in)\s+{escaped_tag}(?:\([^)]*\))?",
        re.IGNORECASE,
    )
    return bool(tag_then_role.search(prompt) or role_then_tag.search(prompt))


def _legend_line(tag: str, role: str, is_person: bool) -> str:
    if is_person:
        return (
            f"{tag} = the exact face/identity of the subject — must be reproduced with exact fidelity to the "
            "reference and in its medium, never a lookalike."
        )
    return {
        "outfit": f"{tag} = the exact outfit worn by the subject.",
        "location": f"{tag} = the exact location/setting of the scene.",
        "style": f"{tag} = the exact visual style/grade to match.",
        "prop": f"{tag} = the exact prop/object to reproduce.",
        "object": f"{tag} = the exact object/element to reproduce.",
    }.get(role, f"{tag} = a reference to reproduce exactly.")


def build_reference_legend(entries: list[dict]) -> str | None:
    """entries: [{"tag", "role", "isPerson"}, ...]."""
    if not entries:
        return None
    lines = [_legend_line(e["tag"], e["role"], e["isPerson"]) for e in entries]
    return "REFERENCES:\n" + "\n".join(lines)


HUMAN_NOUN_SOURCE = (
    "people|persons?|humans?|men|women|man|woman|boys?|girls?|children|child|"
    "bab(?:y|ies)|adults?|students?|pupils?|teachers?|staff|workers?|employees?|"
    "guards?|officers?|doctors?|nurses?|patients?|customers?|shoppers?|"
    "passengers?|drivers?|pedestrians?|visitors?|tourists?|guests?|residents?|"
    "farmers?|vendors?|waiters?|waitresses?|chefs?|soldiers?|actors?|actresses?|"
    "dancers?|singers?|musicians?|athletes?|players?|artists?|photographers?|"
    "pilots?|attendants?|bartenders?|cashiers?|monks?|priests?|friends?|parents?|"
    "mothers?|fathers?|moms?|dads?|brothers?|sisters?|husbands?|wives|wife|"
    "partners?|owners?|leaders?|members?|teenagers?|teens?|youths?|protagonists?|"
    "characters?"
)

NEGATED_HUMANS_RE = re.compile(
    rf"\b(?:no|without)\s+(?:(?:any|a|an|visible|additional|other)\s+)?"
    rf"(?:{HUMAN_NOUN_SOURCE})(?:\s*(?:,|and|or)\s*(?:{HUMAN_NOUN_SOURCE}))*\b",
    re.IGNORECASE,
)

HUMAN_LABELLED_OBJECT_RE = re.compile(
    r"\b(?:students?|pupils?|teachers?|staff|workers?|employees?|visitors?|"
    r"passengers?|drivers?|children|child)(?:['’]s?|s['’])?\s+"
    r"(?:desks?|chairs?|tables?|areas?|lounges?|rooms?|sections?|entrances?|"
    r"exits?|lockers?|uniforms?|signs?|zones?)\b",
    re.IGNORECASE,
)

POSITIVE_HUMAN_NOUN_RE = re.compile(
    rf"\b(?:{HUMAN_NOUN_SOURCE}|crowd|audience|couple|family|families|bride|"
    rf"groom|hero|heroine|subject|individual|portrait|selfie|face|identity|"
    rf"male|female|elderly|eyes?|hands?|arms?|legs?|head|body|bodies|skin|hair)\b",
    re.IGNORECASE,
)

HUMAN_PRONOUN_RE = re.compile(r"\b(?:he|she|him|her|his|hers|they|them|their|theirs|someone|somebody)\b", re.IGNORECASE)

HUMAN_ACTION_RE = re.compile(
    r"\b(?:stands?|standing|sits?|sitting|seated|walks?|walking|runs?|running|poses?|posing|wears?|wearing|"
    r"dressed|holds?|holding|smiles?|smiling|laughs?|laughing|cries|crying|speaks?|speaking|talks?|talking|"
    r"kneels?|kneeling|dances?|dancing|sings?|singing|gestures?|gesturing)\b",
    re.IGNORECASE,
)

NAMED_LOOK_RE = re.compile(
    r"\b(?!Camera\b|View\b|Viewpoint\b|Shot\b|Lens\b|Angle\b|Perspective\b)[A-Z][a-z][A-Za-z'-]*\s+"
    r"(?:is\s+)?(?:looking|facing|gazing)\b"
)


def has_visible_people(raw_prompt: str, has_person_reference: bool = False) -> bool:
    if has_person_reference:
        return True
    positive_text = NEGATED_HUMANS_RE.sub(" ", raw_prompt)
    positive_text = HUMAN_LABELLED_OBJECT_RE.sub(" ", positive_text)
    return bool(
        POSITIVE_HUMAN_NOUN_RE.search(positive_text)
        or HUMAN_PRONOUN_RE.search(positive_text)
        or HUMAN_ACTION_RE.search(positive_text)
        or NAMED_LOOK_RE.search(positive_text)
    )


VIEWPOINT_DIRECTION_RE = re.compile(
    r"\b(?:(?:camera|view(?:point)?|shot|angle|perspective|lens)\s+(?:is\s+)?(?:looking|pointing|facing|tilting?)"
    r"\s+(?:straight\s+)?(?:up|down)|(?:looking|viewed|seen|shot|filmed)\s+(?:straight\s+)?(?:up|down)|"
    r"(?:from|viewed\s+from)\s+(?:directly\s+)?(?:above|below)|top[- ]down|bottom[- ]up|bird['’]?s[- ]eye|"
    r"worm['’]?s[- ]eye|overhead|high[- ]angle|low[- ]angle)\b",
    re.IGNORECASE,
)

ZERO_CAST_POLICY = (
    "CAST: CAST COUNT 0. Render the requested setting and objects unoccupied. "
    "Do not invent any physically present person, bystander, crowd, camera "
    "operator, observer, or human silhouette. Any inferred details must be "
    "non-human and belong to the requested environment."
)

VIEWPOINT_POLICY = (
    'VIEWPOINT: directional phrases such as "looking down" or "looking up" '
    "describe the virtual camera/view orientation only; they do not imply an "
    "observer or on-screen character."
)


def build_cast_policy(raw_prompt: str, has_person_reference: bool = False) -> str | None:
    if has_visible_people(raw_prompt, has_person_reference):
        return None
    if VIEWPOINT_DIRECTION_RE.search(raw_prompt):
        return f"{ZERO_CAST_POLICY}\n{VIEWPOINT_POLICY}"
    return ZERO_CAST_POLICY


def build_framing_coda(aspect_ratio: str, medium: str = "image", subject_mode: str = "person") -> str | None:
    if aspect_ratio not in ("16:9", "21:9"):
        return None
    if medium == "video":
        return (
            "FRAMING: keep the subject large and prominent through the whole shot — "
            "a hero composition within the wide field, one coherent camera move, "
            "the subject remaining the clear focal point across every frame, never "
            "small or distant; background and environment stay supporting, in sharp "
            "focus but not competing with the subject for size."
        )
    if subject_mode == "environment":
        return (
            "FRAMING: compose only the explicitly requested setting and objects "
            "across the wide field; do not invent a foreground figure to satisfy "
            "the composition. Keep architecture and environment detailed, sharp, "
            "and visually balanced."
        )
    return (
        "FRAMING: keep the subject large and prominent in the frame — a hero "
        "composition within the wide field, the subject filling roughly half to "
        "two-thirds of the frame height and placed in the frame's power zone, "
        "never small or distant; background and environment stay supporting, "
        "in sharp focus but not competing with the subject for size."
    )


NEGATIVE_CODA = (
    "blur or softness on the subject, smeared or plasticky skin, washed-out or "
    "muddy color cast, loss of background/environment detail, a small or "
    "distant subject, extra or duplicated limbs, warped anatomy."
)

ENVIRONMENT_NEGATIVE_CODA = (
    "unrequested people, bystanders, crowds or human silhouettes, invented "
    "foreground figures, blur or softness on the requested focal elements, "
    "washed-out or muddy color cast, loss of architecture or environment detail."
)

VIDEO_NEGATIVE_CODA = (
    "identity or wardrobe drift between frames, face morphing, flicker, "
    "duplicated or extra limbs, warped anatomy, a small or distant subject, "
    "smeared or plasticky skin."
)


def build_shot_instruction(
    raw_prompt: str,
    legend: str | None,
    aspect_ratio: str,
    medium: str = "image",
    has_person_reference: bool = False,
) -> str:
    """Compose the final structured instruction. raw_prompt is inserted
    VERBATIM. buildShotInstruction owns the "SCENE:" prefix — callers must
    not re-add it."""
    subject_mode = (
        "environment" if medium == "image" and not has_visible_people(raw_prompt, has_person_reference) else "person"
    )
    framing_coda = build_framing_coda(aspect_ratio, medium, subject_mode)

    blocks: list[str] = []
    if legend:
        blocks.append(legend)
    blocks.append(f"SCENE: {raw_prompt}")

    tail: list[str] = []
    if framing_coda:
        tail.append(framing_coda)
    if medium == "video":
        avoid = VIDEO_NEGATIVE_CODA
    elif subject_mode == "environment":
        avoid = ENVIRONMENT_NEGATIVE_CODA
    else:
        avoid = NEGATIVE_CODA
    tail.append(f"AVOID: {avoid}")
    blocks.append("\n".join(tail))

    return "\n\n".join(blocks)
