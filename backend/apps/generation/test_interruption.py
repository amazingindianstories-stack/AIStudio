"""An interrupted worker must not lose a generation, and must never submit the paid request twice.

Reproduces the 2026-11-24 incident: PostgreSQL ran out of connections, the lease heartbeat of each running
generation failed to reconnect and cancelled the provider call, and healthy Seedream jobs failed as "interrupted"."""
import base64
import io
import threading
import time
from functools import partial
from unittest.mock import patch
from uuid import uuid4

from django.db import OperationalError
from django.test import SimpleTestCase, TransactionTestCase
from PIL import Image

from apps.integrations.transport import admit_request
from apps.media.storage import MemoryAdapter, StorageService

from . import failure_copy, worker
from .failure_copy import INTERRUPTED, NOT_SENT
from .models import Generation
from .providers import higgsfield
from .prompting import face_judge
from .services import executor, image_execution
from .services.deadline import Cancellation, NOT_SENT_MESSAGE, QueueExecutionCancelledError


def beat(**options):
    return partial(executor.LeaseHeartbeat, interval=.01, retry=.01, **options)


class HeartbeatTests(SimpleTestCase):
    def run_heartbeat(self, renew, *, ttl_ms=60000, settle=.3):
        signal = Cancellation()
        heartbeat = executor.LeaseHeartbeat(type('Row', (), {'id': 1})(), 'owner', signal, interval=.01, retry=.01, ttl_ms=ttl_ms)
        with patch.object(heartbeat, '_renew', side_effect=renew), patch.object(executor, 'connections'):
            with heartbeat:
                time.sleep(settle)
        return signal

    def test_database_errors_are_retried_not_treated_as_a_lost_lease(self):
        calls = []
        def renew():
            calls.append(True)
            if len(calls) <= 3:
                raise OperationalError('FATAL: sorry, too many clients already')
            return 1
        signal = self.run_heartbeat(renew)
        self.assertGreater(len(calls), 4)
        self.assertFalse(signal.cancelled.is_set())

    def test_lease_taken_by_another_owner_cancels_at_once(self):
        signal = self.run_heartbeat(lambda: 0)
        self.assertTrue(signal.cancelled.is_set())

    def test_a_lease_unrenewable_for_a_whole_ttl_cancels_before_another_worker_can_claim_it(self):
        def renew():
            raise OperationalError('connection refused')
        signal = self.run_heartbeat(renew, ttl_ms=100)
        self.assertTrue(signal.cancelled.is_set())


class DrainTests(SimpleTestCase):
    def test_stop_cancels_unshielded_work_at_once(self):
        stop = threading.Event()
        signal = worker.WorkerCancellation(stop)
        signal.check()
        stop.set()
        with self.assertRaises(Exception) as caught:
            signal.check()
        self.assertEqual(caught.exception.code, 'queue_execution_cancelled')
        self.assertTrue(signal.cancelled.is_set())

    def test_stop_waits_for_a_shielded_provider_call_until_the_drain_ends(self):
        stop = threading.Event()
        signal = worker.WorkerCancellation(stop, drain_seconds=.2)
        signal.shielded = True
        signal.admit_request()
        stop.set()
        signal.check()
        signal.wait(50)
        time.sleep(.25)
        with self.assertRaises(QueueExecutionCancelledError):
            signal.check()
        self.assertTrue(signal.cancelled.is_set())

    def test_stop_refuses_a_new_provider_request_after_the_one_on_the_wire_finishes(self):
        stop = threading.Event()
        signal = worker.WorkerCancellation(stop)
        signal.shielded = True
        signal.admit_request()
        stop.set()
        signal.check()                       # the finished call's result handling keeps running in the drain
        with self.assertRaises(QueueExecutionCancelledError):
            signal.admit_request()
        signal.check()                       # refusing a new request does not discard the finished call's work

    def test_stop_before_any_request_was_sent_cancels_the_whole_job(self):
        stop = threading.Event()
        signal = worker.WorkerCancellation(stop)
        signal.shielded = True
        stop.set()
        with self.assertRaises(QueueExecutionCancelledError):
            signal.admit_request()
        self.assertTrue(signal.cancelled.is_set())


