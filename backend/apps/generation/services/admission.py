"""Atomic global/per-user queue admission and the existing rolling spend gate."""
import math
import os

from django.db import connection, transaction
from django.db.models import Q

from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.serialization import generation_item
from .queue_snapshot import SQL as SNAPSHOT_SQL

MAX_CONCURRENT = {'image': 10, 'video': 8}    # running jobs across everyone
PER_USER_DEFAULT = PER_USER_MAX = 8                # maxConcurrentJobs: running image/video jobs per user
# BytePlus runs at most this many tasks per Seedance model per account (3 Individual, 10 Enterprise) and silently
# queues the rest on its side; keeping the excess in our queue keeps the order fair and visible.
LANE_SETTING, LANE_DEFAULT, LANE_MAX = 'seedanceConcurrency', 3, 50
SLOT_WAITING = 'SLOT_WAITING'
WORKER_SLOT_WAITING = 'WORKER_SLOT_WAITING'
WORKER_SLOT_MESSAGE = 'Waiting for a free worker slot'
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


def gemini_video_models():
    """Every Gemini Omni name and id, retired ones included: their spend stays in the window it was made in."""
    from apps.generation.model_registry import MODEL_REGISTRY
    return sorted(name for model in MODEL_REGISTRY if model.get('provider') == 'omni' for name in (model['id'], model['name']))


def non_gemini_image_models():
    """Image model names and ids billed by their own provider account (Seedream, Kling), never by the Gemini key:
    they neither spend nor wait on the Gemini window."""
    from apps.generation.model_registry import MODEL_REGISTRY
    return sorted(name for model in MODEL_REGISTRY if model['kind'] == 'image' and model.get('provider') in ('seedream', 'kling')
                  for name in (model['id'], model['name']))


def bills_gemini(item):
    return (item.kind == 'image' and item.model not in non_gemini_image_models()) or item.model in gemini_video_models()


def lane_models(item):
    """Model names sharing this video job's BytePlus model (versions of one model share its concurrency), else []."""
    from apps.generation.model_registry import MODEL_REGISTRY, is_provider_model, provider_model_id
    if item.kind == 'video' and is_provider_model(item.model, 'omnihuman'):
        return ['OmniHuman 2.0']
    if item.kind != 'video' or not is_provider_model(item.model, 'byteplus'):
        return []
    target = provider_model_id(item.model)
    names = set()
    for model in MODEL_REGISTRY:
        if model.get('provider') == 'byteplus' and provider_model_id(model['id']) == target:
            names.update((model['id'], model['name']))
    return sorted(names)


def lane_capacity():
    from apps.admin_dashboard.models import AppSetting
    from apps.admin_dashboard.views import LIMITS, parse
    return parse(AppSetting.objects.filter(key=LANE_SETTING).values_list('value', flat=True).first(), LIMITS[LANE_SETTING])


def lane_message(item):
    return f'Waiting for a free {item.model} slot - it starts automatically.'


def snapshot(item, *, now, best_of):
    with connection.cursor() as cursor:
        cursor.execute(SNAPSHOT_SQL, {'kind': item.kind, 'item_id': item.id, 'user_default': PER_USER_DEFAULT, 'user_max': PER_USER_MAX,
            'lane_models': lane_models(item), 'gemini_video_models': gemini_video_models(),
            'non_gemini_image_models': non_gemini_image_models(),
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
    if lane_models(item):
        lane = max(0, current['lane_running'] + current['lane_older'] - (lane_capacity() - 1))
        if lane > position:
            return {'position': lane, 'status': item.status, 'heldForProvider': True, 'heldReason': lane_message(item)}
    if position > 0 or not bills_gemini(item) or affordable(item, current, multiplier):
        return {'position': position, 'status': item.status}
    oldest = current['oldest_updated_at']
    return {'position': 1, 'status': item.status, 'heldForBudget': True,
            'heldReason': HELD_MESSAGE,
            'retryAfterMs': 5000 if oldest is None else min(max(oldest + SPEND_WINDOW_MS - now, 5000), SPEND_WINDOW_MS)}


def admit_job(identifier, *, now=None, owner=None, held=None):
    """Move a queued job to running when every limit allows it. `held` (a list) receives 'lane' when only the
    provider's per-model limit kept it queued."""
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
        if lane_models(fresh) and current['lane_running'] + current['lane_older'] >= lane_capacity():
            if held is not None:
                held.append('lane')
            return None
        if bills_gemini(fresh) and not affordable(fresh, current, multiplier):
            return None
        cleared = {'provider_status': None, 'progress_message': None} if fresh.provider_status in (SLOT_WAITING, WORKER_SLOT_WAITING) else {}
        if not Generation.objects.filter(pk=identifier, status='queued').update(status='running', updated_at=now, **cleared):
            return None
        return Generation.objects.get(pk=identifier)


def show_worker_slot_wait(item):
    """Label admissible, unclaimed queued rows and unlabel held ones; replace a stale provider-slot wait but no other wait."""
    if item.status != 'queued' or item.provider_status not in (None, '', SLOT_WAITING, WORKER_SLOT_WAITING):
        return
    position = queue_position(item.id)
    if not position or position['status'] != 'queued':
        return
    now = now_ms()
    unclaimed = Generation.objects.filter(pk=item.id, status='queued').filter(
        Q(worker_lease_until__isnull=True) | Q(worker_lease_until__lte=now))
    if position['position'] != 0:
        changed = unclaimed.filter(provider_status=WORKER_SLOT_WAITING).update(
            provider_status=None, progress_message=None, updated_at=now)
    else:
        changed = unclaimed.filter(Q(provider_status__isnull=True) | Q(provider_status='') | Q(provider_status=SLOT_WAITING)).update(
            provider_status=WORKER_SLOT_WAITING, progress_message=WORKER_SLOT_MESSAGE, updated_at=now)
    if changed:
        from apps.generation.realtime import publish_best_effort
        publish_best_effort(Generation.objects.get(pk=item.id))
