"""BytePlus Vision OmniHuman 2.0: signed asynchronous tasks, never implicit resubmission."""
import json
import os
import re

from apps.generation import provider_errors
from apps.integrations.byteplus import sign_request
from apps.integrations.transport import HttpTransport, ProviderError, required_key

HOST = 'cv.byteplusapi.com'
VERSION = '2024-06-06'
REQ_KEY = 'realman_avatar_picture_omni20_cv'
SUBMIT = 'CVSync2AsyncSubmitTask'
QUERY = 'CVSync2AsyncGetResult'
REGION, SERVICE = 'ap-singapore-1', 'cv'
STATES = {'in_queue': 'queued', 'generating': 'running', 'done': 'succeeded',
          'not_found': 'failed', 'expired': 'failed', 'canceled': 'failed'}
INVALID = 'OmniHuman could not use these inputs. Attach one valid image and one WAV or MP3 audio file of 4-300 seconds.'
IMAGE = 'OmniHuman needs an image under 30 MB, with each side 300-6000 pixels and an aspect ratio between 0.4 and 2.5.'
AUDIO = 'OmniHuman needs one WAV or MP3 audio file under 15 MB and 4-300 seconds long.'
UNAVAILABLE = 'OmniHuman is unavailable. Ask an administrator to check its access and configuration.'
BUSY = 'OmniHuman is busy. Try again in a few minutes.'
INTERNAL = 'OmniHuman encountered a service error. Try again later.'
POLICY = 'OmniHuman rejected these inputs under its content policy. Change the image, audio or prompt before trying again.'
EXPIRED = 'The OmniHuman task expired or could not be found. Nothing was resubmitted.'
CANCELED = 'The OmniHuman task was canceled at the provider.'
NO_VIDEO = 'OmniHuman finished but returned no video.'
UNKNOWN = 'OmniHuman returned an unrecognized task response. Nothing was resubmitted.'
CANCEL_DENIED = 'OmniHuman could not cancel this task because it had already started.'
UNCERTAIN = 'OmniHuman did not confirm whether it accepted this request. It may still be running and billed; ask the team to check before retrying.'
AUDIO_CHANGED = 'The OmniHuman audio changed after queueing. Attach it again before generating.'
# Both the gateway's symbolic codes and its documented CodeN values are accepted.
GATEWAY = {
    'MissingParameter': (100002, INVALID), 'MissingAuthenticationToken': (100003, UNAVAILABLE),
    'MissingRequestInfo': (100004, UNAVAILABLE), 'MissingSignature': (100005, UNAVAILABLE),
    'InvalidTimestamp': (100006, UNAVAILABLE), 'ServiceNotFound': (100007, UNAVAILABLE),
    'InvalidActionOrVersion': (100008, UNAVAILABLE), 'InvalidAccessKey': (100009, UNAVAILABLE),
    'SignatureDoesNotMatch': (100010, UNAVAILABLE), 'LackPolicy': (100012, UNAVAILABLE),
    'AccessDenied': (100013, UNAVAILABLE), 'InternalError': (100014, INTERNAL),
    'FailToConnect': (100015, INTERNAL), 'InternalServiceTimeout': (100016, INTERNAL),
    'FlowLimitExceeded': (100018, BUSY), 'ServiceUnavailableTemp': (100019, BUSY),
    'MethodNotAllowed': (100020, UNAVAILABLE), 'InternalServiceError': (100023, INTERNAL),
    'InvalidAuthorization': (100024, UNAVAILABLE), 'InvalidCredential': (100025, UNAVAILABLE),
    'InvalidSecretToken': (100026, UNAVAILABLE),
}
ERROR_COPY = {str(code): message for code, message in {
    50200: INVALID, 50201: INVALID, 50204: INVALID, 50205: IMAGE, 50206: IMAGE,
    50207: IMAGE, 50215: INVALID, 50217: CANCEL_DENIED, 50400: UNAVAILABLE,
    50402: UNAVAILABLE, 50429: BUSY, 50430: BUSY, 50500: INTERNAL, 50501: INTERNAL, 50510: POLICY,
}.items()}
for _name, (_number, _message) in GATEWAY.items():
    ERROR_COPY[_name] = ERROR_COPY[str(_number)] = _message
ERROR_COPY.update(not_found=EXPIRED, expired=EXPIRED, canceled=CANCELED, no_video=NO_VIDEO, unknown_state=UNKNOWN)
RETRYABLE = frozenset(('50429', '50430', '50500', '50501', 'InternalError', 'FailToConnect',
    'InternalServiceTimeout', 'FlowLimitExceeded', 'ServiceUnavailableTemp', 'InternalServiceError',
    '100014', '100015', '100016', '100018', '100019', '100023'))
# Only these codes describe the task itself; a status query ends the job on no other refusal.
TASK_FAILURES = frozenset(('50200', '50201', '50204', '50205', '50206', '50207', '50215', '50510'))


def endpoint(action):
    return f'https://{HOST}/?Action={action}&Version={VERSION}'


def response_error(payload):
    metadata = payload.get('ResponseMetadata')
    if metadata is not None:
        error = metadata.get('Error') if isinstance(metadata, dict) else None
        return str(error.get('Code') or 'invalid_response') if isinstance(error, dict) else 'invalid_response'
    return None if type(payload.get('code')) is int and payload['code'] == 10000 else str(payload.get('code') or 'invalid_response')


