"""Optional best-effort Ably publication; PostgreSQL remains authoritative."""
import base64
import os
from urllib.parse import quote
from .providers.transport import HttpTransport, ProviderError


def generation_event(item, version=0):
    return {'type': 'generation.updated', 'generationId': str(item.id), 'status': item.status,
            'updatedAt': item.updated_at, 'version': version if type(version) is int and version > 0 else item.updated_at}


def publish(item, *, env=None, transport=None):
    env = os.environ if env is None else env
    key = env.get('ABLY_API_KEY')
    if not key or not item.id:
        return {'published': False, 'skipped': True}
    name, separator, secret = key.partition(':')
    if not separator or not name or not secret:
        raise ValueError('ABLY_API_KEY must be an app key (name:secret)')
    channels = ([f'user:{item.user_id}:generations'] if item.user_id else []) + ([f'project:{item.project_id}:generations'] if item.project_id else [])
    transport = transport or HttpTransport(allowed_hosts=['rest.ably.io'], timeout=10)
    for channel in channels:
        response = transport.request('POST', 'https://rest.ably.io/channels/' + quote(channel, safe='') + '/messages',
            headers={'Authorization': 'Basic ' + base64.b64encode(key.encode()).decode(), 'Content-Type': 'application/json'},
            body={'name': 'generation.updated', 'data': generation_event(item)})
        if not response.ok:
            raise ProviderError(f'Ably publish failed ({response.status})')
    return {'published': True, 'channels': channels}


def publish_best_effort(item):
    try:
        return publish(item)
    except Exception:
        return {'published': False}
