"""Direct port of src/lib/media-derivatives.js — pure, unit-testable. See
that file's header for the full reasoning (derivatives are write-path work
because the source object is immutable, ladder chosen from real call-site
widths, never upscale). Keep both sides numerically identical — THUMB_LADDER
here must match the TS array exactly or a card requesting a width Django
doesn't have a step for silently falls back to serving the full original."""

THUMB_LADDER = (512, 1280)

RASTER_EXT = {"png", "jpg", "jpeg", "webp", "gif"}

THUMB_PREFIX = "thumbs/"


def key_extension(key: str) -> str:
    base = key.split("/")[-1]
    dot = base.rfind(".")
    return "" if dot == -1 else base[dot + 1 :].lower()


def is_thumbnailable(key: str) -> bool:
    if key.startswith(THUMB_PREFIX):
        return False
    return key_extension(key) in RASTER_EXT


def thumb_ladder_width(width: int) -> int | None:
    for step in THUMB_LADDER:
        if step >= width:
            return step
    return None


def thumb_key(key: str, width: int) -> str:
    return f"{THUMB_PREFIX}{width}/{key}.webp"


def original_key_from_thumb(key: str) -> dict | None:
    if not key.startswith(THUMB_PREFIX):
        return None
    rest = key[len(THUMB_PREFIX) :]
    slash = rest.find("/")
    if slash == -1:
        return None
    width_str = rest[:slash]
    original = rest[slash + 1 :]
    if not width_str.isdigit() or not original.endswith(".webp"):
        return None
    return {"key": original[: -len(".webp")], "width": int(width_str)}
