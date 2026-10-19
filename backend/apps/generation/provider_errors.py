"""One normalized, secret-free record of what a provider said when it refused or failed work.

Records are kept in ``generations.provider_responses`` (a list; a failed best-of can hold several) and in
``managed_portrait_assets.receipt['lastError']``. Every field is optional except ``provider`` and ``receivedAt``:

    provider    adapter name (seedance, seedream, gemini, omni, kling, magnific, higgsfield, byteplus-assets)
    model       registry display name when the caller knows it
    phase       create | task | status | download | timeout | transcribe | an asset API action
    source      'provider' (the provider answered) or 'veevee' (our transport, deadline or download gave up)
    httpStatus  the provider's HTTP status
    code        the provider's own error code (BytePlus code, Google status/reason, Kling numeric code ...)
    message     the provider's message, redacted and bounded
    param       the request field the provider blamed (BytePlus ``param``, Magnific ``invalid_params``)
    requestId   the provider's request id (header, body field, or the "Request id:" BytePlus puts in messages)
    taskId      the provider task this failure belongs to (asynchronous failures)
    rawBody     the response body, redacted and cut to RAW_LIMIT bytes

Never stored: request headers, credentials, signed URLs or base64 payloads. Redaction runs on every text field,
again when a record is read back, and older records (Seedance create failures that only kept ``rawBody``) are parsed
on read, so the admin view and user messages work for them retroactively.
"""
import json
import re
import time

RAW_LIMIT = 4096
MESSAGE_LIMIT = 1000
PUBLIC_MESSAGE_LIMIT = 240

PROVIDERS = {
    'seedance': 'Seedance', 'seedream': 'Seedream', 'gemini': 'Gemini', 'omni': 'Gemini Omni', 'kling': 'Kling',
    'magnific': 'Magnific', 'higgsfield': 'Higgsfield', 'byteplus-assets': 'Portrait service',
}
# Registry provider -> the adapter that records the error (Seedance runs on the registry's "byteplus" provider).
_REGISTRY_PROVIDER = {'byteplus': 'seedance'}

_CODE = re.compile(r'[A-Za-z0-9_.:\-]{1,100}')
_ID = re.compile(r'[A-Za-z0-9_.:\-]{1,128}')
_PARAM = re.compile(r'[A-Za-z0-9_.\-\[\]]{1,80}')
_EMBEDDED_REQUEST_ID = re.compile(r'\s*\(?\brequest[ _-]?id\b\s*[:=]\s*([A-Za-z0-9_.\-]{6,128})\)?\.?', re.I)

_DATA_URL = re.compile(r'data:[\w/+.\-]*;base64,[A-Za-z0-9+/=_\-]*', re.I)
_URL = re.compile(r'\b(?:https?|gs|s3|wss?)://[^\s"\'<>\\]+', re.I)
_SECRET_PARAM = re.compile(r'(?i)\b((?:[\w-]*[_-])?(?:key|token|signature|sig|secret|password|credential|auth)s?)=([^&\s"\'<>\\,;]+)')
_AUTH_SCHEME = re.compile(r'(?i)\b(bearer|basic|hmac-sha256)\s+[^\s"\'<>\\]+(?:\s*(?:SignedHeaders|Signature)=[^\s"\'<>\\]+)*')
_SECRET_HEADER = re.compile(r'(?i)\b(authorization|x-goog-api-key|x-magnific-api-key|api-key|x-api-key|cookie)\s*[:=]\s*'
                            r'(?:(?:bearer|basic|hmac-sha256)\s+)?[^\s"\'<>\\,;]+')
_LONG_TOKEN = re.compile(r'[A-Za-z0-9+/_\-]{120,}={0,2}')


def now_ms():
    return int(time.time() * 1000)


def redact(text):
    """Remove credentials, URLs (signed or not) and inline media from provider text."""
    if not isinstance(text, str) or not text:
        return text
    text = _DATA_URL.sub('[data-url]', text)
    text = _URL.sub('[url]', text)
    text = _SECRET_HEADER.sub(lambda m: m[1] + ': [redacted]', text)
    text = _AUTH_SCHEME.sub(lambda m: m[1] + ' [redacted]', text)
    text = _SECRET_PARAM.sub(lambda m: m[1] + '=[redacted]', text)
    return _LONG_TOKEN.sub('[redacted]', text)


def _bounded(text, limit):
    if not isinstance(text, str):
        return None
    text = redact(text)
    encoded = text.encode('utf-8')
    return text if len(encoded) <= limit else encoded[:limit].decode('utf-8', errors='ignore')


def _clean(value, pattern):
    if isinstance(value, bool) or value is None:
        return None
    value = str(value).strip()
    return value if pattern.fullmatch(value) else None


