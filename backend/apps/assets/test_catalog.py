from unittest.mock import patch
from uuid import uuid4
from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests
from apps.common.models import ActivityLog
from .models import Asset


class CatalogTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def save(self, body):
        return self.client.post('/api/assets', body, content_type='application/json')

    def test_auth_validation_first_image_and_reserved_slug(self):
        self.assertEqual(self.save({}).status_code, 401)
        self.cookie()
        for body, message in [({}, 'Name is required.'), ({'name': 'Ref'}, 'Invalid asset kind.'),
                              ({'name': 'Ref', 'kind': 'style'}, 'A reference image is required for this material.')]:
            self.assertEqual(self.save(body).json(), {'error': message})
        response = self.save({'name': 'img1', 'kind': 'style', 'images': [' /api/media/assets/a.png ', '/api/media/assets/b.png']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['slug'], 'asset-img1')
        self.assertEqual(response.json()['images'], ['/api/media/assets/a.png'])
        self.assertNotIn('projectId', response.json())
        self.assertNotIn('description', response.json())
        self.assertEqual(ActivityLog.objects.get(action='create_asset').detail['slug'], 'asset-img1')

    def test_edit_retains_slug_created_time_and_images_when_omitted(self):
        self.cookie()
        original = self.save({'name': 'One', 'kind': 'character', 'imageUrl': '/api/media/assets/one.png'}).json()
        response = self.save({'id': original['id'], 'name': 'Renamed', 'kind': 'character'})
        self.assertEqual(response.json()['images'], original['images'])
        self.assertEqual(response.json()['slug'], 'one')
        self.assertEqual(response.json()['createdAt'], original['createdAt'])

    def test_scope_collision_and_upload_cleanup(self):
        self.cookie()
        project_a, project_b = str(uuid4()), str(uuid4())
        base = {'name': 'Same', 'kind': 'prop', 'images': ['/api/media/assets/old.png'], 'projectId': project_a}
        first = self.save(base).json()
        second = self.save(base).json()
        third = self.save({**base, 'projectId': project_b}).json()
        self.assertEqual([first['slug'], second['slug'], third['slug']], ['same', 'same-2', 'same'])
        with patch('apps.media.images.save_asset_image', return_value='/api/media/assets/new.png') as save, \
             patch('apps.media.images.delete_asset_image') as delete:
            response = self.save({**base, 'id': first['id'], 'images': ['data:image/png;base64,YWJj']})
        self.assertEqual(response.json()['images'], ['/api/media/assets/new.png'])
        save.assert_called_once()
        delete.assert_called_once_with('/api/media/assets/old.png')

    def test_delete_missing_is_idempotent_and_removes_saved_media(self):
        self.cookie()
        self.assertEqual(self.client.delete('/api/assets').status_code, 400)
        self.assertEqual(self.client.delete('/api/assets?id=' + str(uuid4())).json(), {'ok': True})
        asset = self.save({'name': 'Remove', 'kind': 'outfit', 'images': ['/api/media/assets/a.png']}).json()
        with patch('apps.media.images.delete_asset_image') as delete:
            response = self.client.delete('/api/assets?id=' + asset['id'])
        self.assertEqual(response.status_code, 200)
        delete.assert_called_once_with('/api/media/assets/a.png')
        self.assertFalse(Asset.objects.filter(pk=asset['id']).exists())
