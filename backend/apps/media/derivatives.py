"""Bounded display derivatives for authorized media reads.

Callers authorize first. Originals are never rewritten: a derivative is written
create-only under ``thumbs/<width>/<key>.webp``. One decode runs per process at
a time; a busy or failing request falls back to the original instead of queueing
full-size decodes (each can hold hundreds of MB).
"""
import io
import threading
import time

MAX_INPUT_BYTES = 32 * 1024 * 1024
MAX_PIXELS = 20_000_000
READ_DEADLINE_SECONDS = 12
IMAGE_TYPES = {'image/png', 'image/jpeg', 'image/webp', 'image/gif'}
DERIVATIVE_CACHE_CONTROL = 'private, max-age=31536000, immutable'
_GATE = threading.BoundedSemaphore(1)


def derivative_key(key, width):
    return f'thumbs/{width}/{key}.webp'


def ready_upload_is_image(key):
    """Extensionless READY image uploads qualify; filename extensions are checked elsewhere."""
    if not key.startswith('uploads/image-reference/'):
        return False
    from .models import UploadSession
    row = UploadSession.objects.filter(key=key).only('state', 'finalized_at', 'content_type').first()
    return bool(row and row.state == 'ready' and row.finalized_at
                and (row.content_type or '').split(';', 1)[0].lower() in IMAGE_TYPES)


def encode_display(data, width):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        if not 0 < image.width * image.height <= MAX_PIXELS:
            raise ValueError('Display derivative pixel bound')
        if image.format not in ('PNG', 'JPEG', 'WEBP', 'GIF'):
            raise ValueError('Display derivative image format')
        image.load()
        target = min(width, image.width)
        image = image.resize((target, max(1, round(image.height * target / image.width))), Image.Resampling.LANCZOS)
        out = io.BytesIO()
        image.save(out, format='WEBP', quality=75)
        return out.getvalue()


def _create_only(primary, key, data):
    put = getattr(primary, 'put_create_only', None)
    if put is not None:
        return put(key, data, 'image/webp', DERIVATIVE_CACHE_CONTROL)
    primary.put(key, data, 'image/webp', DERIVATIVE_CACHE_CONTROL)
    return True


def bounded_derivative(storage, key, width, *, encode=encode_display, gate=_GATE, clock=time.monotonic):
    """Return ``(target_key, fresh_bytes_or_None)``; never raises for a derivative failure."""
    derivative = derivative_key(key, width)
    if storage.exists(derivative):
        return derivative, None
    if not gate.acquire(blocking=False):
        return key, None
    try:
        if storage.exists(derivative):
            return derivative, None
        original = storage.open(key)
        try:
            content_type = (original.content_type or '').split(';', 1)[0].lower()
            if content_type not in IMAGE_TYPES or not 0 < original.content_length <= MAX_INPUT_BYTES:
                return key, None
            data = bytearray()
            deadline = clock() + READ_DEADLINE_SECONDS
            for chunk in original.stream:
                if clock() > deadline or len(data) + len(chunk) > MAX_INPUT_BYTES:
                    return key, None
                data.extend(chunk)
            if len(data) != original.content_length:
                return key, None
            fresh = encode(bytes(data), width)
        finally:
            original.stream.close()
        if _create_only(storage.primary, derivative, fresh):
            return derivative, fresh
        return (derivative, None) if storage.exists(derivative) else (key, None)
    except Exception:
        return key, None
    finally:
        gate.release()
