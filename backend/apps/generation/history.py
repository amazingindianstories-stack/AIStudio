"""GET /api/history: a library page from services.reads, including composite keysets and canonical filenames."""
import logging
from django.core.exceptions import ValidationError
from django.db import DataError
from django.http import HttpResponse
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .services.reads import query_history


@api_view(['GET', 'PATCH', 'DELETE'])
@authentication_classes([])
@permission_classes([])
def history_reads(request):
    user = lookup(request)
    if user is None:
        return Response({'error':'UNAUTHENTICATED'}, status=401)
    if request.method != 'GET':
        from .history_writes import history_mutation
        from apps.common.responses import renew_session
        return renew_session(request, history_mutation(request, user))
    try:
        page = query_history(request.query_params)
    except (ValidationError, DataError) as error:
        code = getattr(error.__cause__, 'sqlstate', None)
        if isinstance(error, DataError) and code not in ('22P02', '22003'):
            raise
        if isinstance(error, ValidationError) and error.code != 'invalid':
            raise
        logging.getLogger(__name__).warning('history_parameter_rejected code=%s', code or 'invalid_uuid')
        response = HttpResponse(b'', status=500)
        del response['Content-Type']
        return response
    response = Response(page)
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
