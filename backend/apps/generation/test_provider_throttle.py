"""Provider rate limits and overload: a 429/5xx must end in the honest state, never a wasted slot or a lost paid output."""
import contextlib
import json
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from django.db import connection
from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.media.audio_inputs import capture_audio_input
from apps.media.storage import MemoryAdapter, StorageService
from testsupport.fake_providers import GOOGLE_STATUS, google_error
from . import failure_copy
from .models import Generation
from .providers import seedream
from .providers.transport import HttpResult, ProviderError
from .serialization import generation_item
from .services import admission, executor, paid_guard, poller, video_execution
from .services.audio_submission import AUDIO_READY, audio_capacity_available, process_audio
from .services.deadline import Cancellation
from .services.image_execution import Dependencies as ImageDependencies, execute_image
from .services.upscale_submission import submit_claimed_upscale

UNLIMITED = {'approved_scope': paid_guard.UNLIMITED_SCOPE, 'unlimited_new_jobs': True}
HOUR = 3600 * 1000


def throttle(status, body=None):
    """The provider's answer; Google's own error shape (google.rpc.Status) unless a body is given."""
    return HttpResult(status, json.dumps(body or google_error(status)).encode())


class LedgerCursor:
    """Stands in for the paid-budget ledger function only; every other statement reaches the real database."""
    def __init__(self, real, ledger):
        self.real, self.ledger = real, ledger

    def __enter__(self):
        self.real.__enter__()
        return self

    def __exit__(self, *exc):
        return self.real.__exit__(*exc)

    def __iter__(self):
        return iter(self.real)

    def __getattr__(self, name):
        return getattr(self.real, name)

    def execute(self, sql, params=None):
        if isinstance(sql, str) and 'goal4_preview_paid_budget.transition' in sql:
            generation, _, old, new = params
            if self.ledger.get(generation) != old:
                raise RuntimeError('No paid submission retry or stale input')
            self.ledger[generation] = new
            return None
        return self.real.execute(sql, params)


@contextlib.contextmanager
def paid_guarded(ledger, sent, responses):
    """The production paid guard over a transport that answers with `responses`; a second POST per job is refused."""
    from apps.generation.providers.transport import HttpTransport

    def provider(self, method, url, **kwargs):
        sent.append((method, url))
        return responses.pop(0)

    real_cursor = connection.cursor
    try:
        with override_settings(VEEVEE_PAID_GUARD=UNLIMITED), patch.object(HttpTransport, '_send', provider), \
                patch.object(connection, 'cursor', lambda *args, **kwargs: LedgerCursor(real_cursor(*args, **kwargs), ledger)):
            yield
    finally:
        paid_guard.STATE.active = None


