"""Goal 2 portrait attribution, typed session and read-only viewer boundaries."""
import uuid
from unittest.mock import Mock, patch
import tempfile
from datetime import timedelta
from urllib.parse import urlsplit, parse_qs
from django.utils import timezone
from apps.media.models import UploadSession
from apps.media.storage import StorageService, FileSystemAdapter
from apps.media.grants import verify_media_grant
from django.test import TestCase, override_settings
from rest_framework.test import APIRequestFactory
from apps.authentication.models import User
from apps.media.uploads import UploadError
from . import portrait_db as db
from .portraits import upload, group_assets
from .portrait_sync import sync_portraits, inventory_portraits

class Goal2PortraitTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create(id=uuid.uuid4(), email='portrait@example.invalid', name='Portrait Artist', password_hash='fixture', password_salt='fixture', created_at=1)
        self.group = db.upsert_portrait_group({'id':str(uuid.uuid4()),'name':'Characters'})
        self.asset = {'id':str(uuid.uuid4()),'groupId':self.group['id'],'name':'Face','imageUrl':'/api/media/face.png','status':'Active'}

    def test_attribution_unknown_then_preserved_through_remote_upsert(self):
        self.assertIsNone(db.upsert_portrait_asset(self.asset)['uploader'])
        known = db.upsert_portrait_asset({**self.asset,'createdById':str(self.actor.id)})
        self.assertEqual(known['uploader']['name'], 'Portrait Artist')
        self.assertEqual(db.upsert_portrait_asset(self.asset)['createdById'],str(self.actor.id))
        self.actor.is_active=False;self.actor.save()
        self.assertIsNone(db.get_portrait_asset(self.asset['id'])['uploader'])

    @override_settings(LOCAL_DATA_MODE='read_only_viewer')
    def test_viewer_get_never_initializes_provider_or_reconciles(self):
        db.upsert_portrait_asset(self.asset)
        with patch('apps.assets.portrait_sync.get_client', side_effect=AssertionError('provider read')):
            self.assertEqual(len(sync_portraits()['assets']),1)
            self.assertEqual(len(inventory_portraits()['assets']),1)
        with patch('apps.assets.portraits.lookup',return_value=self.actor), patch('apps.assets.portraits.get_client',side_effect=AssertionError('provider read')):
            response=group_assets(APIRequestFactory().get('/'),id=self.group['id'])
            self.assertEqual(response.status_code,200)

    def test_upload_reference_handshake_is_actor_and_portrait_scoped(self):
        request=APIRequestFactory().post('/',{'referenceId':str(uuid.uuid4()),'groupId':self.group['id']},format='json')
        with patch('apps.assets.portraits.lookup',return_value=self.actor), patch('apps.assets.portraits.resolve_ready_upload',side_effect=UploadError('UPLOAD_PURPOSE_MISMATCH',403)) as resolve, patch('apps.assets.portraits.get_client') as provider:
            response=upload(request)
            self.assertEqual(response.status_code,403)
            resolve.assert_called_once_with(self.actor.id,request.data['referenceId'] if hasattr(request,'data') else resolve.call_args.args[1],purposes={'portrait'})
            provider.assert_not_called()

    @override_settings(PUBLIC_APP_URL='http://127.0.0.1:9876')
    def test_new_staged_portrait_provider_gets_usable_actor_grant(self):
        for route in ('upload', 'group'):
            ready = UploadSession.objects.create(actor_id=self.actor.id, key=f'uploads/{uuid.uuid4()}/portrait.png', purpose='portrait', content_type='image/png', byte_size=8, state='ready', finalized_at=timezone.now(), expires_at=timezone.now()+timedelta(hours=1))
            with tempfile.TemporaryDirectory() as directory:
                storage = StorageService(FileSystemAdapter(directory))
                storage.primary.put(ready.key,b'fixture!', 'image/png','private')
                # READY uploads are readable (signed) by any actor under the shared policy.
                self.assertTrue(storage.signed_read_url(ready.key,3600,actor_id=uuid.uuid4()))
                provider = Mock(is_mock=True)
                provider.create_asset_group.return_value={'Id':'group-mock'}
                provider.create_asset.return_value={'Id':f'asset-{route}', 'Status':'Active'}
                request = APIRequestFactory().post('/', {'referenceId':str(ready.id),'groupId':self.group['id']},format='json')
                with patch('apps.assets.portraits.lookup',return_value=self.actor), patch('apps.assets.portraits.get_client',return_value=provider), patch('apps.assets.portrait_sync.get_storage',return_value=storage):
                    response = upload(request) if route == 'upload' else group_assets(request,id=self.group['id'])
                self.assertEqual(response.status_code,200)
                asset = response.data['asset'] if route == 'upload' else response.data
                self.assertEqual(asset['byteplusAssetId'],f'asset-{route}')
                signed = provider.create_asset.call_args.args[1]
                token = parse_qs(urlsplit(signed).query)['t'][0]
                self.assertEqual(verify_media_grant(token),ready.key)
                self.assertIn(str(self.actor.id),token)
