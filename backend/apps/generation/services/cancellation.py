"""Provider-backed cancellation. A receipt alone never proves a terminal outcome.

The registry is deliberately small: adapters must expose both a cancel operation
and a status query using the same credentials/task identifiers as submission.

A caller without provider credentials (the MCP service) passes ``defer=True``:
a job with a provider task is then marked ``pending`` and the generation worker,
which has the credentials, performs the same cancel (``settle_pending``).
"""
import os
from types import SimpleNamespace
from uuid import uuid4

from django.db import transaction

from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.model_registry import model_definition
from apps.generation.providers import omni, omnihuman, seedance
from apps.generation.realtime import publish_best_effort
from . import coordinator
from .deadline import Cancellation

ACTIVE = ('queued', 'running')
UNSETTLED = ('requested', 'uncertain')
PENDING = 'pending'   # asked by a caller without provider credentials; the generation worker sends it
DEFERRED = 'Cancellation requested. Veevee is asking the provider to stop this generation.'
COST_UNCONFIRMED = 'cancelled_billing_unconfirmed'
COST_UNSUBMITTED = 'cancelled_before_submission'
ADAPTERS = {'byteplus': (seedance.get_video_task, seedance.cancel_video_task),
            'omni': (omni.get_cancel_status, omni.cancel_video_task),
            'omnihuman': (omnihuman.get_video_task, omnihuman.cancel_video_task)}


class CancelError(Exception):
    def __init__(self, message, status=409, *, busy=False):
        super().__init__(message)
        self.status, self.busy = status, busy


def provider_for(item, env=None):
    provider = (model_definition(item.model) or {}).get('provider')
    env = os.environ if env is None else env
    if provider == 'omni' and env.get('OMNI_USE_VERTEX') == '1':
        return None  # No verified official Vertex cancellation contract.
    return provider if provider in ADAPTERS and item.kind == 'video' else None


def can_cancel(item, env=None):
    if item.status not in ACTIVE or not provider_for(item, env) or item.cancellation_state in UNSETTLED:
        return False
    if item.provider_status in ('SUBMISSION_PENDING', 'SUBMISSION_UNCERTAIN', 'DOWNLOAD_PENDING'):
        return False
    if not item.task_id:
        return item.status == 'queued'
    provider = provider_for(item, env)
    return provider == 'omni' or item.provider_status not in ('running', 'generating', 'done', 'succeeded', 'completed')


