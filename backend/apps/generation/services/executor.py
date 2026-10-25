"""In-process Python execution with fenced, durable provider task receipts."""
import json
import logging
import math
import os
import secrets
import threading
from uuid import uuid4

from django.db import connections, transaction, OperationalError, InterfaceError

from apps.common.leases import now_ms
from apps.generation.model_registry import capability
from apps.generation.models import Generation
from apps.generation.realtime import publish_best_effort
from apps.library.services.naming import assign_generation_naming, same_execution_identity
from . import admission, coordinator, paid_guard, poller
from .deadline import Cancellation
from .video_execution import submit_video
from . import portrait_prepare

logger = logging.getLogger('veevee.generation')


class ReceiptPersistenceError(RuntimeError):
    code = 'task_receipt_persistence_failed'


class LeaseLost(RuntimeError):
    code = 'worker_lease_lost'


def bounded_event(item, *, phase, error_code, persisted, event='generation_failure'):
    result = {'event': event, 'version': 1, 'route': 'generation_worker', 'phase': phase,
        'generationId': str(item.id), 'kind': item.kind, 'model': item.model, 'errorCode': error_code,
        'moderationBlocked': item.moderation_blocked is True, 'persisted': persisted, 'timestamp': now_ms()}
    logger.error(json.dumps(result))
    return result


def video_best_of(item, env):
    if item.kind != 'video' or not capability(item.model, 'videoBestOf') or not env.get('VIDEO_BEST_OF') or item.draft_task_id or not item.reference_images:
        return 1
    try:
        requested = float(env['VIDEO_BEST_OF']) or 2
        return math.floor(min(3, max(2, requested)))
    except (ValueError, OverflowError):
        return 2


