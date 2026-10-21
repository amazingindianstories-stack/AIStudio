import base64
from concurrent.futures import ThreadPoolExecutor
import io
import threading
from unittest.mock import patch
from uuid import uuid4

from django.db import connections, OperationalError
from django.test import TransactionTestCase
from PIL import Image

from .models import Generation
from .services import coordinator, poller
from .services.deadline import Cancellation


class PollerTests(TransactionTestCase):
    def test_terminal_commit_ack_loss_retains_winning_master_without_reupload(self):
        item=self.job()
        saved=[]
        deps=self.deps(get_video=lambda *args,**kwargs:{'status':'succeeded','videoUrl':'https://fixture.invalid/master.mov'},
            save_url=lambda *args:saved.append(args) or {'url':'/api/media/generations/winning.mov'})
        real=coordinator.compare_and_set_outcome
        def lost_ack(*args,**kwargs):
            result=real(*args,**kwargs)
            self.assertIsNotNone(result)
            raise OperationalError('injected outcome commit acknowledgment loss')
        with patch.object(coordinator,'compare_and_set_outcome',side_effect=lost_ack):
            self.assertEqual(poller.advance(item,dependencies=deps)['kind'],'raced')
        item.refresh_from_db()
        self.assertEqual((item.status,item.url,item.task_id),('succeeded','/api/media/generations/winning.mov','task-original'))
        self.assertEqual(poller.advance(item,dependencies=deps)['kind'],'succeeded')
        self.assertEqual(len(saved),1)

    def job(self, **values):
        return Generation.objects.create(**{'kind': 'video', 'status': 'running', 'model': 'Seedance 2.5',
            'prompt': 'isolated fixture', 'aspect_ratio': '16:9', 'task_id': 'task-original',
            'cost_cents': 40, 'created_at': 100, 'updated_at': 200, **values})

    def deps(self, **values):
        return poller.Dependencies(now=lambda: 10000, mock=lambda: False, publish=lambda item: None,
            **values)

    def test_native_mov_success_and_actual_token_price(self):
        item = self.job(reference_videos=['/api/media/fixture.mp4'])
        calls = []
        deps = self.deps(get_video=lambda *args, **kwargs: {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/original.mov',
                'outputFormat': 'mov', 'totalTokens': 100000, 'created_at': 2, 'updated_at': 3},
            pricing=lambda: [{'model': 'Seedance 2.5 · per-token (video input)', 'unitCostCents': 640}],
            save_url=lambda *args: calls.append(args) or {'url': '/api/media/generations/master.mov', 'aspectRatio': '21:9'})
        outcome = poller.advance(item, dependencies=deps)
        self.assertEqual(outcome['kind'], 'succeeded')
        current = outcome['item']
        self.assertEqual((current.cost_cents, current.cost_basis, current.aspect_ratio), (64, 'reconciled', '21:9'))
        self.assertEqual((current.provider_created_at, current.provider_updated_at), (2000, 3000))
        self.assertEqual(calls[0][1], 'mov')
        self.assertEqual(poller.advance(current, dependencies=deps)['kind'], 'succeeded')
        self.assertEqual(len(calls), 1)

    def test_transport_failure_backoff_recovers_without_resubmit(self):
        item = self.job()
        def unavailable(*args, **kwargs):
            raise RuntimeError('private provider body must not become user error')
        deps = self.deps(get_video=unavailable)
        self.assertEqual(poller.advance(item, dependencies=deps), {'kind': 'poll_error', 'pollErrorCount': 1, 'retryAfterMs': 30000})
        item.refresh_from_db()
        self.assertEqual((item.status, item.next_poll_at, item.error), ('running', 40000, None))
        self.assertEqual(poller.advance(item, dependencies=deps)['retryAfterMs'], 60000)
        item.refresh_from_db()
        deps.get_video = lambda *args, **kwargs: {'status': 'running'}
        self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'pending')
        item.refresh_from_db()
        self.assertEqual((item.poll_error_count, item.last_poll_error_at, item.next_poll_at), (0, None, 15000))

    def test_storage_failure_keeps_provider_task_for_durable_retry(self):
        item = self.job()
        def broken(*args):
            raise IOError('storage unavailable')
        deps = self.deps(get_video=lambda *args, **kwargs: {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'}, save_url=broken)
        self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'poll_error')
        item.refresh_from_db()
        self.assertEqual((item.status, item.task_id, item.url), ('running', 'task-original', None))
        deps.save_url = lambda *args: {'url': '/api/media/generations/master.mov'}
        self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'succeeded')

    def test_moderation_missing_output_and_omni_terminal(self):
        for result, model, phrase in [({'status': 'failed', 'error': 'SensitiveContent'}, 'Seedance 2.5', 'BytePlus rejected'),
            ({'status': 'succeeded'}, 'Seedance 2.5', 'no video'),
            ({'status': 'failed', 'error': 'blocked', 'moderationBlocked': True}, 'Gemini Omni Flash', 'blocked'),
            ({'status': 'failed', 'error': 'blocked', 'moderationBlocked': True}, 'Gemini Omni Flash 1.1', 'blocked'),
            ({'status': 'succeeded'}, 'Gemini Omni Flash 1.1', 'Omni reported success but returned no video.')]:
            with self.subTest(result=result):
                item = self.job(model=model)
                deps = self.deps(get_video=lambda *args, **kwargs: result, get_omni=lambda *args, **kwargs: result)
                outcome = poller.advance(item, dependencies=deps)
                self.assertEqual(outcome['kind'], 'failed')
                self.assertIn(phrase, outcome['item'].error)

    def test_omni_save_retry_preserves_base64_master(self):
        for model in ('Gemini Omni Flash', 'Gemini Omni Flash 1.1'):
            with self.subTest(model=model):
                self.omni_save_retry_preserves_base64_master(model)

    def omni_save_retry_preserves_base64_master(self, model):
        item = self.job(model=model)
        calls = []
        def save(*args):
            calls.append(args)
            if len(calls) == 1:
                raise IOError('temporary')
            return {'url': '/api/media/generations/master.mp4'}
        signal = Cancellation(10000)
        with patch.object(signal, 'wait') as wait:
            outcome = poller.advance(item, signal=signal, dependencies=self.deps(
                get_omni=lambda *args, **kwargs: {'status': 'succeeded', 'videoBase64': 'ORIGINAL'}, save_base64=save))
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertEqual([call[:2] for call in calls], [('ORIGINAL', 'mp4')] * 2)
        wait.assert_called_once_with(1000)

    def test_best_of_waits_for_all_then_judges_without_reordering(self):
        item = self.job(candidate_task_ids=['second'], reference_images=['/api/media/references/face.png'])
        outputs = {'task-original': {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/one.mov', 'outputFormat': 'mov'},
                   'second': {'status': 'running'}}
        saved = []
        deps = self.deps(get_video=lambda task, **kwargs: outputs[task], read_reference=lambda ref: {'data': 'face'},
            extract_frame=lambda url: {'data': url}, judge_identity=lambda reference, frame, signal: 95 if 'two' in frame['data'] else 70,
            save_url=lambda *args: saved.append(args) or {'url': '/api/media/generations/winner.mov'})
        self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'pending')
        self.assertEqual(saved, [])
        outputs['second'] = {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/two.mov', 'outputFormat': 'mov'}
        item.refresh_from_db()
        outcome = poller.advance(item, dependencies=deps)
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertEqual(outcome['item'].judge_score, {'identity': 95})
        self.assertIsNone(outcome['item'].candidate_task_ids)
        self.assertEqual(saved[0][0], 'https://fixture.invalid/two.mov')

    def test_fenced_concurrent_completion_has_single_winner(self):
        item = self.job()
        barrier = threading.Barrier(2)
        def get(*args, **kwargs):
            barrier.wait(timeout=10)
            return {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'}
        deps = self.deps(get_video=get, save_url=lambda *args: {'url': '/api/media/generations/master.mov'})
        def run(_):
            try:
                return poller.advance(Generation.objects.get(pk=item.pk), dependencies=deps)['kind']
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(run, range(2))), ['raced', 'succeeded'])
        item.refresh_from_db()
        self.assertEqual(item.status, 'succeeded')

    def test_stale_task_and_worker_cannot_finalize_successor(self):
        item = self.job(worker_lease_id='old', worker_lease_until=500)
        Generation.objects.filter(pk=item.id).update(task_id='successor', worker_lease_id='new')
        deps = self.deps(get_video=lambda *args, **kwargs: {'status': 'failed', 'error': 'old failure'})
        self.assertEqual(poller.advance(item, owner='old', dependencies=deps)['kind'], 'raced')
        item.refresh_from_db()
        self.assertEqual((item.status, item.task_id, item.worker_lease_id), ('running', 'successor', 'new'))

    def test_cancelled_provider_result_never_commits(self):
        item = self.job()
        signal = Cancellation()
        def get(*args, **kwargs):
            signal.cancelled.set()
            return {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'}
        deps = self.deps(get_video=get, save_url=lambda *args: self.fail('Cancelled result persisted'))
        self.assertEqual(poller.advance(item, dependencies=deps, signal=signal)['kind'], 'poll_error')
        item.refresh_from_db()
        self.assertEqual(item.status, 'running')

    def test_magnific_validates_image_and_preserves_master_bytes(self):
        item = self.job(kind='image', model='Magnific Creative')
        buffer = io.BytesIO()
        Image.new('RGB', (128, 128), 'red').save(buffer, format='PNG')
        original, calls = buffer.getvalue(), []
        deps = self.deps(get_magnific=lambda *args, **kwargs: {'status': 'succeeded', 'generatedUrl': 'https://fixture.invalid/image', 'costCents': 22},
            fetch_magnific_image=lambda url: (original, 'image/png'), save_buffer=lambda *args: calls.append(args) or {'url': '/api/media/generations/master.png'})
        outcome = poller.advance(item, dependencies=deps)
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertEqual(calls[0][:2], (original, 'png'))
        self.assertEqual((outcome['item'].cost_cents, outcome['item'].cost_basis), (22, 'reconciled'))

    def magnific_image_deps(self, fetch, saved=None):
        return self.deps(get_magnific=lambda *args, **kwargs: {'status': 'succeeded', 'generatedUrl': 'https://ai-statics.magnific.com/x.png?token=t'},
            fetch_magnific_image=fetch, save_buffer=lambda *args: (saved if saved is not None else []).append(args) or {'url': '/api/media/generations/m.png'})

    def test_magnific_oversized_image_fails_cleanly_without_storing(self):
        from apps.media.errors import MediaTooLargeError
        from .serialization import public_error
        item, saved = self.job(kind='image', model='Magnific Precision V2'), []
        def too_large(url):
            raise MediaTooLargeError('Provider media exceeds the configured download limit.')
        outcome = poller.advance(item, dependencies=self.magnific_image_deps(too_large, saved))
        self.assertEqual((outcome['kind'], outcome['item'].error), ('failed', poller.MAGNIFIC_IMAGE_TOO_LARGE))
        self.assertEqual(public_error(outcome['item'], outcome['item'].error), poller.MAGNIFIC_IMAGE_TOO_LARGE)
        self.assertEqual(saved, [])
        # Too many pixels is judged from the header, before any full decode.
        buffer = io.BytesIO()
        Image.new('RGB', (200, 100), 'red').save(buffer, format='PNG')
        item = self.job(kind='image', model='Magnific Precision V2')
        with patch.object(poller, 'MAGNIFIC_IMAGE_MAX_PIXELS', 19999):
            outcome = poller.advance(item, dependencies=self.magnific_image_deps(lambda url: (buffer.getvalue(), 'image/png'), saved))
        self.assertEqual((outcome['kind'], outcome['item'].error), ('failed', poller.MAGNIFIC_IMAGE_TOO_LARGE))
        self.assertEqual(saved, [])

    def test_magnific_unreadable_image_retries_then_fails_instead_of_running_forever(self):
        buffer = io.BytesIO()
        Image.new('RGB', (64, 64), 'red').save(buffer, format='PNG')
        truncated, saved = buffer.getvalue()[:-40], []
        item = self.job(kind='image', model='Magnific Creative')
        deps = self.magnific_image_deps(lambda url: (truncated, 'image/png'), saved)
        for attempt in range(1, poller.MAGNIFIC_SAVE_ATTEMPTS):
            self.assertEqual(poller.advance(item, dependencies=deps)['kind'], 'poll_error')
            item.refresh_from_db()
            self.assertEqual((item.status, item.poll_error_count), ('running', attempt))
        outcome = poller.advance(item, dependencies=deps)
        self.assertEqual((outcome['kind'], outcome['item'].error), ('failed', poller.MAGNIFIC_SAVE_FAILED))
        self.assertEqual(saved, [])

    def test_magnific_image_download_stops_at_its_cap_while_streaming(self):
        import contextlib
        from apps.integrations.remote import SafeMediaFetcher
        seen = []
        class Recording(SafeMediaFetcher):
            @contextlib.contextmanager
            def open_file(self, url, *, max_bytes=None):
                seen.append(max_bytes)
                yield io.BytesIO(b'png'), 'image/png'
        with patch('apps.generation.services.poller.get_media_fetcher', lambda: Recording(['ai-statics.magnific.com'])):
            self.assertEqual(poller.Dependencies().fetch_magnific_image('https://ai-statics.magnific.com/x.png'), (b'png', 'image/png'))
        self.assertEqual(seen, [poller.MAGNIFIC_IMAGE_MAX_BYTES])
