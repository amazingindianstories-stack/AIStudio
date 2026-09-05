"""Direct port of src/lib/media-sniff.js — keep both in sync.

Sniffs an image's real format from its own bytes rather than trusting a
(mostly absent) content-type or an extensionless/UUID-keyed URL. BUG-03: the
history/download-zip route used to call
`_extension_from_content_type(None, item.url)` with `None` hardcoded as the
content-type argument, so every content-type branch was dead code and it
always fell through to guessing from the URL — which is ".bin" for the
common case of a storage key with no extension. By the time this runs,
`read_stored_buffer()` has already returned the full buffer, so the magic
number is right there.

Only formats this app actually writes to image storage are recognised (PNG,
JPEG, WebP, GIF, AVIF). Video is deliberately out of scope — the one call
site filters to `kind == "image"` before reaching this function.
"""


def extension_from_bytes(data: bytes, fallback_url: str) -> str:
    b = data
    if len(b) >= 8 and b[0] == 0x89 and b[1] == 0x50 and b[2] == 0x4E and b[3] == 0x47:
        return "png"
    if len(b) >= 3 and b[0] == 0xFF and b[1] == 0xD8 and b[2] == 0xFF:
        return "jpg"
    if (
        len(b) >= 12
        and b[0:4] == b"RIFF"
        and b[8:12] == b"WEBP"
    ):
        return "webp"
    if len(b) >= 4 and b[0:4] == b"GIF8":  # GIF87a or GIF89a
        return "gif"
    if len(b) >= 12 and b[4:8] == b"ftyp":  # ISOBMFF box
        brand = b[8:12]
        if brand in (b"avif", b"avis"):
            return "avif"

    # Genuinely unrecognised bytes — fall back to the URL, same as before.
    base = fallback_url.split("?")[0]
    url_ext = base.rsplit(".", 1)[-1].lower() if "." in base else ""
    return url_ext if url_ext and len(url_ext) <= 5 else "bin"
