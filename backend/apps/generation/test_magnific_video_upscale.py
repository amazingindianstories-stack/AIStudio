"""Magnific video upscale: every API, worker and reconciler path, with only the network faked.

Path map (production order):
  gateway POST /api/generate/upscale (flagged) -> upscale view -> video branch
  -> validation -> stored-source probe -> estimate -> persist (paid guard reserve)
  -> worker submit (fenced, signed HTTPS source) -> poll -> stream master -> succeeded.
The image branch of the same view is covered by test_enqueue / test_upscale_*.
"""
import os
import subprocess
import tempfile
import uuid
from unittest.mock import patch
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.media.storage import FileSystemAdapter, StorageService
from testsupport.fake_providers import FakeProviders, mp4_bytes
from .models import Generation
from .providers import magnific
from .services import executor, poller
from .services.upscale_validation import (InvalidUpscaleRequest, validate_video_upscale_request, video_upscale_cost,
                                          video_upscale_frames, inspect_video_source)

ENV = {'MOCK_GENERATION': '0', 'MAGNIFIC_API_KEY': 'fake-magnific-key'}
CREATIVE = {'model': 'Magnific Video Creative', 'resolution': '2k', 'creativity': 0, 'sharpen': 0, 'smartGrain': 0,
            'fpsBoost': False, 'flavor': 'vivid', 'outputFormat': 'h264'}


def clip(seconds=1, rate=12, size='160x90'):
    with tempfile.TemporaryDirectory() as directory:
        target = f'{directory}/v.mp4'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate={rate}', '-t', str(seconds),
                        '-c:v', 'mpeg4', '-f', 'mp4', target], check=True)
        with open(target, 'rb') as handle:
            return handle.read()


class PayloadTests(SimpleTestCase):
    def test_payloads_match_the_documented_schemas(self):
        url = 'https://storage.example/signed'
        creative = magnific.build_video_payload('Magnific Video Creative', url, CREATIVE)
        self.assertEqual(creative, {'endpoint': '/v1/ai/video-upscaler', 'body': {
            'video': url, 'resolution': '2k', 'creativity': 0, 'fps_boost': False, 'sharpen': 0, 'smart_grain': 0,
            'flavor': 'vivid', 'output_format': 'h264'}})
        turbo = magnific.build_video_payload('Magnific Video Creative Turbo', url, {**CREATIVE, 'resolution': '4k', 'creativity': 40.0})
        self.assertEqual((turbo['endpoint'], turbo['body']['resolution'], turbo['body']['creativity']), ('/v1/ai/video-upscaler/turbo', '4k', 40))
        precision = magnific.build_video_payload('Magnific Video Precision', url, {'resolution': '1k', 'strength': 75, 'sharpen': 3,
                                                                                    'smartGrain': 2, 'fpsBoost': True, 'outputFormat': 'prores_422_hq'})
        self.assertEqual(precision['body'], {'video': url, 'resolution': '1k', 'fps_boost': True, 'sharpen': 3, 'smart_grain': 2,
                                             'strength': 75, 'output_format': 'prores_422_hq'})
        topaz = magnific.build_video_payload('Magnific Video Topaz', url, {'resolution': '720p', 'enhancementModel': 'starlight_fast_2',
                                                                            'targetFps': 30, 'frameInterpolation': 'chronos', 'noise': .25})
        self.assertEqual(topaz, {'endpoint': '/v1/ai/video-upscaler-topaz', 'body': {
            'video': url, 'resolution': '720p', 'enhancement_model': 'starlight_fast_2', 'target_fps': 30,
            'frame_interpolation': 'chronos', 'noise': .25}})
        # Without a target the source rate is kept and no interpolation model is sent.
        keep = magnific.build_video_payload('Magnific Video Topaz', url, {'resolution': '2k', 'enhancementModel': 'starlight_precise_2_5', 'noise': 0})
        self.assertEqual(keep['body'], {'video': url, 'resolution': '2k', 'enhancement_model': 'starlight_precise_2_5', 'noise': 0})
        with self.assertRaises(ValueError):
            magnific.build_video_payload('Magnific Video Creative', 'http://insecure.example/v.mp4', CREATIVE)

    def test_status_endpoints_and_prores_master_selection(self):
        self.assertEqual(magnific.VIDEO_ENDPOINTS['Magnific Video Creative Turbo'][1], '/v1/ai/video-upscaler')
        urls = ['https://cdn-magnific.freepik.com/a-preview.mp4?token=x', 'https://cdn-magnific.freepik.com/a.mov?token=x']
        self.assertEqual(magnific.video_master_url(urls, 'prores_422_hq'), urls[1])
        self.assertEqual(magnific.video_master_url(urls[:1], 'h264'), urls[0])
        with self.assertRaises(Exception):
            magnific.video_master_url(urls[:1], 'prores_422_hq')

    def test_completed_without_urls_is_retryable_not_terminal(self):
        from .providers.transport import HttpResult, ProviderError
        import json
        class Transport:
            def request(self, *args, **kwargs):
                return HttpResult(status=200, body=json.dumps({'data': {'status': 'COMPLETED', 'generated': []}}).encode(), headers={})
        with self.assertRaises(ProviderError):
            magnific.get_video_upscale_status('t', model='Magnific Video Creative', api_key='k', transport=Transport())


