"""Google Interactions video adapter (Gemini Omni Flash) with credential-scoped downloads.

Gemini Omni Flash 1.1 (`gemini-omni-1.1-flash`), per ai.google.dev/gemini-api/docs/omni, /docs/models/gemini-omni-flash
and ai.google.dev/api/interactions-api (VideoResponseFormat), read 2026-10-18: POST /v1beta/interactions with `model`,
`input` (text and inline image parts) and `response_format` {type: video, aspect_ratio 16:9|9:16, duration, resolution
360p|720p|1080p|4k}; with `background` the interaction is polled by GET /v1beta/interactions/{id}, and the REST result
carries the video in `steps[].content[]` (inline base64 `data`, or a Files API `uri`). There is no seed, negative
prompt, system instruction or audio field. The retired preview (`gemini-omni-flash-preview`, shut down 2026-10-22) is
never submitted again; building its payload remains possible only as evidence for the historical parity tests.
"""
import base64
import json
import os
import re
from urllib.parse import quote, urlsplit

from apps.common.javascript import string
from apps.generation import provider_errors
from apps.generation.model_registry import capability, model_definition, provider_model_id, retirement_message
from .transport import HttpTransport, ProviderError, required_key


def build_input(assembled, model_name):
    groups = assembled['groups']
    count = sum(len(group['images']) for group in groups)
    if count > 14:
        raise ValueError(f'Too many reference images: {count}. {model_name} accepts at most 14 images per prompt — remove {count - 14}.')
    budget, parts, identity = 14 - count, [], False
    for group in groups:
        parts.append({'type': 'text', 'text': group['header']})
        parts.extend({'type': 'image', 'mime_type': img['mimeType'], 'data': img['data']} for img in group['images'])
        identity = identity or bool(group.get('identity'))
        for tile in group.get('tiles') or []:
            if budget <= 0:
                break
            parts.append({'type': 'image', 'mime_type': tile['mimeType'], 'data': tile['data']})
            budget -= 1
    shot = assembled.get('shotInstruction')
    parts.append({'type': 'text', 'text': shot if shot is not None else ('SCENE: ' if groups else '') + assembled['instruction']})
    if identity:
        parts.append({'type': 'text', 'text': 'FINAL CHECK: every person referenced above must be a 1:1 photographic match to their reference images (bone structure, eyes, nose, lips, jawline, skin tone, apparent age) in every frame of the video. If not, correct it.'})
    return parts


def assert_google_host(url):
    parsed = urlsplit(url)
    host = parsed.hostname or ''
    if host != 'googleapis.com' and not host.endswith('.googleapis.com'):
        raise ValueError(f'Refusing to attach Omni credentials to unexpected host: {host}')
    # Credentials never travel over cleartext, URL userinfo or an unexpected port.
    if parsed.scheme != 'https' or parsed.username is not None or parsed.password is not None or parsed.port not in (None, 443):
        raise ValueError('Refusing to attach Omni credentials to an insecure URL.')
    return host


def build_endpoint(*, vertex=False, project=None, location=None):
    if vertex:
        if not project:
            raise ValueError('Vertex Omni requires a GCP project id.')
        return f'https://aiplatform.googleapis.com/v1beta1/projects/{project}/locations/{location or "global"}/interactions'
    return 'https://generativelanguage.googleapis.com/v1beta/interactions'


def build_payload(input, aspect_ratio, duration, env=None, *, model, resolution=None):
    """`resolution` is sent only when given: the retired preview had no such field."""
    name = model_definition(model)['name']
    if aspect_ratio not in ('16:9', '9:16'):
        raise ValueError(f'{name} only supports 16:9/9:16 aspect ratios (got "{aspect_ratio}").')
    response_format = {'type': 'video', 'aspect_ratio': aspect_ratio, 'duration': string(duration) + 's'}
    if resolution is not None:
        response_format['resolution'] = resolution
    return {'model': provider_model_id(model, env), 'input': input, 'background': True, 'response_format': response_format}


