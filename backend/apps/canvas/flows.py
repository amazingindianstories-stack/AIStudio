"""Flows, Catch up, AI search and AI usage analytics for boards.

A Flow is a chain of AI steps drawn on the board (sticky-shaped nodes carrying ``flow`` settings, joined by ordinary
connectors). The board walks the chain in order and asks for one ``flowstep`` job per step, so each step is quoted,
admitted and billed like any other board text job and nothing runs until the person confirms the quoted total. The
server keeps the 24 hours of earlier outputs of each step (``FlowOutputVersion``) so a result can be reverted;
``run_scheduler`` prunes older ones.
"""
import json
import logging
from datetime import datetime, timedelta, timezone

from apps.authentication.models import User
from apps.common.leases import now_ms
from apps.generation.models import Generation
from .ai_jobs import PROCESSING, JobError
from .models import BoardActivity, BoardAiJob, BoardVisit, FlowOutputVersion
from . import services, sidekicks

logger = logging.getLogger('veevee.maintenance')

ACK = sidekicks.ACK
MAX_STEP_TASK = 4000
MAX_INPUTS = 20
MAX_INPUT_CHARS = 10_000
MAX_FLOW_STEPS = 30
FLOW_CHARS = 50_000
VERSION_RETENTION_MS = 24 * 60 * 60 * 1000
MAX_VERSIONS_PER_NODE = 50
CATCHUP_PERIODS = {'1w': 7, '2w': 14, '1m': 30}
CATCHUP_ROWS = 300
CATCHUP_CHARS = 40_000
SEARCH_RESULTS = 50

FLOW_TEMPLATES = [
    {'id': 'summarize-and-actions', 'name': 'Summarize and list actions', 'description': 'Reads the connected notes, summarizes them, then lists next steps.',
     'steps': [{'block': 'instruction', 'task': 'Summarize the connected notes in three sentences.'},
               {'block': 'instruction', 'task': 'From the summary, list the next steps as short lines, one per line.'}]},
    {'id': 'pitch-from-notes', 'name': 'Pitch from notes', 'description': 'Turns notes into a logline, then a one-paragraph pitch.',
     'steps': [{'block': 'instruction', 'task': 'Write a one-sentence logline from the connected notes.'},
               {'block': 'instruction', 'task': 'Expand the logline into a one-paragraph pitch for a producer.'}]},
    {'id': 'shot-list', 'name': 'Scene to shot list', 'description': 'Breaks a scene into shots, then writes a camera note for each.',
     'steps': [{'block': 'instruction', 'task': 'Break the connected scene into a numbered list of shots, one per line.'},
               {'block': 'instruction', 'task': 'For each shot, add a short camera and lens note on the same line.'}]},
    {'id': 'facts-and-brief', 'name': 'Facts and brief', 'description': 'Lists the key facts on a topic, then writes a short brief.',
     'steps': [{'block': 'instruction', 'task': 'List the five most useful facts about the connected topic.'},
               {'block': 'instruction', 'task': 'Write a short brief from those facts for a creative team.'}]},
]


def _error(message, code=None, status=400):
    return JobError(status, message, code)


# ---- Flow steps ---------------------------------------------------------------------------------------------------

def step_request(body):
    """The validated Flow step: (format, processing, conversation turns)."""
    if not isinstance(body, dict):
        raise _error('Invalid request.')
    task = sidekicks._text(body.get('task'), MAX_STEP_TASK, 'Task', True)
    processing = body.get('processing', 'basic')
    if processing not in PROCESSING:
        raise _error('Unknown processing.', 'UNKNOWN_PROCESSING')
    inputs = body.get('inputs', [])
    if not isinstance(inputs, list) or len(inputs) > MAX_INPUTS:
        raise _error(f'A step takes at most {MAX_INPUTS} inputs.')
    parts, total = [], 0
    for item in inputs:
        text = item.get('text') if isinstance(item, dict) else None
        if not isinstance(text, str):
            raise _error('Invalid input.')
        text = text.strip()[:MAX_INPUT_CHARS]
        total += len(text)
        if text:
            parts.append(f'--- input {len(parts) + 1}\n{text}')
    if total > FLOW_CHARS:
        raise _error('This step\'s inputs are too long.')
    web = body.get('webSearch', False)
    if not isinstance(web, bool):
        raise _error('Invalid webSearch.')
    context = f'TASK:\n{task}\n\nINPUTS:\n' + ('\n\n'.join(parts) if parts else '(none)')
    return 'flowstep-web' if web else 'flowstep', processing, [{'role': 'user', 'text': context}, {'role': 'model', 'text': ACK}, {'role': 'user', 'text': 'Run the step.'}], task


