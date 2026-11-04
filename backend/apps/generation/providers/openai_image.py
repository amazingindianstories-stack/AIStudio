"""OpenAI GPT Image 2.5 adapter: one synchronous Images API call per job, billed by the usage it returns.

developers.openai.com/api/docs/guides/image-generation and /api/reference/resources/images/methods/{generate,edit}
(read 2026-11-04): JSON bodies on /v1/images/generations and /v1/images/edits; edits take up to 16 `images` as
data URLs; prompts up to 32,000 characters; `size` is WxH with both edges multiples of 16, a long:short ratio of at
most 3:1, a longest edge of at most 3840 and 655,360 to 8,294,400 pixels; the response carries `data[].b64_json`
and a token `usage` object.
"""
import base64
import io
import os
import re

from apps.generation import provider_errors
from apps.generation.model_registry import model_definition
from apps.integrations.transport import HttpTransport, ProviderError, required_key

BASE_URL = 'https://api.openai.com/v1/images'
GENERATIONS_URL = BASE_URL + '/generations'
EDITS_URL = BASE_URL + '/edits'
MAX_IMAGES = 16
MAX_PROMPT_CHARACTERS = 32000
# One image per request, in lossless PNG so the stored master keeps every byte the model produced and a transparent
# background survives. Quality and background are the artist's choice (registry `qualities`/`backgrounds`); `auto`
# quality is not offered because its cost cannot be estimated before the run.
OUTPUT_FORMAT = 'png'
DEFAULT_QUALITY, DEFAULT_BACKGROUND = 'high', 'opaque'
# The edits endpoint takes PNG, JPEG and WebP; any other reference type is re-encoded to PNG, at most 2048 px on the
# long edge, and refused before decoding when it is larger than this many pixels.
REFERENCE_TYPES = frozenset({'image/png', 'image/jpeg', 'image/webp'})
MAX_REFERENCE_EDGE = 2048
MAX_DECODED_PIXELS = 8192 * 8192
TIMEOUT_SECONDS = 300
# A 3840x2160 PNG is tens of megabytes before base64; leave room above the transport default.
MAX_RESPONSE_BYTES = 128 * 1024 * 1024
# Rate limit and overload reject the request before any generation, so nothing was billed.
UNPROCESSED_STATUSES = frozenset({429, 503})

MIN_PIXELS, MAX_PIXELS, MAX_EDGE, STEP = 655360, 8294400, 3840, 16
TARGET_PIXELS = {'1K': 1024 * 1024, '2K': 2048 * 2048, '4K': MAX_PIXELS}


def image_size(resolution='1K', aspect_ratio='1:1'):
    """The WxH closest to the resolution's pixel budget at this ratio, inside every documented size constraint."""
    if resolution not in TARGET_PIXELS:
        raise ValueError(f'GPT Image 2.5 supports 1K/2K/4K only; {resolution} was requested.')
    try:
        across, down = (int(value) for value in aspect_ratio.split(':'))
    except (AttributeError, ValueError):
        raise ValueError(f'GPT Image 2.5 does not support {aspect_ratio}.') from None
    if across <= 0 or down <= 0 or max(across, down) > 3 * min(across, down):
        raise ValueError(f'GPT Image 2.5 does not support {aspect_ratio}.')
    # Search landscape sizes (short edge in steps of 16, long edge the nearest step to the ratio) and transpose for
    # portrait, so W:H and H:W always get mirrored sizes.
    ratio = max(across, down) / min(across, down)
    target = TARGET_PIXELS[resolution]
    best = None
    for short in range(STEP, MAX_EDGE + 1, STEP):
        long = round(short * ratio / STEP) * STEP
        if long > MAX_EDGE or not MIN_PIXELS <= short * long <= MAX_PIXELS:
            continue
        key = (abs(short * long - target), abs(long / short - ratio))
        if best is None or key < best[0]:
            best = (key, long, short)
    _, long, short = best
    width, height = (long, short) if across >= down else (short, long)
    return f'{width}x{height}'


def build_request(assembled, display):
    """Prompt text and ordered reference images from the shared assembler output (the Gemini layout, flattened)."""
    from apps.generation.prompting.shot_spec import build_cast_policy
    groups = assembled['groups']
    count = sum(len(group['images']) for group in groups)
    if count > MAX_IMAGES:
        raise ValueError(f'Too many reference images: {count}. {display} accepts at most {MAX_IMAGES} images per prompt - remove {count - MAX_IMAGES}.')
    budget, images, legend, identity = MAX_IMAGES - count, [], [], False
    for group in groups:
        first = len(images) + 1
        images.extend(group['images'])
        identity = identity or bool(group.get('identity'))
        for tile in group.get('tiles') or []:
            if budget <= 0:
                break
            images.append(tile)
            budget -= 1
        if len(images) >= first:
            label = f'Image {first}' if len(images) == first else f'Images {first}-{len(images)}'
            legend.append(f"{label}: {group['header']}")
    instruction = assembled['instruction']
    shot = assembled.get('shotInstruction')
    texts = legend + [shot if shot is not None else 'SCENE: ' + instruction if groups else instruction]
    cast = build_cast_policy(instruction, identity)
    if cast:
        texts.append(cast)
    if identity:
        texts.append('FINAL CHECK: every person referenced above must be a 1:1 photographic match to their reference images (bone structure, eyes, nose, lips, jawline, skin tone, apparent age). If not, correct it.')
    prompt = '\n\n'.join(texts)
    if len(prompt) > MAX_PROMPT_CHARACTERS:
        raise ValueError(f'{display} accepts prompts up to {MAX_PROMPT_CHARACTERS} characters; this one is {len(prompt)}. Shorten the prompt or use fewer references.')
    return {'prompt': prompt, 'images': images}