class GeminiThrottleTests(TransactionTestCase):
    def job(self, **values):
        return Generation.objects.create(**{'kind': 'image', 'status': 'queued', 'model': 'Nano Banana Pro', 'prompt': 'fixture',
            'aspect_ratio': '1:1', 'created_at': executor.now_ms(), 'updated_at': executor.now_ms(), 'cost_cents': 14,
            'user_id': uuid4(), **values})

    def run_throttled(self, status):
        row, sent = self.job(), []
        ledger = {row.id: 'RESERVED'}
        deps = ImageDependencies()
        deps.assets, deps.pricing, deps.storage = [], [], lambda: StorageService(MemoryAdapter())
        deps.assemble = Mock(return_value={'instruction': 'fixture', 'groups': []})
        image = lambda job, **kwargs: execute_image(job, dependencies=deps, **kwargs)
        with paid_guarded(ledger, sent, [throttle(status), throttle(status)]):
            outcome = executor.process_generation(row.id, owner='worker', image_execute=image, heartbeat=False,
                                                  env={'GOOGLE_API_KEY': 'fixture'})
        row.refresh_from_db()
        return row, outcome, sent, ledger

    def test_throttle_under_the_paid_guard_fails_fast_unbilled_with_the_busy_copy(self):
        for status in (429, 503):
            with self.subTest(status=status):
                row, outcome, sent, ledger = self.run_throttled(status)
                self.assertEqual((outcome['kind'], row.status), ('failed', 'failed'))
                self.assertEqual(len(sent), 1, 'the single paid POST is the only one')
                self.assertEqual(ledger[row.id], 'SUBMITTING')
                self.assertIn(f'({status})', row.error)
                self.assertNotIn('No paid submission', row.error)
                self.assertNotIn('may still have been accepted', row.error, 'a throttle was not processed, so it is not uncertain')
                self.assertEqual(generation_item(row)['error'], failure_copy.BUSY + f' Provider code: {GOOGLE_STATUS[status]}.')
                (record,) = row.provider_responses
                self.assertEqual({key: record[key] for key in ('provider', 'model', 'phase', 'httpStatus', 'code', 'message', 'unbilled')},
                                 {'provider': 'gemini', 'model': row.model, 'phase': 'create', 'httpStatus': status,
                                  'code': GOOGLE_STATUS[status], 'message': 'Request failed.', 'unbilled': True})

    def test_unbilled_throttle_rows_do_not_count_toward_the_gemini_spend_window(self):
        for status in (429, 503):
            with self.subTest(status=status):
                Generation.objects.all().delete()
                row, *_ = self.run_throttled(status)
                waiting = self.job()
                current = admission.snapshot(waiting, now=executor.now_ms(), best_of=2)
                self.assertEqual((current['window_rows'], float(current['window_cents'])), (0, 0.0))
                Generation.objects.filter(pk=row.id).update(error='Gemini image error (500): boom', provider_responses=None)
                self.assertEqual(admission.snapshot(waiting, now=executor.now_ms(), best_of=2)['window_rows'], 1,
                                 'a failure that may have been billed still counts')


class MagnificThrottleTests(TransactionTestCase):
    def test_create_429_says_the_service_is_busy_and_keeps_the_status(self):
        from .test_enqueue import picture
        storage = StorageService(MemoryAdapter())
        storage.primary.put('references/job.png', picture(), 'image/png', 'private')
        row = Generation.objects.create(kind='image', status='running', prompt='fixture', model='Magnific Precision V2',
            aspect_ratio='1:1', user_id=uuid4(), created_at=1, updated_at=1, worker_lease_id='owner',
            submission_input={'version': 1, 'source': '/api/media/references/job.png', 'params': {
                'scaleFactor': '4x', 'flavor': 'photo', 'sharpen': 7, 'smartGrain': 7, 'ultraDetail': 30}})
        def busy(payload, signal):
            raise ProviderError('Too many requests', status=429)
        with patch.dict('os.environ', {'MOCK_GENERATION': '0'}):
            failed = submit_claimed_upscale(row, owner='owner', signal=Cancellation(), storage=storage, submit=busy)
        self.assertEqual((failed.status, failed.provider_status, failed.task_id), ('failed', 'REJECTED', None))
        self.assertIn('429', failed.error)
        self.assertEqual(generation_item(failed)['error'], failure_copy.UPSCALE_BUSY)
        self.assertIn('busy', failure_copy.UPSCALE_BUSY)
        self.assertIn('Nothing was charged', failure_copy.UPSCALE_BUSY)


