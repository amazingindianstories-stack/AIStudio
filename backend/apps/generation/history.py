"""Current history read, including composite keysets and canonical filenames."""
import logging
from django.core.exceptions import ValidationError
from django.db import DataError
from django.http import HttpResponse
from django.conf import settings
from django.db.models import BooleanField, F
from django.db.models.expressions import RawSQL
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from apps.library.filenames import batch_resolve_generation_filenames
from .history_counts import filters, first, base_query
from .history_parameters import decode_cursor, page_limit
from .serialization import generation_item
from .updates import operand_text


def query_history(params):
    project, kind, query = filters(params)
    rows = base_query(kind, query)
    if first(params, 'projectId') == 'none' or project:
        rows = rows.filter(project_id=project)
    folder = first(params, 'folderId')
    if folder == 'none':
        rows = rows.filter(folder_id=None)
    elif folder:
        rows = rows.filter(folder_id=folder)
    favorite = first(params, 'favorite') == '1'
    if favorite:
        rows = rows.filter(is_favorite=True)
    sort = 'favorited_at' if favorite else 'created_at'
    cursor = decode_cursor(first(params, 'cursor'))
    if cursor:
        rows = rows.filter(RawSQL(f'("generations"."{sort}", "generations"."id") < (%s::bigint, %s::uuid)',
            [operand_text(cursor['sort']), cursor['id']], output_field=BooleanField()))
    limit = page_limit(first(params, 'limit'))
    # Match the declared composite indexes. created_at/id cannot be NULL;
    # a favorite cursor comparison also excludes NULL. The first favorite
    # page retains the historical NULL-first behavior for legacy rows.
    ordering = [F(sort).desc(nulls_last=True), F('id').desc(nulls_last=True)] if not favorite or cursor else ['-'+sort, '-id']
    selected = list(rows.order_by(*ordering)[:limit+1])
    more = len(selected) > limit
    page = selected[:limit]
    items = [generation_item(row) for row in page]
    names = batch_resolve_generation_filenames([row.id for row in page])
    for item in items:
        if item['id'] in names:
            item['filename'] = names[item['id']]['filename']
    next_cursor = None
    if more and page:
        last = page[-1]
        value = last.favorited_at if favorite and last.favorited_at is not None else last.created_at
        next_cursor = f'{operand_text(value)}.{last.id}'
    return {'items':items, 'nextCursor':next_cursor}


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
