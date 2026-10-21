"""Old portrait routes under VEEVEE_PORTRAIT_LIFECYCLE: native upload registration and remote-first delete."""
import base64
import hashlib
import json
import uuid
from datetime import timedelta
from unittest.mock import patch
from django.test import SimpleTestCase, TestCase, TransactionTestCase, override_settings
from django.urls import path
from django.utils import timezone
from apps.admin_dashboard import tests as dashboard_tests
from apps.common.models import ActivityLog
from apps.media.models import UploadSession
from apps.media.storage import MemoryAdapter, StorageService
from . import portrait_db as db
from . import portrait_registration, portrait_sync
from apps.integrations.byteplus import BytePlusClient
from .models import PortraitAsset
from .portrait_remote_delete import DeleteHold, delete_once
from .portraits import group_assets, portraits, upload
from .test_portrait_contracts import CONFIG, picture

LIFECYCLE = override_settings(VEEVEE_PORTRAIT_LIFECYCLE=True, VEEVEE_RUNTIME_COMPONENT='api', VEEVEE_MANAGED_PORTRAITS=False)
MANAGED = override_settings(VEEVEE_PORTRAIT_LIFECYCLE=True, VEEVEE_RUNTIME_COMPONENT='api', VEEVEE_MANAGED_PORTRAITS=True)
UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
UPLOAD, PORTRAITS = '/api/assets/portraits/upload', '/api/assets/portraits'

# The views themselves, without the managed-mode 410 wrapper, so the lifecycle gate is what decides.
urlpatterns = [path('api/assets/portraits', portraits), path('api/assets/portraits/upload', upload),
               path('api/assets/portraits/<str:id>/assets', group_assets)]


class Registrar:
    """A BytePlus client for native registration that only records calls."""

    def __init__(self):
        self.calls = []

    def get_asset_group(self, identifier, project_name='default'):
        self.calls.append(('get_asset_group', identifier))
        return {'Id': identifier}

    def create_asset_group(self, name, description, group_type='AIGC', project_name='default'):
        self.calls.append(('create_asset_group', name))
        return {'Id': 'group-new'}

    def create_asset(self, group_id, url, name='', asset_type='Image', project_name='default'):
        self.calls.append(('create_asset', group_id, url))
        return {'Id': 'asset-new', 'Status': 'Processing'}


class Deleter:
    """The exact delete client's interface, recording calls."""

    def __init__(self, remote_group='group-1', fail=None):
        self.calls, self.last_receipt, self.remote_group, self.fail = [], None, remote_group, fail

    def get_asset(self, id, project_name):
        self.calls.append(('get_asset', id))
        if self.fail:
            raise self.fail
        return {'Id': id, 'GroupId': self.remote_group}

    def delete_asset(self, id, project_name):
        self.calls.append(('delete_asset', id))
        return 'confirmed', {'action': 'DeleteAsset', 'http_status': 200, 'request_id': 'req-1'}


@override_settings(ROOT_URLCONF='apps.assets.test_portrait_registration')
class RouteBase(TransactionTestCase):
    cookie = dashboard_tests.SettingsTests.cookie

    def setUp(self):
        dashboard_tests.SettingsTests.setUp(self)
        self.storage = StorageService(MemoryAdapter())
        self.registrar, self.deleter = Registrar(), Deleter()
        signed = lambda ref, actor_id=None: 'https://storage.googleapis.com/bucket/' + ref.rsplit('/', 1)[-1] + '?signature=1'
        for item in (override_settings(VEEVEE_MEDIA_STORAGE=self.storage),
                     patch('apps.assets.portraits.sign_stored_ref', side_effect=signed),
                     patch('apps.assets.portrait_registration.native_client', side_effect=lambda: self.registrar),
                     patch('apps.assets.portrait_remote_delete.native_delete_client', side_effect=lambda: self.deleter)):
            item.__enter__()
            self.addCleanup(item.__exit__, None, None, None)
        self.cookie()

    def reference(self, data=None, stored=True):
        data = data or picture()
        key = f'uploads/portrait/{uuid.uuid4()}'
        if stored:
            self.storage.primary.put(key, data, 'image/png', 'private, no-store')
        row = UploadSession.objects.create(actor_id=UID, key=key, purpose='portrait', content_type='image/png', byte_size=len(data),
                                           sha256=hashlib.sha256(data).hexdigest(), state='ready', finalized_at=timezone.now(),
                                           expires_at=timezone.now() + timedelta(hours=1))
        return str(row.id)

    def post(self, body):
        return self.client.post(UPLOAD, body, content_type='application/json')

    def group(self, **fields):
        return db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Hero', **fields})


