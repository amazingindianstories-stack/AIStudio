"""Validate original Seedream references; normalize only oversized inputs."""
import base64
import math
from django.conf import settings
from apps.media.keys import media_key_from_ref, is_protected_key
from apps.media.storage import get_storage

MAX_PIXELS, MAX_BYTES, TARGET_BYTES = 36000000, 30000000, 29000000
CORRUPT = 'Reference is corrupt, animated, unsupported, or too large to decode. Use a still PNG, JPEG, WebP, or TIFF image.'


def require_native_image_runtime():
    try:
        import pyvips
    except (ImportError, OSError):
        raise ValueError('The native image runtime is unavailable. Try again after service recovery.') from None
    return pyvips


def normalize_seedream_reference(data):
    pyvips = require_native_image_runtime()
    try:
        image = pyvips.Image.new_from_buffer(data, '', fail_on='error')
        loader = image.get('vips-loader')
        format = next((kind for kind in ('jpeg','png','webp','tiff','gif','heif') if kind in loader), None)
        pages = image.get('n-pages') if image.get_typeof('n-pages') else 1
        width, height, alpha = image.width, image.height, image.hasalpha()
        if not format or pages > 1 or width*height > 150000000: raise ValueError()
        image.avg()  # Force complete decode, including truncated-tail failures.
        if width <= 14 or height <= 14 or not 1/16 <= width/height <= 16:
            raise ValueError('dimensions')
    except Exception as error:
        if str(error) == 'dimensions':
            raise ValueError('Reference dimensions must exceed 14 pixels with an aspect ratio between 1:16 and 16:1.') from None
        raise ValueError(CORRUPT) from None
    ext = 'jpg' if format == 'jpeg' else format
    if width*height <= MAX_PIXELS and len(data) <= MAX_BYTES:
        return {'bytes': data, 'ext': ext, 'changed': False}
    scale = min(1, math.sqrt(MAX_PIXELS/(width*height)))
    for _ in range(20):
        w, h = math.floor(width*scale), math.floor(height*scale)
        if w <= 14 or h <= 14: break
        resized = image.resize(min(w/width, h/height), kernel='lanczos3')
        output = resized.pngsave_buffer(strip=True) if alpha else resized.colourspace('srgb').jpegsave_buffer(Q=92, strip=True)
        if len(output) < TARGET_BYTES: return {'bytes':output,'ext':'png' if alpha else 'jpg','changed':True}
        scale *= .9
    raise ValueError('Reference could not fit the 30 MB limit. Export a smaller PNG or JPEG.')


def prepare_seedream_references(references, identifier, *, signal=None, sign=True, persist=True,
                               read=None, upload=None, sign_ref=None, user_id=None):
    if not references: return {'stable':[], 'urls':[]}
    require_native_image_runtime()
    storage = get_storage() if read is None or upload is None or sign_ref is None else None
    read = read or getattr(storage,'read_reference_bytes',None) or storage.read_as_base64
    upload = upload or storage.upload_buffer
    def default_sign(ref):
        key = media_key_from_ref(ref, getattr(settings,'GCP_MEDIA_CDN_URL',''))
        try:
            return storage.signed_read_url(key, actor_id=user_id)
        except Exception as cloud_error:
            from apps.media.grants import media_grant_url
            try:
                return media_grant_url(key, actor_id=user_id)
            except Exception as grant_error:
                raise ValueError(f'{grant_error} (cloud signing also failed: {cloud_error})') from None
    sign_ref = sign_ref or default_sign
    stable, urls = [], []
    for index, ref in enumerate(references):
        if signal: signal.check()
        key = media_key_from_ref(ref, getattr(settings,'GCP_MEDIA_CDN_URL','')) if isinstance(ref,str) else None
        if not key or is_protected_key(key) or '..' in key or any(char in key for char in '?#'):
            raise ValueError('Use an uploaded or stored original image as the reference.')
        try:
            raw = read(ref)
        except Exception:
            raise ValueError(f'Reference {index+1} could not be read. Upload it again.') from None
        # Injected historical readers may still provide base64; production
        # storage supplies original bytes without encoding and decoding them.
        normalized = normalize_seedream_reference(raw['bytes'] if 'bytes' in raw else base64.b64decode(raw['data']))
        if signal: signal.check()
        stored = upload(normalized['bytes'],f"references/{identifier}-seedream-{index}.{normalized['ext']}",normalized['ext']) if normalized['changed'] and persist else ref
        stable.append(stored)
        if sign: urls.append(sign_ref(stored))
        # Do not retain the previous payload while reading the next reference.
        del raw, normalized
    return {'stable':stable,'urls':urls}
