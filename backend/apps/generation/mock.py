"""Port of src/lib/mock.js — MOCK_GENERATION=1 fabricates placeholders so
the UI can be demoed without real API keys.

Deviates from the TS version in one way: the TS file writes an SVG to
Next's `public/generations/` static directory and returns a `/generations/
<id>.svg` path. Railway's container has no equivalent static-file serving
path wired up (Django's media system is `/api/media/...`, backed by
S3/GCS), so this writes through `storage.upload_buffer` instead and
returns a normal `/api/media/...` URL — same placeholder behavior, just
routed through the one media path this backend actually serves.
"""

import os
import random
import uuid
import xml.sax.saxutils as saxutils

from apps.media import storage

PALETTES = [
    ("#1f2937", "#0ea5e9"),
    ("#3b0764", "#ec4899"),
    ("#052e16", "#22c55e"),
    ("#431407", "#f97316"),
    ("#1e1b4b", "#6366f1"),
]


def is_mock() -> bool:
    return os.environ.get("MOCK_GENERATION") == "1"


def _ratio_to_wh(ratio: str) -> tuple[int, int]:
    try:
        w_str, h_str = ratio.split(":")
        w, h = int(w_str), int(h_str)
    except (ValueError, AttributeError):
        return 1280, 720
    if not w or not h:
        return 1280, 720
    scale = 1280 / max(w, h)
    return round(w * scale), round(h * scale)


def mock_placeholder(item_id: str, prompt: str, ratio: str, label: str) -> str:
    w, h = _ratio_to_wh(ratio)
    pal = random.choice(PALETTES)
    short = (prompt[:90] + "…") if len(prompt) > 90 else prompt
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="{pal[0]}"/>
      <stop offset="1" stop-color="{pal[1]}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <text x="24" y="44" font-family="sans-serif" font-size="22" fill="rgba(255,255,255,0.85)">{saxutils.escape(label)}</text>
  <text x="24" y="{h - 28}" font-family="sans-serif" font-size="20" fill="rgba(255,255,255,0.7)">{saxutils.escape(short)}</text>
</svg>"""
    key = f"generations/{item_id}-{uuid.uuid4().hex[:8]}.svg"
    return storage.upload_buffer(svg.encode("utf-8"), key, "svg")
