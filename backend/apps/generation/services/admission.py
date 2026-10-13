"""Atomic global/per-user queue admission and the existing rolling spend gate."""
import math
import os

from django.db import connection, transaction
from django.db.models import Q

from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.serialization import generation_item
from .queue_snapshot import SQL as SNAPSHOT_SQL

MAX_CONCURRENT = {'image': 10, 'video': 6}
SPEND_WINDOW_MS = 600000
HELD_MESSAGE = 'Waiting for the API rate-limit window to clear — this will start automatically.'


def numeric(raw, fallback):
    try:
        value = float(raw) if str(raw).strip() else 0.0
        return value if math.isfinite(value) else fallback
    except (ValueError, TypeError):
        return fallback


def spend_limit_cents():
    raw = os.environ.get('GEMINI_SPEND_LIMIT_CENTS')
    value = numeric(raw, 150)
    if raw is not None and value == 0:
        return 0
    return math.floor(value) if value > 0 else 150


def best_of_multiplier():
    return min(4, max(1, numeric(os.environ.get('FACE_BEST_OF'), 2) or 2))


def bills_gemini(item):
    return (item.kind == 'image' and item.model not in ('Seedream 5.0 Pro', 'seedream-5-pro')) or item.model == 'Gemini Omni Flash'


def snapshot(item, *, now, best_of):
    with connection.cursor() as cursor:
        cursor.execute(SNAPSHOT_SQL, {'kind': item.kind, 'item_id': item.id,
            'created_at': item.created_at, 'best_of': best_of,
            'window_start': now - SPEND_WINDOW_MS,
            'skirt_start': now - SPEND_WINDOW_MS - 6 * 60 * 60 * 1000})
        return dict(zip([column.name for column in cursor.description], cursor.fetchone()))


def affordable(item, current, best_of):
    limit = spend_limit_cents()
    return limit <= 0 or not current['window_rows'] or float(current['window_cents']) + (item.cost_cents or 0) * best_of <= limit


def reap_stale_running_images(*, now=None):
    now = now_ms() if now is None else now
    return Generation.objects.filter(status='running', updated_at__lt=now - 420000, task_id__isnull=True).filter(
        Q(worker_lease_until__isnull=True) | Q(worker_lease_until__lte=now)).filter(
        Q(kind='image') | Q(kind='video')).update(
        status='failed', error='Generation timed out — the server process was interrupted.', updated_at=now)


def queue_position(identifier, *, now=None):
    now = now_ms() if now is None else now
    reap_stale_running_images(now=now)
    item = Generation.objects.filter(pk=identifier).first()
    if item is None:
        return None
    if item.status != 'queued':
        return {'position': 0, 'status': item.status, 'item': generation_item(item)}
    if item.user_id is None:
        return {'position':1,'status':item.status,'heldForAuthentication':True,
            'heldReason':'An authenticated account is required. This legacy job needs reconciliation before submission.'}
    multiplier = best_of_multiplier()
    current = snapshot(item, now=now, best_of=multiplier)
    if not current['user_eligible']:
        return {'position': 1, 'status': item.status, 'heldForConcurrency': True}
    position = max(0, current['running'] + current['older'] - (MAX_CONCURRENT.get(item.kind, 2) - 1))
    if position > 0 or not bills_gemini(item) or affordable(item, current, multiplier):
        return {'position': position, 'status': item.status}
    oldest = current['oldest_updated_at']
    return {'position': 1, 'status': item.status, 'heldForBudget': True,
            'heldReason': HELD_MESSAGE,
            'retryAfterMs': 5000 if oldest is None else min(max(oldest + SPEND_WINDOW_MS - now, 5000), SPEND_WINDOW_MS)}


def admit_job(identifier, *, now=None, owner=None):
    now = now_ms() if now is None else now
    with transaction.atomic():
        row = Generation.objects.filter(pk=identifier).first()
        if row is None or row.status != 'queued' or row.kind not in MAX_CONCURRENT or row.user_id is None:
            return None
        with connection.cursor() as cursor:
            for key in ('generation-kind:' + row.kind, 'generation-user:' + str(row.user_id or row.id)):
                cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', [key])
        fresh = Generation.objects.filter(pk=identifier, status='queued').first()
        if fresh is None or (owner is not None and fresh.worker_lease_id != owner):
            return None
        multiplier = best_of_multiplier()
        current = snapshot(fresh, now=now, best_of=multiplier)
        if not current['user_eligible'] or current['running'] + current['older'] >= MAX_CONCURRENT[fresh.kind]:
            return None
        if bills_gemini(fresh) and not affordable(fresh, current, multiplier):
            return None
        if not Generation.objects.filter(pk=identifier, status='queued').update(status='running', updated_at=now):
            return None
        return Generation.objects.get(pk=identifier)