def provider_for_model(model):
    """The adapter that records errors for a registry model (None for a model with no provider adapter)."""
    from apps.generation.model_registry import model_definition
    if isinstance(model, str) and model.startswith('Gemini (') and model.endswith(')'):
        return 'gemini'     # audio transcription rows: "Gemini (gemini-2.5-flash)"
    provider = (model_definition(model) or {}).get('provider')
    return _REGISTRY_PROVIDER.get(provider, provider) if provider in _REGISTRY_PROVIDER or provider in PROVIDERS else None


def parse_body(text):
    """{code, message, param, requestId} from any provider error body this app talks to; {} when unrecognized."""
    try:
        data = json.loads(text) if isinstance(text, (str, bytes)) else text
    except (ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    result = {}
    metadata = data.get('ResponseMetadata') if isinstance(data.get('ResponseMetadata'), dict) else {}
    error = data.get('error')
    if isinstance(metadata.get('Error'), dict):          # BytePlus OpenAPI (portrait assets)
        error = metadata['Error']
    if isinstance(error, dict):
        status, numeric = error.get('status'), error.get('code')
        reasons = [detail.get('reason') for detail in error.get('details') or []
                   if isinstance(detail, dict) and str(detail.get('@type', '')).endswith('ErrorInfo') and detail.get('reason')]
        # Google answers {code: 400, status: INVALID_ARGUMENT, details: [ErrorInfo reason]}: the reason is the precise code.
        if isinstance(status, str) and not isinstance(numeric, str):
            result['code'] = reasons[0] if reasons else status
        else:
            result['code'] = error.get('Code') or numeric
        result['message'] = error.get('Message') or error.get('message')
        result['param'] = error.get('param')
        result['requestId'] = error.get('request_id') or error.get('requestId')
    elif isinstance(error, str):
        result['message'] = error
    if 'code' not in result and data.get('code') not in (None, 0):  # Kling {code, message, request_id}
        result['code'] = data.get('code')
    if not result.get('message') and isinstance(data.get('message'), str):
        result['message'] = data['message']
    invalid = data.get('invalid_params')                # Magnific {message, invalid_params: [{field, reason}]}
    if isinstance(invalid, list) and invalid:
        fields = [str(item.get('field')) for item in invalid if isinstance(item, dict) and item.get('field')]
        reasons = '; '.join(f"{item.get('field')}: {item.get('reason')}" for item in invalid if isinstance(item, dict))
        result['param'] = result.get('param') or (fields[0] if fields else None)
        result['message'] = (result.get('message') + ' (' + reasons + ')') if result.get('message') and reasons else result.get('message') or reasons
    result['requestId'] = (result.get('requestId') or metadata.get('RequestId') or data.get('request_id')
                           or data.get('RequestId') or data.get('requestId'))
    return {key: value for key, value in result.items() if value not in (None, '')}


def _header(headers, *names):
    lowered = {str(key).lower(): value for key, value in (headers or {}).items()}
    return next((lowered[name] for name in names if lowered.get(name)), None)


def capture(provider, *, model=None, phase=None, status=None, body=None, headers=None, code=None, message=None,
            param=None, request_id=None, task_id=None, source='provider', **extra):
    """A normalized record. Explicit fields win over what the body says; the body fills the rest."""
    text = body.decode('utf-8', errors='replace') if isinstance(body, bytes) else body
    parsed = parse_body(text) if text else {}
    message = message if message is not None else parsed.get('message')
    embedded = _EMBEDDED_REQUEST_ID.search(message) if isinstance(message, str) else None
    entry = {
        'provider': provider, 'model': model, 'phase': phase, 'source': source,
        'httpStatus': status if type(status) is int else None,
        'code': _clean(code if code is not None else parsed.get('code'), _CODE),
        'message': _bounded(str(message), MESSAGE_LIMIT) if message not in (None, '') else None,
        'param': _clean(param if param is not None else parsed.get('param'), _PARAM),
        'requestId': _clean(request_id or _header(headers, 'x-request-id', 'x-tt-logid', 'request-id', 'x-goog-request-id')
                            or parsed.get('requestId') or (embedded[1] if embedded else None), _ID),
        'taskId': _clean(task_id, _ID),
        'rawBody': _bounded(text, RAW_LIMIT) if text else None,
        'receivedAt': now_ms(),
        **extra,
    }
    return {key: value for key, value in entry.items() if value is not None}


def local(provider, code, message, **fields):
    """Our side gave up (deadline, connection, download): no provider answer to quote, but the task/code still help."""
    return capture(provider, code=code, message=message, source='veevee', **fields)


def attach(error, entry):
    """Record ``entry`` on ``error`` (kept with any markers already there, such as Gemini's unbilled flag)."""
    current = getattr(error, 'provider_response', None)
    if isinstance(current, dict) and current.get('unbilled'):
        entry = {**entry, 'unbilled': True}
    try:
        error.provider_response = entry
    except AttributeError:
        pass
    return error


def is_record(entry):
    return isinstance(entry, dict) and bool(entry.get('provider') or entry.get('httpStatus') or entry.get('code')
                                            or entry.get('rawBody'))


def normalize(entry):
    """A record ready to read: older rows (only rawBody/httpStatus/requestId) get their code/message/param parsed."""
    if not is_record(entry):
        return None
    result = dict(entry)
    raw = entry.get('rawBody')
    if isinstance(raw, str) and raw:
        parsed = parse_body(raw)
        for key in ('code', 'message', 'param', 'requestId'):
            if not result.get(key) and parsed.get(key) not in (None, ''):
                result[key] = parsed[key]
    message = result.get('message')
    if not result.get('requestId') and isinstance(message, str):
        embedded = _EMBEDDED_REQUEST_ID.search(message)
        result['requestId'] = embedded[1] if embedded else None
    result['code'] = _clean(result.get('code'), _CODE)
    result['param'] = _clean(result.get('param'), _PARAM)
    result['requestId'] = _clean(result.get('requestId'), _ID)
    result['taskId'] = _clean(result.get('taskId'), _ID)
    result['message'] = _bounded(message, MESSAGE_LIMIT) if isinstance(message, str) and message else None
    result['rawBody'] = _bounded(raw, RAW_LIMIT) if isinstance(raw, str) and raw else None
    if type(result.get('httpStatus')) is not int:
        result['httpStatus'] = None
    return {key: value for key, value in result.items() if value is not None}


def records(responses):
    """Every normalized record of a provider_responses value (markers such as uncertainSubmission are skipped)."""
    values = responses if isinstance(responses, list) else [responses] if isinstance(responses, dict) else []
    return [record for record in (normalize(value) for value in values) if record]


def primary(responses):
    """The record that explains the failure: the latest with a provider code, else the latest provider answer.

    Records are appended in order, so a terminal task failure outranks an earlier candidate's create rejection."""
    found = records(responses)[::-1]
    return (next((item for item in found if item.get('code') and item.get('source') != 'veevee'), None)
            or next((item for item in found if item.get('source') != 'veevee'), None)
            or (found[0] if found else None))


def public_message_text(message):
    """The provider's message when it is safe and short enough for an artist to read; else None."""
    if not isinstance(message, str):
        return None
    from apps.generation.failure_copy import INTERNAL
    text = _EMBEDDED_REQUEST_ID.sub('', redact(message)).replace('\u2014', '-').strip()
    text = re.sub(r'\s+', ' ', text)
    if not text or '[redacted]' in text or INTERNAL.search(text):
        return None
    if len(text) > PUBLIC_MESSAGE_LIMIT:
        text = text[:PUBLIC_MESSAGE_LIMIT].rsplit(' ', 1)[0] + '...'
    return text if text.endswith(('.', '!', '?')) else text + '.'


def user_detail(entry):
    """The exact detail appended to the friendly sentence, e.g. "Provider code: X. Request id: Y."."""
    if not entry:
        return ''
    ours = entry.get('source') == 'veevee'
    parts = []
    code = entry.get('code')
    if code and not (ours and code == 'provider_error'):
        parts.append(('Error code: ' if ours else 'Provider code: ') + code + '.')
    elif entry.get('httpStatus') and not ours:
        parts.append(f"Provider HTTP status: {entry['httpStatus']}.")
    message = public_message_text(entry.get('message')) if not code and not ours else None
    if message:
        parts.append('Provider message: ' + message)
    if entry.get('requestId'):
        parts.append('Request id: ' + entry['requestId'] + '.')
    if entry.get('taskId'):
        parts.append('Task id: ' + entry['taskId'] + '.')
    return ' '.join(parts)


_SENSITIVE = re.compile(r'(Input|Output)(Text|Image|Video|Audio)(?:SensitiveContentDetected|RiskDetection)(?:\.(\w+))?')


def policy_sentence(entry):
    """For a BytePlus content-policy code, the sentence naming what it rejected; None for anything else.

    An input-image privacy (real person) refusal keeps the Portrait Gallery advice and copyright keeps its own copy.
    """
    entry = entry or {}
    code = entry.get('code') or ''
    match = _SENSITIVE.fullmatch(code) if entry.get('provider') in ('seedance', 'seedream') else None
    if not match or match[3] == 'PrivacyInformation' or 'copyright' in (code + ' ' + str(entry.get('message') or '')).lower():
        return None
    label = PROVIDERS.get(entry.get('provider'), 'The provider')
    kind = match[2].lower()
    if match[1] == 'Output':
        return f'{label} stopped the generated {kind} under its content policy.'
    what = 'the prompt text' if kind == 'text' else 'the input ' + kind
    param = f" ({entry['param']})" if entry.get('param') else ''
    return f'{label} rejected {what}{param} under its content policy.'
