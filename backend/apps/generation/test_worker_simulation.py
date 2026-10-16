"""End-to-end: API enqueue → real worker → fake provider network → stored result.

Release gate: every provider path runs the production code (real Dependencies,
adapters, persistence, naming) with only the network faked. A missing import,
a wrong payload builder or a broken persistence step fails here, not in
production.
"""
import os
import uuid
from unittest.mock import patch
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.library.models import GenerationNaming
from apps.media.storage import MemoryAdapter, StorageService
from testsupport.fake_providers import FakeProviders
from .models import Generation
from .services import executor

ENV = {'ARK_API_KEY': 'fake-ark-key', 'GOOGLE_API_KEY': 'fake-google-key', 'MOCK_GENERATION': '0', 'MOCK_ASSET_PROVIDER': '0'}


class WorkerSimulationTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def run_case(self, kind, payload, *, polls=0):
        # Real users always work inside a project that has material assets; the
        # worker's asset lookup only runs there (the 2026-10-13 regression).
        from apps.assets.models import Asset
        from apps.projects.models import Project
        self.cookie()
        project = Project.objects.create(id=uuid.uuid4(), name='Simulation', created_at=1, updated_at=1)
        Asset.objects.create(id=uuid.uuid4(), kind='character', name='Sati', slug='sati', images=[], project_id=project.id, created_at=1, updated_at=1)
        payload = {**payload, 'projectId': str(project.id)}
        storage = StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders() as fake:
            response = self.client.post('/api/generate/' + kind, payload, content_type='application/json',
                                        HTTP_IDEMPOTENCY_KEY='sim-' + uuid.uuid4().hex)
            self.assertEqual(response.status_code, 200, response.content)
            identifier = response.json()['id']
            first = executor.process_generation(identifier, heartbeat=False)
            for _ in range(polls):
                Generation.objects.filter(pk=identifier).update(next_poll_at=0)
                executor.process_generation(identifier, heartbeat=False)
            row = Generation.objects.get(pk=identifier)
        return row, first, fake, storage

    def assert_stored(self, row, storage, content_type_prefix):
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertTrue(row.url and row.url.startswith('/api/media/'), row.url)
        key = row.url[len('/api/media/'):]
        data, content_type = storage.primary.objects[key][:2]
        self.assertTrue(content_type.startswith(content_type_prefix), content_type)
        self.assertGreater(len(data), 100)
        self.assertTrue(GenerationNaming.objects.filter(generation_id=row.id).exists())

    def test_nano_banana_pro_image(self):
        row, _, fake, storage = self.run_case('image', {'prompt': 'a quiet courtyard at dawn', 'model': 'Nano Banana Pro', 'aspectRatio': '1:1'})
        self.assert_stored(row, storage, 'image/')
        self.assertTrue(any('generateContent' in call[1] for call in fake.calls), fake.calls)
        self.assertEqual([model for model, _ in fake.gemini_payloads], ['gemini-3-pro-image'])

    def test_nano_banana_2_1_image_posts_once_to_its_own_model_code(self):
        row, _, fake, storage = self.run_case('image', {'prompt': 'a quiet courtyard at dawn', 'model': 'Nano Banana 2.1',
                                                        'aspectRatio': '4:5', 'resolution': '4K', 'seed': 11})
        self.assert_stored(row, storage, 'image/')
        # The stored ratio is measured from the master (the fake returns a 64x48 PNG).
        self.assertEqual((row.model, row.resolution, row.aspect_ratio, row.seed, row.cost_cents, row.cost_basis),
                         ('Nano Banana 2.1', '4K', '4:3', 11, 12, 'estimated'))
        posts = [call for call in fake.calls if call[0] == 'POST' and call[1].endswith(':generateContent')]
        self.assertEqual(posts, [('POST', 'generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent')])
        [(model, body)] = fake.gemini_payloads
        self.assertEqual(model, 'gemini-nano-banana-2.1')
        self.assertEqual(body['generationConfig'], {'responseModalities': ['TEXT', 'IMAGE'], 'imageConfig': {'aspectRatio': '4:5', 'imageSize': '4K'}, 'seed': 11})

    def test_seedream_image(self):
        row, _, fake, storage = self.run_case('image', {'prompt': 'a quiet courtyard at dawn', 'model': 'Seedream 5.0 Pro', 'aspectRatio': '1:1', 'resolution': '2K'})
        self.assert_stored(row, storage, 'image/')
        self.assertIn(('POST', 'ark.ap-southeast.bytepluses.com/api/v3/images/generations'), fake.calls)
        self.assertEqual(sum(1 for call in fake.calls if call[1].endswith('/images/generations')), 1, 'exactly one paid submission')

    def test_seedance_draft_video_submit_poll_and_native_mov(self):
        row, first, fake, storage = self.run_case('video', {'prompt': 'a slow pan across a candle-lit hall', 'model': 'Seedance 2.5',
                                                            'resolution': '480p', 'draftMode': True, 'duration': 5}, polls=1)
        self.assert_stored(row, storage, 'video/quicktime')
        self.assertTrue(row.url.endswith('.mov'), row.url)
        self.assertEqual(row.task_id, 'cgt-sim-1')
        posts = [call for call in fake.calls if call[0] == 'POST' and call[1].endswith('/contents/generations/tasks')]
        self.assertEqual(len(posts), 1, 'exactly one paid submission')

    def test_unexpected_hosts_fail_closed(self):
        from apps.generation.providers.transport import HttpTransport
        with FakeProviders():
            with self.assertRaises(AssertionError):
                HttpTransport(allowed_hosts=['api.example.invalid']).request('GET', 'https://api.example.invalid/x')

    def test_seedance_2_0_video(self):
        row, _, fake, storage = self.run_case('video', {'prompt': 'a slow pan across a candle-lit hall', 'model': 'Seedance 2.0',
                                                        'resolution': '720p', 'duration': 5}, polls=1)
        self.assert_stored(row, storage, 'video/')

    def test_draft_finalize_submits_once_and_stores_native_mov(self):
        row, _, fake, storage = self.run_case('video', {'prompt': 'a slow pan across a candle-lit hall', 'model': 'Seedance 2.5',
                                                        'resolution': '480p', 'draftMode': True, 'duration': 5}, polls=1)
        self.assertEqual(row.status, 'succeeded', row.error)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders() as fake:
            response = self.client.post('/api/generate/video/finalize', {'sourceGenerationId': str(row.id)}, content_type='application/json')
            self.assertEqual(response.status_code, 200, response.content)
            final_id = response.json()['id']
            executor.process_generation(final_id, heartbeat=False)
            Generation.objects.filter(pk=final_id).update(next_poll_at=0)
            executor.process_generation(final_id, heartbeat=False)
            final = Generation.objects.get(pk=final_id)
        self.assertEqual(final.draft_task_id, row.task_id)
        self.assert_stored(final, storage, 'video/quicktime')
        posts = [call for call in fake.calls if call[0] == 'POST' and call[1].endswith('/contents/generations/tasks')]
        self.assertEqual(len(posts), 1, 'the final is one paid submission')