class RegisteredUploadTests(RouteBase):
    @LIFECYCLE
    def test_a_verified_upload_registers_once_and_a_retry_reuses_that_portrait(self):
        group = self.group()
        reference = self.reference()
        response = self.post({'referenceId': reference, 'groupId': group['id'], 'name': 'One'})
        self.assertEqual(response.status_code, 200, response.content)
        asset = response.json()['asset']
        self.assertEqual((asset['status'], asset['byteplusAssetId'], asset['remoteVerification']), ('Processing', 'asset-new', 'processing'))
        self.assertNotIn('registrationError', response.json())
        self.assertEqual([call[0] for call in self.registrar.calls], ['create_asset_group', 'create_asset'])
        self.assertEqual(self.registrar.calls[1][1:], ('group-new', 'https://storage.googleapis.com/bucket/' + asset['imageUrl'].rsplit('/', 1)[-1] + '?signature=1'))
        self.assertEqual(json.loads(PortraitAsset.objects.get(pk=asset['id']).status_message)['state'], 'ACKNOWLEDGED')
        for body in ({'referenceId': reference, 'groupId': group['id']}, {'referenceId': reference}):
            again = self.post(body)
            self.assertEqual(again.status_code, 200)
            self.assertIs(again.json()['registrationReused'], True)
            self.assertEqual(again.json()['asset']['id'], asset['id'])
        self.assertEqual(len(self.registrar.calls), 2, 'a retry never registers again')
        self.assertEqual(PortraitAsset.objects.count(), 1)

    @LIFECYCLE
    def test_two_portraits_with_one_upload_identity_are_ambiguous(self):
        group = self.group()
        reference = self.reference()
        key = UploadSession.objects.get(pk=reference).key
        for _ in range(2):
            db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'createdById': UID, 'imageUrl': '/api/media/' + key, 'status': 'LocalOnly'})
        response = self.post({'referenceId': reference, 'groupId': group['id']})
        self.assertEqual((response.status_code, response.json()),
                         (409, {'error': 'Ambiguous existing portrait identity; reconcile without registration retry.'}))
        self.assertEqual((self.registrar.calls, PortraitAsset.objects.count()), ([], 2))

    @LIFECYCLE
    def test_a_group_outside_the_requested_project_is_refused(self):
        project = str(uuid.uuid4())
        scoped = self.group(projectId=project)
        data_url = 'data:image/png;base64,' + base64.b64encode(picture()).decode()
        forbidden = {'error': 'Portrait group is outside the requested project scope.'}
        for body in ({'dataUrl': data_url, 'groupId': scoped['id'], 'projectId': str(uuid.uuid4())},
                     {'dataUrl': data_url, 'groupId': scoped['id']},
                     {'referenceId': self.reference(), 'groupId': str(uuid.uuid4())}):
            response = self.post(body)
            self.assertEqual((response.status_code, response.json()), (403, forbidden), body)
        self.assertFalse(PortraitAsset.objects.exists())
        self.assertEqual(self.post({'dataUrl': data_url, 'groupId': scoped['id'], 'projectId': project}).status_code, 200)
        self.assertEqual(self.registrar.calls, [])

    @LIFECYCLE
    def test_a_data_url_upload_stays_local_and_says_how_to_register(self):
        group = self.group()
        response = self.post({'dataUrl': 'data:image/png;base64,' + base64.b64encode(picture()).decode(), 'groupId': group['id']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['registrationError'], 'Use a verified native upload to register this local image.')
        self.assertEqual((response.json()['asset']['status'], response.json()['asset']['statusMessage']), ('LocalOnly', 'remote_registration_not_authorized'))
        self.assertEqual(self.registrar.calls, [])

    @LIFECYCLE
    def test_a_registration_failure_keeps_the_original_with_a_safe_message(self):
        group = self.group()
        response = self.post({'referenceId': self.reference(stored=False), 'groupId': group['id']})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['registrationErrorCode'], 'registration_native_read_failed')
        self.assertEqual(body['registrationError'], 'Original saved. Storage access failed while preparing BytePlus registration.')
        self.assertEqual((body['asset']['status'], body['asset']['statusMessage'], body['asset']['remoteVerification']),
                         ('LocalOnly', 'registration_native_read_failed', 'local_only'))
        self.assertEqual(self.registrar.calls, [])

    @LIFECYCLE
    def test_an_anonymous_upload_is_refused_before_anything_is_read(self):
        self.client.cookies.clear()
        self.assertEqual((self.post({'referenceId': str(uuid.uuid4())}).status_code), 401)


