"""Bounded display derivatives for authorized media reads.

Callers authorize first. Originals are never rewritten: derivatives are written
create-only under ``thumbs/<width>/<key>.webp`` across tiered widths so zoomed-out
boards serve tiny WebP previews while close-up views and downloads keep native
masters intact.

Uses libvips (pyvips) sequential streaming to decode large 20-100 MB masters in
bounded memory and build all missing tiers from a single read of the original.
Per-key in-flight deduplication and a bounded multi-slot semaphore prevent
thundering herds from falling back to multi-megabyte master PNGs.
"""
import io
import os
import tempfile
import threading
import time
from pathlib import Path

THUMB_WIDTHS = (256, 512, 1280)
MAX_INPUT_BYTES = 128 * 1024 * 1024
MAX_PIXELS = 80_000_000
READ_DEADLINE_SECONDS = 20
GATE_WAIT_SECONDS = 8.0
IMAGE_TYPES = {
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/avif',
    'image/tiff',
    'image/bmp',
    'image/heic',
    'image/heif',
}
DERIVATIVE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
READY_UPLOAD_PREFIXES = (
    'uploads/image-reference/',
    'uploads/canvas/',
    'uploads/material/',
    'uploads/portrait/',
)
_GATE = threading.BoundedSemaphore(4)
_INFLIGHT_LOCK = threading.Lock()
_INFLIGHT = {}

_TIER_QUALITY = {256: 72, 512: 75, 1280: 78}


def derivative_step(width):
    """Map a requested pixel width to the smallest derivative tier that covers it, or None for full-res."""
    return next((step for step in THUMB_WIDTHS if width and step >= width), None)


def derivative_key(key, width):
    return f'thumbs/{width}/{key}.webp'


def _quality_for(width):
    return _TIER_QUALITY.get(width, 75)


def ready_upload_is_image(key):
    """Extensionless READY image uploads qualify; filename extensions are checked elsewhere."""
    if not isinstance(key, str) or not key.startswith(READY_UPLOAD_PREFIXES):
        return False
    from .models import UploadSession
    row = UploadSession.objects.filter(key=key).only('state', 'finalized_at', 'content_type').first()
    return bool(
        row
        and row.state == 'ready'
        and row.finalized_at
        and (row.content_type or '').split(';', 1)[0].lower() in IMAGE_TYPES
    )


def _encode_tiers_pyvips(path, widths):
    import pyvips

    header = pyvips.Image.new_from_file(str(path), access='sequential')
    if not 0 < header.width * header.height <= MAX_PIXELS:
        raise ValueError('Display derivative pixel bound')
    ordered = sorted(set(widths), reverse=True)
    max_w = ordered[0]
    # Shrink-on-load / sequential streaming keeps RSS flat even on 50+ MB PNGs;
    # materialize only the small downscaled image once so every smaller tier reuses it.
    current = pyvips.Image.thumbnail(str(path), max_w, height=10_000_000, size='down').copy_memory()
    results = {}
    for target in ordered:
        if current.width > target:
            current = current.thumbnail_image(target, height=10_000_000, size='down')
        results[target] = bytes(current.write_to_buffer('.webp', Q=_quality_for(target), effort=2))
    return results


def _encode_tiers_pillow(source, widths):
    from PIL import Image, ImageOps

    ordered = sorted(set(widths), reverse=True)
    with Image.open(source) as raw:
        if not 0 < raw.width * raw.height <= MAX_PIXELS:
            raise ValueError('Display derivative pixel bound')
        if raw.format not in ('PNG', 'JPEG', 'WEBP', 'GIF', 'TIFF', 'BMP', 'AVIF', 'HEIF'):
            raise ValueError('Display derivative image format')
        raw.load()
        current = ImageOps.exif_transpose(raw)
        if current.mode not in ('RGB', 'RGBA'):
            current = current.convert('RGBA' if 'A' in current.getbands() else 'RGB')
        results = {}
        for target in ordered:
            if current.width > target:
                current = current.resize(
                    (target, max(1, round(current.height * target / current.width))),
                    Image.Resampling.LANCZOS,
                )
            out = io.BytesIO()
            current.save(out, format='WEBP', quality=_quality_for(target), method=2)
            results[target] = out.getvalue()
        return results


def encode_tiers_from_file(path, widths=THUMB_WIDTHS):
    """Decode one staged image file and encode all requested WebP widths in descending order."""
    try:
        return _encode_tiers_pyvips(path, widths)
    except (ImportError, OSError):
        return _encode_tiers_pillow(str(path), widths)


def encode_tiers_from_bytes(data, widths=THUMB_WIDTHS):
    """Encode all requested WebP widths from in-memory image bytes."""
    if not data:
        raise ValueError('Empty image buffer')
    try:
        import pyvips

        header = pyvips.Image.new_from_buffer(data, '', access='sequential')
        if not 0 < header.width * header.height <= MAX_PIXELS:
            raise ValueError('Display derivative pixel bound')
        ordered = sorted(set(widths), reverse=True)
        current = pyvips.Image.thumbnail_buffer(data, ordered[0], height=10_000_000, size='down').copy_memory()
        results = {}
        for target in ordered:
            if current.width > target:
                current = current.thumbnail_image(target, height=10_000_000, size='down')
            results[target] = bytes(current.write_to_buffer('.webp', Q=_quality_for(target), effort=2))
        return results
    except (ImportError, OSError):
        return _encode_tiers_pillow(io.BytesIO(data), widths)


