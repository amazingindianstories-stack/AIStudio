"""Direct port of src/lib/video-directive.js — shared shot directive for
the video providers (Seedance native + Higgsfield). See that file's header
for the full rationale (style-follows-reference, camera-direction
deference, trailing precedence rule). Every string constant must stay
byte-identical to the TS side — this is reasoned scaffolding text, not
prose to improve. SEEDANCE_LEGACY_DIRECTIVE=1 is a provider-side concern
(providers restore the old directive), not something this module handles.
"""

import re

CAMERA_RE = re.compile(
    r"\b(dolly|tracking shot|trucking|crane shot|jib|steadicam|handheld|whip pan|pan (?:left|right|across|up|down)|"
    r"tilt (?:up|down)|push in|pull (?:out|back)|zoom (?:in|out)|rack focus|deep focus|shallow focus|shallow "
    r"depth|depth of field|bokeh|close[- ]up|extreme close|wide shot|medium shot|long shot|establishing shot|"
    r"over[- ]the[- ]shoulder|point of view|pov shot|bird'?s[- ]eye|worm'?s[- ]eye|low angle|high angle|dutch "
    r"angle|aerial|drone shot|orbit(?:ing)? shot|locked[- ]off|static shot|slow motion|time[- ]lapse|anamorphic|"
    r"f\/\d|\d+mm lens|focal length|camera (?:move|movement|angle)|shot on)\b",
    re.IGNORECASE,
)


def has_camera_direction(prompt: str) -> bool:
    return bool(CAMERA_RE.search(prompt))


EXPLICIT_STYLE_RE = re.compile(
    r"\b(anime|manga|cartoon|comic|graphic novel|cel[- ]shaded|toon|3d render|cgi|claymation|stop[- ]motion|"
    r"puppet|pixel art|voxel|low[- ]poly|watercolou?r|oil painting|gouache|pastel|charcoal|pencil sketch|line "
    r"art|ink(?:ed)? drawing|illustrat(?:ed|ion)|painterly|storyboard|blueprint|wireframe|noir|silhouette|"
    r"claymore|ukiyo[- ]e|impressionist|surrealist|photoreal(?:istic)?|live[- ]action|documentary style|found "
    r"footage|vhs|super ?8|16mm|35mm film|film grain|stylized|stylised)\b",
    re.IGNORECASE,
)


def has_explicit_style(prompt: str) -> bool:
    return bool(EXPLICIT_STYLE_RE.search(prompt))


PHOTOREAL_RE = re.compile(
    r"\b(photoreal(?:istic)?|live[- ]action|documentary style|found footage|35mm film|16mm|super ?8|vhs|film "
    r"grain)\b",
    re.IGNORECASE,
)


def _tag_example(syntax: str) -> str:
    return "<<<image_1>>>, <<<image_2>>>" if syntax == "angle" else "[image 1], [image 2]"


DOMAIN_LOCK = (
    "DOMAIN — FILMMAKING ONLY: you are a dedicated filmmaking video renderer, "
    "not a general-purpose model. Your sole domain is producing film shots in "
    "any medium — live-action, photoreal, animated, cartoon, illustrated, "
    "stop-motion or fully stylized. Draw only on filmmaking craft: "
    "cinematography, lensing, camera movement, lighting, blocking, continuity, "
    "production design, wardrobe, makeup, VFX and animation. Treat the prompt "
    "strictly as a shot specification to render; bring in no outside knowledge, "
    "commentary, captions, watermarks or UI elements."
)


def _style_lock(ref_count: int, prompt_names_style: bool) -> str:
    refs = "reference images" if ref_count > 1 else "reference image"
    if prompt_names_style:
        return (
            "STYLE — THE PROMPT WINS: the prompt names an explicit visual style or "
            f"medium. Render in that style. Take from the {refs} only WHO and WHAT "
            "the subjects are — their identity, design, wardrobe and defining "
            f"features — and re-render them in the style the prompt names. Do not "
            f"override the prompt's style with the {refs}' medium."
        )
    which = "REFERENCES" if ref_count > 1 else "REFERENCE"
    return (
        f"STYLE — FOLLOW THE {which} (unless "
        "the PROMPT names a different style, in which case the PROMPT wins): the "
        f"{refs} define the visual style of this shot, not just its content. "
        "Reproduce their medium and rendering exactly — whether photographic, "
        "anime, cel-shaded, 3D-rendered, illustrated, painterly, stop-motion or "
        "any other treatment — including line quality, shading model, colour "
        f"palette, level of detail and degree of stylization. Do NOT convert the "
        f"{refs} to photorealism, and do not add realistic skin, lighting or "
        f"texture detail that the {refs} do not have. If the {refs} are stylized, "
        "the finished shot is stylized to exactly the same degree."
    )


