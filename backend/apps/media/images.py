"""Image uploads and expendable preview derivatives; never re-encode masters."""
import base64
import io
import re
from uuid import uuid4
from .keys import validate_key
from .storage import get_storage

MAX_CANVAS_UPLOAD_BYTES = 8 * 1024 * 1024


def split_data_url(value):
    match = re.fullmatch(r'data:image/([a-zA-Z0-9.+-]+);base64,(.*)', value or '', re.S)
    allowed = {'jpeg':'jpg', 'jpg':'jpg', 'png':'png', 'webp':'webp', 'gif':'gif'}
    if not match or match[1].lower() not in allowed:
        raise ValueError('Unsupported image type. Use JPEG, PNG, WebP, or GIF.')
    return allowed[match[1].lower()], match[2]


def save_asset_image(data_url):
    ext, data = split_data_url(data_url)
    return get_storage().upload_base64(data, f'assets/{uuid4()}.{ext}', ext)


def delete_asset_image(url):
    if url:
        get_storage().delete_by_urls([url])


def save_canvas_asset(data_url, board_id=None):
    ext, data = split_data_url(data_url)
    # Enforce the existing limit before allocating the decoded image. Keep the
    # exact decoded-size check for padding boundaries and malformed encodings.
    if len(data) > 4 * ((MAX_CANVAS_UPLOAD_BYTES + 2) // 3):
        raise ValueError('Images must be 8 MB or smaller.')
    decoded = base64.b64decode(data, validate=True)
    if len(decoded) > MAX_CANVAS_UPLOAD_BYTES:
        raise ValueError('Images must be 8 MB or smaller.')
    prefix = f'canvas/{board_id}' if board_id else 'canvas'
    return get_storage().upload_buffer(decoded, f'{prefix}/{uuid4()}.{ext}', ext)


def is_thumbnailable(key):
    return not key.startswith('thumbs/') and key.rsplit('.', 1)[-1].lower() in ('png','jpg','jpeg','webp','gif')


def thumb_key(key, width):
    return f'thumbs/{width}/{key}.webp'


def thumbnail_bytes(data, width):
    from PIL import Image
    with Image.open(io.BytesIO(data)) as image:
        if image.width * image.height > 40_000_000:
            raise ValueError('Image exceeds pixel limit')
        image.load()
        target = min(width, image.width)
        image = image.resize((target, max(1, round(image.height*target/image.width))), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        image.save(output, format='WEBP', quality=75)
        return output.getvalue()


def write_thumbnails(data, key, *, storage=None):
    if not is_thumbnailable(key):
        return
    storage = storage or get_storage()
    for width in (512, 1280):
        derivative = validate_key(thumb_key(key, width))
        storage.primary.put(derivative, thumbnail_bytes(data, width), 'image/webp',
                            'public, max-age=31536000, immutable')


def save_reference_images(inputs, identifier):
    result = []
    count = 0
    for value in inputs:
        if not isinstance(value, str):
            continue
        if not value.startswith('data:'):
            result.append(value)
            continue
        ext, data = split_data_url(value)
        result.append(get_storage().upload_base64(data, f'references/{identifier}-{count}.{ext}', ext))
        count += 1
    return result
