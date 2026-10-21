"""Real component entrypoint, fake providers, disposable DB and graceful SIGTERM."""
import tempfile
from pathlib import Path
from django.apps import apps
from django.test import override_settings
from .support import ParityCase


class WorkerLoopParityTests(ParityCase):
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory(prefix='parity-worker-')
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.flags = {'VEEVEE_MEDIA_BACKEND': 'filesystem', 'VEEVEE_MEDIA_ROOT': str(self.root),
            'MOCK_GENERATION': '0', 'MOCK_ASSET_PROVIDER': '0', 'ARK_API_KEY': 'fake-ark',
            'GOOGLE_API_KEY': 'fake-google', 'VEEVEE_MANAGED_PORTRAITS': '0'}
        self.enterContext(override_settings(VEEVEE_MEDIA_STORAGE=None,
            VEEVEE_MEDIA_CONFIG={'backend': 'filesystem', 'root': str(self.root)}))

    def test_generation_entrypoint_reaches_loop_executes_fake_provider_and_stops(self):
        response = self.post('/api/generate/image', {'prompt': 'A quiet garden', 'model': 'Nano Banana Pro', 'resolution': '1K'})
        self.assertEqual(response.status_code, 200, response.content)
        identifier = response.json()['id']
        result = self.scenario('worker_loop', self.flags, component='generation', identifier=identifier)
        self.assertEqual(result, {'exit': 0, 'observed': True})
        row = apps.get_model('generation', 'Generation').objects.get(pk=identifier)
        self.assertEqual(row.status, 'succeeded')
        response = self.client.get(f'/api/generations/{identifier}/download')
        self.assertEqual(response.status_code, 200)
        self.assertIn('unsorted_0001.png', response['Content-Disposition'])
        self.assertTrue(b''.join(response.streaming_content).startswith(b'\x89PNG'))
        response.close()

    def test_export_entrypoint_reaches_loop_builds_archive_and_stops(self):
        path = self.root / 'objects/generated/master.mov'
        path.parent.mkdir(parents=True)
        data = b'\x00\x00\x00\x14ftypqt  original bytes'
        path.write_bytes(data)
        row = apps.get_model('generation', 'Generation').objects.create(kind='video', model='fixture', prompt='',
            aspect_ratio='1:1', status='completed', url='/api/media/generated/master.mov', created_at=1, updated_at=1)
        identifier = self.post('/api/history/exports').json()['id']
        self.assertEqual(self.post(f'/api/history/exports/{identifier}/items', {'ids': [str(row.id)]}).status_code, 200)
        self.assertEqual(self.post(f'/api/history/exports/{identifier}/finalize').status_code, 200)
        result = self.scenario('worker_loop', self.flags, component='export', identifier=identifier)
        self.assertEqual(result, {'exit': 0, 'observed': True})

    def test_scheduler_entrypoint_reaches_maintenance_loop_and_stops(self):
        result = self.scenario('worker_loop', {**self.flags, 'VEEVEE_LEASE_PREFIX': 'lease:g4preview:parity:'}, component='scheduler')
        self.assertEqual(result, {'exit': 0, 'observed': True})

        self.assertTrue(apps.get_model('admin_dashboard', 'AppSetting').objects.filter(key='lease:g4preview:parity:scheduler:depth').exists())
        self.assertFalse(apps.get_model('admin_dashboard', 'AppSetting').objects.filter(key='lease:scheduler:depth').exists())

    def test_operational_command_names_keep_safe_report_modes(self):
        self.assertEqual(self.command('cleanup_uploads'), '0\n')
        result = self.scenario('command', {**self.flags, 'BYTEPLUS_ACCESS_KEY_ID': 'fake',
            'BYTEPLUS_SECRET_ACCESS_KEY': 'fake'}, name='portraits_cutover')
        self.assertIn('dry', result['output'].lower())
        self.assertIn('Report only.', self.command('managed_portraits_rollback'))

    def test_worker_private_naming_seeds_canonical_without_advancing_it(self):
        response = self.post('/api/generate/image', {'prompt': 'A garden', 'model': 'Nano Banana Pro'})
        self.assertEqual(response.status_code, 200)
        identifier = response.json()['id']
        apps.get_model('library', 'GenerationNaming').objects.filter(generation_id=identifier).delete()
        counter = apps.get_model('library', 'NamingCounter')
        counter.objects.filter(namespace='global_unsorted').update(next_sequence=41)
        result = self.scenario('worker_loop', {**self.flags, 'VEEVEE_NAMING_PREFIX': 'g4preview:parity:'},
            component='generation', identifier=identifier)
        self.assertEqual(result, {'exit': 0, 'observed': True})
        self.assertEqual(counter.objects.get(namespace='global_unsorted').next_sequence, 41)
        self.assertEqual(counter.objects.get(namespace='g4preview:parity:global_unsorted').next_sequence, 42)
        response = self.client.get(f'/api/generations/{identifier}/download')
        self.assertEqual(response.status_code, 200)
        self.assertIn('unsorted_0041.png', response['Content-Disposition'])
        response.close()

    def test_seedance_draft_requests_native_mov_and_download_preserves_master(self):
        import base64
        result = self.scenario('video_master', {**self.flags, 'VEEVEE_RUNTIME_COMPONENT': 'generation'})
        self.assertEqual(result['status'], 'succeeded', result)
        self.assertEqual(result['formats'], ['mov'])
        self.assertTrue(result['url'].endswith('.mov'))
        response = self.client.get('/api/generations/' + result['id'] + '/download')
        self.assertEqual(response.status_code, 200)
        self.assertIn('unsorted_0001.mov', response['Content-Disposition'])
        self.assertEqual(response['Content-Type'], 'video/quicktime')
        self.assertEqual(b''.join(response.streaming_content), base64.b64decode(result['master']))
        response.close()
