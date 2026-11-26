"""Gemini image payload and request; a throttled request is reported at once, never retried in place."""
import json
import os
import re
from apps.generation.model_registry import model_definition
from apps.generation import provider_errors
from apps.generation.services.deadline import Cancellation, QUEUE_EXECUTION_DEADLINE_MS
from apps.integrations import google_genai
from apps.integrations.transport import HttpTransport, ProviderError

# Callers without a registry model (the hidden Higgsfield video auto-frame) keep Nano Banana Pro.
DEFAULT_MODEL = 'Nano Banana Pro'
MAX_IMAGES = 14
# Vertex AI refuses these sampling fields for Nano Banana 2.1 ("Setting any of these parameters returns an API error",
# docs.cloud.google.com/vertex-ai/generative-ai/docs/models/gemini/nano-banana-2-1, read 2026-11-26), so the seed the job
# records is not sent there.
VERTEX_NO_SEED = frozenset({'gemini-nano-banana-2.1'})


def definition(display=None):
    """The registry entry for a Gemini image model; unknown names keep Nano Banana Pro."""
    found = model_definition(display) or model_definition(DEFAULT_MODEL)
    if found.get('provider') != 'gemini' or not found.get('providerModelId'):
        raise ValueError(f"{found['name']} has no configured Gemini image model.")
    return found


def endpoint(display=None, env=None):
    return google_genai.model_url(definition(display)['providerModelId'], env=env)


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


def build_payload(input, env=None):
    config = {'responseModalities': ['TEXT', 'IMAGE'],
              'imageConfig': {'aspectRatio': input.get('aspectRatio') or '1:1', 'imageSize': input.get('imageSize') or '1K'}}
    model = definition(input.get('modelDisplay'))
    if type(input.get('seed')) in (int, float) and not (model['providerModelId'] in VERTEX_NO_SEED and google_genai.is_vertex(env)):
        config['seed'] = input['seed']
    return {'contents': [{'role': 'user', 'parts': build_parts(input['assembled'], model['name'])}], 'generationConfig': config}


# Rate limit and overload reject the request before any generation, so nothing was billed.
UNPROCESSED_STATUSES = frozenset({429, 503})


def generate_image(input, *, transport=None, env=None, signal=None):
    env = os.environ if env is None else env
    credentials = google_genai.auth_headers(env)
    url = endpoint(input.get('modelDisplay'), env)
    body = build_payload(input, env)
    model = definition(input.get('modelDisplay'))['providerModelId']
    transport = transport or HttpTransport(allowed_hosts=[google_genai.host(env, model)],
        timeout=QUEUE_EXECUTION_DEADLINE_MS // 1000)
    signal = signal or Cancellation()
    signal.check()
    response = transport.request('POST', url,
        headers={'Content-Type': 'application/json', **credentials}, body=body, signal=signal)
    if not response.ok:
        error = ProviderError(f'Gemini image error ({response.status}): {response.text[:400]}', status=response.status,
                              provider_response=provider_errors.capture('gemini', phase='create', status=response.status,
                                                                        body=response.text, headers=response.headers))
        # No in-request retry: the paid guard allows one POST per job, so a retry could only fail and hide this error
        # while holding the worker. Fail now with the busy state; the user retries once the limit clears.
        if response.status in UNPROCESSED_STATUSES:
            error.may_have_submitted = False
            error.provider_response['unbilled'] = True
        raise error
    result = response.json()
    candidate = (result.get('candidates') or [{}])[0]
    parts = (candidate.get('content') or {}).get('parts') or []
    image = next((part['inlineData'] for part in parts if (part.get('inlineData') or {}).get('data')), None)
    if not image:
        # A 200 is billed; never re-submit it automatically.
        raise ProviderError(f"Gemini returned no image ({candidate.get('finishReason') or 'no candidates'}).",
                            provider_response=no_image_record(result, candidate))
    return {'base64': image['data'], 'mimeType': image.get('mimeType') or 'image/png'}


def no_image_record(result, candidate):
    """Why a billed 200 carried no image: the prompt block reason or the candidate's finish reason, never its parts."""
    feedback = result.get('promptFeedback') if isinstance(result.get('promptFeedback'), dict) else {}
    summary = {key: value for key, value in {'finishReason': candidate.get('finishReason'), 'finishMessage': candidate.get('finishMessage'),
               'safetyRatings': candidate.get('safetyRatings'), 'promptFeedback': feedback or None}.items() if value}
    return provider_errors.capture('gemini', phase='create', status=200, body=json.dumps(summary),
                                   code=feedback.get('blockReason') or candidate.get('finishReason') or 'NO_CANDIDATES',
                                   message=candidate.get('finishMessage') or feedback.get('blockReasonMessage') or '',
                                   request_id=result.get('responseId') if isinstance(result.get('responseId'), str) else None)