class ValidationTests(SimpleTestCase):
    def body(self, **params):
        return {'video': '/api/media/generations/a.mp4', 'model': 'Magnific Video Creative', 'params': {**CREATIVE, **params}}

    def test_whole_number_floats_from_javascript_json_are_accepted(self):
        validate_video_upscale_request(self.body(creativity=10.0, sharpen=0.0))

    def test_every_invalid_parameter_is_refused_before_queueing(self):
        for change in ({'resolution': '8k'}, {'creativity': 101}, {'sharpen': -1}, {'smartGrain': 2.5}, {'fpsBoost': 'yes'},
                       {'flavor': 'warm'}, {'outputFormat': 'mov'}, {'strength': 50}, {'scaleFactor': '2x'}, {'model': 'Magnific Video Topaz'}):
            with self.subTest(change=change), self.assertRaises(InvalidUpscaleRequest):
                validate_video_upscale_request(self.body(**change))
        with self.assertRaises(InvalidUpscaleRequest):
            validate_video_upscale_request({**self.body(), 'model': 'Magnific Video Hyper'})
        with self.assertRaises(InvalidUpscaleRequest):
            validate_video_upscale_request({**self.body(), 'video': ''})
        topaz = {'video': 'x', 'model': 'Magnific Video Topaz', 'params': {'resolution': '2k', 'enhancementModel': 'starlight_precise_2_5', 'noise': 0}}
        validate_video_upscale_request(topaz)
        validate_video_upscale_request({**topaz, 'params': {**topaz['params'], 'targetFps': 15, 'frameInterpolation': 'chronos'}})
        for change in ({'noise': 2}, {'targetFps': 14}, {'targetFps': 61}, {'enhancementModel': 'x'}, {'frameInterpolation': 'apollo'},
                       {'targetFps': 30, 'frameInterpolation': 'x'}):
            with self.subTest(change=change), self.assertRaises(InvalidUpscaleRequest):
                validate_video_upscale_request({**topaz, 'params': {**topaz['params'], **change}})

    def test_prores_masters_that_could_not_be_stored_are_refused_up_front(self):
        from .services.upscale_validation import validate_prores_size, estimated_prores_bytes
        uhd = {'width': 1920, 'height': 1080, 'fps': 30, 'durationSeconds': 60}
        prores = {**CREATIVE, 'outputFormat': 'prores_422_hq'}
        with self.assertRaises(InvalidUpscaleRequest):
            validate_prores_size('Magnific Video Creative', {**prores, 'resolution': '4k'}, uhd)
        validate_prores_size('Magnific Video Creative', {**prores, 'resolution': '4k'}, {**uhd, 'durationSeconds': 20})
        validate_prores_size('Magnific Video Creative', {**prores, 'resolution': '2k'}, uhd)
        validate_prores_size('Magnific Video Creative', {**CREATIVE, 'resolution': '4k'}, uhd)  # H.264 is never refused here
        # Apple's 220 Mbps at 1920x1080 29.97 fps reproduces itself.
        one_second = estimated_prores_bytes({'resolution': '1k', 'fpsBoost': False}, {'width': 2048, 'height': 2048 * 1080 / 1920, 'fps': 29.97, 'durationSeconds': 1})
        self.assertAlmostEqual(one_second * 8 / 1e6, 220 * (2048 / 1920) ** 2, delta=1)

    def test_frames_and_estimate(self):
        meta = {'durationSeconds': 5.0, 'fps': 24}
        self.assertEqual(video_upscale_frames('Magnific Video Creative', CREATIVE, meta), 120)
        self.assertEqual(video_upscale_frames('Magnific Video Creative', {**CREATIVE, 'fpsBoost': True}, meta), 192)
        self.assertEqual(video_upscale_frames('Magnific Video Topaz', {'targetFps': 60}, meta), 300)
        self.assertEqual(video_upscale_frames('Magnific Video Creative', CREATIVE, {'durationSeconds': .1, 'fps': 24}), 12)
        pricing = [{'model': 'Magnific Video Creative', 'unit': 'per_1000_frames', 'unitCostCents': 900}]
        self.assertEqual(video_upscale_cost('Magnific Video Creative', CREATIVE, meta, pricing), 108)
        self.assertEqual(video_upscale_cost('Magnific Video Creative', {**CREATIVE, 'resolution': '4k'}, meta, pricing), 144)
        self.assertEqual(video_upscale_cost('Magnific Video Creative', {**CREATIVE, 'resolution': '720p'}, meta, pricing), 84)
        with self.assertRaises(ValueError):
            video_upscale_cost('Magnific Video Creative', CREATIVE, meta, [])


