import json
import logging
import time
import uuid

logger = logging.getLogger('veevee.requests')

class LocalDataModeMiddleware:
    """Viewer mode refuses mutations before domain code or provider work."""
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from django.conf import settings
        from django.http import JsonResponse
        if settings.LOCAL_DATA_MODE == 'read_only_viewer' and request.method not in ('GET', 'HEAD', 'OPTIONS'):
            return JsonResponse({'error': 'READ_ONLY_DATA_VIEWER'}, status=403)
        if settings.LOCAL_DATA_MODE == 'read_only_viewer' and request.path.startswith('/api/') and request.path != '/api/health':
            from django.db import connection, transaction
            with transaction.atomic():
                with connection.cursor() as cursor:
                    cursor.execute('SET LOCAL transaction_read_only = on')
                response = self.get_response(request)
        else:
            response = self.get_response(request)
        response['X-Veevee-Data-Mode'] = settings.LOCAL_DATA_MODE
        return response

class SessionRenewalMiddleware:
    """Carry lookup renewal through all domain responses, including errors.

    Explicit login/logout/password cookies win over an earlier lookup renewal.
    """
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        from .responses import renew_session
        return renew_session(request, self.get_response(request))

class RequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        started = time.monotonic()
        request_id = str(uuid.uuid4())
        response = self.get_response(request)
        response['X-Request-ID'] = request_id
        event = {'event': 'request', 'request_id': request_id, 'route': request.resolver_match.route if request.resolver_match else 'unmatched', 'status': response.status_code, 'duration_ms': round((time.monotonic() - started) * 1000, 2)}
        if hasattr(request, 'validated_actor_id'):
            event['user_id'] = request.validated_actor_id
        logger.info(json.dumps(event))
        return response
