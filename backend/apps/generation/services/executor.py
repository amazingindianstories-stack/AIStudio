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
from apps.library.services.naming import assign_generation_naming
from . import admission, coordinator, poller
from .deadline import Cancellation
from .video_execution import submit_video

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
    metadata={'project_id','folder_id','location_version','is_favorite','favorited_at',
        'flagged','flagged_at','flag_reason','updated_at','worker_lease_until'}
    with transaction.atomic():
        current=Generation.objects.select_for_update().filter(pk=item.id,worker_lease_id=owner).first()
        if not owner or current is None or any(
                getattr(current,field.attname)!=getattr(item,field.attname)
                for field in Generation._meta.concrete_fields if field.attname not in metadata):
            raise LeaseLost('Generation execution changed before completion persistence.')
        fields={**updates,'updated_at':max(updates.get('updated_at',0),current.updated_at+1)}
        Generation.objects.filter(pk=current.id).update(**fields)
        return Generation.objects.get(pk=current.id)


def execute_admitted(item, *, owner, signal=None, image_execute=None, video_submit=None, env=None):
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
        # candidates, request cancellation, or local storage failed.
        if expected.task_id:
            try:
                current = _fenced_update(expected, owner, {'next_poll_at': now_ms() + 5000})
            except LeaseLost:
                return {'kind': 'raced'}
            bounded_event(current, phase='accepted_task_recovery', error_code=getattr(error, 'code', 'provider_poll_error'), persisted=True,
                          event='generation_execution_deferred')
            return {'kind': 'pending', 'item': current}
        failure = {'status': 'failed', 'error': str(error) or ('Video task creation failed.' if item.kind == 'video' else 'Image generation failed.'),
            'moderation_blocked': getattr(error, 'code', None) == 'moderation', 'completed_at': now_ms(), 'updated_at': now_ms()}
        if getattr(error, 'provider_response', None):
            response = error.provider_response
            failure['provider_responses'] = response if isinstance(response, list) else [response]
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
        if was_queued:
            item = admission.admit_job(identifier, owner=owner)
            if item is None:
                return {'kind': 'not_admitted'}
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
