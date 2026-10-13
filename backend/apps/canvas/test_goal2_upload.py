import tempfile
from datetime import timedelta
from uuid import uuid4
from unittest.mock import patch
from django.test import TestCase
from django.utils import timezone
from apps.authentication.models import User
from apps.media.models import UploadSession
from apps.media.storage import StorageService, FileSystemAdapter
from .models import CanvasBoard


class CanvasManifestUploadTests(TestCase):
    def test_ready_manifest_publishes_exact_bytes_and_rejects_other_actor(self):
        actor = User.objects.create(id=uuid4(), email='canvas@example.test', name='Canvas', role='user', password_hash='x', password_salt='', created_at=1)
        board = CanvasBoard.objects.create(id=uuid4(), project_id=uuid4(), name='Board', created_by=actor.id, data={}, created_at=1, updated_at=1)
        original = b'\x89PNG\r\n\x1a\n' + b'fixture-original'
        with tempfile.TemporaryDirectory() as directory:
            storage = StorageService(FileSystemAdapter(directory))
            key = f'uploads/canvas/{actor.id}-{uuid4()}'
            storage.primary.put(key, original, 'image/png', 'private')
            session = UploadSession.objects.create(actor_id=actor.id, key=key, purpose='canvas', content_type='image/png', byte_size=len(original), expires_at=timezone.now()+timedelta(hours=1), finalized_at=timezone.now(), state='ready')
            path = f'/api/canvas-boards/{board.id}/upload'
            with patch('apps.canvas.views.lookup', return_value=actor), patch('apps.media.storage.get_storage', return_value=storage):
                result = self.client.post(path, {'referenceId':str(session.id)}, content_type='application/json')
                self.assertEqual(result.status_code, 200)
                self.assertTrue(result.json()['url'].startswith(f'/api/media/canvas/{board.id}/'))
                self.assertEqual(storage.read(result.json()['url'].removeprefix('/api/media/')), original)
                # Shared studio: another actor's READY canvas upload can be placed too.
                session.actor_id=uuid4(); session.save(update_fields=['actor_id'])
                shared = self.client.post(path, {'referenceId':str(session.id)}, content_type='application/json')
                self.assertEqual(shared.status_code, 200)
                session.state='uploading'; session.finalized_at=None; session.save(update_fields=['state','finalized_at'])
                self.assertEqual(self.client.post(path, {'referenceId':str(session.id)}, content_type='application/json').status_code, 409)