MAGNIFIC_ENV = {**ENV, 'MAGNIFIC_API_KEY': 'fake-magnific-key'}


@override_settings(PUBLIC_APP_URL='https://veevee.test')
class MagnificWorkerSimulationTests(TransactionTestCase):
    """Upscale enqueue → real worker → fake Magnific + CDN → stored master."""
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def storage(self):
        import tempfile
        from apps.media.storage import FileSystemAdapter
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        return StorageService(FileSystemAdapter(directory.name))

    def run_upscale(self, payload, storage, *, polls=1):
        self.cookie()
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, MAGNIFIC_ENV), FakeProviders() as fake:
            response = self.client.post('/api/generate/upscale', payload, content_type='application/json')
            self.assertEqual(response.status_code, 200, response.content)
            identifier = response.json()['id']
            executor.process_generation(identifier, heartbeat=False)
            for _ in range(polls):
                Generation.objects.filter(pk=identifier).update(next_poll_at=0)
                executor.process_generation(identifier, heartbeat=False)
            return Generation.objects.get(pk=identifier), response.json(), fake

    def stored(self, storage, row):
        key = row.url[len('/api/media/'):]
        media = storage.open(key)
        try:
            return b''.join(media.stream), media.content_type
        finally:
            media.stream.close()

    def source_video(self, storage, data):
        key = f'generations/{uuid.uuid4()}.mp4'
        storage.primary.put(key, data, 'video/mp4', 'public, max-age=31536000, immutable')
        return '/api/media/' + key

    def test_image_upscale_precision_v2(self):
        from testsupport.fake_providers import png_bytes
        import base64
        storage = self.storage()
        payload = {'image': 'data:image/png;base64,' + base64.b64encode(png_bytes()).decode(), 'model': 'Magnific Precision V2',
                   'params': {'model': 'Magnific Precision V2', 'filterNsfw': False, 'scaleFactor': '2x', 'flavor': 'photo',
                              'sharpen': 7, 'smartGrain': 7, 'ultraDetail': 30}}
        row, _, fake = self.run_upscale(payload, storage)
        self.assertEqual(row.status, 'succeeded', row.error)
        data, content_type = self.stored(storage, row)
        self.assertEqual(content_type, 'image/png')
        self.assertEqual(data[:8], b'\x89PNG\r\n\x1a\n')
        posts = [call for call in fake.calls if call[0] == 'POST']
        self.assertEqual(posts, [('POST', 'api.magnific.com/v1/ai/image-upscaler-precision-v2')], 'exactly one paid submission')

    def video_payload(self, source, model='Magnific Video Creative', **params):
        defaults = {'Magnific Video Creative': {'resolution': '2k', 'creativity': 0, 'sharpen': 0, 'smartGrain': 0, 'fpsBoost': False, 'flavor': 'vivid', 'outputFormat': 'h264'},
                    'Magnific Video Creative Turbo': {'resolution': '1k', 'creativity': 10, 'sharpen': 5, 'smartGrain': 5, 'fpsBoost': True, 'flavor': 'natural', 'outputFormat': 'h264'},
                    'Magnific Video Precision': {'resolution': '4k', 'sharpen': 0, 'smartGrain': 0, 'strength': 60, 'fpsBoost': False, 'outputFormat': 'h264'},
                    'Magnific Video Topaz': {'resolution': '2k', 'enhancementModel': 'starlight_precise_2_5', 'targetFps': 30, 'frameInterpolation': 'apollo', 'noise': 0}}
        return {'video': source, 'model': model, 'params': {'model': model, **defaults[model], **params}}

    def test_every_video_model_submits_once_to_its_endpoint_and_stores_the_mp4(self):
        from testsupport.fake_providers import mp4_bytes
        endpoints = {'Magnific Video Creative': '/v1/ai/video-upscaler', 'Magnific Video Creative Turbo': '/v1/ai/video-upscaler/turbo',
                     'Magnific Video Precision': '/v1/ai/video-upscaler-precision', 'Magnific Video Topaz': '/v1/ai/video-upscaler-topaz'}
        for model, endpoint in endpoints.items():
            with self.subTest(model=model):
                storage = self.storage()
                source = self.source_video(storage, mp4_bytes())
                row, item, fake = self.run_upscale(self.video_payload(source, model), storage)
                self.assertEqual((item['kind'], item['model'], row.kind), ('video', model, 'video'))
                self.assertEqual(row.status, 'succeeded', row.error)
                self.assertTrue(row.url.endswith('.mp4'), row.url)
                data, content_type = self.stored(storage, row)
                self.assertEqual(content_type, 'video/mp4')
                self.assertEqual(data[4:8], b'ftyp')
                posts = [call for call in fake.calls if call[0] == 'POST']
                self.assertEqual(posts, [('POST', 'api.magnific.com' + endpoint)], 'exactly one paid submission')
                body = next(iter(fake.magnific_tasks.values()))['body']
                self.assertTrue(body['video'].startswith('https://veevee.test/api/media-grant?t='), 'a signed read, never the app media path')
                self.assertEqual(row.submission_input['source'], source)
                self.assertEqual(row.reference_videos, [source])
                self.assertGreater(row.cost_cents, 0)

    def test_prores_keeps_the_native_mov_master_not_the_preview(self):
        from testsupport.fake_providers import mp4_bytes
        storage = self.storage()
        source = self.source_video(storage, mp4_bytes())
        row, _, fake = self.run_upscale(self.video_payload(source, outputFormat='prores_422_hq'), storage)
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertTrue(row.url.endswith('.mov'), row.url)
        data, content_type = self.stored(storage, row)
        self.assertEqual(content_type, 'video/quicktime')
        self.assertEqual(data, fake.mov, 'master bytes preserved exactly')
        self.assertFalse(any(call[0] == 'FETCH' and 'preview' in call[1] for call in fake.calls))
