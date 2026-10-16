"""portraits_cutover: dry run, exact-count apply, pool group untouched, old rows retired, idempotent."""
import io
import os
import uuid
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TransactionTestCase

from testsupport.fake_providers import FakeProviders

from . import managed_pool
from .management.commands import portraits_cutover
from .models import ManagedPortraitPool, PortraitAsset, PortraitGroup

ENV = {'BYTEPLUS_ACCESS_KEY_ID': 'fake-ak', 'BYTEPLUS_SECRET_ACCESS_KEY': 'fake-sk', 'BYTEPLUS_ARK_REGION': 'ap-southeast-1',
       'MOCK_ASSET_PROVIDER': '0', 'MOCK_GENERATION': '0'}


class CutoverTests(TransactionTestCase):
    def setUp(self):
        self.fake = FakeProviders()
        for item in (patch.dict(os.environ, ENV), self.fake):
            item.__enter__()
            self.addCleanup(item.__exit__, None, None, None)
        self.pool = self.group(managed_pool.POOL_GROUP_NAME)
        self.pool_asset = self.asset(self.pool)
        ManagedPortraitPool.objects.create(pk=1, byteplus_group_id=self.pool, updated_at=1)
        self.old_groups = [self.group(f'character-{n}') for n in range(52)]       # more than one listing page
        self.old_assets = [self.asset(self.old_groups[0]) for _ in range(120)] + [self.asset(self.old_groups[1]) for _ in range(3)]
        group = PortraitGroup.objects.create(id=uuid.uuid4(), name='Old', created_at=1, updated_at=1)
        for status in ('Active', 'Active', 'Processing'):
            PortraitAsset.objects.create(id=uuid.uuid4(), group=group, image_url='/api/media/x', status=status, created_at=1, updated_at=1)

    def group(self, name):
        return self.fake.asset_api('CreateAssetGroup', {'Name': name})[1]['Result']['Id']

    def asset(self, group):
        return self.fake.asset_api('CreateAsset', {'GroupId': group, 'URL': 'https://example.invalid/x.png', 'Name': 'n'})[1]['Result']['Id']

    def run_command(self, *args):
        out = io.StringIO()
        call_command('portraits_cutover', *args, stdout=out)
        return out.getvalue()

    def remote(self):
        return set(self.fake.groups), {key for key, value in self.fake.assets.items() if value['Status'] != 'Deleted'}

    def test_dry_run_lists_everything_but_the_pool_and_changes_nothing(self):
        before = self.remote()
        output = self.run_command()
        self.assertIn('52 group(s), 123 asset(s)', output)
        self.assertIn('--expect-assets 123 --expect-groups 52', output)
        self.assertIn(f"group {self.old_groups[0]} name='character-0' assets=120", output)
        self.assertNotIn(self.pool, output)
        self.assertEqual(self.remote(), before)
        self.assertEqual(PortraitAsset.objects.filter(status='Retired').count(), 0)

    def test_apply_needs_both_expected_counts_and_refuses_when_they_differ(self):
        before = self.remote()
        with self.assertRaisesRegex(CommandError, 'needs --expect-assets'):
            self.run_command('--apply')
        with self.assertRaisesRegex(CommandError, 'needs --expect-assets'):
            self.run_command('--apply', '--expect-assets', '123')
        with self.assertRaisesRegex(CommandError, 'differ'):
            self.run_command('--apply', '--expect-assets', '122', '--expect-groups', '52')
        with self.assertRaisesRegex(CommandError, 'differ'):
            self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '51')
        self.assertEqual(self.remote(), before)
        self.assertEqual(PortraitAsset.objects.filter(status='Retired').count(), 0)

    def test_apply_deletes_assets_then_groups_keeps_the_pool_and_retires_the_rows(self):
        output = self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '52')
        self.assertIn('[after] BytePlus: 0 group(s), 0 asset(s)', output)
        self.assertEqual(self.remote(), ({self.pool}, {self.pool_asset}), 'the pool group and its asset are untouched')
        self.assertEqual(sorted(PortraitAsset.objects.values_list('status', flat=True)), ['Retired'] * 3)
        self.assertEqual(PortraitGroup.objects.count(), 1, 'rows are kept')
        deletes = ['group' if 'Action=DeleteAssetGroup' in call[1] else 'asset' for call in self.fake.calls if 'Action=DeleteAsset' in call[1]]
        self.assertEqual(deletes, ['asset'] * 123 + ['group'] * 52, 'every asset is deleted before any group')

    def test_it_is_idempotent(self):
        self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '52')
        again = self.run_command('--apply', '--expect-assets', '0', '--expect-groups', '0')
        self.assertIn('0 group(s), 0 asset(s)', again)
        self.assertEqual(self.remote(), ({self.pool}, {self.pool_asset}))
        with self.assertRaisesRegex(CommandError, 'differ'):
            self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '52')

    def test_an_already_missing_item_counts_as_done(self):
        original = self.fake.asset_api
        vanished = {}

        def racing(action, body):
            if action == 'DeleteAsset' and not vanished:      # removed by someone else between the listing and our delete
                vanished['id'] = body['Id']
                original('DeleteAsset', body)
            return original(action, body)
        with patch.object(self.fake, 'asset_api', racing):
            self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '52')
        self.assertEqual(self.remote(), ({self.pool}, {self.pool_asset}))

    def test_a_failed_asset_delete_leaves_groups_and_rows_alone(self):
        original = self.fake.asset_api

        def broken(action, body):
            if action == 'DeleteAsset' and body['Id'] == self.old_assets[5]:
                return 500, {'ResponseMetadata': {'Error': {'Code': 'InternalError', 'Message': 'boom'}}}
            return original(action, body)
        with patch.object(self.fake, 'asset_api', broken), self.assertRaisesRegex(CommandError, 'could not be deleted'):
            self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '52')
        self.assertEqual(len(self.fake.groups), 53, 'no group was deleted')
        self.assertEqual(PortraitAsset.objects.filter(status='Retired').count(), 0)

    def test_the_pool_group_can_never_be_deleted_even_if_listed(self):
        with self.assertRaisesRegex(CommandError, 'Refusing'):
            portraits_cutover.Command().delete(lambda identifier: self.fail('must not call'), self.pool, {self.pool})
        # a pool group that was never stored in the pool row is still recognised by its name
        ManagedPortraitPool.objects.all().delete()
        self.run_command('--apply', '--expect-assets', '123', '--expect-groups', '52')
        self.assertEqual(self.remote(), ({self.pool}, {self.pool_asset}))

    def test_transport_allows_only_listing_and_deleting(self):
        transport = portraits_cutover.CutoverTransport(allowed_hosts={managed_pool.ASSET_HOST})
        self.assertTrue(transport.paid_guard_exempt)
        for action in ('CreateAsset', 'CreateAssetGroup', 'GetAsset'):
            with self.assertRaisesRegex(ValueError, 'mismatch'):
                transport.request('POST', f'https://{managed_pool.ASSET_HOST}/?Action={action}&Version=2024-01-01', raw_body=b'{}')

    def test_missing_credentials_refuse_to_run(self):
        with patch.dict(os.environ, {'BYTEPLUS_ACCESS_KEY_ID': '', 'BYTEPLUS_SECRET_ACCESS_KEY': ''}), self.assertRaisesRegex(CommandError, 'credentials'):
            self.run_command()
