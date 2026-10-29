"""Persistent scheduling, leased claims and fenced status updates."""
from datetime import datetime
import math

from django.db import transaction
from django.db.models import F, Q
from django.db.models import Count, Window, Case, When, Value, IntegerField
from django.db.models.functions import RowNumber

from apps.common.leases import now_ms
from apps.generation.models import Generation
from .admission import SLOT_WAITING, WORKER_SLOT_WAITING

DEFAULT_POLL_DELAY_MS = 5000
MAX_COORDINATOR_BATCH = 25


def eligible():
    owned = Q(user_id__isnull=False)
    accepted = Q(task_id__isnull=False) & ~Q(task_id='')
    queued = Q(status='queued',kind__in=('image','video','text')) & owned
    asynchronous_image = Q(kind='image',model__in=('Kling Image 3.0','Kling Image 2.1',
        'Higgsfield Nano Banana Pro','Higgsfield Soul')) & accepted
    running = ((Q(kind='video') | Q(model__startswith='Magnific ')) & (owned | accepted)) | asynchronous_image
    from .audio_submission import queued_audio
    return queued | (Q(status='running') & running) | queued_audio()


def provider_timestamp(value):
    if type(value) in (int, float) and math.isfinite(value):
        return math.floor((value * 1000 if value < 10000000000 else value) + .5)
    if isinstance(value, str):
        try:
            return math.floor(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000 + .5)
        except ValueError:
            pass
    return None


def provider_timestamps(payload):
    source = payload.get('data') if isinstance(payload.get('data'), dict) else payload
    result = {}
    for snake, camel in (('created_at', 'createdAt'), ('updated_at', 'updatedAt')):
        value = source.get(snake, source.get(camel))
        timestamp = provider_timestamp(value)
        if timestamp is not None:
            result['provider_' + snake] = timestamp
    status = payload.get('providerStatus', source.get('status', source.get('state')))
    if status is not None:
        result['provider_status'] = status
    return result


def claim_generation(identifier, owner, *, now=None, ttl_ms=60000):
    if not identifier or not owner:
        raise ValueError('generation id and worker owner are required')
    now = now_ms() if now is None else now
    with transaction.atomic():
        query = Generation.objects.filter(eligible(), pk=identifier).filter(
            Q(worker_lease_until__isnull=True) | Q(worker_lease_until__lte=now) | Q(worker_lease_id=owner))
        if not query.update(worker_lease_id=owner, worker_lease_until=now + ttl_ms):
            return None
        return Generation.objects.get(pk=identifier)


def release_generation(identifier, owner):
    with transaction.atomic():
        if not Generation.objects.filter(pk=identifier, worker_lease_id=owner).update(
                worker_lease_id=None, worker_lease_until=None):
            return None
        return Generation.objects.get(pk=identifier)


SHORT_SLOT = Q(kind='video') | Q(model__startswith='Magnific ')


def due_generations(*, now, exclude_ids=()):
    return Generation.objects.filter(eligible()).exclude(pk__in=exclude_ids).filter(
        Q(next_poll_at__isnull=True) | Q(next_poll_at__lte=now)).filter(
        Q(worker_lease_until__isnull=True) | Q(worker_lease_until__lte=now))


def select_unlabelled_short_slot(*, now=None, limit=MAX_COORDINATOR_BATCH, exclude_ids=()):
    """Queued video/upscale rows not yet confirmed admissible, oldest first, wherever they sit behind images."""
    now = now_ms() if now is None else now
    return list(due_generations(now=now, exclude_ids=exclude_ids).filter(SHORT_SLOT, status='queued').filter(
        Q(provider_status__isnull=True) | Q(provider_status__in=('', SLOT_WAITING))).order_by('created_at', 'id')[:limit])


