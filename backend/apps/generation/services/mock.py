"""Explicit offline generation fixture; never selected by missing credentials."""
import hashlib
import io
from PIL import Image, ImageDraw
from apps.media.storage import get_storage


def mock_placeholder(identifier, prompt, aspect_ratio, model):
    try:
        width, height = map(float, aspect_ratio.split(':'))
        height = max(64, min(2048, round(768 * height / width)))
    except (ValueError, ZeroDivisionError):
        height = 768
    digest = hashlib.sha256(identifier.encode()).digest()
    image = Image.new('RGB', (768, height), tuple(40 + channel % 90 for channel in digest[:3]))
    draw = ImageDraw.Draw(image)
    draw.text((32, 32), 'MOCK GENERATION', fill='white')
    draw.text((32, 60), model[:70], fill='white')
    buffer = io.BytesIO()
    image.save(buffer, format='PNG')
    return get_storage().upload_buffer(buffer.getvalue(), f'generations/{identifier}.png', 'png')
