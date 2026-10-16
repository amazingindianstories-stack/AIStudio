"""Chat reference validation and transient preview resizing; masters stay intact."""
import base64
import io
from django.conf import settings
from apps.generation.watermark import WHITESPACE
from apps.media.images import split_data_url
from apps.media.keys import media_key_from_ref, is_protected_key
from apps.media.storage import get_storage

MIME = {'jpg': 'image/jpeg', 'png': 'image/png', 'webp': 'image/webp', 'gif': 'image/gif'}


def parse_message_body(body):
    content = body.get('content').strip(WHITESPACE) if isinstance(body.get('content'), str) else ''
    if not content:
        return {'error': 'content is required.'}
    if len(content.encode('utf-16-le', errors='surrogatepass')) // 2 > 8000:
        return {'error': 'Message is too long (max 8000 characters).'}
    if 'images' in body and not isinstance(body['images'], list):
        return {'error': 'images must be an array of data URLs.'}
    images = [value for value in body.get('images', []) if isinstance(value, str)]
    if len(images) > 10:
        return {'error': 'Attach at most 10 reference images per message.'}
    return {'content': content, 'images': images}


def prep_reference(mime, data):
    try:
        from PIL import Image
        with Image.open(io.BytesIO(base64.b64decode(data))) as image:
            if max(image.size) <= 2048:
                return {'mimeType': mime, 'data': data}
            image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.convert('RGB').save(output, format='JPEG', quality=92)
            return {'mimeType': 'image/jpeg', 'data': base64.b64encode(output.getvalue()).decode()}
    except Exception:
        return {'mimeType': mime, 'data': data}


def images_to_parts(refs, storage=None):
    parts = []
    for ref in refs:
        if ref.startswith('data:'):
            ext, data = split_data_url(ref)
            mime = MIME[ext]
        else:
            key = media_key_from_ref(ref, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
            if not key or is_protected_key(key):
                raise ValueError('Use stored reference images.')
            storage = storage or get_storage()
            raw = storage.read_as_base64(ref)
            preview = prep_reference(raw['mimeType'], raw['data'])
            ext, data = split_data_url(f'data:{preview["mimeType"]};base64,{preview["data"]}')
            mime = MIME[ext]
        parts.append({'inlineData': {'mimeType': mime, 'data': data}})
    return parts