def submission_model(name):
    """The current Omni registry entry for a new submission; refuses retired, unknown and non-Omni models."""
    model = model_definition(name)
    if not model or model.get('provider') != 'omni':
        raise ValueError(f'{name or "This model"} is not a Gemini Omni model.')
    retired = retirement_message(name)
    if retired:
        raise ValueError(retired)
    return model


def map_status(raw):
    if raw == 'completed':
        return 'succeeded'
    return 'failed' if raw in ('failed', 'cancelled', 'incomplete', 'budget_exceeded', 'requires_action') else 'running'


def terminal_status_http_error(status, body):
    if status not in (400, 404, 409, 410, 422):
        return None
    try:
        parsed = json.loads(body)
        message = (parsed.get('error') or {}).get('message') or parsed.get('message') or f'Omni status error ({status}).'
    except (ValueError, AttributeError):
        message = f'Omni status error ({status}): {body[:400]}' if body.strip() else f'Omni status error ({status}).'
    return {'status': 'failed', 'error': message, 'moderationBlocked': bool(re.search(r'input blocked|polic|safety|moderat|block', message, re.I))}


def resolve_vertex_auth(env):
    # Runtime-only ADC resolution; isolated qualification supplies a fake resolver.
    import google.auth
    from google.auth.transport.requests import Request
    credentials, discovered_project = google.auth.default(scopes=['https://www.googleapis.com/auth/cloud-platform'])
    if not credentials.valid:
        credentials.refresh(Request())
    project = env.get('GOOGLE_CLOUD_PROJECT') or discovered_project
    if not project or not credentials.token:
        raise ProviderError('OMNI_USE_VERTEX=1 auth failed. Set GOOGLE_CLOUD_PROJECT and GOOGLE_APPLICATION_CREDENTIALS, or run `gcloud auth application-default login`.')
    return {'project': project, 'token': credentials.token}


def authentication(env, vertex_auth=None):
    if env.get('OMNI_USE_VERTEX') == '1':
        auth = (vertex_auth or resolve_vertex_auth)(env)
        return build_endpoint(vertex=True, project=auth['project']), {'Authorization': 'Bearer ' + auth['token']}
    key = required_key(env, 'GOOGLE_API_KEY', 'GOOGLE_API_KEY is not set.')
    return build_endpoint(), {'x-goog-api-key': key}


def extract_video(result, headers=None, *, transport=None, signal=None):
    uri = None
    for step in result.get('steps') or []:
        for part in step.get('content') or []:
            if part.get('type') == 'video' and part.get('data'):
                return {'base64': part['data'], 'mimeType': part.get('mime_type') or 'video/mp4'}
            if part.get('type') == 'video' and part.get('uri') and not uri:
                uri = part['uri']
    # REST carries a URI-delivered video in steps; `output_video` is the SDK convenience field.
    uri = uri or (result.get('output_video') or {}).get('uri')
    if uri:
        host = assert_google_host(uri)
        transport = transport or HttpTransport(allowed_hosts=[host], max_response_bytes=512 * 1024 * 1024)
        response = transport.request('GET', uri, headers=headers or {}, signal=signal)
        if not response.ok:
            raise ProviderError(f'Failed to download Omni video from uri ({response.status}).', status=response.status,
                                provider_response=provider_errors.capture('omni', phase='download', status=response.status,
                                                                          headers=response.headers))
        return {'base64': base64.b64encode(response.body).decode(), 'mimeType': (response.headers or {}).get('content-type') or 'video/mp4'}
    raise ProviderError('Omni completed but returned no video (no inline data or uri).', provider_response=provider_errors.local(
        'omni', 'no_video', 'Omni completed but returned no video (no inline data or uri).', phase='task',
        task_id=result.get('id') if isinstance(result.get('id'), str) else None))