class BestOfDrainTests(SimpleTestCase):
    def test_finished_best_of_candidate_is_kept_when_the_next_one_is_refused_by_a_restart(self):
        stop = threading.Event()
        signal = worker.WorkerCancellation(stop)
        signal.shielded = True
        buffer = io.BytesIO()
        Image.new('RGB', (400, 300), 'blue').save(buffer, format='PNG')
        sent = []
        def generate(payload, *, signal, env):
            admit_request(signal)            # the transport's pre-send admission
            sent.append(payload['seed'])
            stop.set()                       # SIGTERM arrives while candidate 0 is on the wire; it still finishes
            return {'mimeType': 'image/png', 'base64': base64.b64encode(buffer.getvalue()).decode()}
        judged = []
        def vision_request(parts, *, signal, **kwargs):
            admit_request(signal)
            judged.append(True)
        adapter = MemoryAdapter()
        storage = StorageService(adapter)
        deps = image_execution.Dependencies()
        deps.assets, deps.pricing = [], []
        deps.storage = lambda: storage
        deps.assemble = lambda *args, **kwargs: {'instruction': 'fixture', 'groups': [],
            'judgeFace': {'mimeType': 'image/png', 'data': 'face'}}
        deps.gemini_generate = generate
        deps.now = lambda: 1234
        item = type('Item', (), dict(id='fixture', model='Nano Banana Pro', prompt='fixture', aspect_ratio='1:1',
            resolution='1K', reference_images=[], seed=10, draft_task_id=None, cost_cents=5, cost_basis='estimated',
            project_id=None, user_id=None, task_id=None))()
        with patch.object(face_judge, 'vision_request', vision_request):
            result = image_execution.execute_image(item, signal=signal, dependencies=deps, env={'FACE_BEST_OF': '4'})
        self.assertEqual((sent, judged), ([10], []))
        self.assertEqual(result['status'], 'succeeded')
        self.assertEqual(result['cost_cents'], 5)
        keys = [key for key in adapter.objects if key.startswith('generations/fixture/') and key.endswith('.png')]
        self.assertEqual(storage.read(keys[-1]), buffer.getvalue())


