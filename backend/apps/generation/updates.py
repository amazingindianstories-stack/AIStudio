from django.db.models import Q, BooleanField
from django.db.models.expressions import RawSQL
from .models import Generation
from .serialization import generation_item


def operand_text(value):
    # PostgreSQL receives Node Number's integer or fractional text. Avoid
    # Django IntegerField's truncation and out-of-range predicate shortcuts.
    return str(int(value)) if value == int(value) else str(value)


def read_generation_updates(since, limit=100):
    rows = Generation.objects.exclude(kind='audio').filter(
        Q(status__in=['queued', 'running']) | Q(RawSQL('"generations"."updated_at" > %s::bigint', [operand_text(since)], output_field=BooleanField()))
    ).order_by('-updated_at')[:limit]
    return [generation_item(row) for row in rows]


import time
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .watermark import since_watermark


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def generation_updates(request):
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    values = request.query_params.getlist('since')
    raw = values[0] if values else None
    since = since_watermark(raw, int(time.time() * 1000))
    response = Response({'items': read_generation_updates(since), 'now': int(time.time() * 1000)})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