def request_options(model, stored):
    """The quality and background enqueue stored for this job (its submission input), checked against the registry."""
    definition = model_definition(model) or {}
    capabilities = definition.get('capabilities') or {}
    stored = stored if isinstance(stored, dict) else {}
    quality, background = stored.get('quality'), stored.get('background')
    if quality not in capabilities.get('qualities', []) or background not in capabilities.get('backgrounds', []):
        raise ValueError(f"{definition.get('name', model)} has no valid quality and background for this job.")
    return {'quality': quality, 'background': background}


def accepted_reference(image, position, display):
    """PNG, JPEG and WebP pass through; any other type (HEIC, AVIF, TIFF, GIF, BMP...) becomes a PNG."""
    mime = image.get('mimeType')
    if mime in REFERENCE_TYPES:
        return image
    subtype = str(mime or '').rpartition('/')[2]
    label = subtype.upper() if re.fullmatch(r'[\w.+\-]{1,40}', subtype) else 'UNKNOWN'
    try:
        from PIL import Image
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except ImportError:
            pass
        with Image.open(io.BytesIO(base64.b64decode(image['data']))) as source:
            if source.width * source.height > MAX_DECODED_PIXELS:
                raise ValueError('too many pixels')
            alpha = source.mode in ('RGBA', 'LA', 'PA') or 'transparency' in source.info
            converted = source.convert('RGBA' if alpha else 'RGB')
        converted.thumbnail((MAX_REFERENCE_EDGE, MAX_REFERENCE_EDGE), Image.Resampling.LANCZOS)
        output = io.BytesIO()
        converted.save(output, format='PNG')
    except Exception:
        raise ValueError(f'Reference image {position} ({label}) could not be converted to PNG for {display}. '
                         'Save it as PNG, JPEG or WebP and try again.') from None
    return {'mimeType': 'image/png', 'data': base64.b64encode(output.getvalue()).decode()}


def build_payload(input):
    """The exact Images API body: generations without references, edits with them."""
    definition = model_definition(input['model']) or {}
    if definition.get('provider') != 'openai':
        raise ValueError(f"{input['model']} is not an OpenAI image model.")
    options = request_options(input['model'], input.get('options'))
    built = build_request(input['assembled'], definition['name'])
    payload = {'model': definition['providerModelId'], 'prompt': built['prompt'], 'n': 1,
               'size': image_size(input.get('resolution') or '1K', input.get('aspectRatio') or '1:1'),
               'quality': options['quality'], 'background': options['background'], 'output_format': OUTPUT_FORMAT}
    if built['images']:
        images = [accepted_reference(image, position, definition['name']) for position, image in enumerate(built['images'], 1)]
        payload['images'] = [{'image_url': f"data:{image['mimeType']};base64,{image['data']}"} for image in images]
        return EDITS_URL, payload
    return GENERATIONS_URL, payload


def generate_image(input, *, transport=None, env=None, signal=None):
    """Return the PNG bytes and the provider's token usage; a billed 200 without an image is never resubmitted."""
    env = os.environ if env is None else env
    key = required_key(env, 'OPENAI_API_KEY', 'OpenAI is not configured: OPENAI_API_KEY is missing or redacted.')
    url, payload = build_payload(input)
    transport = transport or HttpTransport(allowed_hosts=['api.openai.com'], timeout=TIMEOUT_SECONDS,
                                           max_response_bytes=MAX_RESPONSE_BYTES)
    if signal:
        signal.check()
    response = transport.request('POST', url, headers={'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'},
                                 body=payload, signal=signal)
    try:
        result = response.json()
    except ValueError:
        result = None
    if not response.ok or not isinstance(result, dict) or result.get('error'):
        code = _error_code(result)
        error = ProviderError(f'{_failure(response.status, code)} ({response.status}, {code})', status=response.status, code=code,
                              provider_response=provider_errors.capture('openai', phase='create', status=response.status,
                                                                        body=response.text, headers=response.headers))
        if response.status in UNPROCESSED_STATUSES:
            error.may_have_submitted = False
            error.provider_response['unbilled'] = True
        raise error
    data = result.get('data') or []
    encoded = data[0].get('b64_json') if len(data) == 1 and isinstance(data[0], dict) else None
    try:
        content = base64.b64decode(encoded, validate=True) if isinstance(encoded, str) and encoded else None
    except ValueError:
        content = None
    if not content:
        raise ProviderError('OpenAI returned no image. The request was not resubmitted.', code='no_result',
                            provider_response=provider_errors.local('openai', 'no_result', 'OpenAI returned no image.',
                                                                    phase='create', status=response.status))
    if signal:
        signal.check()
    return {'content': content, 'usage': result.get('usage')}


def _failure(status, code):
    # Worded so failure_copy classifies it; the exact provider detail is kept in the structured record.
    if status in UNPROCESSED_STATUSES:
        return 'OpenAI rate limit or capacity reached. Try again later.'
    if status in (401, 403):
        return 'OpenAI authentication or model access failed.'
    if code in ('moderation_blocked', 'content_policy_violation'):
        return 'OpenAI blocked the request under its content policy.'
    if 400 <= (status or 0) < 500:
        return 'OpenAI rejected the request. Check reference files and content requirements.'
    return 'OpenAI image error.'


def _error_code(result):
    error = (result or {}).get('error') if isinstance(result, dict) else None
    code = error.get('code') or error.get('type') if isinstance(error, dict) else None
    return code if isinstance(code, str) and code.replace('_', '').replace('-', '').isalnum() and len(code) <= 100 else 'provider_error'