def quote_step(actor, body):
    name, processing, turns, _ = step_request(body)
    return sidekicks.quote_job(actor, name, processing, turns)


def quote_flow(actor, body):
    """The whole run's price: each step quoted on its own, with the total (steps whose inputs are not known yet
    carry placeholder text from the board, so the figure is an estimate)."""
    steps = body.get('steps') if isinstance(body, dict) else None
    if not isinstance(steps, list) or not 0 < len(steps) <= MAX_FLOW_STEPS:
        raise _error(f'A Flow runs 1 to {MAX_FLOW_STEPS} steps.')
    quotes = []
    for step in steps:
        quote = quote_step(actor, step)
        quotes.append({'costCents': quote['costCents'], 'model': quote['model'], **({'groundingCents': quote['groundingCents']} if 'groundingCents' in quote else {})})
    total = sum(item['costCents'] for item in quotes)
    return {'steps': quotes, 'costCents': total, 'credits': sidekicks.quote_credits(actor.id)}


def submit_step(actor, board, body, idempotency_key):
    name, processing, turns, task = step_request(body)
    return sidekicks.submit_job(actor, board, name, task, idempotency_key,
                                request={'processing': processing, 'context': turns[0]['text'], **({'webSearch': True} if name == 'flowstep-web' else {})},
                                build=lambda: (processing, turns), operation='BOARD_FLOW_STEP')


# ---- output versions ----------------------------------------------------------------------------------------------

def node_id(value):
    if not isinstance(value, str) or not 0 < len(value) <= 64:
        raise _error('Invalid nodeId.')
    return value


def record_version(actor, board, body):
    """Keep the output a Flow step is about to lose; a repeat of the newest kept text is not stored again."""
    node = node_id(body.get('nodeId') if isinstance(body, dict) else None)
    text = body.get('text')
    if not isinstance(text, str) or not text.strip() or len(text) > sidekicks.MAX_MESSAGE:
        raise _error('Invalid text.')
    latest = FlowOutputVersion.objects.filter(board_id=board.id, node_id=node).order_by('-created_at').first()
    if latest is None or latest.text != text:
        FlowOutputVersion.objects.create(board_id=board.id, node_id=node, user_id=actor.id, text=text, created_at=now_ms())
        stale = list(FlowOutputVersion.objects.filter(board_id=board.id, node_id=node).order_by('-created_at')
                     .values_list('id', flat=True)[MAX_VERSIONS_PER_NODE:])
        if stale:
            FlowOutputVersion.objects.filter(pk__in=stale).delete()
    return {'ok': True}


def list_versions(board, node):
    node = node_id(node)
    rows = FlowOutputVersion.objects.filter(board_id=board.id, node_id=node, created_at__gt=now_ms() - VERSION_RETENTION_MS) \
        .order_by('-created_at')[:MAX_VERSIONS_PER_NODE]
    names = dict(User.objects.filter(pk__in=[row.user_id for row in rows if row.user_id]).values_list('id', 'name'))
    return [{'id': str(row.id), 'text': row.text, 'at': row.created_at, 'by': names.get(row.user_id)} for row in rows]


def prune_flow_versions(now=None):
    """Scheduler job: drop Flow output versions older than 24 hours."""
    now = now_ms() if now is None else now
    deleted = FlowOutputVersion.objects.filter(created_at__lte=now - VERSION_RETENTION_MS).delete()[0]
    logger.info(json.dumps({'event': 'maintenance_cleanup', 'target': 'flow_output_versions', 'deleted': deleted}))
    return {'ok': True, 'deleted': deleted}


