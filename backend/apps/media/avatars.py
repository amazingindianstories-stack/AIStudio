"""Profile image normalization matching save-media.js dimensions and quality."""
import io
from uuid import uuid4
from .storage import get_storage

MAX_AVATAR_UPLOAD_BYTES = 3 * 1024 * 1024


class InvalidAvatarError(ValueError):
    pass


def save_avatar_image(data):
    if not data:
        raise InvalidAvatarError('The selected image is empty.')
    if len(data) > MAX_AVATAR_UPLOAD_BYTES:
        raise InvalidAvatarError('Profile images must be 3 MB or smaller.')
    try:
        from PIL import Image, ImageOps
        with Image.open(io.BytesIO(data)) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError('Pixel limit exceeded')
            image.load()
            image = ImageOps.exif_transpose(image)
            image = ImageOps.fit(image, (512, 512), method=Image.Resampling.LANCZOS, centering=(0.5, 0.5))
            output = io.BytesIO()
            image.save(output, format='WEBP', quality=84)
            normalized = output.getvalue()
    except Exception as error:
        raise InvalidAvatarError('The selected file is not a valid image.') from error
    return get_storage().upload_buffer(normalized, f'avatars/{uuid4()}.webp', 'webp')


def delete_avatar_image(url):
    if url:
        try:
            get_storage().delete_by_urls([url])
        except Exception:
            pass
