from datetime import timedelta
from uuid import uuid4
from django.test import TransactionTestCase
from django.utils import timezone
from apps.admin_dashboard.tests import SettingsTests
from apps.media.models import UploadSession
from apps.authentication.models import User
from .models import Asset


class MaterialSessionTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def upload(self, actor, purpose='material', state='ready'):
        return UploadSession.objects.create(actor_id=actor, key='uploads/material/' + str(uuid4()),
            purpose=purpose, state=state, content_type='image/png', byte_size=123,
            expires_at=timezone.now() + timedelta(hours=1),
            finalized_at=timezone.now() if state == 'ready' else None)

    def save(self, image):
        return self.client.post('/api/assets', {'name': 'Sheet', 'kind': 'character', 'image': image}, content_type='application/json')

    def test_publish_only_owned_ready_material_and_show_uploader(self):
        self.cookie()
        actor = User.objects.get(email='fixture@example.invalid')
        upload = self.upload(actor.id)
        response = self.save({'referenceId': str(upload.id)})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['images'], ['/api/media/' + upload.key])
        self.assertEqual(response.json()['createdById'], str(actor.id))
        self.assertEqual(response.json()['uploader']['name'], actor.name)
        self.assertEqual(Asset.objects.get().created_by_id, actor.id)

    def test_other_actor_ready_material_is_shared(self):
        self.cookie()
        upload = self.upload(uuid4())
        response = self.save({'referenceId': str(upload.id)})
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['images'], ['/api/media/' + upload.key])

    def test_wrong_purpose_and_unready_rejected(self):
        self.cookie()
        actor = User.objects.get(email='fixture@example.invalid')
        for upload, status in [(self.upload(uuid4(), 'image-reference'), 403), (self.upload(actor.id, 'image-reference'), 403), (self.upload(actor.id, state='uploading'), 409), (self.upload(uuid4(), state='uploading'), 409)]:
            self.assertEqual(self.save({'referenceId': str(upload.id)}).status_code, status)
            self.assertEqual(self.save('/api/media/' + upload.key).status_code, status)
        self.assertFalse(Asset.objects.exists())

    def test_historical_uploader_is_unknown_and_invalid_manifest_is_client_error(self):
        self.cookie()
        self.assertEqual(self.save({'referenceId': 'bad'}).status_code, 400)
        asset = Asset.objects.create(name='Old', slug='old', kind='other', images=['/api/media/assets/old.png'], created_at=1, updated_at=1)
        response = self.client.get('/api/assets').json()['assets'][0]
        self.assertIsNone(response['createdById'])
        self.assertIsNone(response['uploader'])
        asset.refresh_from_db()
        self.assertIsNone(asset.created_by_id)