class PollerThrottleTests(TransactionTestCase):
    def job(self, **values):
        return Generation.objects.create(**{'kind': 'video', 'status': 'running', 'model': 'Seedance 2.5',
            'prompt': 'isolated fixture', 'aspect_ratio': '16:9', 'task_id': 'task-original', 'user_id': uuid4(),
            'cost_cents': 40, 'created_at': 100, 'updated_at': 200, **values})

    def deps(self, **values):
        return poller.Dependencies(now=lambda: 10000, mock=lambda: False, publish=lambda item: None, **values)

    def drain(self, item, deps, *, limit=500):
        """Advance until the job leaves `running`; returns the total backoff the retries asked for."""
        waited = 0
        for _ in range(limit):
            outcome = poller.advance(item, dependencies=deps)
            if outcome['kind'] != 'poll_error':
                return outcome, waited
            waited += outcome['retryAfterMs']
            item.refresh_from_db()
        self.fail('the job was still retrying')

    def test_magnific_status_429s_do_not_use_up_the_download_attempts(self):
        item = self.job(kind='image', model='Magnific Precision V2')
        state = {'status_calls': 0}
        def status(*args, **kwargs):
            state['status_calls'] += 1
            if state['status_calls'] <= 2:
                raise ProviderError('Too many requests', status=429)
            return {'status': 'succeeded', 'generatedUrl': 'https://ai-statics.magnific.com/x.png'}
        deps = self.deps(get_magnific=status, save_buffer=lambda *args: {'url': '/api/media/generations/m.png'},
            fetch_magnific_image=Mock(side_effect=[IOError('cdn'), IOError('cdn')]))
        for expected in ('poll_error', 'poll_error', 'poll_error'):
            self.assertEqual(poller.advance(item, dependencies=deps)['kind'], expected)
            item.refresh_from_db()
        self.assertEqual(item.status, 'running', 'two status 429s and a CDN error must not fail a paid output')
        deps.fetch_magnific_image = lambda url: (_png(), 'image/png')
        self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'succeeded')

    def test_magnific_download_retries_span_at_least_ten_minutes(self):
        item = self.job(kind='image', model='Magnific Precision V2')
        deps = self.deps(get_magnific=lambda *args, **kwargs: {'status': 'succeeded', 'generatedUrl': 'https://ai-statics.magnific.com/x.png'},
            fetch_magnific_image=Mock(side_effect=IOError('cdn')))
        outcome, waited = self.drain(item, deps)
        self.assertEqual((outcome['kind'], outcome['item'].error), ('failed', poller.MAGNIFIC_SAVE_FAILED))
        self.assertGreaterEqual(waited, 10 * 60 * 1000)

    def test_a_downloading_seedance_job_does_not_hold_a_lane_slot(self):
        running = [self.job(task_id=f'task-{index}', created_at=1000 + index) for index in range(3)]
        waiting = self.job(status='queued', task_id=None, created_at=2000)
        self.assertIsNone(admission.admit_job(waiting.id, now=5000), 'the lane is full of running work')
        done = {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'}
        deps = self.deps(get_video=lambda *args, **kwargs: done, save_url=Mock(side_effect=IOError('429 from the CDN')))
        outcome = poller.advance(running[0], dependencies=deps)
        self.assertEqual(outcome['kind'], 'poll_error')
        running[0].refresh_from_db()
        self.assertEqual(running[0].status, 'running', 'the finished output is still being fetched')
        self.assertIsNotNone(admission.admit_job(waiting.id, now=5000), 'BytePlus no longer runs it, so the slot is free')

    def test_download_that_never_works_fails_honestly_after_six_hours_without_resubmitting(self):
        item = self.job()
        deps = self.deps(get_video=lambda *args, **kwargs: {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'},
            save_url=Mock(side_effect=IOError('403 link expired')))
        outcome, waited = self.drain(item, deps)
        self.assertEqual((outcome['kind'], outcome['item'].error), ('failed', poller.DOWNLOAD_ABANDONED))
        self.assertGreaterEqual(waited, 6 * HOUR)
        self.assertLess(waited, 7 * HOUR)
        self.assertEqual(generation_item(outcome['item'])['error'],
                         poller.DOWNLOAD_ABANDONED + ' Error code: output_download_failed. Task id: task-original.')
        (record,) = outcome['item'].provider_responses
        self.assertEqual({key: record[key] for key in ('provider', 'phase', 'source', 'code', 'message', 'taskId')},
                         {'provider': 'seedance', 'phase': 'download', 'source': 'veevee', 'code': 'output_download_failed',
                          'message': '403 link expired', 'taskId': 'task-original'})
        self.assertEqual(outcome['item'].task_id, 'task-original', 'the provider task is kept; nothing is resubmitted')

    def test_status_polls_that_never_work_fail_honestly_after_six_hours(self):
        item = self.job()
        deps = self.deps(get_video=Mock(side_effect=ProviderError('Seedance poll error 429', status=429)))
        outcome, waited = self.drain(item, deps)
        self.assertEqual((outcome['kind'], outcome['item'].error), ('failed', poller.POLL_ABANDONED))
        self.assertGreaterEqual(waited, 6 * HOUR)
        self.assertLess(waited, 7 * HOUR)
        self.assertEqual(generation_item(outcome['item'])['error'], poller.POLL_ABANDONED + ' Error code: poll_abandoned. Task id: task-original.')

    def test_a_recovering_status_poll_restarts_the_window(self):
        item = self.job()
        deps = self.deps(get_video=Mock(side_effect=ProviderError('Seedance poll error 429', status=429)))
        for _ in range(5):
            poller.advance(item, dependencies=deps)
            item.refresh_from_db()
        deps.get_video = lambda *args, **kwargs: {'status': 'running'}
        self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'pending')
        item.refresh_from_db()
        self.assertEqual(item.poll_error_count, 0)


def _png():
    import io
    from PIL import Image
    buffer = io.BytesIO()
    Image.new('RGB', (64, 64), 'red').save(buffer, format='PNG')
    return buffer.getvalue()


class SeedreamOverloadCopyTests(TransactionTestCase):
    def test_overload_codes_say_busy_whatever_the_status(self):
        for status, code in ((503, 'ServerOverloaded'), (500, 'RateLimitExceeded'), (502, 'QuotaExceeded'),
                             (500, 'TooManyRequests'), (503, 'RequestBurstTooFast'), (429, 'RateLimitExceeded')):
            with self.subTest(status=status, code=code):
                row = Generation.objects.create(kind='image', status='queued', model='Seedream 5.0 Pro', prompt='fixture',
                    aspect_ratio='1:1', created_at=1, updated_at=1, user_id=uuid4(), cost_cents=4)
                transport = Mock()
                transport.request.return_value = throttle(status, {'error': {'code': code, 'message': 'x'}})
                def image(job, **kwargs):
                    return seedream.generate_image({'prompt': 'fixture', 'aspectRatio': '1:1', 'resolution': '2K', 'references': []},
                        transport=transport, env={'ARK_API_KEY': 'fixture'}, signal=kwargs['signal'])
                outcome = executor.process_generation(row.id, owner='worker', image_execute=image, heartbeat=False, env={})
                row.refresh_from_db()
                self.assertEqual(outcome['kind'], 'failed')
                self.assertEqual(generation_item(row)['error'], failure_copy.BUSY + f' Provider code: {code}.')
                self.assertEqual(('may still have been accepted' in row.error), status >= 500,
                                 'a 5xx stays uncertain; only the copy changes')

    def test_a_real_rejection_keeps_the_rejected_copy(self):
        row = SimpleNamespace(kind='image', model='Seedream 5.0 Pro', moderation_blocked=None)
        message = 'Seedream rejected the request. Check reference files and content requirements. (400, InvalidParameter)'
        self.assertEqual(failure_copy.public_message(row, message), failure_copy.IMAGE_REJECTED)


class BestOfMarkerTests(SimpleTestCase):
    def submit(self, error, count=3):
        deps = video_execution.Dependencies()
        deps.assets, deps.inline, deps.sign = lambda _: [], lambda refs, signal: [], lambda ref: ref
        deps.seedance_submit = Mock(side_effect=error)
        item = SimpleNamespace(id=uuid4(), status='running', task_id=None, draft_task_id=None, model='Seedance 2.5', prompt='x',
            aspect_ratio='16:9', duration=5, resolution='1080p', reference_images=[], reference_videos=[], reference_audios=[],
            project_id=None, continuation_frame_url=None, last_frame_url=None, generate_audio=True, draft_mode=False,
            bitrate_mode='high', video_task_mode=None, seed=17, cost_cents=120)
        with self.assertRaises(ProviderError) as caught:
            video_execution.submit_video(item, signal=Cancellation(), on_task=lambda *args: None, count=count, dependencies=deps, env={})
        return caught.exception

    def test_all_candidates_refused_with_a_4xx_were_never_submitted(self):
        for status in (400, 429):
            with self.subTest(status=status):
                error = self.submit(ProviderError('Seedance error', status=status, may_have_submitted=False))
                self.assertFalse(error.may_have_submitted)
                self.assertEqual(error.status, status)
                self.assertFalse(executor.submission_uncertain(error))


class AudioThrottleTests(TransactionTestCase):
    def prepared(self):
        store = StorageService(MemoryAdapter())
        row = Generation.objects.create(kind='audio', status='queued', prompt='', model='Gemini (fixture)', aspect_ratio='audio',
            user_id=uuid4(), provider_status=AUDIO_READY, submission_input={'version': 2, 'operation': 'audio-transcription'},
            created_at=1, updated_at=1)
        row.submission_input = capture_audio_input(store, 'data:audio/wav;base64,YWJj', row.id, model='fixture', name='fixture')
        row.save(update_fields=['submission_input'])
        return row, store

    def transcriber(self, status):
        from apps.media.audio import get_transcriber
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=None, GOOGLE_API_KEY='fixture'):
            provider = get_transcriber()
        return provider

    def test_a_429_fails_the_row_and_frees_the_users_audio_slot(self):
        from apps.generation.providers.transport import HttpTransport
        row, store = self.prepared()
        provider = self.transcriber(429)
        with patch.object(HttpTransport, 'request', lambda self, *args, **kwargs: throttle(429)):
            outcome = process_audio(row.id, 'audio:throttled', signal=Cancellation(), provider=provider, storage=store)
        row.refresh_from_db()
        self.assertEqual((outcome['kind'], row.status), ('failed', 'failed'))
        self.assertNotEqual(row.provider_status, 'SUBMISSION_UNCERTAIN')
        self.assertIn('429', row.error)
        self.assertEqual(generation_item(row)['error'], failure_copy.BUSY + ' Provider code: RESOURCE_EXHAUSTED.')
        self.assertEqual([(record['provider'], record['phase'], record['httpStatus'], record['code']) for record in row.provider_responses],
                         [('gemini', 'transcribe', 429, 'RESOURCE_EXHAUSTED')])
        self.assertTrue(audio_capacity_available(row.user_id), 'a throttle must not lock the user out of transcription')

    def test_other_definite_4xx_fail_with_the_rejected_copy_and_5xx_stays_uncertain(self):
        from apps.generation.providers.transport import HttpTransport
        for status, uncertain in ((400, False), (408, True), (500, True)):
            with self.subTest(status=status):
                row, store = self.prepared()
                provider = self.transcriber(status)
                with patch.object(HttpTransport, 'request', lambda self, *args, **kwargs: throttle(status)):
                    try:
                        process_audio(row.id, 'audio:' + str(status), signal=Cancellation(), provider=provider, storage=store)
                    except Exception:
                        self.assertTrue(uncertain)
                row.refresh_from_db()
                self.assertEqual(row.provider_status == 'SUBMISSION_UNCERTAIN', uncertain)
                self.assertEqual(row.status, 'running' if uncertain else 'failed')
                if not uncertain:
                    self.assertEqual(generation_item(row)['error'], failure_copy.AUDIO_REJECTED + ' Provider code: INVALID_ARGUMENT.')
