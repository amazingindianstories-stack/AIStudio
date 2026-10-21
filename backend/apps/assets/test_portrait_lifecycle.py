"""Old portrait routes under VEEVEE_PORTRAIT_LIFECYCLE: list-only sync, readiness and tombstones."""
import base64
import json
import uuid
from unittest.mock import patch
from django.test import TestCase, override_settings
from apps.admin_dashboard import tests as dashboard_tests
from apps.integrations.transport import HttpResult, HttpTransport
from apps.media.storage import MemoryAdapter, StorageService
from . import portrait_db as db
from . import portrait_lifecycle, portrait_sync
from apps.integrations.byteplus import BytePlusClient
from .models import PortraitAsset, PortraitGroup
from .portraits import cleanup_deleted_portraits, remove_portrait_asset
from .test_portrait_contracts import CONFIG, OfflineRemote, picture

LIFECYCLE = override_settings(VEEVEE_PORTRAIT_LIFECYCLE=True, VEEVEE_RUNTIME_COMPONENT='api', VEEVEE_MANAGED_PORTRAITS=False)


class PredicateTests(TestCase):
    def test_only_the_api_process_without_the_automatic_pool_uses_the_lifecycle(self):
        for flag, component, managed, expected in (
                (True, 'api', False, True), (False, 'api', False, False), (True, None, False, False),
                (True, 'generation', False, False), (True, 'export', False, False), (True, 'scheduler', False, False),
                (True, 'api', True, False)):
            with override_settings(VEEVEE_PORTRAIT_LIFECYCLE=flag, VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_MANAGED_PORTRAITS=managed):
                self.assertIs(portrait_lifecycle.enabled(), expected, (flag, component, managed))


class TombstoneTests(TestCase):
    def group(self, **fields):
        return db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Group', **fields})

    def asset(self, group, **fields):
        return db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'imageUrl': '/api/media/assets/' + str(uuid.uuid4()) + '.png',
                                         'status': 'Active', **fields})

    @LIFECYCLE
    def test_deleted_portrait_is_kept_as_a_tombstone_and_hidden_from_every_listing(self):
        group = self.group()
        first = self.asset(group, byteplusAssetId='asset-1')
        second = self.asset(group, status='Processing')
        db.upsert_portrait_group({**db.get_portrait_group(group['id']), 'primaryAssetId': first['imageUrl']})
        self.assertEqual(db.delete_portrait_asset('asset-1')['id'], first['id'])
        row = PortraitAsset.objects.get(pk=first['id'])
        self.assertEqual((row.status, row.byteplus_asset_id, row.image_url), ('PreviewDeleted', 'asset-1', first['imageUrl']))
        self.assertEqual([a['id'] for a in db.list_portrait_assets(group['id'])], [second['id']])
        self.assertEqual([a['id'] for a in db.list_all_portrait_assets()], [second['id']])
        listed = db.get_portrait_group(group['id'])
        self.assertEqual(([a['id'] for a in listed['assets']], listed['activeCount'], listed['processingCount']), ([second['id']], 0, 1))
        [projected] = db.list_portrait_groups()
        self.assertEqual(projected['primaryAssetId'], second['imageUrl'])
        self.assertEqual((projected['activeCount'], projected['processingCount']), (0, 1))
        # The stored group still names the deleted original; only listings move on.
        self.assertEqual(PortraitGroup.objects.get(pk=group['id']).primary_asset_id, first['imageUrl'])

    @LIFECYCLE
    def test_a_tombstone_is_never_brought_back_or_restatused(self):
        group = self.group()
        asset = self.asset(group, byteplusAssetId='asset-1')
        remove_portrait_asset(asset)
        tombstone = PortraitAsset.objects.get(pk=asset['id'])
        again = db.upsert_portrait_asset({**asset, 'status': 'Active', 'name': 'Back'})
        self.assertEqual(again['status'], 'PreviewDeleted')
        imported = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'byteplusAssetId': 'asset-1',
                                             'imageUrl': 'https://remote.invalid/x', 'status': 'Active'})
        self.assertEqual(imported['id'], asset['id'])
        self.assertEqual(db.update_portrait_asset_status('asset-1', 'Failed', 'late')['status'], 'PreviewDeleted')
        self.assertEqual(PortraitAsset.objects.count(), 1)
        row = PortraitAsset.objects.get(pk=asset['id'])
        self.assertEqual((row.status, row.name, row.status_message, row.updated_at), (tombstone.status, tombstone.name, tombstone.status_message, tombstone.updated_at))
        # Deleting again leaves the tombstone as it is.
        remove_portrait_asset(asset)
        self.assertEqual(PortraitAsset.objects.get(pk=asset['id']).updated_at, tombstone.updated_at)

    @LIFECYCLE
    def test_live_rows_still_update_and_groups_cannot_be_hard_deleted(self):
        group = self.group()
        asset = self.asset(group, byteplusAssetId='asset-1', status='Processing')
        self.assertEqual(db.update_portrait_asset_status('asset-1', 'Active')['status'], 'Active')
        self.assertEqual(db.upsert_portrait_asset({**asset, 'status': 'Failed'})['status'], 'Failed')
        with self.assertRaisesMessage(ValueError, 'Preview portrait group hard delete HOLD'):
            db.delete_portrait_group(group['id'])
        self.assertTrue(PortraitGroup.objects.filter(pk=group['id']).exists())

    @LIFECYCLE
    def test_deleting_keeps_remote_identities_and_media(self):
        remote = OfflineRemote()
        self.assertIsNone(cleanup_deleted_portraits(remote, [{'byteplusAssetId': 'asset-1', 'imageUrl': '/api/media/assets/x.png'}], {'byteplusGroupId': 'group-1'}))
        self.assertEqual(remote.calls, [])
        with override_settings(VEEVEE_PORTRAIT_LIFECYCLE=False):
            cleanup_deleted_portraits(remote, [{'byteplusAssetId': 'asset-1', 'imageUrl': '/api/media/assets/x.png'}], {'byteplusGroupId': 'group-1'})
        self.assertEqual([action for action, _ in remote.calls], ['DeleteAsset', 'DeleteAssetGroup'])

    def test_without_the_lifecycle_deletes_are_physical(self):
        for settings in ({}, {'VEEVEE_PORTRAIT_LIFECYCLE': True, 'VEEVEE_RUNTIME_COMPONENT': 'api', 'VEEVEE_MANAGED_PORTRAITS': True}):
            with override_settings(**settings):
                group = self.group()
                asset = self.asset(group)
                remove_portrait_asset(asset)
                self.assertFalse(PortraitAsset.objects.filter(pk=asset['id']).exists())
                db.delete_portrait_group(group['id'])
                self.assertFalse(PortraitGroup.objects.filter(pk=group['id']).exists())


