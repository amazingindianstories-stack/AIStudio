from unittest.mock import patch

from django.db import OperationalError
from django.test import TransactionTestCase

from apps.admin_dashboard.tests import SettingsTests
from .models import Asset


class CatalogCommitSafetyTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def test_storage_value_error_is_private_and_creates_no_asset(self):
        self.cookie()
        with patch('apps.media.images.save_asset_image',side_effect=ValueError('private-fixture-token')):
            response = self.client.post('/api/assets',{'name':'Fixture','kind':'character',
                'image':'data:image/png;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Failed to save material asset.'})
        self.assertFalse(Asset.objects.exists())

    def test_failed_replacement_preserves_persisted_old_image(self):
        self.cookie()
        asset = Asset.objects.create(name='Old', kind='character', slug='old',
            images=['/api/media/assets/old.png'], created_at=1, updated_at=1)
        with patch('apps.assets.catalog.Asset.objects.update_or_create', side_effect=OperationalError('synthetic write failure')), \
             patch('apps.media.images.delete_asset_image') as delete:
            response = self.client.post('/api/assets', {'id': str(asset.id), 'name': 'New',
                'kind': 'character', 'imageUrl': '/api/media/assets/new.png'}, content_type='application/json')
        self.assertEqual(response.status_code, 500)
        asset.refresh_from_db()
        self.assertEqual(asset.images, ['/api/media/assets/old.png'])
        delete.assert_not_called()