class RemoteDeleteRouteTests(RouteBase):
    def portrait(self, group, **fields):
        return db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'createdById': UID,
                                         'imageUrl': '/api/media/assets/' + str(uuid.uuid4()) + '.png', 'status': 'Active', **fields})

    @LIFECYCLE
    def test_both_routes_delete_remotely_first_then_keep_a_tombstone(self):
        group = self.group(byteplusGroupId='group-1')
        registered = self.portrait(group, byteplusAssetId='asset-1')
        local = self.portrait(group, status='LocalOnly')
        response = self.client.delete(f'{PORTRAITS}?assetId={registered["id"]}&groupId={group["id"]}')
        self.assertEqual((response.status_code, response.json()),
                         (200, {'ok': True, 'assetId': registered['id'], 'groupId': group['id'], 'remoteDeletion': 'confirmed'}))
        self.assertEqual(self.deleter.calls, [('get_asset', 'asset-1'), ('delete_asset', 'asset-1')])
        response = self.client.delete(f'{PORTRAITS}/{group["id"]}/assets?assetId={local["id"]}')
        self.assertEqual((response.status_code, response.json()['remoteDeletion']), (200, 'not_registered'))
        self.assertEqual(len(self.deleter.calls), 2, 'an unregistered portrait needs no BytePlus call')
        rows = {str(row.id): row for row in PortraitAsset.objects.all()}
        self.assertEqual({rows[registered['id']].status, rows[local['id']].status}, {'PreviewDeleted'})
        self.assertEqual(json.loads(rows[registered['id']].status_message)['receipt']['request_id'], 'req-1')
        self.assertEqual([(log.action, log.detail['remoteDeletion']) for log in ActivityLog.objects.order_by('created_at')],
                         [('delete_portrait_asset', 'confirmed'), ('delete_portrait_asset', 'not_registered')])

    @LIFECYCLE
    def test_delete_requests_are_checked_before_any_remote_call(self):
        group = self.group(byteplusGroupId='group-1')
        pending = self.portrait(group, status='RegistrationPending')
        live = self.portrait(group, byteplusAssetId='asset-2')
        for url, status, body in (
                (PORTRAITS, 400, {'error': 'assetId is required; character-group deletion remains unavailable.'}),
                (f'{PORTRAITS}?id={group["id"]}', 400, {'error': 'assetId is required; character-group deletion remains unavailable.'}),
                (f'{PORTRAITS}?assetId={uuid.uuid4()}', 404, {'ok': False, 'error': 'Portrait no longer exists; refresh Gallery before retrying.'}),
                (f'{PORTRAITS}?assetId={live["id"]}', 400, {'ok': False, 'error': 'Character identity is required.'}),
                (f'{PORTRAITS}/{uuid.uuid4()}/assets?assetId={live["id"]}', 409, {'ok': False, 'error': 'Portrait is outside the requested character/project scope.'}),
                (f'{PORTRAITS}/{group["id"]}/assets?assetId={pending["id"]}', 409,
                 {'ok': False, 'error': 'Pending or uncertain registration/deletion requires reconciliation first.'})):
            response = self.client.delete(url)
            self.assertEqual((response.status_code, response.json()), (status, body), url)
        self.assertEqual(self.deleter.calls, [])
        self.client.cookies.clear()
        for url in (PORTRAITS, f'{PORTRAITS}/{group["id"]}/assets'):
            self.assertEqual(self.client.delete(url).status_code, 401)
        self.assertEqual(set(PortraitAsset.objects.values_list('status', flat=True)), {'RegistrationPending', 'Active'})

    @LIFECYCLE
    def test_an_unverifiable_remote_answer_keeps_the_portrait(self):
        group = self.group(byteplusGroupId='group-1')
        live = self.portrait(group, byteplusAssetId='asset-3')
        self.deleter.fail = RuntimeError('timeout')
        response = self.client.delete(f'{PORTRAITS}?assetId={live["id"]}&groupId={group["id"]}')
        self.assertEqual((response.status_code, response.json()),
                         (502, {'ok': False, 'error': 'BytePlus deletion could not be verified. Portrait retained; no automatic retry.'}))
        self.assertEqual(PortraitAsset.objects.get(pk=live['id']).status, 'Active')