class InterruptionPersistenceTests(TransactionTestCase):
    def job(self, **values):
        return Generation.objects.create(**{'kind': 'image', 'status': 'queued', 'model': 'Seedream 5.0 Pro', 'prompt': 'fixture',
            'aspect_ratio': '1:1', 'created_at': 100, 'updated_at': 100, 'cost_cents': 14, 'user_id': uuid4(), **values})

    def run_job(self, item, image, *, signal=None, heartbeat=True):
        return executor.process_generation(item.id, owner='worker-a', signal=signal or Cancellation(), image_execute=image,
            heartbeat=heartbeat, env={})

    def test_heartbeat_outage_during_the_provider_call_does_not_fail_or_resubmit_the_generation(self):
        item = self.job()
        submitted, renewals = [], []
        real = executor.LeaseHeartbeat._renew
        def renew(self):
            renewals.append(True)
            if len(renewals) <= 3:
                raise OperationalError('FATAL: sorry, too many clients already')
            return real(self)
        def image(job, *, signal, **kwargs):
            submitted.append(True)
            signal.request_started = True
            deadline = time.monotonic() + 5
            while len(renewals) < 5 and time.monotonic() < deadline:
                signal.check()
                time.sleep(.01)
            return {'status': 'succeeded', 'url': '/api/media/generations/master.png'}
        with patch.object(executor.LeaseHeartbeat, '_renew', renew), patch.object(executor, 'LeaseHeartbeat', beat()):
            outcome = self.run_job(item, image)
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertEqual(len(submitted), 1)
        item.refresh_from_db()
        self.assertEqual((item.status, item.url, item.worker_lease_id), ('succeeded', '/api/media/generations/master.png', None))

    def test_restart_lets_an_in_flight_provider_call_finish_instead_of_failing_it(self):
        item = self.job()
        stop = threading.Event()
        submitted = []
        def image(job, *, signal, **kwargs):
            submitted.append(True)
            signal.admit_request()
            stop.set()                       # SIGTERM arrives while the provider is still rendering
            time.sleep(.05)
            signal.check()                   # the call returned; saving its result still runs inside the drain
            return {'status': 'succeeded', 'url': '/api/media/generations/master.png'}
        outcome = self.run_job(item, image, signal=worker.WorkerCancellation(stop), heartbeat=False)
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertEqual(len(submitted), 1)
        item.refresh_from_db()
        self.assertEqual(item.status, 'succeeded')

    def test_call_outlasting_the_drain_fails_as_possibly_charged_and_is_never_resubmitted(self):
        item = self.job()
        stop = threading.Event()
        submitted = []
        def image(job, *, signal, **kwargs):
            submitted.append(True)
            signal.admit_request()
            stop.set()
            time.sleep(.05)
            signal.check()
            self.fail('the drain should have ended')
        outcome = self.run_job(item, image, signal=worker.WorkerCancellation(stop, drain_seconds=0), heartbeat=False)
        self.assertEqual(outcome['kind'], 'failed')
        item.refresh_from_db()
        self.assertIn('It may still have been accepted by the provider', item.error)
        self.assertEqual(failure_copy._sentence(item, item.error), INTERRUPTED)
        self.assertEqual(self.run_job(item, image, heartbeat=False)['kind'], 'unclaimed')
        self.assertEqual(len(submitted), 1)

    def test_interruption_before_anything_reached_the_provider_says_nothing_was_charged(self):
        item = self.job()
        stop = threading.Event()
        def image(job, *, signal, **kwargs):
            stop.set()
            signal.check()                   # still preparing references: no request has gone out
        outcome = self.run_job(item, image, signal=worker.WorkerCancellation(stop), heartbeat=False)
        self.assertEqual(outcome['kind'], 'failed')
        item.refresh_from_db()
        self.assertEqual(item.error, NOT_SENT_MESSAGE)
        self.assertEqual(failure_copy._sentence(item, item.error), NOT_SENT)

    def higgsfield_call(self, signal, read):
        sent = []
        class Response:
            status = 200
            def read(self, size):
                return read()
            def getheaders(self):
                return []
        class Connection:
            def __init__(self, *args):
                pass
            def request(self, *args, **kwargs):
                sent.append(True)
            def getresponse(self):
                return Response()
            def close(self):
                pass
        with patch.object(higgsfield, 'validated_target', return_value=('mcp.higgsfield.ai', '192.0.2.1', '/mcp')), \
                patch.object(higgsfield, 'PinnedHTTPSConnection', Connection):
            higgsfield.HiggsfieldTransport().request('POST', 'https://mcp.higgsfield.ai/mcp', body={}, signal=signal)
        return sent

    def test_higgsfield_call_cut_off_mid_request_is_not_reported_as_never_sent(self):
        item = self.job(model='Nano Banana Pro')
        stop = threading.Event()
        def read():
            stop.set()                       # SIGTERM arrives while Higgsfield is answering the paid call
            return b'{}'
        def image(job, *, signal, **kwargs):
            self.higgsfield_call(signal, read)
            self.fail('the drain should have ended')
        outcome = self.run_job(item, image, signal=worker.WorkerCancellation(stop, drain_seconds=0), heartbeat=False)
        self.assertEqual(outcome['kind'], 'failed')
        item.refresh_from_db()
        self.assertIn('It may still have been accepted by the provider', item.error)
        self.assertEqual(failure_copy._sentence(item, item.error), INTERRUPTED)

    def test_paid_call_finishing_inside_the_drain_persists_its_result(self):
        item = self.job(model='Nano Banana Pro')
        stop = threading.Event()
        def image(job, *, signal, **kwargs):
            replies = iter([b'{}', b''])
            def read():
                stop.set()
                return next(replies)
            sent = self.higgsfield_call(signal, read)
            signal.check()                   # downloading and saving the result runs after the call returned
            self.assertEqual(len(sent), 1)
            return {'status': 'succeeded', 'url': '/api/media/generations/master.png'}
        outcome = self.run_job(item, image, signal=worker.WorkerCancellation(stop), heartbeat=False)
        self.assertEqual(outcome['kind'], 'succeeded')
        item.refresh_from_db()
        self.assertEqual((item.status, item.url), ('succeeded', '/api/media/generations/master.png'))

    def test_restart_finishes_the_call_on_the_wire_but_starts_no_further_paid_request(self):
        item = self.job(model='Nano Banana Pro')
        stop = threading.Event()
        sent = []
        def image(job, *, signal, **kwargs):
            replies = iter([b'{}', b''])
            def read():
                stop.set()
                return next(replies)
            sent.extend(self.higgsfield_call(signal, read))     # candidate 1 finishes inside the drain
            sent.extend(self.higgsfield_call(signal, lambda: b''))  # candidate 2 must not be sent
            self.fail('a second paid request started after the stop')
        outcome = self.run_job(item, image, signal=worker.WorkerCancellation(stop), heartbeat=False)
        self.assertEqual(outcome['kind'], 'failed')
        self.assertEqual(len(sent), 1)
        item.refresh_from_db()
        self.assertIn('It may still have been accepted by the provider', item.error)

    def test_accepted_task_survives_a_killed_worker_and_is_resumed_by_another_without_a_new_submission(self):
        item = self.job(model='Kling Image 3.0')
        stop = threading.Event()
        def killed(job, *, on_task, signal, **kwargs):
            on_task('accepted-before-kill')
            stop.set()
            signal.check()
        self.assertEqual(self.run_job(item, killed, signal=worker.WorkerCancellation(stop), heartbeat=False)['kind'], 'pending')
        item.refresh_from_db()
        self.assertEqual((item.status, item.task_id, item.worker_lease_id), ('running', 'accepted-before-kill', None))
        resumed = []
        def successor(job, *, on_task, **kwargs):
            resumed.append(job.task_id)
            return {'status': 'succeeded', 'url': '/api/media/generations/master.png'}
        outcome = executor.process_generation(item.id, owner='worker-b', image_execute=successor, heartbeat=False, env={})
        self.assertEqual((outcome['kind'], resumed), ('succeeded', ['accepted-before-kill']))