class PullOnlySyncTests(TestCase):
    def setUp(self):
        self.remote = OfflineRemote()
        self.storage = StorageService(MemoryAdapter())

    def sync(self, project_id=None):
        with patch('apps.assets.portrait_sync.get_storage', return_value=self.storage):
            return portrait_sync.sync_portraits(project_id, self.remote)

    @LIFECYCLE
    def test_sync_only_lists_imports_missing_identities_and_projects_readiness(self):
        linked = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Local Name', 'byteplusGroupId': 'group-1'})
        stale = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': linked['id'], 'byteplusAssetId': 'asset-1',
                                          'imageUrl': '/api/media/assets/a.png', 'status': 'Processing'})
        gone = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': linked['id'], 'byteplusAssetId': 'asset-gone',
                                         'imageUrl': '/api/media/assets/b.png', 'status': 'Active'})
        local = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': linked['id'], 'imageUrl': '/api/media/assets/c.png', 'status': 'LocalOnly'})
        deleted = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': linked['id'], 'byteplusAssetId': 'asset-deleted',
                                            'imageUrl': '/api/media/assets/d.png', 'status': 'Active'})
        db.delete_portrait_asset(deleted['id'])
        self.remote.groups['group-1'] = {'Id': 'group-1', 'Name': 'Remote Name'}
        self.remote.assets['asset-1'] = {'Id': 'asset-1', 'GroupId': 'group-1', 'Status': 'Active', 'URL': 'https://remote.invalid/1'}
        self.remote.assets['asset-new'] = {'Id': 'asset-new', 'GroupId': 'group-1', 'Status': 'Active', 'URL': 'https://remote.invalid/new', 'Name': 'New'}
        before = {row.id: (row.status, row.image_url, row.updated_at) for row in PortraitAsset.objects.all()}
        result = self.sync()
        self.assertEqual({action for action, _ in self.remote.calls}, {'ListAssetGroups', 'ListAssets'})
        self.assertTrue(result['syncedWithByteplus'])
        # Existing rows are evidence: neither the local name nor the stale status is rewritten.
        self.assertEqual({row.id: (row.status, row.image_url, row.updated_at) for row in PortraitAsset.objects.exclude(byteplus_asset_id='asset-new')}, before)
        self.assertEqual(db.get_portrait_group(linked['id'])['name'], 'Local Name')
        imported = PortraitAsset.objects.get(byteplus_asset_id='asset-new')
        self.assertEqual((imported.group_id, imported.status, imported.image_url), (uuid.UUID(linked['id']), 'Active', 'https://remote.invalid/new'))
        by_id = {asset['id']: asset for asset in result['assets']}
        self.assertNotIn(deleted['id'], by_id)
        self.assertEqual((by_id[stale['id']]['status'], by_id[stale['id']]['remoteVerification'], by_id[stale['id']]['remoteStatus']), ('Active', 'active', 'Active'))
        self.assertEqual((by_id[gone['id']]['status'], by_id[gone['id']]['remoteVerification']), ('RemoteMissing', 'absent'))
        self.assertEqual((by_id[local['id']]['status'], by_id[local['id']]['remoteVerification']), ('LocalOnly', 'local_only'))
        self.assertTrue(all(isinstance(asset['remoteVerifiedAt'], int) for asset in result['assets']))
        [group] = result['groups']
        self.assertEqual((group['groupVerification'], group['remoteGroupMissing'], group['groupOperationHold']), ('present', False, False))
        self.assertNotIn(deleted['id'], [asset['id'] for asset in group['assets']])

    @LIFECYCLE
    def test_an_asset_outside_the_listed_groups_stops_the_sync_without_changes(self):
        group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Group', 'byteplusGroupId': 'group-1'})
        asset = db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'byteplusAssetId': 'asset-1',
                                          'imageUrl': '/api/media/assets/a.png', 'status': 'Active'})
        self.remote.assets['asset-1'] = {'Id': 'asset-1', 'GroupId': 'group-unlisted', 'Status': 'Active'}
        result = self.sync()
        self.assertEqual(result['syncError'], 'Portrait synchronization incomplete; local records preserved.')
        self.assertEqual((PortraitGroup.objects.count(), PortraitAsset.objects.count()), (1, 1))
        [projected] = result['assets']
        self.assertEqual((projected['id'], projected['status'], projected['remoteVerification']), (asset['id'], 'RemoteUnverified', 'unverified'))
        self.assertNotIn('remoteVerifiedAt', projected)

    @LIFECYCLE
    def test_reconcile_hands_the_pull_only_path_a_list_only_client(self):
        with patch('apps.assets.portrait_sync.pull_only_reconcile', return_value={'assets': []}) as pull:
            self.assertEqual(portrait_sync.reconcile('project', self.remote), {'assets': []})
        project, client = pull.call_args.args
        self.assertEqual(project, 'project')
        self.assertIsInstance(client, portrait_lifecycle.ListOnlyClient)
        with self.assertRaisesMessage(ValueError, 'Remote portrait write/interface forbidden'):
            client.create_asset('group-1', 'https://remote.invalid/x')
        self.assertEqual(self.remote.calls, [])

    def test_without_the_lifecycle_sync_is_unchanged(self):
        group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Group', 'byteplusGroupId': 'group-1'})
        db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'byteplusAssetId': 'asset-1',
                                  'imageUrl': '/api/media/assets/a.png', 'status': 'Processing'})
        self.remote.groups['group-1'] = {'Id': 'group-1', 'Name': 'Group'}
        self.remote.assets['asset-1'] = {'Id': 'asset-1', 'GroupId': 'group-1', 'Status': 'Active'}
        result = self.sync()
        self.assertEqual(PortraitAsset.objects.get(byteplus_asset_id='asset-1').status, 'Active')
        self.assertNotIn('remoteVerification', result['assets'][0])
        self.assertNotIn('remoteVerification', portrait_sync.local_result()['assets'][0])

    @LIFECYCLE
    def test_local_results_are_projected_without_remote_evidence(self):
        group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Group', 'byteplusGroupId': 'group-1'})
        db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'byteplusAssetId': 'asset-1',
                                  'imageUrl': '/api/media/assets/a.png', 'status': 'Active'})
        with override_settings(LOCAL_DATA_MODE='read_only_viewer'):
            result = portrait_sync.sync_portraits()
        self.assertEqual((result['assets'][0]['status'], result['assets'][0]['remoteVerification']), ('RemoteUnverified', 'unverified'))
        self.assertEqual(result['groups'][0]['groupVerification'], 'unverified')
        self.assertFalse(result['syncedWithByteplus'])