# ---- Catch up -----------------------------------------------------------------------------------------------------

def visit(actor, board):
    """Record that the user opened the board; returns the time of their previous visit (null the first time)."""
    now = now_ms()
    previous = BoardVisit.objects.filter(board_id=board.id, user_id=actor.id).values_list('visited_at', flat=True).first()
    BoardVisit.objects.update_or_create(board_id=board.id, user_id=actor.id, defaults={'visited_at': now})
    return {'previousVisitAt': previous}


def catchup_since(actor, board, period):
    if period in CATCHUP_PERIODS:
        return now_ms() - CATCHUP_PERIODS[period] * 24 * 60 * 60 * 1000
    visited = BoardVisit.objects.filter(board_id=board.id, user_id=actor.id).values_list('visited_at', flat=True).first()
    return visited if visited is not None else now_ms() - CATCHUP_PERIODS['1w'] * 24 * 60 * 60 * 1000


def catchup_rows(actor, board, period):
    since = catchup_since(actor, board, period)
    rows = BoardActivity.objects.filter(board_id=board.id, created_at__gt=since).exclude(actor_id=actor.id) \
        .order_by('created_at', 'ordinal')
    return since, rows


def catchup_info(actor, board, period):
    since, rows = catchup_rows(actor, board, period)
    return {'since': since, 'changes': rows.count(), 'period': period if period in CATCHUP_PERIODS else 'last'}


