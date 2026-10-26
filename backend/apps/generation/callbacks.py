"""Authenticated Seedance callbacks feed the same fenced durable state machine."""
import hashlib
import hmac
import re
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.common.leases import now_ms
from apps.generation.providers.seedance import normalize_video_task_payload
from apps.generation.services import coordinator, poller


def token_matches(supplied, expected):
    if not isinstance(supplied, str) or not isinstance(expected, str) or not expected:
        return False
    return hmac.compare_digest(hashlib.sha256(supplied.encode()).digest(), hashlib.sha256(expected.encode()).digest())


def extract_task_id(payload):
    if not isinstance(payload, dict):
        return None
    value = payload.get('id')
    if value is None:
        value = payload.get('task_id')
    if value is None and isinstance(payload.get('data'), dict):
        value = payload['data'].get('id')
    if not isinstance(value, str):
        return None
    value = value.strip()
    return value if 0 < len(value) <= 256 and re.fullmatch(r'[A-Za-z0-9._:-]+', value) else None


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def seedance_callback(request):
    expected = getattr(settings, 'SEEDANCE_CALLBACK_SECRET', '')
    if not expected:
        return Response({'error': 'CALLBACK_NOT_CONFIGURED'}, status=503)
    tokens = request.query_params.getlist('token')
    if not token_matches(tokens[0] if tokens else None, expected):
        return Response({'error': 'UNAUTHORIZED'}, status=401)
    try:
        payload = request.data
    except Exception:
        payload = None
    task_id = extract_task_id(payload)
    if not task_id:
        return Response({'error': 'INVALID_TASK_ID'}, status=400)
    item = coordinator.task_item(task_id)
    if item is None:
        return Response({'accepted': False}, status=202)
    timestamp = now_ms()
    provider = coordinator.provider_timestamps(payload)
    current = coordinator.mark_callback_received(task_id, now=timestamp, provider=provider) or item
    if current.status in ('succeeded', 'failed', 'cancelled'):
        kind = current.status
    else:
        deps = poller.Dependencies()
        default_get = deps.get_video
        deps.get_video = lambda requested, **options: normalize_video_task_payload(payload) if requested == task_id else default_get(requested, **options)
        kind = poller.advance(current, source='callback', provider=provider, callback_received_at=timestamp, dependencies=deps)['kind']
    return Response({'accepted': True, 'outcome': kind}, headers={'Cache-Control': 'no-store'})


@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def retired_queue_execute(request):
    # Explicit blueprint retirement: a browser never launches paid provider work.
    worker = token_matches(request.headers.get('x-generation-worker-secret'), getattr(settings, 'GENERATION_WORKER_SECRET', ''))
    if not worker and lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    return Response({'error': 'QUEUE_EXECUTION_MOVED', 'message': 'Generation execution is owned by the Python worker.'}, status=410)
