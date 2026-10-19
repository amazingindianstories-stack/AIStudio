"""Kling single-image task API, reference gates, and durable polling primitives."""
import base64
import io
import math
import os
import re
import time
from urllib.parse import quote, urlsplit

from PIL import Image
from apps.common.javascript import utf16_length
from apps.generation.model_registry import MODEL_REGISTRY
from apps.generation.services.deadline import Cancellation
from apps.generation.watermark import WHITESPACE
from .transport import HttpTransport, ProviderError, required_key

DEFAULT_HOST = 'https://api-singapore.klingai.com'
# KLING_API_HOST may only name a Kling API host: the key is sent there as a bearer token.
HOST_PATTERN = re.compile(r'https://(?:[a-z0-9-]+\.)+klingai\.com')
CREATE_PATH = '/v1/images/generations'
PROMPT_MAX = 2500
MODELS = [{'id': m['id'], 'modelName': m['providerModelId'], 'display': m['name'],
           'resolutions': m['capabilities']['resolutions'],
           'twoKNeedsNoReference': '2K' not in m['capabilities']['referenceResolutions'],
           'aspectRatios': m['capabilities']['aspectRatios']}
          for m in MODEL_REGISTRY if m['provider'] == 'kling']
PERSON_RULE = ('reproduce this exact person — same face and bone structure, jawline, '
               'hairline, eyes, nose, lips, facial hair, hairstyle, build and apparent age, '
               'plus the distinguishing marks shown, and the same medium and rendering '
               'style as the reference. The same individual, never a lookalike, and never '
               'beautified, slimmed or de-aged relative to the reference')
SUBJECT_RULE = ('reproduce exactly what this shows — same shapes, colours, materials, '
                'patterns and detailing, in the same medium and rendering style')


def spec(model):
    name = model.strip(WHITESPACE).lower()
    return next((m for m in MODELS if name in (m['display'].lower(), m['id'])), None)


def nearest_aspect_ratio(width, height):
    if not width or not height:
        return None
    target = math.log(width / height)
    return min(MODELS[0]['aspectRatios'], key=lambda label: abs(math.log(int(label.split(':')[0]) / int(label.split(':')[1])) - target))


def build_input(assembled, model_display):
    groups = [g for g in assembled['groups'] if g['images']]
    total = sum(len(g['images']) for g in groups)
    if total > 1:
        named = ', '.join(g['tag'] for g in groups)
        raise ValueError(f"{model_display} accepts 1 reference image, but this prompt resolved to {total} ({named}). Kling's multi-reference mode is a different model (kling-v3-omni) that is not available here — use Nano Banana Pro for multi-reference prompts, or reduce this one to a single reference.")
    group = groups[0] if groups else None
    reference = group['images'][0] if group else None
    text = assembled.get('shotInstruction')
    if text is None:
        text = assembled['instruction']
    if group:
        text = re.sub('@' + re.escape(group['tag'].removeprefix('@')) + r'\b', 'the reference image', text, flags=re.I | re.ASCII)
    leftover = re.findall(r'@img[0-9]+', text, re.I)
    if leftover:
        if not reference:
            tags = ', '.join(dict.fromkeys(leftover))
            raise ValueError(f'This prompt tags {tags} but no reference image is attached. Attach the image, or remove the tag from the prompt.')
        text = re.sub(r'@img[0-9]+', 'the reference image', text, flags=re.I)
    text = re.sub(r'@([a-z][a-z0-9_-]*)', r'\1', text, flags=re.I | re.ASCII)
    if group and not assembled.get('shotInstruction'):
        text = 'REFERENCE IMAGE — ' + (PERSON_RULE if group.get('identity') else SUBJECT_RULE) + '.\n\n' + text
    return {'prompt': text, **({'reference': reference} if reference else {})}


def build_payload(input):
    model = input['model']
    definition = spec(model)
    if not definition:
        raise ValueError(f"{model} is not a Kling model this app knows. Known: " + ', '.join(m['display'] for m in MODELS))
    display = definition['display']
    prompt = input['prompt'].strip(WHITESPACE)
    if not prompt:
        raise ValueError('Prompt is required.')
    length = utf16_length(prompt)
    if length > PROMPT_MAX:
        raise ValueError(f'{display} accepts prompts up to 2500 characters; this one is {length}. Shorten the prompt (or use Nano Banana Pro, which has no such limit).')
    references = input.get('references') or []
    if len(references) > 1:
        raise ValueError(f"{display} accepts one reference image; {len(references)} were provided. Kling's multi-reference model is Kling Image 3.0 Omni on a separate endpoint, which is not wired up yet — use Nano Banana Pro for multi-reference work, or reduce this to a single @tag.")
    resolution = input.get('resolution') if input.get('resolution') is not None else '1K'
    if resolution not in definition['resolutions']:
        where = ' Use Kling Image 3.0 for 2K.' if resolution == '2K' else ' 4K is Kling Image 3.0 Omni only, which is not wired up here.' if resolution == '4K' else ''
        raise ValueError(f"{display} supports {'/'.join(definition['resolutions'])} only; {resolution} was requested.{where}")
    if definition['twoKNeedsNoReference'] and resolution == '2K' and references:
        raise ValueError(f'{display} cannot render 2K from a reference image — Kling rejects it with "resolution value \'2k\' is not supported". Drop to 1K, remove the reference, or use Kling Image 3.0, which does 2K with a reference.')
    aspect = input.get('aspectRatio') if input.get('aspectRatio') is not None else '1:1'
    if aspect not in definition['aspectRatios']:
        raise ValueError(f"{display} does not support {aspect}. Supported: " + ', '.join(definition['aspectRatios']))
    return {'model_name': definition['modelName'], 'prompt': prompt, 'n': 1, 'aspect_ratio': aspect,
            'resolution': resolution.lower(), **({'image': references[0]['data']} if references else {})}