def catchup_turns(actor, board, period):
    since, rows = catchup_rows(actor, board, period)
    rows = list(rows[:CATCHUP_ROWS])
    if not rows:
        raise _error('Nothing changed in this time.', 'NOTHING_CHANGED', 409)
    names = dict(User.objects.filter(pk__in={row.actor_id for row in rows if row.actor_id}).values_list('id', 'name'))
    lines = []
    for row in rows:
        when = datetime.fromtimestamp(row.created_at / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M')
        lines.append(f"{when}|{names.get(row.actor_id, 'Someone')}|{row.action}|{row.node_type}|{row.node_id}|{row.snippet or ''}")
    context = ('CHANGES since ' + datetime.fromtimestamp(since / 1000, timezone.utc).strftime('%Y-%m-%d %H:%M')
               + ' (time|who|action|type|nodeId|text):\n' + '\n'.join(lines))[:CATCHUP_CHARS]
    return [{'role': 'user', 'text': context}, {'role': 'model', 'text': ACK}, {'role': 'user', 'text': 'Summarize what changed.'}]


def quote_catchup(actor, board, body):
    period = body.get('period') if isinstance(body, dict) else None
    return sidekicks.quote_job(actor, 'catchup', 'basic', catchup_turns(actor, board, period))


def submit_catchup(actor, board, body, idempotency_key):
    period = body.get('period') if isinstance(body, dict) else None
    return sidekicks.submit_job(actor, board, 'catchup', 'Catch up', idempotency_key, request={'period': period},
                                build=lambda: ('basic', catchup_turns(actor, board, period)), operation='BOARD_CATCHUP')


# ---- AI search ----------------------------------------------------------------------------------------------------

def search_turns(body):
    query = sidekicks._text(body.get('query') if isinstance(body, dict) else None, 300, 'Search', True)
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    return [{'role': 'user', 'text': f'TODAY: {today}'}, {'role': 'model', 'text': ACK}, {'role': 'user', 'text': query}], query


def quote_search(actor, body):
    return sidekicks.quote_job(actor, 'boardsearch', 'basic', search_turns(body)[0])


def submit_search(actor, board, body, idempotency_key):
    turns, query = search_turns(body)
    return sidekicks.submit_job(actor, board, 'boardsearch', query, idempotency_key, request={'query': query},
                                build=lambda: ('basic', turns), operation='BOARD_SEARCH')


def apply_search(actor, board, identifier):
    """Run a finished ``boardsearch`` job's filters over this project's boards the user can open."""
    job = sidekicks.get_job(actor, board, identifier)
    if job['format'] != 'boardsearch':
        raise _error('Job not found.', status=404)
    if job['status'] != 'succeeded':
        raise _error('The search has not finished.', 'NOT_READY', 409)
    filters = job['result']
    terms = [term.lower() for term in filters.get('terms', [])]
    cutoff = now_ms() - filters['updatedWithinDays'] * 24 * 60 * 60 * 1000 if filters.get('updatedWithinDays') else None
    matches = []
    for item in services.list_boards(board.project_id, actor):
        if terms and not any(term in item['name'].lower() for term in terms):
            continue
        if cutoff is not None and item['updatedAt'] < cutoff:
            continue
        if filters.get('createdByMe') and item['createdBy'] != str(actor.id):
            continue
        matches.append(item)
    matches.sort(key=lambda item: -item['updatedAt'])
    return {'filters': filters, 'boards': matches[:SEARCH_RESULTS]}


# ---- usage analytics ----------------------------------------------------------------------------------------------

PERIODS = {'day': 'day', 'week': 'week', 'month': 'month', 'quarter': 'quarter'}
FORMAT_LABELS = {'sidekick': 'Sidekick', 'sidekick-web': 'Sidekick', 'flowstep': 'Flow', 'flowstep-web': 'Flow', 'catchup': 'Catch up',
                 'boardsearch': 'AI search', 'stickies': 'Create with AI', 'image': 'Create with AI'}


def usage(body):
    """Board AI spend for administrators: estimator cents and job counts per period, by action and (unless hidden)
    by person, over the last ``days``."""
    period = PERIODS.get(body.get('period'), 'month')
    days = body.get('days')
    days = days if isinstance(days, int) and 1 <= days <= 730 else 180
    hide_users = body.get('hideUsers') is True
    since = now_ms() - days * 24 * 60 * 60 * 1000
    jobs = list(BoardAiJob.objects.filter(created_at__gte=since).values('user_id', 'format', 'created_at', 'generation_id'))
    costs = dict(Generation.objects.filter(pk__in=[job['generation_id'] for job in jobs]).exclude(status__in=('failed', 'cancelled'))
                 .values_list('id', 'cost_cents'))
    names = {} if hide_users else dict(User.objects.filter(pk__in={job['user_id'] for job in jobs}).values_list('id', 'name'))
    buckets, by_format, by_user = {}, {}, {}
    for job in jobs:
        cost = costs.get(job['generation_id'])
        if cost is None:
            continue
        moment = datetime.fromtimestamp(job['created_at'] / 1000, timezone.utc)
        if period == 'day':
            start = moment.date()
        elif period == 'week':
            start = (moment - timedelta(days=moment.weekday())).date()
        elif period == 'month':
            start = moment.date().replace(day=1)
        else:
            start = moment.date().replace(month=(moment.month - 1) // 3 * 3 + 1, day=1)
        label = FORMAT_LABELS.get(job['format'], job['format'])
        for table, key in ((buckets, start.isoformat()), (by_format, label)):
            row = table.setdefault(key, {'costCents': 0, 'jobs': 0})
            row['costCents'] += cost
            row['jobs'] += 1
        if not hide_users:
            row = by_user.setdefault(str(job['user_id']), {'id': str(job['user_id']), 'name': names.get(job['user_id'], 'Unknown'),
                                                           'costCents': 0, 'jobs': 0})
            row['costCents'] += cost
            row['jobs'] += 1
    return {'period': period, 'days': days, 'hideUsers': hide_users,
            'periods': [{'start': key, **value} for key, value in sorted(buckets.items())],
            'formats': [{'format': key, **value} for key, value in sorted(by_format.items(), key=lambda pair: -pair[1]['costCents'])],
            'users': None if hide_users else sorted(by_user.values(), key=lambda row: -row['costCents']),
            'totalCents': sum(row['costCents'] for row in buckets.values())}
