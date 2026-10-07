import json
import logging
import time
import uuid

logger = logging.getLogger('veevee.requests')

class RequestLogMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        started = time.monotonic()
        request_id = str(uuid.uuid4())
        response = self.get_response(request)
        response['X-Request-ID'] = request_id
        logger.info(json.dumps({'event': 'request', 'request_id': request_id, 'route': request.resolver_match.route if request.resolver_match else 'unmatched', 'status': response.status_code, 'duration_ms': round((time.monotonic() - started) * 1000, 2)}))
        return response
