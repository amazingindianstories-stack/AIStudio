"""Admin AI interaction log: who ran which board AI job, when, on which board, with which model and outcome.

Reads canvas_board_ai_jobs joined to the generation row that executed it (status, model, cost). The prompt is
already stored on the job row, so it is shown here; nothing is written by this module. Admin only, keyset
paged on (created_at, id), with a streaming CSV export."""
from django.db.models import Q
from django.http import StreamingHttpResponse
from apps.authentication.models import User
from apps.canvas.models import BoardAiJob
from apps.canvas.views import reply, failure
from apps.common.leases import now_ms
from apps.generation.models import Generation
from .admin_api import node_route, admin_gate
from .content_log import UUID
from .queries import first, csv_line, csv_cell, iso_time, MAX_CSV_ROWS, ACTIVITY_CSV_BATCH
import re

CURSOR = re.compile(r'^(\d{1,16})\.([0-9a-fA-F-]{36})$')
PAGE = 100
PROMPT_LIMIT = 500


def filtered(params):
    rows = BoardAiJob.objects.all()
    for name, field in (('boardId', 'board_id'), ('userId', 'user_id')):
        value = first(params, name)
        if value:
            if not UUID.match(value): raise ValueError(name)
            rows = rows.filter(**{field: value})
    kind = first(params, 'capability')
    if kind: rows = rows.filter(format=kind)
    return rows


def keyset(rows, last):
    if last: rows = rows.filter(Q(created_at__lt=last[0]) | Q(created_at=last[0], id__lt=last[1]))
    return rows.order_by('-created_at', '-id')


def entries(jobs):
    generations = {g.id: g for g in Generation.objects.filter(id__in=[j.generation_id for j in jobs]).only('id', 'status', 'model', 'cost_cents', 'cost_basis', 'error')}
    out = []
    for job in jobs:
        gen = generations.get(job.generation_id)
        out.append({'id': str(job.id), 'boardId': str(job.board_id), 'userId': str(job.user_id), 'capability': job.format,
                    'prompt': job.prompt[:PROMPT_LIMIT], 'generationId': str(job.generation_id), 'createdAt': job.created_at,
                    'status': gen.status if gen else 'deleted', 'model': gen.model if gen else None,
                    'costCents': gen.cost_cents if gen else None, 'costBasis': gen.cost_basis if gen else None})
    return out


def page_of(params):
    cursor = first(params, 'cursor')
    match = CURSOR.match(cursor) if cursor else None
    if cursor and not match: raise ValueError('cursor')
    page = list(keyset(filtered(params), (int(match[1]), match[2]) if match else None)[:PAGE + 1])
    more = len(page) > PAGE
    page = page[:PAGE]
    return {'rows': entries(page), 'nextCursor': f'{page[-1].created_at}.{page[-1].id}' if more else None}


def csv_rows(params):
    rows = filtered(params)
    emails = {str(user.id): user.email for user in User.objects.all()}
    yield csv_line(['time', 'board_id', 'user', 'user_id', 'capability', 'model', 'status', 'cost_cents', 'cost_basis', 'prompt'])
    sent, last = 0, None
    while sent < MAX_CSV_ROWS:
        size = min(ACTIVITY_CSV_BATCH, MAX_CSV_ROWS - sent)
        batch = list(keyset(rows, last)[:size])
        for row in entries(batch):
            yield csv_line([iso_time(row['createdAt']), row['boardId'], csv_cell(emails.get(row['userId'], '')), row['userId'], row['capability'],
                            csv_cell(row['model']), row['status'], '' if row['costCents'] is None else row['costCents'],
                            csv_cell(row['costBasis']), csv_cell(row['prompt'])])
        sent += len(batch)
        if len(batch) < size: return
        last = (batch[-1].created_at, batch[-1].id)


@node_route(['GET'])
def ai_log(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    params = request.query_params
    try:
        if first(params, 'format') == 'csv':
            response = StreamingHttpResponse(csv_rows(params), content_type='text/csv; charset=utf-8')
            response['Content-Disposition'] = f'attachment; filename="veevee-ai-log-{iso_time(now_ms())[:10]}.csv"'
            response['Cache-Control'] = 'no-store'
            return response
        return reply(request, page_of(params))
    except ValueError: return reply(request, {'error': 'Invalid filter'}, 400)
    except Exception: return failure()