@override_settings(PUBLIC_APP_URL='https://veevee.test')
class EnqueueTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def storage(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return StorageService(FileSystemAdapter(directory.name))

    def put(self, storage, data, key=None):
        key = key or f'generations/{uuid.uuid4()}.mp4'
        storage.primary.put(key, data, 'video/mp4', 'public, max-age=31536000, immutable')
        return '/api/media/' + key

    def post(self, storage, body):
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV):
            return self.client.post('/api/generate/upscale', body, content_type='application/json')

    def test_unauthenticated_is_refused(self):
        self.assertEqual(self.client.post('/api/generate/upscale', {'video': 'x'}, content_type='application/json').status_code, 401)

    def test_success_records_source_estimate_and_probe(self):
        self.cookie()
        storage = self.storage()
        source = self.put(storage, clip(seconds=2, rate=24))
        response = self.post(storage, {'video': source, 'model': 'Magnific Video Creative', 'params': CREATIVE})
        self.assertEqual(response.status_code, 200, response.content)
        item = response.json()
        self.assertEqual((item['kind'], item['status'], item['model'], item['resolution'], item['duration']),
                         ('video', 'queued', 'Magnific Video Creative', '2k', 2))
        self.assertEqual(item['aspectRatio'], '16:9')
        row = Generation.objects.get(pk=item['id'])
        self.assertEqual(row.submission_input['source'], source)
        self.assertEqual(row.submission_input['sourceMeta']['fps'], 24)
        self.assertEqual(row.cost_cents, 44)  # 48 frames at 900/1000 cents (2K)
        self.assertEqual((row.cost_basis, row.task_id), ('estimated', None))
        from .serialization import generation_item
        self.assertEqual(generation_item(row)['upscaleParams'], CREATIVE, 'clients regenerate with the exact original parameters')

    def test_every_refusal_returns_400_and_queues_nothing(self):
        self.cookie()
        storage = self.storage()
        good = self.put(storage, clip())
        long = self.put(storage, clip(seconds=61, size='32x18'))
        fast = self.put(storage, clip(rate=90, size='32x18'))
        not_video = self.put(storage, b'not a video at all', key='generations/fake.mp4')
        cases = {
            'unsupported model': {'video': good, 'model': 'Magnific Video Hyper', 'params': CREATIVE},
            'bad params': {'video': good, 'model': 'Magnific Video Creative', 'params': {**CREATIVE, 'resolution': '8k'}},
            'foreign url': {'video': 'https://evil.example/v.mp4', 'model': 'Magnific Video Creative', 'params': CREATIVE},
            'export archive': {'video': '/api/media/exports/a.zip', 'model': 'Magnific Video Creative', 'params': CREATIVE},
            'missing object': {'video': '/api/media/generations/missing.mp4', 'model': 'Magnific Video Creative', 'params': CREATIVE},
            'not a video': {'video': not_video, 'model': 'Magnific Video Creative', 'params': CREATIVE},
            'too long': {'video': long, 'model': 'Magnific Video Creative', 'params': CREATIVE},
            'too fast': {'video': fast, 'model': 'Magnific Video Creative', 'params': CREATIVE},
        }
        for name, body in cases.items():
            with self.subTest(name):
                response = self.post(storage, body)
                self.assertEqual(response.status_code, 400, response.content)
                self.assertIn('error', response.json())
        self.assertFalse(Generation.objects.exists())

    def test_unpriced_model_fails_without_queueing(self):
        self.cookie()
        storage = self.storage()
        source = self.put(storage, clip())
        with patch('apps.generation.enqueue_views.read_pricing', lambda: []):
            response = self.post(storage, {'video': source, 'model': 'Magnific Video Creative', 'params': CREATIVE})
        self.assertEqual(response.status_code, 500)
        self.assertFalse(Generation.objects.exists())

    def test_generic_generate_routes_refuse_upscale_models(self):
        self.cookie()
        for kind, model in (('video', 'Magnific Video Creative'), ('image', 'Magnific Precision V2')):
            with self.subTest(kind=kind):
                response = self.post_generate(kind, {'prompt': f'{model} (2k)', 'model': model, 'aspectRatio': '16:9'})
                self.assertEqual(response.status_code, 400, response.content)
                self.assertEqual(response.json()['error'], 'Upscale models run from the Upscale composer.')
        self.assertFalse(Generation.objects.exists())

    def post_generate(self, kind, body):
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage()), patch.dict(os.environ, ENV):
            return self.client.post('/api/generate/' + kind, body, content_type='application/json')

    def test_image_requests_still_take_the_image_branch(self):
        self.cookie()
        response = self.post(self.storage(), {'image': 'https://evil.example/a.png', 'model': 'Magnific Creative', 'params': {}})
        self.assertEqual(response.status_code, 400)
        self.assertFalse(Generation.objects.exists())


