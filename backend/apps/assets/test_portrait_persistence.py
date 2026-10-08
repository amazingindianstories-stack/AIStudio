from django.db import connection, IntegrityError, transaction
from django.test import TransactionTestCase
from .models import PortraitAsset, PortraitGroup


class PortraitPersistenceTests(TransactionTestCase):
    def setUp(self):
        # Disposable fixture: physical constraints match current declarations;
        # this is not evidence of Django baseline schema creation.
        with connection.cursor() as cursor:
            cursor.execute("CREATE TABLE IF NOT EXISTS portrait_groups (id uuid PRIMARY KEY,byteplus_group_id text UNIQUE,name text NOT NULL,description text,group_type text NOT NULL DEFAULT 'AIGC',project_name text NOT NULL DEFAULT 'default',primary_asset_id text,project_id uuid,created_at bigint NOT NULL,updated_at bigint NOT NULL)")
            cursor.execute("CREATE TABLE IF NOT EXISTS portrait_assets (id uuid PRIMARY KEY,group_id uuid NOT NULL REFERENCES portrait_groups(id) ON DELETE CASCADE,byteplus_asset_id text UNIQUE,name text,asset_type text NOT NULL DEFAULT 'Image',role text NOT NULL DEFAULT 'reference',image_url text NOT NULL,status text NOT NULL DEFAULT 'Processing',status_message text,created_at bigint NOT NULL,updated_at bigint NOT NULL)")
            cursor.execute('TRUNCATE portrait_assets,portrait_groups')

    def group(self, identifier, **kwargs):
        return PortraitGroup.objects.create(id=identifier,name='संदर्भ',created_at=1,updated_at=2,**kwargs)

    def test_nullable_provider_ids_defaults_and_relation(self):
        group = self.group('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        self.group('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
        for identifier in ['cccccccc-cccc-4ccc-8ccc-cccccccccccc','dddddddd-dddd-4ddd-8ddd-dddddddddddd']:
            PortraitAsset.objects.create(id=identifier,group=group,image_url='/fixture/portrait.png',created_at=3,updated_at=4)
        asset = PortraitAsset.objects.select_related('group').get(pk='cccccccc-cccc-4ccc-8ccc-cccccccccccc')
        self.assertEqual(asset.group.name,'संदर्भ')
        self.assertEqual((asset.asset_type,asset.role,asset.status),('Image','reference','Processing'))
        self.assertEqual((asset.group.group_type,asset.group.project_name),('AIGC','default'))
        self.assertIsNone(asset.byteplus_asset_id)
        self.assertIsNone(asset.group.byteplus_group_id)
        self.assertIsNone(asset.name)

    def test_provider_uniqueness_and_database_cascade(self):
        group = self.group('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',byteplus_group_id='fixture-provider-group')
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.group('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',byteplus_group_id='fixture-provider-group')
        PortraitAsset.objects.create(id='cccccccc-cccc-4ccc-8ccc-cccccccccccc',group=group,byteplus_asset_id='fixture-provider-asset',image_url='/fixture/image.png',created_at=3,updated_at=4)
        with self.assertRaises(IntegrityError), transaction.atomic():
            PortraitAsset.objects.create(id='dddddddd-dddd-4ddd-8ddd-dddddddddddd',group=group,byteplus_asset_id='fixture-provider-asset',image_url='/fixture/image.png',created_at=3,updated_at=4)
        with connection.cursor() as cursor:
            cursor.execute('DELETE FROM portrait_groups WHERE id=%s',[str(group.pk)])
        self.assertFalse(PortraitAsset.objects.exists())
