from unittest.mock import patch
from uuid import uuid4
from django.test import TransactionTestCase, override_settings
from apps.media.storage import MemoryAdapter, StorageService
from apps.admin_dashboard.tests import SettingsTests, UID
from apps.common.models import ActivityLog
from apps.projects import visibility
from apps.projects.models import Project
from .models import Asset


class CatalogTests(TransactionTestCase):
    def setUp(self):
        SettingsTests.setUp(self)
        override = override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter()))
        override.enable()
        self.addCleanup(override.disable)

    cookie = SettingsTests.cookie

    def save(self, body):
        return self.client.post('/api/assets', body, content_type='application/json')

    def make_asset(self, name, slug, images, project_id=None):
        from apps.common.leases import now_ms
        asset = Asset.objects.create(id=uuid4(), created_by_id=UID, name=name, kind='character', slug=slug, images=images,
                                     project_id=project_id, created_at=now_ms(), updated_at=now_ms())
        from .views import serialize
        return serialize(asset)

    def test_auth_validation_first_image_and_reserved_slug(self):
        self.assertEqual(self.save({}).status_code, 401)
        self.cookie()
        for body, message in [({}, 'Name is required.'), ({'name': 'Ref'}, 'Invalid asset kind.'),
                              ({'name': 'Ref', 'kind': 'style'}, 'A reference image is required for this material.')]:
            self.assertEqual(self.save(body).json(), {'error': message})
        with patch('apps.media.images.save_asset_image', side_effect=['/api/media/assets/a.png', '/api/media/assets/b.png']):
            response = self.save({'name': 'img1', 'kind': 'style', 'images': ['data:image/png;base64,YQ==', 'data:image/png;base64,Yg==']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['slug'], 'asset-img1')
        self.assertEqual(response.json()['images'], ['/api/media/assets/a.png'])
        self.assertNotIn('projectId', response.json())
        self.assertNotIn('description', response.json())
        self.assertEqual(ActivityLog.objects.get(action='create_asset').detail['slug'], 'asset-img1')

    def test_edit_retains_slug_created_time_and_images_when_omitted(self):
        self.cookie()
        original = self.make_asset('One', 'one', ['/api/media/assets/one.png'])
        response = self.save({'id': original['id'], 'name': 'Renamed', 'kind': 'character'})
        self.assertEqual(response.json()['images'], original['images'])
        self.assertEqual(response.json()['slug'], 'one')
        self.assertEqual(response.json()['createdAt'], original['createdAt'])

    def test_scope_collision_and_upload_cleanup(self):
        self.cookie()
        project_a, project_b = (str(Project.objects.create(name=n, created_at=1, updated_at=1).id) for n in 'ab')
        base = {'name': 'Same', 'kind': 'prop', 'images': ['data:image/png;base64,YQ=='], 'projectId': project_a}
        with patch('apps.media.images.save_asset_image', return_value='/api/media/assets/old.png'):
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
        asset = self.make_asset('Remove', 'remove', ['/api/media/assets/a.png'])
        with patch('apps.media.images.delete_asset_image') as delete:
            response = self.client.delete('/api/assets?id=' + asset['id'])
        self.assertEqual(response.status_code, 200)
        delete.assert_called_once_with('/api/media/assets/a.png')
        self.assertFalse(Asset.objects.filter(pk=asset['id']).exists())

    def test_rejects_foreign_media_reference(self):
        self.cookie()
        for image in ('/api/media/generated/x.png', 'https://example.test/x.png', 'generated/x.png'):
            response = self.save({'name': 'Foreign', 'kind': 'prop', 'images': [image]})
            self.assertEqual((response.status_code, response.json()), (400, {'error': 'Unsupported material image reference.'}))
        self.assertFalse(Asset.objects.exists())
        # An existing row keeps a reference it already holds.
        asset = self.make_asset('Held', 'held', ['/api/media/generated/legacy.png'])
        response = self.save({'id': asset['id'], 'name': 'Held', 'kind': 'character', 'images': ['/api/media/generated/legacy.png']})
        self.assertEqual(response.json()['images'], ['/api/media/generated/legacy.png'])

    def test_delete_never_removes_non_asset_keys(self):
        self.cookie()
        for image, deleted in (('/api/media/generated/x.png', 0), ('/api/media/uploads/material/x', 0),
                               ('/api/media/assets/a.png', 1)):
            asset = self.make_asset('Del', 'del-' + str(deleted) + image[-3:], [image])
            with patch('apps.media.storage.StorageService.delete_by_urls') as delete:
                self.assertEqual(self.client.delete('/api/assets?id=' + asset['id']).json(), {'ok': True})
            self.assertEqual(delete.call_count, deleted, image)
        # Replacing a foreign image on update does not delete it either.
        asset = self.make_asset('Swap', 'swap', ['/api/media/generated/x.png'])
        with patch('apps.media.storage.StorageService.delete_by_urls') as delete, \
             patch('apps.media.images.save_asset_image', return_value='/api/media/assets/n.png'):
            self.save({'id': asset['id'], 'name': 'Swap', 'kind': 'character', 'images': ['data:image/png;base64,YQ==']})
        delete.assert_not_called()

    def test_hidden_project_asset_is_not_editable_or_deletable(self):
        from apps.authentication.models import User
        self.cookie()
        owner = User.objects.create(id=uuid4(), email='owner@example.invalid', name='Owner', role='user',
                                    password_hash='x', password_salt='x', created_at=1, is_active=True, auth_version=0)
        project = Project.objects.create(name='Secret', created_by=owner.id, created_at=1, updated_at=1)
        visibility.set_access(project.id, 'users', [str(owner.id)], 1)
        asset = self.make_asset('Hidden', 'hidden', ['/api/media/assets/h.png'], project.id)
        response = self.save({'id': asset['id'], 'name': 'Taken', 'kind': 'character', 'images': ['data:image/png;base64,YQ=='],
                              'projectId': str(project.id)})
        self.assertEqual((response.status_code, response.json()), (404, {'error': 'Material not found.'}))
        with patch('apps.media.storage.StorageService.delete_by_urls') as delete:
            self.assertEqual(self.client.delete('/api/assets?id=' + asset['id']).json(), {'ok': True})
        delete.assert_not_called()
        row = Asset.objects.get(pk=asset['id'])
        self.assertEqual((row.name, row.images, row.project_id), ('Hidden', ['/api/media/assets/h.png'], project.id))
        # Moving an asset into a project the actor cannot see is also refused.
        visible = self.make_asset('Mine', 'mine', ['/api/media/assets/m.png'])
        response = self.save({'id': visible['id'], 'name': 'Mine', 'kind': 'character', 'projectId': str(project.id)})
        self.assertEqual(response.status_code, 404)
        self.assertIsNone(Asset.objects.get(pk=visible['id']).project_id)
        self.assertEqual(self.save({'id': str(uuid4()), 'name': 'X', 'kind': 'prop', 'images': ['data:image/png;base64,YQ==']}).status_code, 404)

    def test_refused_project_writes_nothing_to_storage(self):
        self.cookie()
        adapter = MemoryAdapter()
        with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(adapter)):
            for project_id in (str(uuid4()), 'not-a-uuid'):
                response = self.save({'name': 'Leak', 'kind': 'prop', 'images': ['data:image/png;base64,YQ=='],
                                      'projectId': project_id})
                self.assertEqual((response.status_code, response.json()), (404, {'error': 'Project not found.'}))
        self.assertEqual(adapter.objects, {})
        self.assertFalse(Asset.objects.filter(name='Leak').exists())


class CatalogListQueryTests(TransactionTestCase):
    cookie = SettingsTests.cookie

    def setUp(self):
        SettingsTests.setUp(self)

    def add(self, count):
        from apps.common.leases import now_ms
        for index in range(count):
            Asset.objects.create(id=uuid4(), created_by_id=UID, name=f'a{index}', kind='character', slug=f'a{index}-{uuid4().hex[:6]}',
                                 images=[], created_at=now_ms(), updated_at=now_ms())

    def count_queries(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/assets')
        self.assertEqual(response.status_code, 200)
        return len(queries), response.json()['assets']

    def test_list_uses_a_constant_query_count(self):
        self.cookie()
        self.add(1)
        one, assets = self.count_queries()
        self.assertEqual(len(assets), 1)
        self.assertIsNotNone(assets[0]['uploader'])
        self.add(19)
        twenty, assets = self.count_queries()
        self.assertEqual(len(assets), 20)
        self.assertEqual(one, twenty)