def prep_reference(mime_type, encoded):
    data = base64.b64decode(encoded)
    with Image.open(io.BytesIO(data)) as source:
        width, height = source.size
        if min(width, height) < 300:
            raise ValueError(f'Kling needs reference images at least 300px on both sides; this one is {width}×{height}.')
        if not .4 <= width / height <= 2.5:
            raise ValueError(f'Kling needs a reference aspect ratio between 1:2.5 and 2.5:1; this one is {width}×{height}.')
        if source.format not in ('JPEG', 'PNG') or len(data) > 10 * 1024 * 1024:
            out = io.BytesIO()
            source.convert('RGB').save(out, format='JPEG', quality=90)
            data, mime_type = out.getvalue(), 'image/jpeg'
        if len(data) > 10 * 1024 * 1024:
            reduced = source.convert('RGB')
            reduced.thumbnail((2048, 2048), Image.Resampling.LANCZOS)
            out = io.BytesIO()
            reduced.save(out, format='JPEG', quality=85)
            data = out.getvalue()
    if len(data) > 10 * 1024 * 1024:
        raise ValueError(f"The reference image is {len(data) / 1024 / 1024:.1f}MB after compression; Kling's limit is 10MB.")
    return {'mimeType': mime_type, 'data': base64.b64encode(data).decode()}


def api_host(env=None):
    """The configured Kling API origin (KLING_API_HOST or the documented default), refused unless it is a Kling host."""
    env = os.environ if env is None else env
    host = (env.get('KLING_API_HOST') or DEFAULT_HOST).strip().removesuffix('/')
    if not HOST_PATTERN.fullmatch(host):
        raise ProviderError('KLING_API_HOST must be an https://<name>.klingai.com address with no path or port.', code='missing_configuration')
    return host


def create_url(env=None):
    """The one endpoint that creates (and bills) a Kling image task."""
    return api_host(env) + CREATE_PATH


def request(path, *, method='GET', body=None, transport=None, env=None, signal=None):
    env = os.environ if env is None else env
    key = required_key(env, 'KLING_API', 'KLING_API is not set, so Kling models cannot be called. Create an API key in the Kling console and set KLING_API.')
    host = api_host(env)
    transport = transport or HttpTransport(allowed_hosts=[urlsplit(host).hostname])
    response = transport.request(method, host + path, headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'}, body=body, signal=signal)
    try:
        result = response.json()
    except ValueError:
        raise ProviderError(f'Kling returned a non-JSON {response.status} response: {response.text[:300]}', status=response.status)
    if not response.ok or type(result.get('code')) is not int or result['code'] != 0:
        raise ProviderError(f"Kling {path} failed (http {response.status}, code {result.get('code', 'undefined')}): {result.get('message') or 'no message'}", status=response.status)
    return result


def submit_image(input, **options):
    result = request(CREATE_PATH, method='POST', body=build_payload(input), **options)
    task_id = (result.get('data') or {}).get('task_id')
    if not task_id:
        raise ProviderError('Kling accepted the request but returned no task_id.')
    return task_id


def resolve_image(task_id, **options):
    task = request(CREATE_PATH + '/' + quote(task_id, safe=''), **options)['data']
    if task.get('task_status') == 'succeed':
        images = (task.get('task_result') or {}).get('images') or [{}]
        url = images[0].get('url')
        if not url:
            raise ProviderError('Kling reported success but returned no image URL.')
        return {'status': 'succeeded', 'url': url, **({'unitDeduction': task['final_unit_deduction']} if 'final_unit_deduction' in task else {})}
    if task.get('task_status') == 'failed':
        raise ProviderError('Kling generation failed: ' + task['task_status_msg'] if task.get('task_status_msg') else 'Kling generation failed with no reason given.')
    return {'status': 'running' if task.get('task_status') == 'submitted' else 'queued', 'task': task}


def generate_image(input, *, timeout_ms=240000, poll_ms=3000, signal=None, **options):
    signal = signal or Cancellation(timeout_ms)
    task_id = submit_image(input, signal=signal, **options)
    deadline = time.monotonic() + timeout_ms / 1000
    while time.monotonic() < deadline:
        signal.wait(poll_ms)
        result = resolve_image(task_id, signal=signal, **options)
        if result['status'] == 'succeeded':
            return result
    raise ProviderError(f'Kling task {task_id} did not finish within {math.floor(timeout_ms / 1000 + .5)}s.')