class ListOnlyClientTests(TestCase):
    @LIFECYCLE
    def test_the_sync_client_can_only_list_the_default_catalogue(self):
        with patch('apps.integrations.byteplus.config_from_env', return_value=dict(CONFIG, is_mock=True)):
            client = portrait_sync.get_client()
        self.assertIsInstance(client, portrait_lifecycle.ListOnlyClient)
        self.assertFalse(client.is_mock)
        for name in ('create_asset', 'create_asset_group', 'delete_asset', 'get_asset', 'transport'):
            with self.assertRaisesMessage(ValueError, 'Remote portrait write/interface forbidden'):
                getattr(client, name)
        sent = []
        body = {'Items': [], 'NextToken': ''}
        with patch.object(HttpTransport, '_send', autospec=True,
                          side_effect=lambda *a, **k: sent.append((a[1:], k)) or HttpResult(200, json.dumps({'Result': body}).encode())):
            self.assertEqual(client.list_asset_groups(group_type='AIGC', project_name='default'), body)
        [((method, url), _)] = sent
        self.assertEqual((method, url), ('POST', 'https://ark.ap-southeast-1.byteplusapi.com/?Action=ListAssetGroups&Version=2024-01-01'))

    def test_the_list_transport_refuses_anything_but_a_default_catalogue_listing(self):
        transport = portrait_lifecycle.list_transport()
        self.assertIs(transport.paid_guard_exempt, True)
        base = 'https://ark.ap-southeast-1.byteplusapi.com/?Action={}&Version=2024-01-01'
        good = {'ProjectName': 'default', 'Filter': {'GroupType': 'AIGC'}, 'MaxResults': 100}
        for method, url, payload in (('POST', base.format('CreateAsset'), good), ('GET', base.format('ListAssets'), good),
                                     ('POST', base.format('ListAssets'), {**good, 'ProjectName': 'other'}),
                                     ('POST', base.format('ListAssets'), {**good, 'MaxResults': 101}),
                                     ('POST', base.format('ListAssets'), {**good, 'Filter': {'GroupType': 'AIGC', 'GroupIds': ['g']}}),
                                     ('POST', 'https://ark.ap-southeast-1.byteplusapi.com/?Action=ListAssets&Version=2024-01-01&x=1', good)):
            with patch.object(HttpTransport, '_send') as send, self.assertRaisesMessage(ValueError, 'Preview portrait pull-only HOLD'):
                transport.request(method, url, raw_body=json.dumps(payload).encode())
            send.assert_not_called()


