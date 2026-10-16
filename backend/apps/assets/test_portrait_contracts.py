import base64
import io
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier, Event
from unittest.mock import patch
from django.db import connection, connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.authentication.models import User
from apps.generation.providers.transport import HttpResult
from apps.media.storage import MemoryAdapter, StorageService
from .byteplus import BytePlusClient, BytePlusAssetError, sign_request, validate_portrait_image
from . import portrait_db as db
from .portrait_sync import sync_portraits, inventory_portraits, list_all_pages, unlinked_global_candidate, portrait_display_ref
from .models import PortraitGroup, PortraitAsset

CONFIG = {'ak': 'TEST_ACCESS_KEY', 'sk': 'TEST_SECRET_KEY', 'region': 'ap-southeast-1',
    'host': 'ark.ap-southeast-1.byteplusapi.com', 'base_url': 'https://ark.ap-southeast-1.byteplusapi.com', 'is_mock': False}


def picture(width=500, height=750, format='PNG'):
    from PIL import Image
    stream = io.BytesIO()
    Image.new('RGB', (width, height), (100, 150, 200)).save(stream, format=format)
    return stream.getvalue()


class OfflineRemote(BytePlusClient):
    def __init__(self):
        super().__init__(dict(CONFIG))
        self.calls = []
        self.fail_action = None
    def call(self, action, body, signal=None):
        self.calls.append((action, body))
        if action == self.fail_action:
            raise BytePlusAssetError('synthetic timeout', 'network_error', 502)
        return self.mock(action, body)