def failure(payload, *, phase, http_status=None, task_id=None, code=None, headers=None):
    code = code or response_error(payload) or 'invalid_response'
    record = provider_errors.capture('omnihuman', phase=phase, status=http_status, code=code,
        body=json.dumps(payload), headers=headers, task_id=task_id)
    error = ProviderError(ERROR_COPY.get(code, UNKNOWN), code=code, status=http_status, provider_response=record,
        may_have_submitted=phase == 'create' and (code in RETRYABLE - {'50429', '50430', 'FlowLimitExceeded', '100018', 'ServiceUnavailableTemp', '100019'} or code not in ERROR_COPY))
    error.submission_is_ambiguous = error.may_have_submitted
    return error


def call(action, body, *, env=None, transport=None, signal=None, date=None):
    if action not in (SUBMIT, QUERY):
        raise ValueError('Unsupported OmniHuman action.')
    env = os.environ if env is None else env
    try:
        ak = required_key(env, 'OMNIHUMAN_ACCESS_KEY_ID')
        sk = required_key(env, 'OMNIHUMAN_SECRET_ACCESS_KEY')
    except ProviderError as error:
        error.may_have_submitted = False
        raise
    raw = json.dumps(body, ensure_ascii=False, separators=(',', ':'))
    headers = {'content-type': 'application/json', 'host': HOST}
    signed = sign_request(body=raw, ak=ak, sk=sk, region=REGION, service=SERVICE,
        query={'Action': action, 'Version': VERSION}, headers=headers, date=date)
    transport = transport or HttpTransport(allowed_hosts={HOST}, timeout=45, max_response_bytes=1024 * 1024)
    try:
        response = transport.request('POST', endpoint(action), headers=signed['headers'], raw_body=raw.encode(), signal=signal)
    except Exception as error:
        if action != SUBMIT or getattr(error, 'may_have_submitted', True) is False:
            raise
        raise ProviderError(UNCERTAIN, code='ambiguous_submission', provider_response=provider_errors.local(
            'omnihuman', getattr(error, 'code', None) or 'connection_error', str(error), phase='create')) from error
    try:
        payload = response.json()
    except ValueError:
        error = ProviderError(UNKNOWN, code='invalid_response', status=response.status,
            provider_response=provider_errors.capture('omnihuman', phase='create' if action == SUBMIT else 'status',
                status=response.status, body=response.text, headers=response.headers))
        error.submission_is_ambiguous = action == SUBMIT and response.ok
        raise error from None
    if not isinstance(payload, dict):
        raise ProviderError(UNKNOWN, code='invalid_response')
    if not response.ok or response_error(payload):
        raise failure(payload, phase='create' if action == SUBMIT else 'status', http_status=response.status,
            headers=response.headers, task_id=body.get('task_id'))
    return payload


def create_video_task(input, *, env=None, transport=None, signal=None):
    images, audios = input.get('imageUrls') or [], input.get('audioUrls') or []
    if len(images) != 1 or len(audios) != 1:
        raise ProviderError(INVALID, code='invalid_inputs', may_have_submitted=False)
    body = {'req_key': REQ_KEY, 'image_urls': images, 'audio_url': audios[0]}
    if input.get('prompt'):
        body['prompt'] = input['prompt']
    result = call(SUBMIT, body, env=env, transport=transport, signal=signal)
    data = result.get('data') if isinstance(result.get('data'), dict) else {}
    identifier = data.get('task_id')
    if not isinstance(identifier, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', identifier):
        raise ProviderError(UNKNOWN, code='missing_task_id')  # ambiguous: never retry the POST
    return identifier


def normalize_video_task_payload(payload, task_id=None):
    data = payload.get('data') if isinstance(payload.get('data'), dict) else {}
    state = data.get('status') if isinstance(data.get('status'), str) else None
    status = STATES.get(state)
    result = {'status': status or 'failed', 'providerStatus': state, 'raw': payload}
    if status == 'succeeded' and isinstance(data.get('video_url'), str) and data['video_url'].startswith('https://'):
        result['videoUrl'] = data['video_url']
    elif status == 'succeeded' or status == 'failed' or status is None:
        code = 'no_video' if status == 'succeeded' else state if state in ERROR_COPY else 'unknown_state'
        error = failure(payload, phase='task', task_id=task_id, code=code)
        result.update(status='failed', error=str(error), providerError=error.provider_response)
    return result


def get_video_task(task_id, *, env=None, transport=None, signal=None):
    try:
        payload = call(QUERY, {'req_key': REQ_KEY, 'task_id': task_id}, env=env, transport=transport, signal=signal)
    except ProviderError as error:
        if error.code in TASK_FAILURES:
            return {'status': 'failed', 'error': str(error), 'providerError': error.provider_response,
                    'moderationBlocked': error.code == '50510'}
        raise
    return normalize_video_task_payload(payload, task_id)


def video_container(stream):
    """Read container headers from the original spool; provider URLs need not carry an extension."""
    stream.seek(0, 2)
    length = stream.tell()
    offset = 0
    while offset + 8 <= length:
        stream.seek(offset)
        header = stream.read(8)
        size, kind = int.from_bytes(header[:4], 'big'), header[4:]
        header_size = 8
        if size == 1:
            extended = stream.read(8)
            if len(extended) != 8:
                break
            size, header_size = int.from_bytes(extended, 'big'), 16
        if size == 0:
            size = length - offset
        if size < header_size or offset + size > length:
            break
        if kind == b'ftyp' and size >= header_size + 8:
            brand = stream.read(4)
            stream.seek(0)
            if brand == b'qt  ':
                return 'mov'
            if brand in (b'isom', b'iso2', b'iso4', b'iso5', b'iso6', b'mp41', b'mp42', b'avc1', b'M4V '):
                return 'mp4'
            break
        offset += size
    stream.seek(0)
    raise ValueError('OmniHuman returned an unsupported video container. The original was not converted.')
