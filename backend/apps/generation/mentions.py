"""Direct port of src/lib/mentions.js — shared @imgN reference-tag logic."""

import re

MENTION_RE = re.compile(r"@img(\d+)", re.IGNORECASE)
VIDEO_MENTION_RE = re.compile(r"@vid(\d+)", re.IGNORECASE)
TAG_RE = re.compile(r"@([a-z][a-z0-9_-]*)", re.IGNORECASE)


def is_img_tag(slug: str) -> bool:
    return bool(re.match(r"^img\d+$", slug, re.IGNORECASE))


def is_vid_tag(slug: str) -> bool:
    return bool(re.match(r"^vid\d+$", slug, re.IGNORECASE))


def parse_asset_slugs(prompt: str) -> list[str]:
    """Named asset slugs referenced in a prompt, first-appearance order,
    excluding ad-hoc @imgN tokens. @vidN is a clip tag, not an asset slug —
    without that exclusion it would be looked up as a saved asset named
    "vid1", found nothing, and silently stayed in the prompt as text."""
    seen: set[str] = set()
    order: list[str] = []
    for m in TAG_RE.finditer(prompt):
        slug = m.group(1).lower()
        if is_img_tag(slug) or is_vid_tag(slug) or slug in seen:
            continue
        seen.add(slug)
        order.append(slug)
    return order


def parse_mention_indices(prompt: str) -> list[int]:
    indices = {int(m.group(1)) for m in MENTION_RE.finditer(prompt) if int(m.group(1)) >= 1}
    return sorted(indices)


def parse_video_mention_indices(prompt: str) -> list[int]:
    indices = {int(m.group(1)) for m in VIDEO_MENTION_RE.finditer(prompt) if int(m.group(1)) >= 1}
    return sorted(indices)


def resolve_video_references(prompt: str, clips: list[str]) -> list[str]:
    """Which attached clips to actually send: an explicit @vidN tag is
    intent, no tags means send them all."""
    if not clips:
        return []
    tagged = [n for n in parse_video_mention_indices(prompt) if n <= len(clips)]
    indices = tagged if tagged else list(range(1, len(clips) + 1))
    return [clips[n - 1] for n in indices]


def resolve_references(prompt: str, uploads: list[str]) -> list[dict]:
    """Which uploaded images to actually send: an explicit @imgN tag is
    intent (send only those); no tags means send all uploads. Out-of-range
    tags (e.g. @img9 with 2 uploads) are ignored."""
    if not uploads:
        return []
    tagged = [n for n in parse_mention_indices(prompt) if n <= len(uploads)]
    indices = tagged if tagged else list(range(1, len(uploads) + 1))
    return [{"tag": f"@img{n}", "index": n, "dataUrl": uploads[n - 1]} for n in indices]


def renumber_img_mentions(prompt: str, mapping: list[int | None]) -> str:
    """Rewrites @imgN tokens so they keep pointing at the same physical
    image after the upload array is reordered. mapping[oldIndex] (0-based)
    is the image's new 0-based index; an old index missing from mapping
    (out of range) is left untouched."""

    def replace(m: re.Match) -> str:
        old_index = int(m.group(1)) - 1
        new_index = mapping[old_index] if 0 <= old_index < len(mapping) else None
        return m.group(0) if new_index is None else f"@img{new_index + 1}"

    return MENTION_RE.sub(replace, prompt)
