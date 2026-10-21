"""Gallery HTTP lifecycle through durable uploads and scheduler command."""
import hashlib
import json
import os
from pathlib import Path
from unittest.mock import patch

from django.apps import apps
from django.test import override_settings
from testsupport.fake_providers import FakeProviders
from .support import ParityCase


class PortraitGalleryParityTests(ParityCase):
    def setUp(self):
        super().setUp()
        import tempfile
        directory = tempfile.TemporaryDirectory(prefix='parity-portraits-')
        self.addCleanup(directory.cleanup)
        self.enterContext(override_settings(VEEVEE_MANAGED_PORTRAITS=True, PUBLIC_APP_URL='https://fixture.invalid',
            VEEVEE_MEDIA_STORAGE=None, VEEVEE_MEDIA_CONFIG={'backend': 'filesystem', 'root': directory.name}))
        self.enterContext(patch.dict(os.environ, {'BYTEPLUS_ACCESS_KEY_ID': 'fake',
            'BYTEPLUS_SECRET_ACCESS_KEY': 'fake', 'MOCK_ASSET_PROVIDER': '0'}))
        self.fake = self.enterContext(FakeProviders(asset_activation_polls=1))

    def scheduler(self):
        # Real scheduler leases last three seconds; release only this test's
        # scheduler slots to make the next commanded tick deterministic.
        apps.get_model('admin_dashboard', 'AppSetting').objects.filter(key__startswith='lease:scheduler:').delete()
        return self.command('run_scheduler', '--once')

    def test_gallery_upload_register_list_rename_delete(self):
        self.assertEqual(self.client.get('/api/portraits').json(), {'enabled': True, 'portraits': [], 'next': None})
        source = (Path(__file__).resolve().parents[1] / 'testsupport/data/face_public_domain.jpg').read_bytes()
        import io
        from PIL import Image
        buffer = io.BytesIO()
        Image.open(io.BytesIO(source)).convert('RGB').resize((640, 640)).save(buffer, format='JPEG')
        data = buffer.getvalue()
        response = self.post('/api/uploads/init', {'purpose': 'portrait', 'contentType': 'image/jpeg',
            'byteSize': len(data), 'filename': 'portrait.jpg', 'sha256': hashlib.sha256(data).hexdigest()})
        self.assertEqual(response.status_code, 200, response.content)
        upload = response.json()
        response = self.client.put(upload['uploadUrl'], data, content_type='image/jpeg',
                                   HTTP_CONTENT_RANGE=f'bytes 0-{len(data)-1}/{len(data)}')
        self.assertIn(response.status_code, (200, 201), response.content)
        response = self.post(f'/api/uploads/{upload["uploadId"]}/finalize')
        self.assertEqual(response.status_code, 200, response.content)
        response = self.post('/api/portraits', {'uploads': [{'referenceId': upload['uploadId'], 'name': 'Fixture Face'}]})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertTrue(response.json()['results'][0]['ok'], response.content)
        reports = [self.scheduler(), self.scheduler()]
        portraits = self.client.get('/api/portraits').json()['portraits']
        self.assertEqual(len(portraits), 1, {'portraits': portraits, 'reports': reports, 'rows': list(apps.get_model('assets', 'ManagedPortraitAsset').objects.values()), 'calls': self.fake.calls})
        portrait = portraits[0]
        self.assertEqual((portrait['name'], portrait['state']), ('Fixture Face', 'ready'))
        identifier = portrait['id']
        response = self.client.patch('/api/portraits/' + identifier, {'name': 'Renamed Face'}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(self.client.get('/api/portraits').json()['portraits'][0]['name'], 'Renamed Face')
        response = self.post('/api/portraits/delete', {'ids': [identifier]})
        self.assertEqual(response.status_code, 200, response.content)
        self.scheduler()
        self.assertEqual(self.client.get('/api/portraits').json()['portraits'], [])
        self.assertEqual(apps.get_model('assets', 'ManagedPortraitAsset').objects.get(pk=identifier).status, 'DELETED')
        self.assertTrue(any('Action=CreateAsset&' in url for _, url in self.fake.calls), self.fake.calls)
        self.assertTrue(any('Action=DeleteAsset&' in url for _, url in self.fake.calls), self.fake.calls)

    def test_managed_mode_tombstones_legacy_routes_and_flag_off_disables_gallery(self):
        for path in ('/api/assets/portraits', '/api/assets/portraits/upload',
                     '/api/assets/portraits/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/assets'):
            for method in ('GET', 'POST', 'PATCH', 'DELETE'):
                response = self.client.generic(method, path, b'{}', content_type='application/json')
                self.assertEqual((response.status_code, response.json()['error']), (410, 'PORTRAITS_ARE_AUTOMATIC'))
        with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
            self.assertEqual(self.client.get('/api/portraits').json(), {'enabled': False, 'portraits': [], 'next': None})
            self.assertEqual(self.post('/api/portraits').json(), {'error': 'PORTRAITS_DISABLED', 'code': 'PORTRAITS_DISABLED', 'message': 'Portraits are not available.'})
            self.assertEqual(self.post('/api/portraits').status_code, 404)


class LegacyPortraitParityTests(ParityCase):
    def fixture(self, status='Active'):
        group = apps.get_model('assets', 'PortraitGroup').objects.create(name='Fixture',
            byteplus_group_id='group-fixture', created_at=1, updated_at=1)
        asset = apps.get_model('assets', 'PortraitAsset').objects.create(group=group, name='Face',
            image_url='/api/media/uploads/portrait/fixture', byteplus_asset_id='asset-fixture',
            status=status, created_at=1, updated_at=1)
        return group, asset

    def test_legacy_presence_list_and_remote_first_delete_tombstone(self):
        group, asset = self.fixture()
        result = self.scenario('legacy_portraits', {'VEEVEE_RUNTIME_COMPONENT': 'api',
            'VEEVEE_PORTRAIT_LIFECYCLE': '1', 'VEEVEE_MANAGED_PORTRAITS': '0',
            'MOCK_ASSET_PROVIDER': '0', 'BYTEPLUS_ACCESS_KEY_ID': 'fake', 'BYTEPLUS_SECRET_ACCESS_KEY': 'fake'},
            asset=str(asset.id), group=str(group.id))
        self.assertEqual(result['delete'][0], 200, result)
        self.assertEqual(result['remote_status'], 'Deleted')
        asset.refresh_from_db()
        self.assertEqual(asset.status, 'PreviewDeleted')
        text = json.dumps(result['listing'])
        self.assertIn('"remoteVerification": "active"', text)
        self.assertNotIn(str(asset.id), json.dumps(result['after']))
        self.assertTrue(any('Action=GetAsset&' in url for _, url in result['calls']))
        self.assertTrue(any('Action=DeleteAsset&' in url for _, url in result['calls']))