class BytePlusContracts(SimpleTestCase):
    def test_openapi_signature_matches_isolated_node_golden(self):
        result = sign_request(body='{"Name":"test-group"}', ak='TEST_ACCESS_KEY', sk='TEST_SECRET_KEY',
            headers={'content-type': 'application/json', 'host': 'ark.ap-southeast-1.byteplusapi.com'},
            query={'Version': '2024-01-01', 'Action': 'CreateAssetGroup'}, date=datetime(2026, 9, 16, 12, tzinfo=timezone.utc))
        self.assertEqual(result['signature'], '69a2684c324ddfb86e7206b04af796818318dd2c50ff7a1d68127939a199c65d')
        self.assertEqual(result['stringToSign'], 'HMAC-SHA256\n20260916T120000Z\n20260916/ap-southeast-1/ark/request\n16db2c4f90bda891cfd28e447055006e168d7226f9403c5305128569583147f5')

    def test_signed_compact_bytes_request_shapes_and_error_classification(self):
        class Transport:
            def request(self, *args, **kwargs):
                self.args, self.kwargs = args, kwargs
                return self.response
        transport = Transport()
        transport.response = HttpResult(200, b'{"Result":{"Id":"asset-fixture"}}')
        client = BytePlusClient(CONFIG, transport)
        self.assertEqual(client.create_asset('group-fixture', 'https://storage.invalid/source', name='नायक'), {'Id': 'asset-fixture'})
        raw = transport.kwargs['raw_body']
        expected = {'GroupId': 'group-fixture', 'URL': 'https://storage.invalid/source', 'Name': 'नायक', 'AssetType': 'Image', 'ProjectName': 'default', 'Moderation': {'Strategy': 'Default'}}
        self.assertEqual(raw, json.dumps(expected, ensure_ascii=False, separators=(',', ':')).encode())
        self.assertIn('Action=CreateAsset&Version=2024-01-01', transport.args[1])
        self.assertIn('Authorization', transport.kwargs['headers'])
        self.assertNotIn('body', transport.kwargs)
        client.list_assets(group_ids=['g'], statuses=['Active'], next_token='token')
        self.assertEqual(json.loads(transport.kwargs['raw_body']), {'Filter': {'GroupIds': ['g'], 'Statuses': ['Active'], 'GroupType': 'AIGC'}, 'MaxResults': 50, 'NextToken': 'token', 'ProjectName': 'default'})
        for response, code in [(HttpResult(403, b'{"ResponseMetadata":{"Error":{"Code":"Privacy","Message":"portrait rejected"}}}'), 'moderation_rejected'), (HttpResult(500, b'<html>bad</html>'), 'invalid_response'), (HttpResult(429, b'{"error":{"code":"Quota","message":"busy"}}'), 'Quota')]:
            transport.response = response
            with self.assertRaises(BytePlusAssetError) as error:
                client.get_asset('asset')
            self.assertEqual((error.exception.code, error.exception.status), (code, response.status))

    def test_missing_credentials_never_calls_transport_or_silently_mocks(self):
        with patch('apps.assets.byteplus.HttpTransport') as transport:
            client = BytePlusClient({**CONFIG, 'ak': None, 'sk': None})
            with self.assertRaises(BytePlusAssetError) as error:
                client.create_asset_group('P')
            self.assertEqual((error.exception.code, error.exception.status), ('missing_configuration', 503))
            transport.return_value.request.assert_not_called()

    def test_image_dimension_format_ratio_size_validation(self):
        self.assertEqual(validate_portrait_image(picture())['width'], 500)
        for data, code in [(b'', 'invalid_image'), (b'bad', 'decode_failed'), (picture(250, 300), 'dimensions_out_of_bounds'),
                           (picture(1000, 300), 'invalid_aspect_ratio'), (picture(300, 1000), 'invalid_aspect_ratio'),
                           (b'x' * (30 * 1024 * 1024 + 1), 'file_too_large')]:
            with self.assertRaises(BytePlusAssetError) as error:
                validate_portrait_image(data)
            self.assertEqual(error.exception.code, code)
        for format in ('JPEG', 'WEBP', 'BMP', 'TIFF', 'GIF'):
            self.assertEqual(validate_portrait_image(picture(format=format))['format'], format.lower())

    def test_complete_pagination_duplicates_tokens_invalid_and_cap(self):
        calls = []
        def page(**kwargs):
            calls.append(kwargs)
            return {'Items': [{'Id': 'b'}, {'Id': 'a'}], 'NextToken': 'next'} if not kwargs['next_token'] else {'Items': [{'Id': 'a', 'Name': 'latest'}], 'NextToken': ''}
        result = list_all_pages(page)
        self.assertEqual(result, {'items': [{'Id': 'a', 'Name': 'latest'}, {'Id': 'b'}], 'pages': 2})
        self.assertEqual(calls[0]['max_results'], 100)
        with self.assertRaisesMessage(ValueError, 'Repeated'):
            list_all_pages(lambda **_: {'Items': [], 'NextToken': 'same'})
        with self.assertRaisesMessage(ValueError, 'page limit'):
            list_all_pages(lambda **_: {'Items': [], 'NextToken': str(uuid.uuid4())}, max_pages=2)
        for result in ({}, {'Items': [{}]}):
            with self.assertRaises(ValueError):
                list_all_pages(lambda **_: result)

    def test_unique_global_name_link_and_durable_url_selection(self):
        remote = {'Id': 'group', 'Name': 'Name'}
        scoped = {'id': 'project', 'name': 'Name', 'projectId': 'P'}
        global_group = {'id': 'global', 'name': ' Name '}
        self.assertEqual(unlinked_global_candidate([scoped, global_group], remote, [remote]), global_group)
        self.assertIsNone(unlinked_global_candidate([global_group], remote, [remote, remote]))
        self.assertEqual(portrait_display_ref('/api/media/assets/local.png', 'https://remote.invalid/new'), '/api/media/assets/local.png')
        self.assertEqual(portrait_display_ref('https://remote.invalid/old', 'https://remote.invalid/new'), 'https://remote.invalid/new')


