from django.db.models import Q, BooleanField
from django.db.models.expressions import RawSQL
from .models import Generation
from .serialization import generation_item


def operand_text(value):
    # PostgreSQL receives Node Number's integer or fractional text. Avoid
    # Django IntegerField's truncation and out-of-range predicate shortcuts.
    from decimal import Decimal
    number = float(value)
    text = repr(number)
    # Number.toString uses decimal notation below 1e21, scientific notation
    # above it. Expand shortest float text rather than the exact binary integer.
    if number.is_integer() and abs(number) < 1e21:
        return format(Decimal(text), 'f').split('.')[0]
    return text


PAGE_LIMIT = 100
ACTIVE_LIMIT = 200
# Rows can commit slightly after a poll reads, carrying an updated_at a little
# earlier than that poll's clock (worker clocks, longer transactions). The next
# watermark trails the server clock by this much; re-sent rows merge idempotently.
COMMIT_LAG_MS = 30_000


def read_generation_updates(since, limit=PAGE_LIMIT, after_id=None):
    """Return ``(items, next_cursor, more)`` without skipping changes.

    Changed rows are read oldest-first by ``(updated_at, id)`` so a full page
    hands back an exact cursor instead of silently truncating older changes.
    Active (queued/running) rows are always included.
    """
    base = Generation.objects.exclude(kind__in=('audio', 'text'))
    changed = RawSQL('"generations"."updated_at" > %s::bigint', [operand_text(since)], output_field=BooleanField())
    condition = Q(changed)
    if after_id is not None and float(since).is_integer():
        condition |= Q(updated_at=int(since), id__gt=after_id)
    rows = list(base.filter(condition).order_by('updated_at', 'id')[:limit + 1])
    more = len(rows) > limit
    rows = rows[:limit]
    seen = {row.id for row in rows}
    active = [row for row in base.filter(status__in=['queued', 'running']).order_by('-updated_at')[:ACTIVE_LIMIT]
              if row.id not in seen]
    cursor = {'since': rows[-1].updated_at, 'afterId': str(rows[-1].id)} if more else None
    from apps.library.filenames import batch_resolve_generation_filenames
    names = batch_resolve_generation_filenames([row.id for row in rows + active])
    return [generation_item(row, names.get(str(row.id), {}).get('filename')) for row in rows + active], cursor, more


import time
import logging
from django.db import DataError
from django.http import HttpResponse
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .watermark import since_watermark


def _after_id(raw):
    import uuid
    try:
        return uuid.UUID(raw) if raw else None
    except (ValueError, TypeError):
        return None


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def generation_updates(request):
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    values = request.query_params.getlist('since')
    raw = values[0] if values else None
    now = int(time.time() * 1000)
    since = since_watermark(raw, now)
    after_id = _after_id(request.query_params.get('afterId'))
    try:
        items, cursor, more = read_generation_updates(since, after_id=after_id)
    except DataError as error:
        code = getattr(error.__cause__, 'sqlstate', None)
        if code not in ('22P02', '22003'):
            raise
        # Current Node emits an empty 500 and no renewed cookie when its
        # bigint operand fails. Do not expose database or framework details.
        logging.getLogger(__name__).warning('update_operand_rejected sqlstate=%s', code)
        response = HttpResponse(b'', status=500)
        response.skip_session_renewal = True
        del response['Content-Type']
        return response
    # ``now`` is kept for older clients; ``next``/``more`` page without gaps.
    next_cursor = cursor or {'since': max(int(since), now - COMMIT_LAG_MS), 'afterId': None}
    response = Response({'items': items, 'now': now, 'next': next_cursor, 'more': more})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
