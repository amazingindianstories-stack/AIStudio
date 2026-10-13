"""Magnific creative and precision APIs with source-equivalent payload gates."""
import math
import os
import re
from urllib.parse import quote
from apps.common.javascript import number, string, truthy, UNDEFINED
from .transport import HttpTransport, ProviderError, required_key

BASE_URL = 'https://api.magnific.com'
MODELS = ['Magnific Creative', 'Magnific Precision V2', 'Magnific Precision V1']
PRESETS = ['standard', 'soft_portraits', 'hard_portraits', 'art_n_illustration', 'videogame_assets',
           'nature_n_landscapes', 'films_n_photography', '3d_renders', 'science_fiction_n_horror']
ENGINES = ['automatic', 'magnific_illusio', 'magnific_sharpy', 'magnific_sparkle']


def resolve_variant(model):
    values = {'Magnific Creative': 'creative', 'Magnific Precision V1': 'precision-v1', 'Magnific Precision V2': 'precision-v2'}
    if model not in values:
        raise ValueError('Unsupported Magnific model.')
    return values[model]


def clamp(value, minimum, maximum, fallback):
    value = number(value)
    if math.isnan(value):
        return fallback
    if math.isfinite(value):
        value = math.floor(value + .5)
    return min(maximum, max(minimum, value))


def build_payload(variant, input):
    image, params = input.get('image'), input.get('params') or {}
    if not image or not isinstance(image, str):
        raise ValueError('A valid source image (data URI or public URL) is required.')
    image = image.strip()
    if not image.startswith(('data:', 'http://', 'https://')):
        image = 'data:image/png;base64,' + image
    if variant in ('precision-v1', 'precision-v2'):
        body = {'image': image}
        if variant == 'precision-v2':
            scale = re.sub(r'x$', '', string(params.get('scaleFactor') or '2x'), flags=re.I)
            body.update(scale_factor=clamp(scale, 2, 16, 2),
                        flavor=params['flavor'] if params.get('flavor') in ('photo', 'sublime', 'photo_denoiser') else 'photo')
        body.update(sharpen=clamp(params.get('sharpen', UNDEFINED), 0, 100, 50 if variant == 'precision-v1' else 7),
                    smart_grain=clamp(params.get('smartGrain', UNDEFINED), 0, 100, 7),
                    ultra_detail=clamp(params.get('ultraDetail', UNDEFINED), 0, 100, 30),
                    filter_nsfw=truthy(params.get('filterNsfw')))
        return {'endpoint': '/v1/ai/image-upscaler-precision' + ('-v2' if variant == 'precision-v2' else ''), 'body': body}
    body = {'image': image, 'scale_factor': params['scaleFactor'] if params.get('scaleFactor') in ('2x', '4x', '8x', '16x') else '2x',
            'optimized_for': params['optimizedFor'] if params.get('optimizedFor') in PRESETS else 'standard',
            'engine': params['engine'] if params.get('engine') in ENGINES else 'automatic'}
    for key in ('creativity', 'hdr', 'resemblance', 'fractality'):
        body[key] = clamp(params.get(key, UNDEFINED), -10, 10, 0)
    body['filter_nsfw'] = truthy(params.get('filterNsfw'))
    if isinstance(params.get('prompt'), str) and params['prompt'].strip():
        body['prompt'] = params['prompt'].strip()
    return {'endpoint': '/v1/ai/image-upscaler', 'body': body}


def params_for_model(model, params):
    keys = {'Magnific Creative': ['scaleFactor', 'prompt', 'optimizedFor', 'engine', 'creativity', 'hdr', 'resemblance', 'fractality'],
            'Magnific Precision V2': ['scaleFactor', 'flavor', 'sharpen', 'smartGrain', 'ultraDetail'],
            'Magnific Precision V1': ['sharpen', 'smartGrain', 'ultraDetail']}
    resolve_variant(model)
    return {'model': model, 'filterNsfw': truthy(params.get('filterNsfw')), **{key: params[key] for key in keys[model] if key in params}}


def submit_upscale(input, *, transport=None, env=None, signal=None):
    env = os.environ if env is None else env
    key = input.get('apiKey') or required_key(env, 'MAGNIFIC_API_KEY', 'MAGNIFIC_API_KEY is not configured.')
    variant = resolve_variant(input.get('model', 'Magnific Creative'))
    request = build_payload(variant, input)
    transport = transport or HttpTransport(allowed_hosts=['api.magnific.com'], timeout=30)
    response = transport.request('POST', BASE_URL + request['endpoint'],
        headers={'x-magnific-api-key': key, 'Content-Type': 'application/json'}, body=request['body'], signal=signal)
    try:
        result = response.json()
    except ValueError:
        result = {}
    if not response.ok:
        details = ', '.join(f"{item.get('field', 'undefined')}: {item.get('reason', 'undefined')}" for item in result['invalid_params']) if isinstance(result.get('invalid_params'), list) else None
        message = result.get('message')
        error = f'{message} ({details})' if message and details else details or message or f'Magnific API error ({response.status})'
        raise ProviderError(error, status=response.status)
    data = result.get('data') or {}
    if not data.get('task_id'):
        raise ProviderError('Magnific API did not return a valid task_id.')
    return {'taskId': data['task_id'], 'status': data.get('status') or 'CREATED', 'variant': variant, 'endpoint': request['endpoint']}


def get_upscale_status(task_id, *, model='Magnific Creative', api_key=None, transport=None, env=None, signal=None):
    if not task_id:
        raise ValueError('taskId is required.')
    env = os.environ if env is None else env
    key = api_key or required_key(env, 'MAGNIFIC_API_KEY', 'MAGNIFIC_API_KEY is not configured.')
    variant = resolve_variant(model)
    endpoint = '/v1/ai/image-upscaler' + ('-precision' if variant == 'precision-v1' else '-precision-v2' if variant == 'precision-v2' else '')
    transport = transport or HttpTransport(allowed_hosts=['api.magnific.com'], timeout=15)
    response = transport.request('GET', BASE_URL + endpoint + '/' + quote(task_id, safe=''),
                                 headers={'x-magnific-api-key': key}, signal=signal)
    try:
        result = response.json()
    except ValueError:
        result = {}
    if not response.ok:
        raise ProviderError(result.get('message') or f'Failed to fetch Magnific task status ({response.status})', status=response.status)
    data = result.get('data') or {}
    status = (data.get('status') or 'IN_PROGRESS').upper()
    if status == 'COMPLETED':
        urls = data.get('generated') if isinstance(data.get('generated'), list) else []
        if not urls:
            raise ProviderError('Magnific task completed but returned no output image URL.')
        return {'status': 'succeeded', 'generatedUrls': urls, 'generatedUrl': urls[0], 'taskId': task_id}
    if status == 'FAILED':
        return {'status': 'failed', 'error': data.get('error') or result.get('message') or 'Magnific upscale task failed.', 'taskId': task_id}
    return {'status': 'running', 'taskId': task_id}