def select_due_generations(*, now=None, limit=MAX_COORDINATOR_BATCH, exclude_ids=()):
    now = now_ms() if now is None else now
    limit = max(1, min(MAX_COORDINATOR_BATCH, int(limit or MAX_COORDINATOR_BATCH)))
    due = due_generations(now=now, exclude_ids=exclude_ids).annotate(dispatch_rank=Case(When(SHORT_SLOT & (
        Q(status='running') | Q(provider_status=WORKER_SLOT_WAITING)), then=Value(0)),
        default=Value(1), output_field=IntegerField()))
    from .audio_submission import audio_limits
    global_limit, user_limit = audio_limits()
    reserved = dict(Generation.objects.filter(kind='audio', provider_status__in=(
        'SUBMISSION_PENDING', 'SUBMISSION_UNCERTAIN')).values('user_id').annotate(
            total=Count('id')).values_list('user_id', 'total'))
    free = max(0, global_limit - sum(reserved.values()))
    selected = list(due.exclude(kind='audio').order_by('dispatch_rank', 'created_at', 'id')[:limit])
    if free:
        # Apportion each account before LIMIT: one backlog must not hide other
        # accounts or non-audio work. Claim-time locking remains authoritative.
        audio = due.filter(kind='audio').annotate(
            account_rank=Window(RowNumber(), partition_by=[F('user_id')],
                                order_by=[F('created_at').asc(), F('id').asc()]),
            account_slots=Case(*[When(user_id=user, then=Value(max(0, user_limit-count)))
                                for user, count in reserved.items()],
                               default=Value(user_limit), output_field=IntegerField()),
        ).filter(account_rank__lte=F('account_slots')).order_by('created_at', 'id')
        selected.extend(audio[:min(free, limit)])
    return sorted(selected, key=lambda row: (row.dispatch_rank, row.created_at, str(row.id)))[:limit]


def expected_version(item, *, owner=None):
    query = Generation.objects.filter(pk=item.id, status=item.status, updated_at=item.updated_at)
    if owner is not None:
        query = query.filter(worker_lease_id=owner)
    return query


def persist_provider_receipt(item, owner, updates):
    """Fence accepted work by execution identity, not mutable library metadata.

    A favorite/flag/move can advance updated_at during paid I/O. Lock and
    preserve that current metadata while guarding owner, state and the prior
    receipt chain. Other outcome writes keep their stricter version fence.
    """
    allowed={'task_id','candidate_task_ids','submitted_at','next_poll_at',
        'updated_at','cost_cents','provider_status'}
    if not owner or set(updates)-allowed or not updates.get('task_id') or 'submitted_at' not in updates:
        raise ValueError('Unexpected provider receipt fields.')
    with transaction.atomic():
        current=Generation.objects.select_for_update().filter(pk=item.id,
            status='running',worker_lease_id=owner).first()
        if current is None or item.status!='running' or any(
                getattr(current,field)!=getattr(item,field) for field in (
                    'kind','model','user_id','task_id','submitted_at','submission_input')):
            return None
        if (current.candidate_task_ids or [])!=(item.candidate_task_ids or []):
            return None
        fields={**updates,'updated_at':max(updates.get('updated_at',0),current.updated_at+1)}
        Generation.objects.filter(pk=current.id).update(**fields)
        return Generation.objects.get(pk=current.id)


def schedule_generation(item, *, now=None, delay_ms=DEFAULT_POLL_DELAY_MS, provider=None, owner=None):
    now = now_ms() if now is None else now
    provider = provider or {}
    if set(provider) - {'provider_created_at', 'provider_updated_at', 'provider_status'}:
        raise ValueError('Unexpected provider scheduling field')
    with transaction.atomic():
        if not expected_version(item, owner=owner).update(last_poll_at=now,
                next_poll_at=now + max(0, delay_ms), poll_attempts=F('poll_attempts') + 1, **provider):
            return None
        return Generation.objects.get(pk=item.id)


def task_item(task_id):
    return Generation.objects.filter(Q(task_id=task_id) | Q(candidate_task_ids__contains=[task_id])).first()


def mark_callback_received(task_id, *, now=None, provider=None):
    now = now_ms() if now is None else now
    provider = provider or {}
    if set(provider) - {'provider_created_at', 'provider_updated_at', 'provider_status'}:
        raise ValueError('Unexpected callback field')
    with transaction.atomic():
        item = task_item(task_id)
        if item is None:
            return None
        Generation.objects.filter(pk=item.id).update(callback_received_at=now, next_poll_at=now, **provider)
        return Generation.objects.get(pk=item.id)


def compare_and_set_outcome(item, updates, *, owner=None):
    # Only the generation executor/finalizer calls this trusted service.
    # No client-supplied dictionary reaches it directly.
    with transaction.atomic():
        query = expected_version(item, owner=owner).filter(task_id=item.task_id)
        if not query.update(**updates, poll_error_count=0, last_poll_error_at=None):
            return None
        return Generation.objects.get(pk=item.id)


def record_poll_error(item, *, now=None):
    return expected_version(item).filter(task_id=item.task_id).update(
        poll_error_count=F('poll_error_count') + 1, last_poll_error_at=now_ms() if now is None else now)