def create_video_task(input, *, transport=None, env=None, signal=None, vertex_auth=None):
    env = os.environ if env is None else env
    model = submission_model(input.get('modelDisplay'))
    resolution, duration = input.get('resolution') or '720p', input['duration']
    # Refused before any credential or network use: an unoffered size or length is also an unpriced one.
    resolutions, durations = capability(model['id'], 'resolutions', []), capability(model['id'], 'durations', [])
    if resolution not in resolutions:
        raise ValueError(f'{model["name"]} supports {"/".join(resolutions)} only (got {string(resolution)}).')
    if type(duration) is not int or duration not in durations:
        raise ValueError(f'{model["name"]} supports {"/".join(map(str, durations))}s durations (got {string(duration)}).')
    payload = build_payload(build_input(input['assembled'], model['name']), input['aspectRatio'], duration, env,
                            model=model['id'], resolution=resolution)
    endpoint, headers = authentication(env, vertex_auth)
    transport = transport or HttpTransport(allowed_hosts=['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'], max_response_bytes=512 * 1024 * 1024)
    response = transport.request('POST', endpoint, headers={**headers, 'Content-Type': 'application/json'}, body=payload, signal=signal)
    if not response.ok:
        raise ProviderError(f'Omni create error ({response.status}): {response.text[:400]}', status=response.status,
                            provider_response=provider_errors.capture('omni', phase='create', status=response.status,
                                                                      body=response.text, headers=response.headers))
    result = response.json()
    task_id = result.get('id') or result.get('name')
    if not task_id:
        raise ProviderError('Omni create returned no interaction id.', provider_response=provider_errors.local(
            'omni', 'no_interaction_id', 'Omni create returned no interaction id.', phase='create',
            status=response.status, body=response.text, headers=response.headers))
    return task_id


def get_video_status(task_id, *, transport=None, download_transport=None, env=None, signal=None, vertex_auth=None):
    env = os.environ if env is None else env
    endpoint, headers = authentication(env, vertex_auth)
    transport = transport or HttpTransport(allowed_hosts=['generativelanguage.googleapis.com', 'aiplatform.googleapis.com'], max_response_bytes=512 * 1024 * 1024)
    response = transport.request('GET', endpoint + '/' + quote(task_id, safe=''), headers=headers, signal=signal)
    if not response.ok:
        terminal = terminal_status_http_error(response.status, response.text)
        if terminal:
            return {**terminal, 'providerError': provider_errors.capture('omni', phase='status', status=response.status,
                                                                         body=response.text, headers=response.headers, task_id=task_id)}
        raise ProviderError(f'Omni status error ({response.status}): {response.text[:400]}', status=response.status,
                            provider_response=provider_errors.capture('omni', phase='status', status=response.status,
                                                                      body=response.text, headers=response.headers, task_id=task_id))
    result = response.json()
    status = map_status(result.get('status'))
    if status == 'succeeded':
        video = extract_video(result, headers, transport=download_transport, signal=signal)
        return {'status': status, 'videoBase64': video['base64'], 'mimeType': video['mimeType']}
    if status == 'failed':
        message = (result.get('error') or {}).get('message') or f'Omni generation ended with status "{result.get("status", "undefined")}".'
        # The interaction's own error code, else a telling terminal status (budget_exceeded, incomplete ...) is the code;
        # a plain "failed" leaves the provider's message to explain itself.
        summary = {key: result[key] for key in ('id', 'status', 'error') if result.get(key) is not None}
        parsed = provider_errors.parse_body(summary)
        record = provider_errors.capture('omni', phase='task', body=json.dumps(summary), task_id=task_id,
                                         code=parsed.get('code') or (result.get('status') if result.get('status') != 'failed' else None))
        return {'status': status, 'error': message, 'moderationBlocked': bool(re.search(r'polic|safety|moderat|block', message, re.I)),
                'providerError': record}
    return {'status': status}
