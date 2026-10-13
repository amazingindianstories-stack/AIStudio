"""Strict Magnific input boundary before any billable submission."""
import base64
import io
import math
import re
from urllib.parse import urljoin, urlsplit
from PIL import Image
from apps.common.javascript import string, utf16_length
from apps.generation.providers.magnific import MODELS, PRESETS, ENGINES

MAX_BYTES = 20*1024*1024
MAX_PIXELS = 40000000
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$', re.I)
MIMES = ('image/jpeg', 'image/png', 'image/webp')
SCALES = ('2x', '4x', '8x', '16x')


class InvalidUpscaleRequest(ValueError):
    pass


def fail(message):
    raise InvalidUpscaleRequest(message)


def validate_upscale_request(body):
    body = body if isinstance(body, dict) else {}
    model = body.get('model')
    if model not in MODELS: fail('Unsupported upscale model.')
    if not isinstance(body.get('image'), str) or not body['image']: fail('Source image is required for upscaling.')
    for key in ('projectId', 'folderId'):
        if body.get(key) is not None and not UUID.fullmatch(string(body[key])): fail(f'Invalid {key}.')
    params = body.get('params')
    if not isinstance(params, dict): fail('Invalid upscale parameters.')
    allowed = ['model', 'filterNsfw'] + (
        ['scaleFactor','optimizedFor','engine','creativity','hdr','resemblance','fractality','prompt'] if model == 'Magnific Creative' else
        ['scaleFactor','flavor','sharpen','smartGrain','ultraDetail'] if model == 'Magnific Precision V2' else ['sharpen','smartGrain','ultraDetail'])
    for key in params:
        if key not in allowed: fail(f'Parameter {key} is not supported by {model}.')
    if params.get('model') is not None and params['model'] != model: fail('Parameter model does not match model.')
    if params.get('prompt') is not None and (not isinstance(params['prompt'], str) or utf16_length(params['prompt']) > 2000): fail('Prompt must be 2000 characters or fewer.')
    if params.get('filterNsfw') is not None and type(params['filterNsfw']) is not bool: fail('filterNsfw must be boolean.')
    def numeric(key, minimum, maximum):
        value = params.get(key)
        if type(value) not in (int, float) or not math.isfinite(value) or not minimum <= value <= maximum:
            fail(f'{key} must be between {minimum} and {maximum}.')
    if model == 'Magnific Creative':
        if params.get('scaleFactor') not in SCALES: fail('Invalid scaleFactor.')
        if params.get('optimizedFor') not in PRESETS: fail('Invalid optimizedFor preset.')
        if params.get('engine') not in ENGINES: fail('Invalid engine.')
        for key in ('creativity','hdr','resemblance','fractality'): numeric(key, -10, 10)
    else:
        for key in ('sharpen','smartGrain','ultraDetail'): numeric(key, 0, 100)
        if model == 'Magnific Precision V2':
            if params.get('scaleFactor') not in SCALES: fail('Invalid scaleFactor.')
            if params.get('flavor') not in ('photo','sublime','photo_denoiser'): fail('Invalid flavor.')
    return body


def validate_source(value, origin):
    if value.startswith('data:'): return
    try:
        # WHATWG treats backslashes as slashes for HTTP special schemes.
        parsed = urlsplit(urljoin(origin+'/', value.replace('\\', '/')))
        base = urlsplit(origin)
        port = parsed.port or (443 if parsed.scheme == 'https' else 80)
        base_port = base.port or (443 if base.scheme == 'https' else 80)
        same = (parsed.scheme, parsed.hostname, port) == (base.scheme, base.hostname, base_port)
    except ValueError:
        fail('Invalid source image URL.')
    if not same or not parsed.path.startswith('/api/media/'): fail('Source image must be uploaded to this application.')


def inspect_image(data, declared_mime):
    try:
        decoded = base64.b64decode(data)
    except (ValueError, TypeError):
        fail('Source is not a valid supported image.')
    if len(decoded) > MAX_BYTES: fail('Source image must be 20 MB or smaller.')
    if string(declared_mime).lower() not in MIMES: fail('Source must be a JPEG, PNG, or WebP image.')
    try:
        image = Image.open(io.BytesIO(decoded))
        # Sharp's limitInputPixels fails in metadata before the explicit gate.
        if image.width*image.height > MAX_PIXELS: raise ValueError()
    except Exception:
        fail('Source is not a valid supported image.')
    with image:
        if not image.width or not image.height: fail('Source image exceeds the 40 megapixel limit.')
        detected = 'image/' + ('jpeg' if image.format == 'JPEG' else (image.format or '').lower())
        if detected not in MIMES or detected != declared_mime.lower(): fail('Source image type does not match its contents.')
        return {'buffer': decoded, 'meta': {'width': image.width, 'height': image.height}}


def aspect_ratio(width, height):
    if not width or not height: return '1:1'
    ratios = ['1:1','16:9','9:16','4:3','3:4','3:2','2:3','21:9']
    distances = [abs(width/height-int(label.split(':')[0])/int(label.split(':')[1])) for label in ratios]
    index = distances.index(min(distances))
    return ratios[index] if distances[index] < .08 else f'{width}:{height}'


def validate_output_area(model, params, meta):
    # The Creative endpoint documents a 25.3M-pixel output maximum. Do not
    # silently reduce scale/source quality or spend on a known invalid request.
    if model == 'Magnific Creative':
        scale = int(params['scaleFactor'][:-1])
        if meta['width'] * meta['height'] * scale * scale > 25300000:
            fail('Magnific Creative output cannot exceed 25.3 megapixels. Choose a smaller scale or source image.')
