"""Provider-backed cancellation. A receipt alone never proves a terminal outcome.

The registry is deliberately small: adapters must expose both a cancel operation
and a status query using the same credentials/task identifiers as submission.
"""
import os
from uuid import uuid4

from django.db import transaction

from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.model_registry import model_definition
from apps.generation.providers import omni, seedance
from apps.generation.realtime import publish_best_effort
from . import coordinator
from .deadline import Cancellation

ACTIVE = ('queued', 'running')
UNSETTLED = ('requested', 'uncertain')
COST_UNCONFIRMED = 'cancelled_billing_unconfirmed'
COST_UNSUBMITTED = 'cancelled_before_submission'
# OmniHuman's provider is a separate change; whichever of the two lands second
# registers its CVCancelTask adapter here and its cancel endpoint in
# paid_guard.CANCEL_ENDPOINTS. Its signature, identifiers and polling contract
# must stay with that adapter.
ADAPTERS = {'byteplus': (seedance.get_video_task, seedance.cancel_video_task),
            'omni': (omni.get_cancel_status, omni.cancel_video_task)}


class CancelError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


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
    return provider == 'omni' or item.provider_status not in ('running', 'generating', 'succeeded', 'completed')


def cancel_generation(identifier, actor, *, env=None, adapters=None, advance=None):
    """Fence submission/poll workers, then request cancel and let polling settle it.

    A provider may finish between preflight and cancel. In particular ModelArk
    DELETE can delete a finished record. A subsequent missing task is uncertain,
    never evidence of cancellation; keep its receipt and reconciliation active.
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
        if not can_cancel(item, env):
            raise CancelError('This task has already started or is being submitted and cannot be cancelled.')
        claim = coordinator.claim_generation(identifier, owner, now=now, ttl_ms=120000)
        if claim is None:
            raise CancelError('The generation is being updated. Try cancelling again in a moment.')
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
    message, state = None, 'requested'
    try:
        if env.get('MOCK_GENERATION') == '1':
            # Disposable fixtures never call a real provider.
            coordinator.compare_and_set_outcome(item, {'status': 'cancelled', 'cancellation_state': 'confirmed',
                'completed_at': now_ms(), 'updated_at': now_ms(), 'cost_basis': COST_UNCONFIRMED,
                'next_poll_at': None}, owner=owner)
        else:
            get_status, cancel = adapters[provider_for(item, env)]
            signal = Cancellation(45000)
            for task_id in [item.task_id, *(item.candidate_task_ids or [])]:
                result = get_status(task_id, signal=signal)
                if result['status'] in ('succeeded', 'failed', 'cancelled'):
                    continue
                if provider_for(item, env) != 'omni' and result['status'] != 'queued':
                    state, message = 'refused', 'The provider has started this task and can no longer cancel it. It will continue normally.'
                    continue
                try:
                    cancel(task_id, signal=signal)
                except Exception as error:
                    if getattr(error, 'status', None) in (400, 409):
                        state, message = 'refused', 'The provider could not cancel this task because it has already started or finished. Its outcome is being checked.'
                    else:
                        raise
            # Polling, rather than the cancel HTTP response, owns terminal state.
            current = Generation.objects.get(pk=item.id)
            advance(current, owner=owner, signal=signal)
    except Exception:
        state = 'uncertain'
        message = 'The provider has not confirmed cancellation. This generation will keep reconciling; it may still finish.'
    finally:
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