class LeaseHeartbeat:
    def __init__(self, item, owner, cancellation, *, interval=15, ttl_ms=60000):
        self.item, self.owner, self.cancellation = item, owner, cancellation
        self.interval, self.ttl_ms = interval, ttl_ms
        self.stop = threading.Event()

    def __enter__(self):
        def beat():
            try:
                while not self.stop.wait(self.interval):
                    renewed = Generation.objects.filter(pk=self.item.id, worker_lease_id=self.owner,
                        status='running').update(worker_lease_until=now_ms() + self.ttl_ms)
                    if not renewed:
                        self.cancellation.cancelled.set()
                        return
            except Exception:
                self.cancellation.cancelled.set()
            finally:
                connections.close_all()
        self.thread = threading.Thread(target=beat, name='generation-lease', daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stop.set()
        self.thread.join(timeout=2)


def _fenced_update(item, owner, updates):
    with transaction.atomic():
        if not coordinator.expected_version(item, owner=owner).filter(task_id=item.task_id).update(**updates):
            raise LeaseLost('Generation ownership changed before persistence.')
        return Generation.objects.get(pk=item.id)


def _persist_task_receipt(item,owner,updates):
    current=coordinator.persist_provider_receipt(item,owner,updates)
    if current is None:
        raise LeaseLost('Generation ownership changed before receipt persistence.')
    return current


def _persist_completion(item,owner,updates,timestamp):
    with transaction.atomic():
        current=_fenced_completion_update(item,owner,updates)
        if current.status=='succeeded':
            assign_generation_naming(current.id,current.folder_id,current.project_id,now=timestamp)
        return current


def _fenced_completion_update(item,owner,updates):
    """Ignore only library metadata and heartbeat renewal during completed work.

    Every other concrete model field stays fenced, including execution inputs,
    receipt/progress state, account, lease owner and any competing master.
    New model fields are protected automatically rather than silently ignored.
    """
    with transaction.atomic():
        current=Generation.objects.select_for_update().filter(pk=item.id,worker_lease_id=owner).first()
        if not owner or current is None or not same_execution_identity(current, item, ignored={'worker_lease_until'}):
            raise LeaseLost('Generation execution changed before completion persistence.')
        fields={**updates,'updated_at':max(updates.get('updated_at',0),current.updated_at+1)}
        Generation.objects.filter(pk=current.id).update(**fields)
        return Generation.objects.get(pk=current.id)


def execute_admitted(item, **kwargs):
    if not paid_guard.enabled():
        return _execute_admitted(item, **kwargs)
    return paid_guard.execute(_execute_admitted, item, **kwargs)


def _execute_admitted(item, *, owner, signal=None, image_execute=None, video_submit=None, env=None):
    """Run on a worker thread with its own DB connection, never a detached task.

    All provider I/O receives the same bounded cancellation object. Persistence
    errors propagate separately; no provider work is repeated after one.
    """
    env = os.environ if env is None else env
    signal = signal or Cancellation()
    video_submit = video_submit or submit_video
    if item.kind != 'video' and image_execute is None:
        from .image_execution import execute_image
        image_execute = execute_image
    count = video_best_of(item, env)
    changes = {}
    if not item.draft_task_id and capability(item.model, 'seed') and item.seed is None:
        changes['seed'] = secrets.randbelow(2147483647)
    if count > 1 and not item.task_id:
        changes['cost_cents'] = (item.cost_cents or 0) * count
    if changes:
        item = _fenced_update(item, owner, changes)
    expected = item
    unit_cost = (item.cost_cents or 0) / count
    accepted = []

    def on_task(task_id, index=0, requested_count=1):
        nonlocal expected
        if not isinstance(task_id, str) or not task_id:
            raise ValueError('Provider returned an invalid task receipt.')
        accepted.append(task_id)
        timestamp = now_ms()
        update = {'task_id': accepted[0], 'candidate_task_ids': accepted[1:] if requested_count > 1 else None,
            'submitted_at': timestamp, 'next_poll_at': timestamp + 5000,
            'updated_at': max(timestamp, expected.updated_at + 1)}
        if item.kind == 'video':
            update['cost_cents'] = math.floor(unit_cost * len(accepted) + .5)
        # Retry only the local receipt write. Provider submission has already
        # succeeded and must never be retried as part of persistence recovery.
        for attempt in range(3):
            try:
                expected = _persist_task_receipt(expected, owner, update)
                return
            except LeaseLost:
                raise
            except Exception as error:
                # A lost commit acknowledgement may leave the receipt durable.
                # Recognize it before retrying the same optimistic version.
                try:
                    current = Generation.objects.filter(pk=expected.id, worker_lease_id=owner,
                        status='running', task_id=accepted[0]).first()
                    if current and (current.candidate_task_ids or []) == accepted[1:] and all(
                            getattr(current,field)==getattr(expected,field) for field in (
                                'kind','model','user_id','submission_input')):
                        expected = current
                        return
                except Exception:
                    pass
                if attempt == 2:
                    raise ReceiptPersistenceError('Provider task was accepted but its receipt could not be persisted.') from error

    # Work errors are caught here. The following success persistence remains
    # outside the catch so a DB failure never becomes a provider-failed row.
    try:
        if item.kind == 'video':
            updates = video_submit(item, signal=signal, on_task=on_task, count=count, env=env)
        else:
            updates = image_execute(item, signal=signal, on_task=on_task, env=env)
        signal.check()
    except LeaseLost:
        return {'kind': 'raced'}
    except ReceiptPersistenceError:
        bounded_event(expected, phase='task_receipt', error_code='task_receipt_persistence_failed',
            persisted=False, event='generation_persistence_failure')
        raise
    except Exception as error:
        # An accepted asynchronous task is useful work, even when later
        # candidates, request cancellation, or local storage failed. Only the
        # provider ending that task (error.terminal) settles it as failed.
        terminal = getattr(error, 'terminal', False) is True
        if expected.task_id and not terminal:
            try:
                current = _fenced_update(expected, owner, {'next_poll_at': now_ms() + 5000})
            except LeaseLost:
                return {'kind': 'raced'}
            bounded_event(current, phase='accepted_task_recovery', error_code=getattr(error, 'code', 'provider_poll_error'), persisted=True,
                          event='generation_execution_deferred')
            return {'kind': 'pending', 'item': current}
        failure = {'status': 'failed', 'error': str(error) or ('Video task creation failed.' if item.kind == 'video' else 'Image generation failed.'),
            'moderation_blocked': getattr(error, 'code', None) == 'moderation', 'completed_at': now_ms(), 'updated_at': now_ms()}
        responses = provider_responses(error, item)
        if getattr(error, 'code', None) == 'moderation' and portrait_prepare.privacy_rejection(str(error), {'error': {'code': getattr(error, 'upstream_code', '')}}) and portrait_prepare.learn_from_rejection(item):
            failure['error'] = portrait_prepare.REJECTED_MESSAGE     # a face the detector missed is now a portrait; Retry sends it as one
        if not terminal and submission_uncertain(error):
            # The provider may have accepted (and billed) this request. Keep the
            # evidence and say so; nothing here ever re-submits automatically.
            failure['error'] = (failure['error'].rstrip('. ') + '. It may still have been accepted by the provider; check before retrying.')
            responses = [*responses, {'uncertainSubmission': True, 'errorType': type(error).__name__, 'recordedAt': now_ms()}]
        if responses:
            failure['provider_responses'] = responses
        try:
            failed = _fenced_update(expected, owner, failure)
        except LeaseLost:
            return {'kind': 'raced'}
        except Exception:
            bounded_event(expected, phase='execution', error_code='persistence_failed', persisted=False, event='generation_persistence_failure')
            raise
        bounded_event(failed, phase='execution', error_code=getattr(error, 'code', 'provider_failed'), persisted=True)
        publish_best_effort(failed)
        return {'kind': 'failed', 'item': failed}
    timestamp = now_ms()
    updates['updated_at'] = max(timestamp, expected.updated_at + 1)
    if updates.get('status') == 'succeeded':
        updates['completed_at'] = timestamp
    for attempt in range(3):
        try:
            current=_persist_completion(expected,owner,updates,timestamp)
            break
        except (OperationalError,InterfaceError):
            # Retry the materialized local result only. A successful transaction
            # with lost acknowledgment already includes naming; recognize that
            # exact immutable master under this owner instead of replaying work.
            if updates.get('status')=='succeeded' and updates.get('url'):
                try:
                    durable=Generation.objects.filter(pk=expected.id,status='succeeded',
                        model=expected.model,task_id=expected.task_id,worker_lease_id=owner,
                        url=updates['url'],completed_at=updates['completed_at']).first()
                    if durable and all(getattr(durable,field)==getattr(expected,field)
                            for field in ('kind','user_id','submission_input')) and (
                            durable.candidate_task_ids or [])==(expected.candidate_task_ids or []):
                        current=durable
                        break
                except (OperationalError,InterfaceError):
                    pass
            if attempt==2:
                raise
    publish_best_effort(current)
    return {'kind': current.status, 'item': current}


def process_generation(identifier, *, owner=None, signal=None, image_execute=None, video_submit=None, env=None, heartbeat=True):
    owner = owner or 'python-generation:' + str(uuid4())
    if Generation.objects.filter(pk=identifier,kind='audio').exists():
        from .audio_submission import process_audio
        return process_audio(identifier,owner,signal=signal or Cancellation())
    item = coordinator.claim_generation(identifier, owner)
    if item is None:
        return {'kind': 'unclaimed'}
    signal = signal or Cancellation()
    try:
        was_queued = item.status == 'queued'
        if was_queued and item.provider_status == admission.WORKER_SLOT_WAITING:
            coordinator.expected_version(item, owner=owner).update(
                provider_status=None, progress_message=None, updated_at=max(now_ms(), item.updated_at + 1))
            item = Generation.objects.get(pk=identifier)
            publish_best_effort(item)
        if was_queued and portrait_prepare.applies(item):
            deferred = _prepare_portraits(item, owner)
            if deferred is not None:
                return deferred
            item = Generation.objects.get(pk=identifier)
        if was_queued:
            held = []
            admitted = admission.admit_job(identifier, owner=owner, held=held)
            if admitted is None:
                if held:
                    _show_slot_wait(Generation.objects.get(pk=identifier), owner)
                return {'kind': 'not_admitted'}
            item = admitted
            publish_best_effort(item)
        if item.model.startswith('Magnific ') and item.submission_input is not None and not item.task_id:
            if item.provider_status in ('SUBMISSION_PENDING','SUBMISSION_UNCERTAIN'):
                return {'kind':'submission_uncertain','item':item}
            from .upscale_submission import submit_claimed_upscale
            if heartbeat:
                with LeaseHeartbeat(item,owner,signal):
                    submitted = submit_claimed_upscale(item,owner=owner,signal=signal)
            else:
                submitted = submit_claimed_upscale(item,owner=owner,signal=signal)
            publish_best_effort(submitted)
            return {'kind':'pending','item':submitted}
        if not was_queued and (item.kind == 'video' or item.model.startswith('Magnific ')):
            if heartbeat:
                with LeaseHeartbeat(item, owner, signal):
                    return poller.advance(item, source='worker', signal=signal, owner=owner)
            return poller.advance(item, source='worker', signal=signal, owner=owner)
        if heartbeat:
            with LeaseHeartbeat(item, owner, signal):
                return execute_admitted(item, owner=owner, signal=signal, image_execute=image_execute, video_submit=video_submit, env=env)
        return execute_admitted(item, owner=owner, signal=signal, image_execute=image_execute, video_submit=video_submit, env=env)
    finally:
        coordinator.release_generation(identifier, owner)
        if portrait_prepare.enabled():
            status = Generation.objects.filter(pk=identifier).values_list('status', flat=True).first()
            if status not in ('queued', 'running'):
                portrait_prepare.finish(identifier, failed=status == 'failed')


def _prepare_portraits(item, owner):
    """Run before admission. Returns None when the job may continue, else a result describing the wait/failure."""
    from apps.assets import managed_pool
    now = now_ms()
    try:
        outcome = portrait_prepare.prepare(item)
    except Exception:
        logger.error('portrait preparation failed; job stays queued for retry')
        outcome = managed_pool.wait('portrait_error', 15000)
    if outcome.kind == 'ready':
        portrait_prepare.clear_wait(item.id)
        if item.provider_status == portrait_prepare.WAITING_STATUS:
            coordinator.expected_version(item, owner=owner).update(provider_status=None, progress_message=None,
                                                                   updated_at=max(now, item.updated_at + 1))
        return None
    if outcome.kind == 'wait':
        started = portrait_prepare.wait_started(item.id, outcome.reason, now)
        limit = managed_pool.setting_values()['portraitQueueWaitMinutes'] * 60 * 1000
        if now - started <= limit:
            message = portrait_prepare.MESSAGES.get(outcome.reason, 'Preparing portraits…')
            if item.provider_status != portrait_prepare.WAITING_STATUS or item.progress_message != message:
                coordinator.expected_version(item, owner=owner).update(provider_status=portrait_prepare.WAITING_STATUS,
                    progress_message=message, updated_at=max(now, item.updated_at + 1))
                item = Generation.objects.get(pk=item.id)
                publish_best_effort(item)
            coordinator.schedule_generation(item, delay_ms=outcome.delay_ms, owner=owner)
            return {'kind': 'portrait_waiting', 'reason': outcome.reason}
        outcome = managed_pool.failed(managed_pool.PORTRAIT_BUSY.format(minutes=limit // 60000), 'portrait_wait_timeout')
    detail = {'provider_responses': [{**outcome.detail, 'model': item.model}]} if isinstance(outcome.detail, dict) else {}
    coordinator.expected_version(item, owner=owner).update(status='failed', error=outcome.message, completed_at=now,
        provider_status=None, progress_message=None, updated_at=max(now, item.updated_at + 1), **detail)
    portrait_prepare.finish(item.id)
    publish_best_effort(Generation.objects.get(pk=item.id))
    return {'kind': 'failed', 'reason': outcome.reason}


def _show_slot_wait(item, owner):
    """The provider's per-model limit is full: say so on the card (cleared when the job is admitted)."""
    message = admission.lane_message(item)
    if item.status == 'queued' and (item.provider_status != admission.SLOT_WAITING or item.progress_message != message):
        coordinator.expected_version(item, owner=owner).update(provider_status=admission.SLOT_WAITING, progress_message=message,
                                                               updated_at=max(now_ms(), item.updated_at + 1))
        publish_best_effort(Generation.objects.get(pk=item.id))


# Our transport or deadline gave up on the provider: no provider answer to quote, but the code tells support which.
LOCAL_FAILURE_CODES = frozenset(('request_deadline', 'response_deadline', 'response_deadline_unavailable', 'response_too_large',
                                 'ambiguous_submission', 'invalid_provider_endpoint', 'output_download_failed'))


def provider_responses(error, item):
    """The provider records a failed execution keeps: the adapter's own, else one for our timeout or dropped call."""
    from apps.generation import provider_errors
    response = getattr(error, 'provider_response', None)
    responses = response if isinstance(response, list) else [response] if response else []
    if not responses and (getattr(error, 'code', None) in LOCAL_FAILURE_CODES or isinstance(error, (TimeoutError, ConnectionError))):
        provider = provider_errors.provider_for_model(item.model)
        if provider:
            code = getattr(error, 'code', None)
            responses = [provider_errors.local(provider, code if isinstance(code, str) else type(error).__name__,
                                               str(error) or type(error).__name__, phase='create', task_id=item.task_id)]
    # Adapters do not know the registry name; the admin view filters and groups by it.
    return [{**value, 'model': item.model} if provider_errors.is_record(value) and not value.get('model') else value
            for value in responses]


def submission_uncertain(error):
    """True when a failed provider call might still have created a billable job."""
    if getattr(error, 'may_have_submitted', True) is False:
        return False
    if isinstance(error, (TimeoutError, ConnectionError)):
        return True
    status = getattr(error, 'status', None)
    if status is None:
        return type(error).__name__ in ('ProviderError', 'QueueExecutionDeadlineError', 'ReadTimeout', 'ConnectTimeout', 'ChunkedEncodingError')
    return status == 408 or status >= 500
