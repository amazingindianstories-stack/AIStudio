"""Image bounds shared by the BytePlus asset library and Seedance image references.

Each side must be 300-6000 px, the aspect ratio 0.4-2.5 and the file at most 30 MB. Dimensions are read from
the first bytes of the image (Pillow stops as soon as the header is parsed), never by decoding the whole file.
"""
import base64
import io
import re

from PIL import Image

MIN_SIDE, MAX_SIDE, MIN_RATIO, MAX_RATIO = 300, 6000, 0.4, 2.5
MAX_BYTES = 30 * 1024 * 1024
HEADER_BYTES = 4 * 1024 * 1024
SIZE_TAIL = 'Resize it and try again; nothing was queued.'
WORKER_TAIL = 'Resize it and try again; nothing was sent to the provider, so this was not charged.'
SEEDANCE_RULE = (f'Seedance needs at least {MIN_SIDE} px on the short side and an aspect ratio between '
                 f'{MIN_RATIO:g} and {MAX_RATIO:g}.')
# Matches enqueue and worker copy: "<label> is W x H px. <rule> <tail>".
SEEDANCE_MESSAGE = re.compile(r'[^\n]{1,100} is \d{1,6} x \d{1,6} px\. ' + re.escape(SEEDANCE_RULE) + ' ('
                              + re.escape(SIZE_TAIL) + '|' + re.escape(WORKER_TAIL) + ')')


ORIENTED_FORMATS = ('JPEG', 'MPO', 'WEBP', 'TIFF')     # EXIF orientation is parsed with the header; PNG's getexif() would decode every pixel


def dimensions(chunks):
    """(width, height) from an iterable of byte chunks, or None when the header cannot be read in the first few MB.
    Only the header is parsed, never the pixels. Orientation is honoured where the format keeps it in the header."""
    buffer = bytearray()
    for chunk in chunks:
        buffer += chunk
        try:
            with Image.open(io.BytesIO(buffer)) as image:       # lazy: reads only the header, no pixel decode
                width, height = image.size
                orientation = image.getexif().get(0x0112) if image.format in ORIENTED_FORMATS else None
        except Exception:
            if len(buffer) >= HEADER_BYTES:
                return None
            continue
        return (height, width) if orientation in (5, 6, 7, 8) else (width, height)
    return None


def data_url_dimensions(ref):
    match = re.fullmatch(r'data:image/[^;]+;base64,(.*)', ref, re.S)
    if not match:
        return None
    try:
        return dimensions([base64.b64decode(match[1][:(HEADER_BYTES // 3) * 4], validate=False)])
    except Exception:
        return None


def stored_dimensions(storage, key):
    try:
        media = storage.open(key)
    except Exception:
        return None
    try:
        return dimensions(media.stream)
    finally:
        try:
            media.stream.close()
        except Exception:
            pass


def side_problem(width, height):
    """'size' when a side is outside 300..6000, else 'ratio' when the aspect ratio is outside 0.4..2.5, else None."""
    if min(width, height) < MIN_SIDE or max(width, height) > MAX_SIDE:
        return 'size'
    if not MIN_RATIO <= width / height <= MAX_RATIO:
        return 'ratio'
    return None


def seedance_problem(width, height):
    """Seedance image references: a short side under 300 px or a ratio outside 0.4-2.5 (larger images are downscaled)."""
    return min(width, height) < MIN_SIDE or not MIN_RATIO <= width / height <= MAX_RATIO


def seedance_message(label, width, height, tail):
    return f'{label} is {width} x {height} px. {SEEDANCE_RULE} {tail}'


def reference_dimensions(ref, storage=None):
    """Dimensions of a data URL or stored reference; None for anything else (asset ids, outside URLs) or when unreadable."""
    if not isinstance(ref, str) or not ref or ref.startswith('asset://') or re.search(r'[?&#]bp[-_]asset', ref):
        return None
    if ref.startswith('data:'):
        return data_url_dimensions(ref)
    from django.conf import settings
    from apps.media.keys import media_key_from_ref
    from apps.media.storage import get_storage
    try:
        key = media_key_from_ref(ref.split('#', 1)[0], getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
        return stored_dimensions(storage or get_storage(), key) if key else None
    except Exception:
        return None
