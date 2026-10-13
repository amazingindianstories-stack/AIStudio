from unittest.mock import Mock, patch
from django.db import OperationalError
from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests
from .models import PortraitGroup, PortraitAsset
from . import portrait_db as db


class PortraitDeleteSafetyTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def fixture(self):
        group = PortraitGroup.objects.create(name='Fixture', byteplus_group_id='group-fixture',
            primary_asset_id='/api/media/assets/original.png', created_at=1, updated_at=1)
        asset = PortraitAsset.objects.create(group=group, byteplus_asset_id='asset-fixture',
            image_url=group.primary_asset_id, created_at=1, updated_at=1)
        return group, asset

    def test_failed_catalog_delete_never_deletes_original_or_provider(self):
        self.cookie()
        for mode in ('asset', 'group', 'nested'):
            group, asset = self.fixture()
            remote = Mock()
            path = ('/api/assets/portraits?id='+str(group.id) if mode == 'group' else
                '/api/assets/portraits?assetId='+str(asset.id) if mode == 'asset' else
                '/api/assets/portraits/'+str(group.id)+'/assets?assetId='+str(asset.id))
            target = 'delete_portrait_group' if mode == 'group' else 'delete_portrait_asset'
            with patch('apps.assets.portraits.get_client',return_value=remote), \
                 patch('apps.assets.portraits.db.'+target,side_effect=OperationalError('injected')), \
                 patch('apps.assets.portraits.delete_asset_image') as delete:
                response = self.client.delete(path)
            self.assertEqual(response.status_code,500)
            self.assertTrue(PortraitAsset.objects.filter(pk=asset.id).exists())
            delete.assert_not_called()
            remote.delete_asset.assert_not_called()
            remote.delete_asset_group.assert_not_called()
            group.delete()

    def test_primary_update_failure_rolls_back_asset_and_preserves_original(self):
        self.cookie()
        group, asset = self.fixture()
        remote = Mock()
        with patch('apps.assets.portraits.get_client',return_value=remote), \
             patch('apps.assets.portraits.db.upsert_portrait_group',side_effect=OperationalError('injected')), \
             patch('apps.assets.portraits.delete_asset_image') as delete:
            response = self.client.delete('/api/assets/portraits?assetId='+str(asset.id))
        self.assertEqual(response.status_code,500)
        self.assertTrue(PortraitAsset.objects.filter(pk=asset.id).exists())
        group.refresh_from_db()
        self.assertEqual(group.primary_asset_id,asset.image_url)
        delete.assert_not_called()
        remote.delete_asset.assert_not_called()

    def test_success_retains_original_shared_by_other_durable_references(self):
        self.cookie()
        group, asset = self.fixture()
        remote = Mock()
        with patch('apps.assets.portraits.get_client',return_value=remote), \
             patch('apps.assets.portraits.delete_asset_image') as delete:
            response = self.client.delete('/api/assets/portraits?assetId='+str(asset.id))
        self.assertEqual(response.status_code,200)
        self.assertFalse(PortraitAsset.objects.filter(pk=asset.id).exists())
        group.refresh_from_db()
        self.assertIsNone(group.primary_asset_id)
        delete.assert_not_called()
        remote.delete_asset.assert_called_once_with('asset-fixture')

    def test_cleanup_query_failure_retains_remote_identity_and_original(self):
        from .portraits import cleanup_deleted_portraits
        remote = Mock()
        with patch('apps.assets.portraits.PortraitAsset.objects.filter',side_effect=OperationalError('injected')), \
             patch('apps.assets.portraits.delete_asset_image') as delete:
            cleanup_deleted_portraits(remote,[{'byteplusAssetId':'asset-fixture','imageUrl':'/api/media/assets/original.png'}])
        remote.delete_asset.assert_not_called()
        delete.assert_not_called()

    def test_committed_catalog_lost_ack_retains_original_and_remote_identity(self):
        from .portraits import remove_portrait_asset
        self.cookie()
        group, asset = self.fixture()
        remote = Mock()
        def committed_then_lost_ack(value):
            remove_portrait_asset(value)
            raise OperationalError('injected committed acknowledgment loss')
        with patch('apps.assets.portraits.get_client',return_value=remote), \
             patch('apps.assets.portraits.remove_portrait_asset',side_effect=committed_then_lost_ack), \
             patch('apps.assets.portraits.delete_asset_image') as delete:
            response = self.client.delete('/api/assets/portraits?assetId='+str(asset.id))
        self.assertEqual(response.status_code,500)
        self.assertFalse(PortraitAsset.objects.filter(pk=asset.id).exists())
        group.refresh_from_db()
        self.assertIsNone(group.primary_asset_id)
        delete.assert_not_called()
        remote.delete_asset.assert_not_called()

    def test_unknown_or_repeated_delete_never_deletes_untracked_provider_identity(self):
        self.cookie()
        group, asset = self.fixture()
        remote = Mock()
        with patch('apps.assets.portraits.get_client',return_value=remote):
            first = self.client.delete('/api/assets/portraits?assetId='+asset.byteplus_asset_id)
            repeated = self.client.delete('/api/assets/portraits?assetId='+asset.byteplus_asset_id)
            unknown = self.client.delete('/api/assets/portraits?assetId=asset-unknown')
        self.assertEqual(first.status_code,200)
        self.assertEqual(repeated.json(),{'ok':True,'deleted':'already_removed'})
        self.assertEqual(unknown.json(),{'ok':True,'deleted':'already_removed'})
        remote.delete_asset.assert_called_once_with(asset.byteplus_asset_id)
