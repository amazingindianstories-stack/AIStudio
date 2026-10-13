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