class ManagedModeTests(RouteBase):
    @MANAGED
    def test_with_the_automatic_pool_on_neither_registration_nor_remote_delete_runs(self):
        group = self.group(byteplusGroupId='group-1')
        with patch('apps.assets.portraits.get_client', return_value=BytePlusClient({**CONFIG, 'is_mock': True})):
            response = self.post({'referenceId': self.reference(), 'groupId': group['id']})
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('registrationError', response.json())
            self.assertNotIn('remoteVerification', response.json()['asset'])
            asset = response.json()['asset']
            deleted = self.client.delete(f'{PORTRAITS}/{group["id"]}/assets?assetId={asset["id"]}')
        self.assertEqual((deleted.status_code, deleted.json()), (200, {'ok': True}))
        self.assertFalse(PortraitAsset.objects.exists(), 'the plain route deletes the row')
        self.assertEqual((self.registrar.calls, self.deleter.calls), ([], []))
        with patch.object(portrait_registration.DjangoStore, 'confirm_own') as confirm, \
                patch('apps.assets.portrait_sync._reconcile', return_value={'assets': [{'remoteVerification': 'active'}]}):
            portrait_sync.reconcile(None, None)
        confirm.assert_not_called()


class ReconcileConfirmationTests(TestCase):
    def acknowledged(self, group, remote_id, status='Processing'):
        marker = {'version': 1, 'state': 'ACKNOWLEDGED', 'remote_id': remote_id, 'remote_group_id': group['byteplusGroupId']}
        return db.upsert_portrait_asset({'id': str(uuid.uuid4()), 'groupId': group['id'], 'byteplusAssetId': remote_id, 'imageUrl': '/api/media/assets/' + remote_id,
                                         'status': status, 'statusMessage': json.dumps(marker, sort_keys=True)})

    @LIFECYCLE
    def test_a_complete_inventory_confirms_only_our_acknowledged_processing_rows(self):
        group = db.upsert_portrait_group({'id': str(uuid.uuid4()), 'name': 'Hero', 'byteplusGroupId': 'group-1'})
        active, failed, unverified = (self.acknowledged(group, remote_id) for remote_id in ('asset-a', 'asset-f', 'asset-u'))
        listed = {'assets': [{**active, 'remoteVerification': 'active'}, {**failed, 'remoteVerification': 'failed'},
                             {**unverified, 'remoteVerification': 'unverified'}]}
        with patch('apps.assets.portrait_sync.pull_only_reconcile', return_value=listed) as pull:
            self.assertIs(portrait_sync.reconcile('project', 'client'), listed)
        pull.assert_called_once()
        statuses = dict(PortraitAsset.objects.values_list('byteplus_asset_id', 'status'))
        self.assertEqual(statuses, {'asset-a': 'Active', 'asset-f': 'Failed', 'asset-u': 'Processing'})

    @LIFECYCLE
    def test_confirmation_runs_after_the_pull_only_result_for_active_and_failed_only(self):
        listed = {'assets': [{'id': 'a', 'remoteVerification': 'active'}, {'id': 'b', 'remoteVerification': 'absent'},
                             {'id': 'c', 'remoteVerification': 'failed'}]}
        with patch('apps.assets.portrait_sync.pull_only_reconcile', return_value=listed), \
                patch.object(portrait_registration.DjangoStore, 'confirm_own', autospec=True) as confirm:
            self.assertIs(portrait_sync.reconcile('project', 'client'), listed)
        self.assertEqual([call.args[1]['id'] for call in confirm.call_args_list], ['a', 'c'])

    def test_without_the_lifecycle_reconcile_confirms_nothing(self):
        with patch('apps.assets.portrait_sync._reconcile', return_value={'assets': [{'id': 'a', 'remoteVerification': 'active'}]}), \
                patch.object(portrait_registration.DjangoStore, 'confirm_own') as confirm:
            portrait_sync.reconcile('project', 'client')
        confirm.assert_not_called()