def cancel_generation(identifier, actor, *, env=None, adapters=None, advance=None, defer=False):
    """Fence submission/poll workers, then request cancel and let polling settle it.

    A provider may finish between preflight and cancel. In particular ModelArk
    DELETE can delete a finished record. A subsequent missing task is uncertain,
    never evidence of cancellation; keep its receipt and reconciliation active.
    Only a cancel the provider accepted marks the row as cancelling, and the
    request reconciles inline only when every task accepted it; a finished
    result is always saved by the generation worker, never by this request.
    """
    from .poller import advance as poll
    advance = advance or poll
    env = os.environ if env is None else env
    adapters = adapters or ADAPTERS
    owner, now = 'cancel-' + uuid4().hex, now_ms()
    with transaction.atomic():
        item = Generation.objects.select_for_update().filter(pk=identifier).first()
        if item is None:
            raise CancelError('Generation not found.', 404)
        if str(item.user_id) != str(actor.id) and actor.role != 'admin':
            raise CancelError('Only the owner or an admin can cancel this generation.', 403)
        if item.status == 'cancelled':
            return item, None
        if not provider_for(item, env):
            raise CancelError('This provider does not support cancellation.', 400)
        if item.status not in ACTIVE:
            return item, 'The generation already finished. Its result has been kept.'
        if item.cancellation_state in UNSETTLED:
            return item, 'Cancellation is being reconciled with the provider.'
        if defer and item.cancellation_state == PENDING:
            return item, DEFERRED
        if not can_cancel(item, env):
            raise CancelError('This task has already started or is being submitted and cannot be cancelled.')
        if defer and item.task_id:
            Generation.objects.filter(pk=item.id).update(cancellation_state=PENDING, updated_at=max(now, item.updated_at + 1))
            current = Generation.objects.get(pk=item.id)
            transaction.on_commit(lambda: publish_best_effort(current))
            return current, DEFERRED
        claim = coordinator.claim_generation(identifier, owner, now=now, ttl_ms=120000)
        if claim is None:
            raise CancelError('The generation is being updated. Try cancelling again in a moment.', busy=True)
        prior = item.cancellation_state
        Generation.objects.filter(pk=item.id, worker_lease_id=owner).update(
            cancellation_state='requested', updated_at=max(now, item.updated_at + 1))
        item = Generation.objects.get(pk=item.id)
        if not item.task_id:
            # Claim + row lock excludes submission. No remote paid task exists.
            Generation.objects.filter(pk=item.id, worker_lease_id=owner).update(status='cancelled',
                cancellation_state='confirmed', completed_at=now, next_poll_at=None,
                cost_cents=0, cost_basis=COST_UNSUBMITTED)
            current = coordinator.release_generation(item.id, owner)
            transaction.on_commit(lambda: publish_best_effort(current))
            return current, None
    publish_best_effort(item)
    message, state, refused, attempted, accepted, finished = None, None, False, False, 0, False
    try:
        if env.get('MOCK_GENERATION') == '1':
            # Disposable fixtures never call a real provider.
            coordinator.compare_and_set_outcome(item, {'status': 'cancelled', 'cancellation_state': 'confirmed',
                'completed_at': now_ms(), 'updated_at': now_ms(), 'cost_basis': COST_UNCONFIRMED,
                'next_poll_at': None}, owner=owner)
        else:
            get_status, cancel = adapters[provider_for(item, env)]
            signal = Cancellation(45000)
            tasks = [item.task_id, *(item.candidate_task_ids or [])]
            for task_id in tasks:
                result = get_status(task_id, signal=signal)
                if result['status'] in ('succeeded', 'failed', 'cancelled'):
                    continue
                if provider_for(item, env) != 'omni' and result['status'] != 'queued':
                    refused, message = True, 'The provider has started this task and can no longer cancel it. It will continue normally.'
                    continue
                attempted = True
                try:
                    cancel(task_id, signal=signal)
                except Exception as error:
                    if getattr(error, 'status', None) in (400, 409):
                        refused, message = True, 'The provider could not cancel this task because it has already started or finished. Its outcome is being checked.'
                        continue
                    raise
                accepted += 1
            if not attempted and not refused:
                finished, message = True, 'The generation already finished at the provider. Its result is being saved.'
            if accepted == len(tasks):
                # Polling, rather than the cancel HTTP response, owns terminal state.
                current = Generation.objects.get(pk=item.id)
                advance(current, owner=owner, signal=signal)
    except Exception:
        if attempted:
            state = 'uncertain'
            message = 'The provider has not confirmed cancellation. This generation will keep reconciling; it may still finish.'
        else:
            message = 'The provider could not be reached to cancel this generation. Try again in a moment.'
    finally:
        # A deferred request whose task already finished at the provider is moot: clear it so polling saves the result.
        state = state or ('refused' if refused else 'requested' if accepted else None if finished and prior == PENDING else prior)
        with transaction.atomic():
            current = Generation.objects.select_for_update().get(pk=item.id)
            if current.status in ACTIVE and current.worker_lease_id == owner:
                # An active result after a cancellation request remains reconciling.
                Generation.objects.filter(pk=item.id).update(cancellation_state=state,
                    next_poll_at=now_ms(), updated_at=max(now_ms(), current.updated_at + 1))
            current = coordinator.release_generation(item.id, owner) or Generation.objects.get(pk=item.id)
        publish_best_effort(current)
    if current.status == 'cancelled':
        return current, None
    if current.status in ('succeeded', 'failed'):
        return current, 'The generation finished before cancellation was confirmed. Its result has been kept.'
    return current, message or 'Cancellation requested. Waiting for the provider to confirm the outcome.'


def pending_cancellations(*, limit=8, exclude_ids=()):
    """Ids of active jobs whose deferred cancel the generation worker still has to send, oldest request first."""
    rows = Generation.objects.filter(status__in=ACTIVE, cancellation_state=PENDING).exclude(pk__in=list(exclude_ids))
    return list(rows.order_by('updated_at').values_list('id', flat=True)[:limit])


def settle_pending(identifier, *, env=None, adapters=None, advance=None):
    """Generation worker: send a deferred cancel exactly as the web would, with this process's credentials.

    The request was authorized when it was made. A refusal (the task started) ends the request; a busy row or an
    unreachable provider leaves it pending for a later pass. Returns a worker outcome label.
    """
    row = Generation.objects.filter(pk=identifier, status__in=ACTIVE, cancellation_state=PENDING).values('user_id', 'updated_at').first()
    if row is None:
        return 'cancel_settled'
    try:
        current, _ = cancel_generation(identifier, SimpleNamespace(id=row['user_id'], role='user'), env=env, adapters=adapters,
                                       advance=advance)
    except CancelError as error:
        if error.busy:
            return 'cancel_busy'
        Generation.objects.filter(pk=identifier, cancellation_state=PENDING).update(
            cancellation_state='refused', updated_at=max(now_ms(), row['updated_at'] + 1))
        publish_best_effort(Generation.objects.get(pk=identifier))
        return 'cancel_refused'
    return 'cancel_busy' if current.cancellation_state == PENDING and current.status in ACTIVE else 'cancel_settled'