def encode_display(data, width):
    """Encode a single WebP display derivative from bytes."""
    return encode_tiers_from_bytes(data, (width,))[width]


def _create_only(primary, key, data):
    put = getattr(primary, 'put_create_only', None)
    if put is not None:
        return put(key, data, 'image/webp', DERIVATIVE_CACHE_CONTROL)
    primary.put(key, data, 'image/webp', DERIVATIVE_CACHE_CONTROL)
    return True


def write_derivatives_from_file(path, key, *, storage=None, widths=THUMB_WIDTHS):
    """Generate and store create-only WebP derivatives for an already-staged local file."""
    from .images import is_thumbnailable
    from .keys import validate_key
    from .storage import get_storage

    if not is_thumbnailable(key):
        return {}
    storage = storage or get_storage()
    encoded = encode_tiers_from_file(path, widths)
    written = {}
    for width, payload in encoded.items():
        derivative = validate_key(derivative_key(key, width))
        _create_only(storage.primary, derivative, payload)
        written[width] = derivative
    return written


def _stage_original(storage, key, *, clock, deadline):
    """Stream an original image to a temp file within byte/time bounds, or return None."""
    original = storage.open(key)
    try:
        content_type = (original.content_type or '').split(';', 1)[0].lower()
        if content_type not in IMAGE_TYPES or not 0 < original.content_length <= MAX_INPUT_BYTES:
            return None
        fd, temp_name = tempfile.mkstemp(prefix='veevee-thumb-')
        total = 0
        try:
            with os.fdopen(fd, 'wb') as staged:
                for chunk in original.stream:
                    if clock() > deadline or total + len(chunk) > MAX_INPUT_BYTES:
                        raise ValueError('Original exceeds time or byte bound')
                    staged.write(chunk)
                    total += len(chunk)
            if total != original.content_length:
                raise ValueError('Truncated original stream')
            return Path(temp_name)
        except Exception:
            Path(temp_name).unlink(missing_ok=True)
            return None
    finally:
        original.stream.close()


def bounded_derivative(storage, key, width, *, encode=encode_display, gate=_GATE, clock=time.monotonic,
                       seconds=READ_DEADLINE_SECONDS):
    """Return ``(target_key, fresh_bytes_or_None)``; never raises for a derivative failure.

    ``seconds`` bounds reading the original; at 0 an existing derivative is used and none is made.
    When using the default encoder, all standard tiers are produced from one read of the master.
    """
    derivative = derivative_key(key, width)
    if storage.exists(derivative):
        return derivative, None
    if seconds <= 0:
        return key, None

    default_gate = gate is _GATE
    inflight_event = None
    is_owner = False

    if default_gate:
        with _INFLIGHT_LOCK:
            existing = _INFLIGHT.get(key)
            if existing is None:
                inflight_event = threading.Event()
                _INFLIGHT[key] = inflight_event
                is_owner = True
            else:
                inflight_event = existing
        if not is_owner:
            inflight_event.wait(timeout=min(seconds, GATE_WAIT_SECONDS))
            return (derivative, None) if storage.exists(derivative) else (key, None)

    acquired = False
    try:
        if default_gate:
            acquired = gate.acquire(timeout=min(seconds, GATE_WAIT_SECONDS))
        else:
            acquired = gate.acquire(blocking=False)
        if not acquired:
            return key, None

        if storage.exists(derivative):
            return derivative, None

        deadline = clock() + seconds
        staged = _stage_original(storage, key, clock=clock, deadline=deadline)
        if staged is None:
            return key, None
        try:
            if encode is encode_display:
                tiers = tuple(sorted(set(THUMB_WIDTHS) | {width}))
                encoded = encode_tiers_from_file(staged, tiers)
                requested_fresh = None
                for tier_width, payload in encoded.items():
                    tier_key = derivative_key(key, tier_width)
                    created = _create_only(storage.primary, tier_key, payload)
                    if tier_width == width and created:
                        requested_fresh = payload
                if requested_fresh is not None:
                    return derivative, requested_fresh
                return (derivative, None) if storage.exists(derivative) else (key, None)
            else:
                fresh = encode(staged.read_bytes(), width)
                if _create_only(storage.primary, derivative, fresh):
                    return derivative, fresh
                return (derivative, None) if storage.exists(derivative) else (key, None)
        finally:
            staged.unlink(missing_ok=True)
    except Exception:
        return key, None
    finally:
        if acquired:
            gate.release()
        if is_owner:
            with _INFLIGHT_LOCK:
                if _INFLIGHT.get(key) is inflight_event:
                    _INFLIGHT.pop(key, None)
            inflight_event.set()