@override_settings(PUBLIC_APP_URL='https://veevee.test')
class WorkerTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def queued(self, storage, **params):
        self.cookie()
        key = f'generations/{uuid.uuid4()}.mp4'
        storage.primary.put(key, mp4_bytes(), 'video/mp4', 'public, max-age=31536000, immutable')
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV):
            response = self.client.post('/api/generate/upscale', {'video': '/api/media/' + key, 'model': 'Magnific Video Creative',
                                                                  'params': {**CREATIVE, **params}}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['id']

    def storage(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return StorageService(FileSystemAdapter(directory.name))

    def test_ambiguous_submit_is_held_and_never_resubmitted(self):
        storage = self.storage()
        identifier = self.queued(storage)
        def boom(payload, signal):
            raise TimeoutError('provider timed out after accepting?')
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders() as fake, \
                patch.object(magnific, 'submit_video_upscale', boom):
            with self.assertRaises(TimeoutError):
                executor.process_generation(identifier, heartbeat=False)
            row = Generation.objects.get(pk=identifier)
            self.assertEqual((row.provider_status, row.task_id), ('SUBMISSION_UNCERTAIN', None))
            Generation.objects.filter(pk=identifier).update(worker_lease_id=None, worker_lease_until=None)
            outcome = executor.process_generation(identifier, heartbeat=False)
        self.assertEqual(outcome['kind'], 'submission_uncertain')
        self.assertFalse([call for call in fake.calls if call[0] == 'POST'])

    def test_non_https_signed_source_fails_before_the_pending_marker(self):
        storage = self.storage()
        identifier = self.queued(storage)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage, PUBLIC_APP_URL='http://localhost:3000'), patch.dict(os.environ, ENV), FakeProviders() as fake:
            executor.process_generation(identifier, heartbeat=False)
        row = Generation.objects.get(pk=identifier)
        self.assertEqual((row.status, row.provider_status, row.task_id), ('failed', 'NOT_SUBMITTED', None))
        from .serialization import generation_item
        self.assertEqual(generation_item(row)['error'], 'The upscale source could not be prepared. Nothing was sent to Magnific.')
        self.assertFalse(fake.calls)

    def test_definitive_rejection_ends_the_job_without_a_retry(self):
        storage = self.storage()
        identifier = self.queued(storage)
        posts = []
        def refuse(payload, signal):
            posts.append(payload)
            raise magnific.ProviderError('Could not validate video', status=400)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders(), \
                patch.object(magnific, 'submit_video_upscale', refuse):
            executor.process_generation(identifier, heartbeat=False)
            Generation.objects.filter(pk=identifier).update(worker_lease_id=None, worker_lease_until=None)
            executor.process_generation(identifier, heartbeat=False)
        row = Generation.objects.get(pk=identifier)
        self.assertEqual((row.status, row.provider_status, row.task_id, len(posts)), ('failed', 'REJECTED', None, 1))
        from .serialization import generation_item
        self.assertEqual(generation_item(row)['error'], 'Magnific rejected this upscale. Nothing was charged; check the source and settings.')

    def test_server_errors_and_lost_receipts_stay_uncertain(self):
        from .services import upscale_submission
        for error in (magnific.ProviderError('busy', status=503), magnific.ProviderError('timeout', status=408), TimeoutError('t')):
            self.assertFalse(upscale_submission.definitive_rejection(error), error)
        self.assertTrue(upscale_submission.definitive_rejection(magnific.ProviderError('bad', status=422)))
        self.assertFalse(upscale_submission.definitive_rejection(RuntimeError('Provider accepted upscale without a valid receipt.')))

    def test_running_failed_and_poll_errors(self):
        storage = self.storage()
        identifier = self.queued(storage)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders():
            executor.process_generation(identifier, heartbeat=False)
            row = Generation.objects.get(pk=identifier)
            self.assertEqual((row.status, row.provider_status), ('running', 'SUBMITTED'))
            deps = poller.Dependencies(get_magnific_video=lambda *a, **k: {'status': 'running'})
            self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'pending')
            row = Generation.objects.get(pk=identifier)
            def unreadable(*a, **k):
                raise magnific.ProviderError('Magnific task completed but returned no output video URL.')
            deps = poller.Dependencies(get_magnific_video=unreadable)
            self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'poll_error')
            row = Generation.objects.get(pk=identifier)
            self.assertEqual(row.status, 'running')
            deps = poller.Dependencies(get_magnific_video=lambda *a, **k: {'status': 'failed', 'error': 'Invalid video'})
            outcome = poller.advance(row, dependencies=deps)
        self.assertEqual(outcome['kind'], 'failed')
        row = Generation.objects.get(pk=identifier)
        self.assertEqual(row.status, 'failed')
        from .serialization import generation_item
        from .failure_copy import UPSCALE_FAILED
        self.assertEqual(generation_item(row)['error'], UPSCALE_FAILED)

    def test_scheduler_leaves_magnific_rows_to_the_leased_worker(self):
        from apps.workers import maintenance
        storage = self.storage()
        identifier = self.queued(storage)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders() as fake:
            executor.process_generation(identifier, heartbeat=False)
            Generation.objects.filter(pk=identifier).update(next_poll_at=0, worker_lease_id=None, worker_lease_until=None)
            before = len(fake.calls)
            with patch('apps.generation.providers.seedance.get_video_task', side_effect=AssertionError('Seedance polled a Magnific task')):
                counts = maintenance.reconcile_videos()
            self.assertEqual((counts['checked'], len(fake.calls)), (0, before), 'the scheduler never touches a Magnific row')
            executor.process_generation(identifier, heartbeat=False)
        self.assertEqual(Generation.objects.get(pk=identifier).status, 'succeeded')
        self.assertTrue(any(call[0] == 'GET' and call[1].startswith('api.magnific.com/v1/ai/video-upscaler/') for call in fake.calls))

    def completed(self, storage):
        identifier = self.queued(storage)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders():
            executor.process_generation(identifier, heartbeat=False)
        return identifier

    def advance_with(self, identifier, storage, save):
        deps = poller.Dependencies(get_magnific_video=lambda *a, **k: {'status': 'succeeded', 'generatedUrl': 'https://cdn-magnific.freepik.com/x.mp4?token=t',
                                                                        'generatedUrls': []}, save_magnific_video=save)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV):
            try:
                return poller.advance(Generation.objects.get(pk=identifier), dependencies=deps)
            finally:
                Generation.objects.filter(pk=identifier).update(next_poll_at=0)

    def test_an_oversized_master_fails_cleanly_instead_of_retrying(self):
        from apps.media.errors import MediaTooLargeError
        storage = self.storage()
        identifier = self.completed(storage)
        def too_large(*args):
            raise MediaTooLargeError('Provider media exceeds the configured download limit.')
        self.assertEqual(self.advance_with(identifier, storage, too_large)['kind'], 'failed')
        row = Generation.objects.get(pk=identifier)
        from .serialization import generation_item
        self.assertIn('larger than 4 GB', generation_item(row)['error'])

    def test_repeated_save_failures_end_the_job_after_three_attempts(self):
        storage = self.storage()
        identifier = self.completed(storage)
        def broken(*args):
            raise IOError('Provider media ended before its declared length.')
        kinds = [self.advance_with(identifier, storage, broken)['kind'] for _ in range(3)]
        self.assertEqual(kinds, ['poll_error', 'poll_error', 'failed'])
        from .serialization import generation_item
        self.assertEqual(generation_item(Generation.objects.get(pk=identifier))['error'], 'The upscaled master could not be downloaded and stored.')

    def test_a_stored_master_is_recorded_even_after_the_job_deadline(self):
        from .services.deadline import Cancellation
        storage = self.storage()
        identifier = self.completed(storage)
        signal = Cancellation(60000)
        def slow(*args):
            signal.deadline = 0  # the job's own budget ran out during the download
            return {'url': '/api/media/generations/x/y.mp4', 'aspectRatio': '16:9'}
        deps = poller.Dependencies(get_magnific_video=lambda *a, **k: {'status': 'succeeded', 'generatedUrl': 'https://cdn-magnific.freepik.com/x.mp4?token=t'},
                                   save_magnific_video=slow)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV):
            outcome = poller.advance_magnific_video(Generation.objects.get(pk=identifier), signal=signal, dependencies=deps)
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertEqual(Generation.objects.get(pk=identifier).url, '/api/media/generations/x/y.mp4')


