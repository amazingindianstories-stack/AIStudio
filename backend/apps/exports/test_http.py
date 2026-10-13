import uuid
from unittest.mock import patch
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.generation.models import Generation
from apps.library.services.idempotency import now_ms
from apps.media.storage import StorageService, MemoryAdapter
from .models import MediaExport, MediaExportItem
from . import services


@override_settings(ROOT_URLCONF='apps.exports.urls', EXPORT_WORKER_SECRET='local-worker-secret')
class ExportHTTPTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = SettingsTests.setUp
    actor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

    def post(self, path, body=None, **headers):
        return self.client.post(path, body or {}, content_type='application/json', **headers)

    def fixture(self):
        generation = Generation.objects.create(kind='video', status='completed', model='fixture', prompt='', aspect_ratio='1:1', url='/api/media/native.mov', created_at=1, updated_at=1)
        job = services.create_export(self.actor)
        services.append_items(job['id'], self.actor, [str(generation.id)])
        return services.finalize_export(job['id'], self.actor), generation

    def test_auth_and_owned_status_exact_shape(self):
        self.assertEqual(self.post('/api/history/exports').status_code, 401)
        self.cookie()
        made = self.post('/api/history/exports')
        self.assertEqual(made.status_code, 201)
        identifier = made.json()['id']
        self.assertEqual(made.json()['status'], 'draft')
        self.assertEqual(self.client.get('/api/history/exports/' + identifier).json(), {
            'id': identifier, 'status': 'draft', 'totalItems': 0, 'processedItems': 0,
            'skippedItems': 0, 'warnings': [], 'error': None, 'expiresAt': None,
            'complete': False, 'retryable': False, 'nextAction': 'finalize'})
        other = services.create_export(uuid.uuid4())
        self.assertEqual(self.client.get('/api/history/exports/' + other['id']).status_code, 404)
        self.assertEqual(self.post('/api/history/exports/' + other['id'] + '/finalize').status_code, 409)

    def test_append_validation_ownership_and_not_draft(self):
        self.cookie()
        job, generation = self.fixture()
        path = f'/api/history/exports/{job.id}/items'
        self.assertEqual(self.post(path, {'ids': []}).json(), {'error': 'INVALID_EXPORT_ITEMS'})
        response = self.post(path, {'ids': [str(generation.id)]})
        self.assertEqual((response.status_code, response.json()), (409, {'error': 'EXPORT_NOT_DRAFT'}))
        other = services.create_export(uuid.uuid4())
        response = self.post(f'/api/history/exports/{other["id"]}/items', {'ids': [str(generation.id)]})
        self.assertEqual((response.status_code, response.json()), (404, {'error': 'EXPORT_NOT_FOUND'}))
        new = self.post('/api/history/exports').json()
        append = self.post(f'/api/history/exports/{new["id"]}/items', {'ids': [str(generation.id)]})
        self.assertEqual(append.json(), {'accepted': 1, 'totalItems': 1, 'rejected': []})
        self.assertEqual(self.post(f'/api/history/exports/{new["id"]}/finalize').json(), {'id': new['id'], 'status': 'queued'})

    def test_stored_worker_diagnostics_remain_private_in_status(self):
        self.cookie()
        job = services.create_export(self.actor)
        for state,message in (('failed','Export failed.'),('queued','Export encountered an error; retry is pending.')):
            with self.subTest(state=state):
                MediaExport.objects.filter(pk=job['id']).update(status=state,error='private-fixture-token')
                response = self.client.get('/api/history/exports/'+job['id'])
                self.assertEqual(response.status_code,200)
                self.assertEqual(response.json()['error'],message)
                self.assertNotIn('private-fixture-token',response.content.decode())
                self.assertEqual(MediaExport.objects.get(pk=job['id']).error,'private-fixture-token')

    def test_finalize_duplicate_leaf_names_succeeds(self):
        self.cookie()
        job = services.create_export(self.actor)
        rows = [Generation.objects.create(kind='image', status='done', model='fixture', prompt='', aspect_ratio='1:1', url='/api/media/a.png', created_at=1, updated_at=1) for _ in range(2)]
        services.append_items(job['id'], self.actor, [str(row.id) for row in rows])
        response = self.post(f'/api/history/exports/{job["id"]}/finalize')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(MediaExport.objects.get(pk=job['id']).manifest_version, 3)
        paths = list(MediaExportItem.objects.filter(export_id=job['id']).values_list('filename', flat=True))
        self.assertEqual(len(set(paths)), 2)

    def test_download_not_ready_expired_and_five_minute_grant(self):
        self.cookie()
        job, _ = self.fixture()
        path = f'/api/history/exports/{job.id}/download'
        self.assertEqual(self.client.get(path).json(), {'error': 'NOT_READY'})
        MediaExport.objects.filter(pk=job.id).update(status='ready', output_key='exports/archive.zip', expires_at=1)
        self.assertEqual(self.client.get(path).status_code, 410)
        MediaExport.objects.filter(pk=job.id).update(expires_at=now_ms() + 60000)
        with patch('apps.exports.views.get_storage') as storage:
            storage.return_value.signed_export_download_url.return_value = 'https://storage.invalid/read/private.zip?grant=fixture'
            response = self.client.get(path)
            self.assertEqual((response.status_code, response['Location']), (307, 'https://storage.invalid/read/private.zip?grant=fixture'))
            storage.return_value.signed_export_download_url.assert_called_once_with('exports/archive.zip', 'Veevee_Assets_' + __import__('datetime').datetime.fromtimestamp(job.created_at / 1000, __import__('datetime').timezone.utc).strftime('%Y-%m-%d') + '.zip')
            self.assertEqual(response['Cache-Control'], 'private, no-store')

    def test_worker_access_secret_lease_item_and_action_guards(self):
        job, generation = self.fixture()
        self.assertEqual(self.post('/api/worker/exports/access').json(), {'error': 'FORBIDDEN'})
        secret = {'HTTP_X_EXPORT_WORKER_SECRET': 'local-worker-secret'}
        body = {'exportId': str(job.id), 'owner': 'worker', 'action': 'source', 'generationId': str(generation.id)}
        self.assertEqual(self.post('/api/worker/exports/access', body, **secret).json(), {'error': 'LEASE_LOST'})
        services.claim_export('worker')
        with override_settings(GENERATION_WORKER_SECRET='old-generation-secret'), patch('apps.exports.views.get_storage') as blocked:
            old=self.post('/api/worker/exports/access',body,HTTP_X_GENERATION_WORKER_SECRET='old-generation-secret')
            self.assertEqual(old.status_code,403)
            blocked.assert_not_called()
        with patch('apps.exports.views.get_storage') as storage:
            storage.return_value.signed_read_url.return_value = 'https://storage.invalid/source'
            response = self.post('/api/worker/exports/access', body, **secret)
            self.assertEqual(response.json(), {'url': 'https://storage.invalid/source'})
            storage.return_value.signed_read_url.assert_called_once_with('native.mov', 900)
            response = self.post('/api/worker/exports/access', {**body, 'generationId': str(uuid.uuid4())}, **secret)
            self.assertEqual((response.status_code, response.json()), (404, {'error': 'ITEM_NOT_FOUND'}))
            storage.return_value.create_resumable_upload_session.return_value = 'https://storage.invalid/upload'
            response = self.post('/api/worker/exports/access', {**body, 'action': 'upload'}, **secret)
            self.assertTrue(response.json()['key'].startswith(f'exports/{self.actor}/{job.id}/1-legacy-'))
            first_key=response.json()['key']
            next_upload=self.post('/api/worker/exports/access',{**body,'action':'upload'},**secret)
            self.assertNotEqual(first_key,next_upload.json()['key'])
            self.assertTrue(first_key.endswith('.zip'))
        self.assertEqual(self.post('/api/worker/exports/access', {**body, 'action': 'invalid'}, **secret).json(), {'error': 'INVALID_ACTION'})
        self.assertEqual(self.post('/api/worker/exports/access', {**body, 'owner': 'other'}, **secret).status_code, 409)
        MediaExport.objects.filter(pk=job.id).update(lease_until=1)
        self.assertEqual(self.post('/api/worker/exports/access', body, **secret).status_code, 409)

    @override_settings(EXPORT_WORKER_SECRET='')
    def test_worker_access_unconfigured_secret_fails_closed(self):
        self.assertEqual(self.post('/api/worker/exports/access', {}, HTTP_X_EXPORT_WORKER_SECRET='anything').status_code, 403)

    def test_legacy_capability_never_signs_for_stale_owner_expired_or_completed_job(self):
        job, generation = self.fixture()
        services.claim_export('current-owner')
        secret = {'HTTP_X_EXPORT_WORKER_SECRET': 'local-worker-secret'}
        with patch('apps.exports.views.get_storage') as storage, patch('apps.exports.views.now_ms',return_value=5000):
            for action in ('source','upload'):
                body = {'exportId':str(job.id),'owner':'old-owner','action':action,'generationId':str(generation.id)}
                self.assertEqual(self.post('/api/worker/exports/access',body,**secret).status_code,409)
                body['owner'] = 'current-owner'
                MediaExport.objects.filter(pk=job.id).update(lease_until=5000)
                self.assertEqual(self.post('/api/worker/exports/access',body,**secret).status_code,409)
                MediaExport.objects.filter(pk=job.id).update(status='ready',lease_until=10000,output_key='exports/winner.zip')
                self.assertEqual(self.post('/api/worker/exports/access',body,**secret).status_code,409)
                MediaExport.objects.filter(pk=job.id).update(status='running',lease_until=10000)
            storage.assert_not_called()
        self.assertEqual(MediaExport.objects.get(pk=job.id).output_key,'exports/winner.zip')

    def test_local_download_attachment_streams_original_zip_bytes(self):
        self.cookie()
        job, _ = self.fixture()
        import io
        import zipfile
        data = io.BytesIO()
        with zipfile.ZipFile(data, 'w') as archive:
            archive.writestr('Global/Unsorted/unsorted_0001.mov', b'original native MOV')
        original = data.getvalue()
        storage = StorageService(MemoryAdapter())
        storage.primary.put('exports/archive.zip', original, 'application/zip', '')
        MediaExport.objects.filter(id=job.id).update(status='ready', output_key='exports/archive.zip', expires_at=now_ms() + 60000)
        with patch('apps.exports.views.get_storage', return_value=storage), patch.object(storage, 'signed_export_download_url', return_value=None):
            response = self.client.get(f'/api/history/exports/{job.id}/download')
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response['Content-Disposition'].startswith('attachment; filename="Veevee_Assets_'))
            self.assertEqual(response['Cache-Control'], 'private, no-store')
            self.assertEqual(b''.join(response.streaming_content), original)