class PortraitReconciliationTests(TransactionTestCase):
    def setUp(self):
        self.client_remote = OfflineRemote()
        self.storage = StorageService(MemoryAdapter())

    def group(self, **fields):
        return db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Group', **fields})

    def asset(self, group, **fields):
        return db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'imageUrl': '/api/media/assets/local.png', 'status': 'Active', **fields})

    def sync(self, project_id=None):
        with patch('apps.assets.portrait_sync.get_storage', return_value=self.storage):
            return sync_portraits(project_id, self.client_remote)

    def test_incomplete_remote_inventory_mutates_nothing(self):
        group = self.group()
        asset = self.asset(group)
        self.client_remote.create_asset_group('Remote')
        self.client_remote.fail_action = 'ListAssets'
        before = list(PortraitGroup.objects.values()), list(PortraitAsset.objects.values())
        result = self.sync()
        self.assertFalse(result['syncedWithByteplus'])
        self.assertEqual((list(PortraitGroup.objects.values()), list(PortraitAsset.objects.values())), before)
        self.assertEqual(result['assets'][0]['id'], asset['id'])
        self.assertNotIn('CreateAsset', [action for action, _ in self.client_remote.calls])

    def test_reconcile_orphans_preserves_local_scopes_urls_legacy_and_remote_missing(self):
        project = str(uuid.uuid4())
        linked = self.group(byteplusGroupId='group-existing', projectId=project, projectName='legacy-project')
        local = self.asset(linked, byteplusAssetId='asset-existing')
        missing = self.asset(linked, byteplusAssetId='asset-remote-missing')
        self.client_remote.groups['group-existing'] = {'Id': 'group-existing', 'Name': 'Remote Name'}
        self.client_remote.assets['asset-existing'] = {'Id': 'asset-existing', 'GroupId': 'group-existing', 'URL': 'https://temporary.invalid/signed?secret=abc', 'Status': 'Active'}
        self.client_remote.assets['asset-orphan'] = {'Id': 'asset-orphan', 'GroupId': 'group-unlisted', 'URL': 'https://temporary.invalid/orphan', 'Name': 'Orphan', 'Status': 'Active'}
        result = self.sync(project)
        self.assertTrue(result['syncedWithByteplus'])
        self.assertEqual(len(result['assets']), 3)
        refreshed = db.get_portrait_group(linked['id'])
        self.assertEqual((refreshed['projectId'], refreshed['projectName']), (project, 'legacy-project'))
        self.assertEqual(db.get_portrait_asset(local['id'])['imageUrl'], '/api/media/assets/local.png')
        self.assertIsNotNone(db.get_portrait_asset(missing['id']))
        orphan_group = db.get_portrait_group_by_byteplus_id('group-unlisted')
        self.assertNotIn('projectId', orphan_group)
        self.assertEqual(db.get_portrait_asset_by_byteplus_id('asset-orphan')['groupId'], orphan_group['id'])

    def test_global_unlinked_group_reused_but_project_same_name_not_borrowed(self):
        global_group = self.group(name='Hero')
        scoped = self.group(name='Hero', projectId=str(uuid.uuid4()))
        self.client_remote.groups['group-hero'] = {'Id': 'group-hero', 'Name': 'Hero'}
        self.sync()
        self.assertEqual(db.get_portrait_group_by_byteplus_id('group-hero')['id'], global_group['id'])
        self.assertNotIn('byteplusGroupId', db.get_portrait_group(scoped['id']))

    def test_unknown_asset_registration_is_durable_and_never_replayed(self):
        group = self.group(byteplusGroupId='group-existing')
        asset = self.asset(group)
        self.client_remote.fail_action = 'CreateAsset'
        result = self.sync()
        self.assertFalse(result['syncedWithByteplus'])
        self.assertEqual(db.get_portrait_asset(asset['id'])['statusMessage'], 'registration_outcome_unknown')
        self.client_remote.fail_action = None
        second = self.sync()
        self.assertFalse(second['syncedWithByteplus'])
        self.assertEqual(sum(action == 'CreateAsset' for action, _ in self.client_remote.calls), 1)

    def test_successful_group_identity_commits_before_later_failure(self):
        group = self.group(projectId=str(uuid.uuid4()))
        asset = self.asset(group)
        self.client_remote.fail_action = 'CreateAsset'
        self.sync()
        self.assertTrue(db.get_portrait_group(group['id']).get('byteplusGroupId'))
        self.assertEqual(db.get_portrait_asset(asset['id'])['statusMessage'], 'registration_outcome_unknown')
        self.assertEqual(sum(action == 'CreateAssetGroup' for action, _ in self.client_remote.calls), 1)
        self.sync()
        self.assertEqual(sum(action == 'CreateAssetGroup' for action, _ in self.client_remote.calls), 1)

    def test_diagnostic_inventory_read_only_reports_both_missing_directions(self):
        group = self.group(byteplusGroupId='group-local')
        self.asset(group, byteplusAssetId='asset-local')
        self.client_remote.assets['asset-remote'] = {'Id': 'asset-remote', 'GroupId': 'group-remote'}
        before = (PortraitGroup.objects.count(), PortraitAsset.objects.count())
        result = inventory_portraits(self.client_remote)
        self.assertEqual(result['remoteAssetsMissingLocally'], ['asset-remote'])
        self.assertEqual(result['localAssetsMissingRemotely'], ['asset-local'])
        self.assertEqual((PortraitGroup.objects.count(), PortraitAsset.objects.count()), before)
        self.assertTrue(all(action.startswith('List') for action, _ in self.client_remote.calls))

    def test_concurrent_sync_busy_preserves_local_records(self):
        group = self.group()
        ready, release = Event(), Event()
        def holder():
            try:
                with connection.cursor() as cursor:
                    cursor.execute('SELECT pg_advisory_lock(746833219)')
                    ready.set()
                    release.wait(10)
                    cursor.execute('SELECT pg_advisory_unlock(746833219)')
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(holder)
            self.assertTrue(ready.wait(10))
            try:
                result = self.sync()
                self.assertTrue(result['syncInProgress'])
                self.assertEqual(result['groups'][0]['id'], group['id'])
                self.assertEqual(self.client_remote.calls, [])
            finally:
                release.set()
            future.result(timeout=10)

    def test_image_lookup_exact_query_host_and_default_group_concurrency(self):
        group = self.group()
        asset = self.asset(group, imageUrl='https://old.invalid/assets/master.png?token=old')
        for ref in ['https://old.invalid/assets/master.png?token=old', 'https://old.invalid/assets/master.png?token=new', 'https://new.invalid/assets/master.png']:
            self.assertEqual(db.get_portrait_asset_by_image_url(ref)['id'], asset['id'])
        target_project = str(uuid.uuid4())
        barrier = Barrier(4)
        def call():
            try:
                barrier.wait(10)
                return db.ensure_default_portrait_group(target_project)
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(lambda _: call(), range(4)))
        self.assertEqual(len({r['id'] for r in results}), 1)
        self.assertEqual(PortraitGroup.objects.filter(project_id=target_project).count(), 1)

    def test_image_lookup_rejects_prefix_subpath_and_ambiguous_identities(self):
        group = self.group()
        self.asset(group, imageUrl='https://old.invalid/assets/master.png.extra')
        self.asset(group, imageUrl='https://old.invalid/archive/assets/hero.png')
        self.assertIsNone(db.get_portrait_asset_by_image_url('https://old.invalid/assets/master.png'))
        self.assertIsNone(db.get_portrait_asset_by_image_url('https://new.invalid/assets/hero.png'))
        self.asset(group, imageUrl='https://one.invalid/assets/shared.png?token=one')
        self.asset(group, imageUrl='https://two.invalid/assets/shared.png?token=two')
        self.assertIsNone(db.get_portrait_asset_by_image_url('https://new.invalid/assets/shared.png'))
        self.asset(group, imageUrl='https://same.invalid/assets/duplicate.png?token=one')
        self.asset(group, imageUrl='https://same.invalid/assets/duplicate.png?token=two')
        self.assertIsNone(db.get_portrait_asset_by_image_url('https://same.invalid/assets/duplicate.png?token=new'))
        self.assertIsNone(db.get_portrait_asset_by_image_url('https://old.invalid/'))