class StreamingSaveTests(SimpleTestCase):
    """The production save path: SafeMediaFetcher spool -> container check -> upload_stream."""

    def fetcher_class(self, payload, seen):
        import contextlib
        import tempfile as tf
        from apps.media.remote import SafeMediaFetcher

        class Spooling(SafeMediaFetcher):
            @contextlib.contextmanager
            def open_file(self, url, *, max_bytes=None):
                seen.append((url, self.max_bytes, self.total_timeout))
                with tf.TemporaryFile() as spool:
                    spool.write(payload)
                    spool.seek(0)
                    yield spool, 'application/octet-stream'
        return Spooling

    def save(self, payload, ext):
        from testsupport.fake_providers import mp4_bytes  # noqa: F401  (ffmpeg present in the image)
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        storage = StorageService(FileSystemAdapter(directory.name))
        seen = []
        base = self.fetcher_class(payload, seen)(['cdn-magnific.freepik.com'])
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch('apps.generation.services.poller.get_media_fetcher', lambda: base):
            saved = poller.Dependencies().save_magnific_video('https://cdn-magnific.freepik.com/a.' + ext + '?token=t', ext, 'g/1', {'kind': 'video'})
        key = saved['url'][len('/api/media/'):]
        media = storage.open(key)
        try:
            stored = b''.join(media.stream)
        finally:
            media.stream.close()
        return saved, stored, media.content_type, seen

    def test_mp4_master_streams_with_the_raised_cap_and_keeps_its_bytes(self):
        from testsupport.fake_providers import mp4_bytes
        data = mp4_bytes()
        saved, stored, content_type, seen = self.save(data, 'mp4')
        self.assertEqual((stored, content_type), (data, 'video/mp4'))
        self.assertEqual(seen[0][1:], (poller.MAGNIFIC_VIDEO_MAX_BYTES, poller.MAGNIFIC_VIDEO_DOWNLOAD_SECONDS))
        self.assertEqual(saved['aspectRatio'], '16:9')

    def test_prores_mov_master_must_be_a_real_quicktime_container(self):
        from testsupport.fake_providers import mov_bytes, mp4_bytes
        data = mov_bytes()
        _, stored, content_type, _ = self.save(data, 'mov')
        self.assertEqual((stored, content_type), (data, 'video/quicktime'))
        with self.assertRaises(ValueError):
            self.save(mp4_bytes(), 'mov')  # an ISO MP4 labelled .mov is refused, never stored as the master


class ProbeTests(SimpleTestCase):
    def test_probe_reads_local_files_and_signed_reads(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        storage = StorageService(FileSystemAdapter(directory.name))
        storage.primary.put('uploads/a/b.mp4', clip(seconds=2, rate=24), 'video/mp4', 'private')
        meta = inspect_video_source('/api/media/uploads/a/b.mp4', storage=storage)
        self.assertEqual((meta['fps'], meta['width'], meta['height']), (24, 160, 90))
        self.assertAlmostEqual(meta['durationSeconds'], 2, delta=.1)
        seen = []
        class Remote:
            primary = object()
            def signed_read_url(self, key, seconds, *, actor_id=None):
                seen.append((key, seconds))
                return 'https://storage.example/' + key
        def run(command, **kwargs):
            seen.append(command[-1])
            raise subprocess.CalledProcessError(1, command)
        with self.assertRaises(InvalidUpscaleRequest):
            inspect_video_source('/api/media/generations/x.mp4', storage=Remote(), run=run)
        self.assertEqual(seen, [('generations/x.mp4', 600), 'https://storage.example/generations/x.mp4'])