class RejectedRegistrationDeleteTests(SimpleTestCase):
    """A portrait BytePlus definitively rejected (e.g. quota) can be deleted locally."""

    def run_delete(self, status, marker, remote_id=None):
        calls = []

        class Store:
            def group(self, gid):
                return {'id': gid, 'projectId': 'p1', 'projectName': 'default', 'byteplusGroupId': 'group-1'}

            def claim(self, asset, m):
                calls.append(('claim', m['remote_asset_id'], m['previous_status']))
                return True

            def archive(self, aid, m, receipt, outcome):
                calls.append(('archive', outcome))

            def unknown(self, aid, m):
                calls.append(('unknown',))

        class Client:
            def get_asset(self, *a, **k):
                raise AssertionError('BytePlus must not be called')
            delete_asset = get_asset

        asset = {'id': 'a1', 'groupId': 'g1', 'status': status, 'statusMessage': json.dumps(marker),
                 'byteplusAssetId': remote_id, 'imageUrl': '/api/media/uploads/portrait/x'}
        try:
            return delete_once(asset, 'actor', project_id='p1', group_id='g1', store=Store(), client=Client()), calls
        except DeleteHold as exc:
            return str(exc), calls

    def test_rejected_without_remote_asset_is_deleted_locally(self):
        result, calls = self.run_delete('RegistrationFailed', {'state': 'REJECTED', 'error_code': 'QuotaSharedPoolExceeded'})
        self.assertEqual(result['remoteDeletion'], 'not_registered')
        self.assertEqual(calls, [('claim', None, 'RegistrationFailed'), ('archive', 'not_registered')])

    def test_uncertain_or_remote_registrations_stay_held(self):
        for status, marker, remote in (('RegistrationUnknown', {'state': 'REJECTED'}, None),
                                       ('RegistrationPending', {}, None),
                                       ('RegistrationFailed', {'state': 'FAILED_UNVERIFIED'}, None),
                                       ('RegistrationFailed', {'state': 'REJECTED'}, 'asset-9'),
                                       ('RegistrationFailed', {'state': 'SUBMISSION_UNCERTAIN'}, None)):
            result, calls = self.run_delete(status, marker, remote)
            self.assertIsInstance(result, str, (status, marker, remote))
            self.assertEqual(calls, [])
