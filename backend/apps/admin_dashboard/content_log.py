"""Admin content log: who added, edited or deleted which board object, read from board_activity.

Board activity is written by the save path (apps.canvas.activity) and kept for its retention
window; this module only reads it. Admin only, keyset paged, with a streaming CSV export."""
import re
from django.db.models import Q
from django.http import StreamingHttpResponse
from apps.authentication.models import User
from apps.canvas.models import BoardActivity, ACTIVITY_ACTIONS
from apps.canvas.views import reply, failure
from apps.common.leases import now_ms
from .admin_api import node_route, admin_gate
from .queries import first, csv_line, csv_cell, iso_time, MAX_CSV_ROWS, ACTIVITY_CSV_BATCH

UUID = re.compile(r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
CURSOR = re.compile(r'^(\d{1,16})\.(\d{1,9})\.([0-9a-fA-F-]{36})$')
PAGE = 100


def filtered(params):
    rows = BoardActivity.objects.all()
    for name, field in (('boardId', 'board_id'), ('actorId', 'actor_id')):
        value = first(params, name)
        if value:
            if not UUID.match(value): raise ValueError(name)
            rows = rows.filter(**{field: value})
    action = first(params, 'action')
    if action:
        if action not in ACTIVITY_ACTIONS: raise ValueError('action')
        rows = rows.filter(action=action)
    return rows


def keyset(rows, last):
    if last:
        # Newest first on (created_at, ordinal, id): rows strictly after the cursor.
        rows = rows.filter(Q(created_at__lt=last[0]) | Q(created_at=last[0], ordinal__lt=last[1])
                           | Q(created_at=last[0], ordinal=last[1], id__lt=last[2]))
    return rows.order_by('-created_at', '-ordinal', '-id')


def entry(row):
    return {'id': str(row.id), 'boardId': str(row.board_id), 'actorId': str(row.actor_id) if row.actor_id else None, 'action': row.action,
            'nodeId': row.node_id, 'nodeType': row.node_type, 'snippet': row.snippet, 'createdAt': row.created_at}


def page_of(params):
    rows = filtered(params)
    cursor = first(params, 'cursor')
    match = CURSOR.match(cursor) if cursor else None
    if cursor and not match: raise ValueError('cursor')
    page = list(keyset(rows, (int(match[1]), int(match[2]), match[3]) if match else None)[:PAGE + 1])
    more = len(page) > PAGE
    page = page[:PAGE]
    return {'rows': [entry(row) for row in page], 'nextCursor': f'{page[-1].created_at}.{page[-1].ordinal}.{page[-1].id}' if more else None}


def csv_rows(params):
    rows = filtered(params)
    emails = {str(user.id): user.email for user in User.objects.all()}
    yield csv_line(['time', 'board_id', 'user', 'user_id', 'action', 'node_id', 'node_type', 'snippet'])
    sent, last = 0, None
    while sent < MAX_CSV_ROWS:
        size = min(ACTIVITY_CSV_BATCH, MAX_CSV_ROWS - sent)
        batch = list(keyset(rows, last)[:size])
        for row in batch:
            actor = str(row.actor_id) if row.actor_id else ''
            yield csv_line([iso_time(row.created_at), row.board_id, csv_cell(emails.get(actor, '')), actor, row.action,
                            csv_cell(row.node_id), csv_cell(row.node_type), csv_cell(row.snippet)])
        sent += len(batch)
        if len(batch) < size: return
        last = (batch[-1].created_at, batch[-1].ordinal, batch[-1].id)


@node_route(['GET'])
def content_log(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    params = request.query_params
    try:
        if first(params, 'format') == 'csv':
            response = StreamingHttpResponse(csv_rows(params), content_type='text/csv; charset=utf-8')
            response['Content-Disposition'] = f'attachment; filename="veevee-content-log-{iso_time(now_ms())[:10]}.csv"'
            response['Cache-Control'] = 'no-store'
            return response
        return reply(request, page_of(params))
    except ValueError: return reply(request, {'error': 'Invalid filter'}, 400)
    except Exception: return failure()
