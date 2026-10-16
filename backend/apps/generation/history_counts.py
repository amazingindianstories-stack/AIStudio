from django.conf import settings
from django.db.models import BooleanField, Count
from django.db.models.expressions import RawSQL
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .models import Generation

JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def first(params, key):
    values = params.getlist(key)
    return values[0] if values else None


def filters(params):
    project = first(params, 'projectId')
    kind = first(params, 'kind')
    raw = (first(params, 'q') or '').strip(JS_WHITESPACE)
    # JavaScript slice counts UTF-16 units; Node's UTF-8 binding replaces an
    # orphan surrogate at the slice boundary with U+FFFD.
    query = raw.encode('utf-16-le', 'surrogatepass')[:400].decode('utf-16-le', 'replace').strip(JS_WHITESPACE)
    return (None if project == 'none' else project), (kind if kind in ('image', 'video', 'audio') else None), query


def base_query(kind, query):
    rows = Generation.objects.all()
    if kind != 'audio':
        rows = rows.exclude(kind='audio')
    if kind:
        rows = rows.filter(kind=kind)
    if query:
        pattern = '%' + query.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'
        # Keep PostgreSQL ILIKE semantics (Django icontains uses UPPER/LIKE).
        rows = rows.filter(RawSQL('"generations"."prompt" ILIKE %s', [pattern], output_field=BooleanField()))
    return rows


def grouped(rows):
    result = {'total': 0, 'unsorted': 0, 'byFolder': {}}
    for row in rows.order_by().values('folder_id').annotate(n=Count('*')):
        result['total'] += row['n']
        if row['folder_id'] is None:
            result['unsorted'] += row['n']
        else:
            result['byFolder'][str(row['folder_id'])] = row['n']
    return result


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def history_counts(request):
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    project, kind, query = filters(request.query_params)
    rows = base_query(kind, query)
    response = Response({'project': grouped(rows.filter(project_id=project)) if project else {'total': 0, 'unsorted': 0, 'byFolder': {}},
        'globalLibrary': grouped(rows.filter(project_id=None)),
        'allAssets': rows.count(), 'favorites': rows.filter(is_favorite=True).count()})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