@override_settings(ROOT_URLCONF='apps.assets.urls')
class PortraitHTTPTests(TransactionTestCase):
    cookie = SettingsTests.cookie

    def test_provider_error_text_is_private_but_http_status_is_preserved(self):
        self.cookie()
        with patch('apps.assets.portraits.get_client') as get:
            get.return_value.create_asset_group.side_effect = BytePlusAssetError('private-fixture-token','provider_error',502)
            response = self.post('/api/assets/portraits',{'name':'Fixture'})
        self.assertEqual(response.status_code,502)
        self.assertEqual(response.json(),{'error':'Failed to process portrait resource.'})
        self.assertFalse(PortraitGroup.objects.exists())

    def setUp(self):
        SettingsTests.setUp(self)
        self.remote = BytePlusClient({**CONFIG, 'is_mock': True})
        self.storage = StorageService(MemoryAdapter())
        for target, result in [('apps.assets.portraits.get_client', self.remote), ('apps.assets.portrait_sync.get_client', self.remote),
                               ('apps.media.images.get_storage', self.storage), ('apps.assets.portrait_sync.get_storage', self.storage)]:
            patcher = patch(target, return_value=result)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.data_url = 'data:image/png;base64,' + base64.b64encode(picture()).decode()

    def post(self, path, body):
        return self.client.post(path, body, content_type='application/json')

    def test_all_eight_methods_authenticate(self):
        path = '/api/assets/portraits'
        group_path = path + '/' + str(uuid.uuid4()) + '/assets'
        for response in [self.client.get(path), self.post(path, {}), self.client.patch(path, {}, content_type='application/json'),
                         self.client.delete(path), self.client.get(group_path), self.post(group_path, {}), self.client.delete(group_path),
                         self.post(path + '/upload', {})]:
            self.assertEqual((response.status_code, response.json()), (401, {'error': 'UNAUTHENTICATED'}))

    def test_group_lifecycle_inventory_role_and_asset_primary_replacement(self):
        self.cookie()
        base = '/api/assets/portraits'
        self.assertEqual(self.post(base, {}).status_code, 400)
        group = self.post(base, {'name': '  Hero  ', 'description': '  Description  '}).json()
        self.assertEqual((group['name'], group['description']), ('Hero', 'Description'))
        path = f'{base}/{group["id"]}/assets'
        first = self.post(path, {'dataUrl': self.data_url, 'name': 'Full', 'role': 'full_body'}).json()
        second = self.post(path, {'dataUrl': self.data_url, 'name': 'Close'}).json()
        self.assertEqual(first['status'], 'Processing')
        self.assertEqual(first['role'], 'full_body')
        self.assertTrue(first['imageUrl'].startswith('/api/media/assets/'))
        self.assertEqual(db.get_portrait_group(group['id'])['primaryAssetId'], first['imageUrl'])
        polled = self.client.get(path).json()['assets']
        self.assertTrue(all(asset['status'] == 'Active' for asset in polled))
        self.assertEqual(self.client.patch(base, {'groupId': group['id'], 'name': 'Rename'}, content_type='application/json').json()['group']['name'], 'Rename')
        self.assertEqual(self.client.patch(base, {'assetId': second['id'], 'name': 'Asset Rename'}, content_type='application/json').json()['asset']['name'], 'Asset Rename')
        self.assertEqual(self.client.delete(path + '?assetId=' + first['id']).json(), {'ok': True})
        self.assertEqual(db.get_portrait_group(group['id'])['primaryAssetId'], second['imageUrl'])
        actor = User.objects.get(pk='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        actor.role = 'member'; actor.save(update_fields=['role'])
        self.assertEqual(self.client.get(base + '?inventory=1').status_code, 403)
        actor.role = 'admin'; actor.save(update_fields=['role'])
        self.assertIsNone(self.client.get(base + '?inventory=1').json()['remote'])
        self.assertEqual(self.client.delete(base + '?id=' + group['id']).json(), {'ok': True})
        self.assertFalse(PortraitAsset.objects.exists())

    def test_direct_upload_default_fallback_lookup_delete_remote_id_and_validation(self):
        self.cookie()
        path = '/api/assets/portraits/upload'
        self.assertEqual(self.post(path, {}).status_code, 400)
        bad = 'data:image/png;base64,' + base64.b64encode(picture(250, 300)).decode()
        self.assertEqual(self.post(path, {'dataUrl': bad}).status_code, 400)
        uploaded = self.post(path, {'dataUrl': self.data_url, 'groupId': str(uuid.uuid4())})
        self.assertEqual(uploaded.status_code, 200)
        asset = uploaded.json()['asset']
        self.assertEqual((asset['name'], asset['status']), ('Portrait', 'Active'))
        self.assertEqual(PortraitGroup.objects.count(), 1)
        found = db.get_portrait_asset_by_image_url(asset['imageUrl'] + '?expires=fixture')
        self.assertEqual(found['byteplusAssetId'], asset['byteplusAssetId'])
        deleted = self.client.delete('/api/assets/portraits?assetId=' + asset['byteplusAssetId'])
        self.assertEqual(deleted.json(), {'ok': True})
        self.assertFalse(PortraitAsset.objects.exists())
        self.assertEqual(self.client.delete('/api/assets/portraits?assetId=asset-missing').json(), {'ok': True, 'deleted': 'already_removed'})

    def test_group_asset_scope_and_remote_delete_failure_nonfatal(self):
        self.cookie()
        group = db.ensure_default_portrait_group()
        asset = self.post(f'/api/assets/portraits/{group["id"]}/assets', {'dataUrl': self.data_url}).json()
        wrong = str(uuid.uuid4())
        self.assertEqual(self.client.delete(f'/api/assets/portraits/{wrong}/assets?assetId={asset["id"]}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/assets/portraits/{wrong}/assets').status_code, 404)
        with patch.object(self.remote, 'delete_asset', side_effect=BytePlusAssetError('remote failed', status=502)):
            self.assertEqual(self.client.delete(f'/api/assets/portraits/{group["id"]}/assets?assetId={asset["id"]}').status_code, 200)
        self.assertFalse(PortraitAsset.objects.exists())