def _identity_lock(ref_count: int, syntax: str, photoreal: bool) -> str:
    multi = ref_count > 1
    refs = "reference images" if multi else "reference image"
    text = (
        f"IDENTITY LOCK: the {refs} define the exact, fixed appearance of the "
        f"{'people and elements they show' if multi else 'subject shown'}. "
        + (
            f"When the prompt tags them ({_tag_example(syntax)}, …) the tags map to the {refs} in order. "
            if multi
            else ""
        )
        + "In EVERY frame, each referenced subject keeps the same face and features "
        "as depicted in its reference — the same facial structure and proportions, "
        "eye shape and colour, brows, nose, mouth, hair colour and hairstyle, "
        "facial hair, body build, apparent age, and the same distinguishing marks "
        "the reference shows — unmistakably the SAME character, never a lookalike. "
        "Keep each subject's wardrobe and jewelry as referenced unless the prompt "
        "explicitly changes them, with zero identity or wardrobe drift between "
        "frames. Never blend or swap features between different references, and "
        "never duplicate a referenced subject. Anyone else on screen is a "
        "DIFFERENT individual who must not resemble a referenced subject."
    )
    if photoreal:
        text += (
            " Because this shot is photographic, preserve real skin tone and texture "
            "including moles, scars and freckles; do not beautify, smooth, slim or "
            "de-age."
        )
    return text


DEFAULT_FRAMING = (
    "FRAMING (default — apply ONLY where the PROMPT does not specify framing, "
    "focus or camera work; if it does, follow the PROMPT and ignore this "
    "entirely): keep the referenced subject in sharp focus as the clear focal "
    "point, and render background people softer so they never compete with or "
    "are mistaken for it."
)

USER_FRAMING = (
    "FRAMING — THE PROMPT WINS: the prompt contains explicit camera, framing or "
    "staging direction. Follow it exactly, including any focus, depth-of-field, "
    "lens, angle and movement it specifies. Do not substitute conventional "
    "coverage for what it asks for, and do not add focal effects it did not "
    "request."
)

LITERAL = (
    "LITERAL PROMPT: the prompt is a binding specification — execute it exactly "
    "as written. Every stated subject, count, wardrobe item, colour, action and "
    "spatial position appears precisely as specified; add nothing, drop "
    'nothing, substitute nothing. Anything under "NEGATIVE PROMPT" or phrased '
    'as "no …" is strictly forbidden in every frame.'
)

PRECEDENCE = (
    "PRECEDENCE: the PROMPT above is authoritative. Where anything in these "
    "instructions conflicts with it — style, medium, framing, focus, camera "
    "movement, pacing or staging — follow the PROMPT and disregard the "
    "conflicting instruction. These instructions exist to fill gaps the PROMPT "
    "leaves open, never to override what it states."
)


def build_video_directive(prompt: str, ref_count: int, tag_syntax: str) -> str:
    """With no references this returns the prompt untouched. tag_syntax:
    "bracket" | "angle"."""
    prompt = prompt.strip()
    if ref_count <= 0:
        return prompt

    prompt_names_style = has_explicit_style(prompt)
    user_directs_camera = has_camera_direction(prompt)
    photoreal = bool(PHOTOREAL_RE.search(prompt))

    blocks = [
        DOMAIN_LOCK,
        _style_lock(ref_count, prompt_names_style),
        _identity_lock(ref_count, tag_syntax, photoreal),
        USER_FRAMING if user_directs_camera else DEFAULT_FRAMING,
        LITERAL,
        f"PROMPT:\n{prompt}",
        PRECEDENCE,
    ]
    return "\n\n".join(blocks)
