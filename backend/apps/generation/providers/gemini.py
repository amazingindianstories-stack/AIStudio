"""Gemini image payload and bounded source-compatible transient retries."""
import json
import os
import random
import re
from apps.generation.model_registry import model_definition
from apps.generation.services.deadline import Cancellation
from .transport import HttpTransport, ProviderError, required_key

API_ROOT = 'https://generativelanguage.googleapis.com/v1beta'
# Callers without a registry model (the hidden Higgsfield video auto-frame) keep Nano Banana Pro.
DEFAULT_MODEL = 'Nano Banana Pro'
MAX_IMAGES = 14


def definition(display=None):
    """The registry entry for a Gemini image model; unknown names keep Nano Banana Pro."""
    found = model_definition(display) or model_definition(DEFAULT_MODEL)
    if found.get('provider') != 'gemini' or not found.get('providerModelId'):
        raise ValueError(f"{found['name']} has no configured Gemini image model.")
    return found


def endpoint(display=None):
    return f"{API_ROOT}/models/{definition(display)['providerModelId']}:generateContent"


def build_parts(assembled, display=None):
    from apps.generation.prompting.shot_spec import build_cast_policy
    groups = assembled['groups']
    count = sum(len(group['images']) for group in groups)
    if count > MAX_IMAGES:
        raise ValueError(f'Too many reference images: {count}. {display or DEFAULT_MODEL} accepts at most {MAX_IMAGES} images per prompt — remove {count - MAX_IMAGES}.')
    budget, parts, identity = MAX_IMAGES - count, [], False
    for group in groups:
        parts.append({'text': group['header']})
        parts.extend({'inlineData': {'mimeType': image['mimeType'], 'data': image['data']}} for image in group['images'])
        identity = identity or bool(group.get('identity'))
        for tile in group.get('tiles') or []:
            if budget <= 0:
                break
            parts.append({'inlineData': {'mimeType': tile['mimeType'], 'data': tile['data']}})
            budget -= 1
    instruction = assembled['instruction']
    shot = assembled.get('shotInstruction')
    parts.append({'text': shot if shot is not None else 'SCENE: ' + instruction if groups else instruction})
    cast = build_cast_policy(instruction, identity)
    if cast:
        parts.append({'text': cast})
    if identity:
        parts.append({'text': 'FINAL CHECK: every person referenced above must be a 1:1 photographic match to their reference images (bone structure, eyes, nose, lips, jawline, skin tone, apparent age). If not, correct it.'})
    return parts


def retry_delay_ms(text):
    try:
        details = json.loads(text).get('error', {}).get('details')
        if not isinstance(details, list):
            return None
        for detail in details:
            if isinstance(detail.get('@type'), str) and detail['@type'].endswith('RetryInfo'):
                match = re.fullmatch(r'([0-9.]+)s', str(detail.get('retryDelay', '')))
                if match:
                    return min(max(float(match[1]) * 1000, 1000), 60000)
    except (ValueError, AttributeError):
        pass
    return None


def build_payload(input):
    config = {'responseModalities': ['TEXT', 'IMAGE'],
              'imageConfig': {'aspectRatio': input.get('aspectRatio') or '1:1', 'imageSize': input.get('imageSize') or '1K'}}
    if type(input.get('seed')) in (int, float):
        config['seed'] = input['seed']
    return {'contents': [{'role': 'user', 'parts': build_parts(input['assembled'], definition(input.get('modelDisplay'))['name'])}], 'generationConfig': config}


UNPROCESSED_RETRY_STATUSES = frozenset({429, 503})


def generate_image(input, *, transport=None, env=None, signal=None, random_value=random.random):
    env = os.environ if env is None else env
    key = required_key(env, 'GOOGLE_API_KEY')
    url = endpoint(input.get('modelDisplay'))
    body = build_payload(input)
    transport = transport or HttpTransport(allowed_hosts=['generativelanguage.googleapis.com'])
    signal = signal or Cancellation()
    slept, last_error = 0, ''
    for attempt in range(1, 5):
        signal.check()
        response = transport.request('POST', url,
            headers={'Content-Type': 'application/json', 'x-goog-api-key': key}, body=body, signal=signal)
        if not response.ok:
            last_error = f'Gemini image error ({response.status}): {response.text[:400]}'
            # Retry only rejections that were not processed (rate limit,
            # overloaded). Other errors may have consumed paid generation.
            if response.status in UNPROCESSED_RETRY_STATUSES:
                hint = retry_delay_ms(response.text)
                wait = min(hint if hint is not None else 4000 * 2 ** (attempt-1) * (.75 + random_value() * .5), 90000 - slept)
                if wait > 0:
                    slept += wait
                    signal.wait(wait)
                    continue
            raise ProviderError(last_error, status=response.status)
        result = response.json()
        candidate = (result.get('candidates') or [{}])[0]
        parts = (candidate.get('content') or {}).get('parts') or []
        image = next((part['inlineData'] for part in parts if (part.get('inlineData') or {}).get('data')), None)
        if not image:
            # A 200 is billed; never re-submit it automatically.
            raise ProviderError(f"Gemini returned no image ({candidate.get('finishReason') or 'no candidates'}).")
        return {'base64': image['data'], 'mimeType': image.get('mimeType') or 'image/png'}
    raise ProviderError(last_error or 'Gemini image generation failed.')