@override_settings(ROOT_URLCONF='apps.assets.urls')
class LocalOnlyRouteTests(TestCase):
    cookie = dashboard_tests.SettingsTests.cookie

    def setUp(self):
        dashboard_tests.SettingsTests.setUp(self)
        self.storage = StorageService(MemoryAdapter())
        for target in ('apps.media.images.get_storage', 'apps.assets.portrait_sync.get_storage'):
            patcher = patch(target, return_value=self.storage)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.data_url = 'data:image/png;base64,' + base64.b64encode(picture()).decode()
        self.cookie()

    def post(self, path, body):
        return self.client.post(path, body, content_type='application/json')

    @LIFECYCLE
    def test_characters_and_uploads_stay_local_without_any_provider_client(self):
        with patch('apps.assets.portraits.get_client', side_effect=AssertionError('provider client')):
            group = self.post('/api/assets/portraits', {'name': 'Hero'}).json()
            self.assertNotIn('byteplusGroupId', group)
            added = self.post(f'/api/assets/portraits/{group["id"]}/assets', {'dataUrl': self.data_url, 'name': 'Close'})
            self.assertEqual(added.status_code, 200)
            uploaded = self.post('/api/assets/portraits/upload', {'dataUrl': self.data_url, 'groupId': group['id']})
            self.assertEqual(uploaded.status_code, 200)
        for asset in (added.json(), uploaded.json()['asset']):
            self.assertEqual((asset['status'], asset['statusMessage']), ('LocalOnly', 'remote_registration_not_authorized'))
            self.assertNotIn('byteplusAssetId', asset)
            self.assertTrue(asset['imageUrl'].startswith('/api/media/assets/'))
        self.assertEqual(db.get_portrait_group(group['id'])['primaryAssetId'], added.json()['imageUrl'])
        self.assertFalse(PortraitGroup.objects.exclude(byteplus_group_id=None).exists())

    @LIFECYCLE
    def test_listing_a_group_still_polls_processing_assets(self):
        remote = BytePlusClient({**CONFIG, 'is_mock': True})
        group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Group'})
        with patch('apps.assets.portraits.get_client', return_value=remote) as get:
            response = self.client.get(f'/api/assets/portraits/{group["id"]}/assets')
        self.assertEqual((response.status_code, response.json(), get.call_count), (200, {'assets': []}, 1))
