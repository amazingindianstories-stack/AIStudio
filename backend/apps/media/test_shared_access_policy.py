"""Shared-studio media policy: allow/deny matrix and bounded derivatives."""
import io
import tempfile
import threading
from datetime import timedelta
from unittest.mock import patch
from uuid import uuid4
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from PIL import Image
from apps.authentication.models import User
from apps.authentication.session import sign_session
from .derivatives import bounded_derivative, MAX_INPUT_BYTES
from .grants import authorize_owned_upload_read, authorize_upload_read
from .models import UploadSession
from .storage import FileSystemAdapter, MemoryAdapter, StorageService
from .uploads import UploadError, resolve_owned_ready_upload, resolve_ready_upload


def png(size=(64, 48)):
    out = io.BytesIO()
    Image.new('RGB', size, (200, 30, 30)).save(out, format='PNG')
    return out.getvalue()


class SignedRedirectStorage(StorageService):
    def browser_url(self, key):
        return f'https://storage.invalid/signed/{key}?X-Goog-Expires=900'


class SharedMediaPolicyTests(TransactionTestCase):
    def setUp(self):
        self.owner = User.objects.create(id=uuid4(), email='owner@example.test', name='Owner',
            role='user', password_hash='x', password_salt='', created_at=1)
        self.other = User.objects.create(id=uuid4(), email='peer@example.test', name='Peer',
            role='user', password_hash='x', password_salt='', created_at=1)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.storage = StorageService(FileSystemAdapter(self.temporary.name))
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'

    def upload(self, *, state='ready', finalized=True, purpose='image-reference', actor=None):
        key = f'uploads/{purpose}/{uuid4()}'
        self.storage.primary.put(key, png(), 'image/png', 'private, no-store')
        return UploadSession.objects.create(actor_id=(actor or self.owner).id, key=key, purpose=purpose,
            content_type='image/png', byte_size=10, state=state,
            finalized_at=timezone.now() if finalized else None, expires_at=timezone.now()+timedelta(hours=1))

    def get(self, user, key, **params):
        if user is None:
            self.client.cookies.pop('veevee_session', None)
        else:
            self.client.cookies['veevee_session'] = sign_session(user)
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            response = self.client.get('/api/media/' + key, params)
        if hasattr(response, 'close'):
            response.close()
        return response.status_code

    def test_media_route_matrix(self):
        ready = self.upload()
        unready = self.upload(state='uploading', finalized=False)
        cancelled = self.upload(state='cancelled')
        for user in (self.owner, self.other):
            self.assertEqual(self.get(user, ready.key, inline='1'), 200)
            self.assertEqual(self.get(user, unready.key, inline='1'), 404)
            self.assertEqual(self.get(user, cancelled.key, inline='1'), 404)
            self.assertEqual(self.get(user, 'exports/' + str(uuid4()) + '.zip', inline='1'), 404)
        self.assertEqual(self.get(None, ready.key, inline='1'), 401)

    def test_signed_redirect_is_never_cached(self):
        ready = self.upload()
        storage = SignedRedirectStorage(self.storage.primary)
        self.client.cookies['veevee_session'] = sign_session(self.other)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            response = self.client.get('/api/media/' + ready.key)
        self.assertEqual(response.status_code, 307)
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertTrue(response['Location'].startswith('https://storage.invalid/signed/'))

    def test_reference_resolution_shared_but_registration_and_exports_owner_only(self):
        ready = self.upload()
        self.assertEqual(resolve_ready_upload(self.other.id, str(ready.id)).id, ready.id)
        self.assertEqual(authorize_upload_read(ready.key, self.other.id).id, ready.id)
        with self.assertRaises(UploadError) as caught:
            resolve_owned_ready_upload(self.other.id, str(ready.id))
        self.assertEqual(caught.exception.code, 'UPLOAD_NOT_FOUND')
        with self.assertRaises(ValueError):
            authorize_owned_upload_read(ready.key, self.other.id)
        self.assertEqual(authorize_owned_upload_read(ready.key, self.owner.id).id, ready.id)

    def test_shared_resolution_keeps_state_and_purpose_checks(self):
        cases = [(self.upload(state='uploading', finalized=False), 'UPLOAD_NOT_READY', None),
                 (self.upload(state='cancelled'), 'UPLOAD_CANCELLED', None),
                 (self.upload(purpose='video-reference'), 'UPLOAD_PURPOSE_MISMATCH', {'image-reference'})]
        for row, code, purposes in cases:
            with self.assertRaises(UploadError) as caught:
                resolve_ready_upload(self.other.id, str(row.id), purposes=purposes)
            self.assertEqual(caught.exception.code, code)
        with self.assertRaises(ValueError):
            authorize_upload_read(cases[0][0].key, self.other.id)


class BoundedDerivativeTests(TransactionTestCase):
    def storage_with(self, key, data, content_type='image/png'):
        storage = StorageService(MemoryAdapter())
        storage.primary.put(key, data, content_type, 'private')
        return storage

    def test_creates_derivative_once_and_reuses_it(self):
        storage = self.storage_with('generated/a.png', png((900, 600)))
        target, fresh = bounded_derivative(storage, 'generated/a.png', 512)
        self.assertEqual(target, 'thumbs/512/generated/a.png.webp')
        self.assertTrue(fresh)
        self.assertEqual(bounded_derivative(storage, 'generated/a.png', 512), (target, None))
        self.assertEqual(storage.primary.objects['generated/a.png'][0][:8], b'\x89PNG\r\n\x1a\n')

    def test_non_image_oversize_and_busy_fall_back_to_original(self):
        storage = self.storage_with('generated/v.mov', b'mov-bytes', 'video/quicktime')
        self.assertEqual(bounded_derivative(storage, 'generated/v.mov', 512), ('generated/v.mov', None))
        big = self.storage_with('generated/big.png', png())
        with patch('apps.media.derivatives.MAX_INPUT_BYTES', 10):
            self.assertEqual(bounded_derivative(big, 'generated/big.png', 512), ('generated/big.png', None))
        gate = threading.BoundedSemaphore(1)
        gate.acquire()
        busy = self.storage_with('generated/b.png', png())
        self.assertEqual(bounded_derivative(busy, 'generated/b.png', 512, gate=gate), ('generated/b.png', None))
        self.assertNotIn('thumbs/512/generated/b.png.webp', busy.primary.objects)

    def test_create_only_never_overwrites_existing_derivative(self):
        storage = self.storage_with('generated/c.png', png())
        existing = b'existing-derivative'

        def racing_encode(data, width):
            storage.primary.put('thumbs/512/generated/c.png.webp', existing, 'image/webp', 'private')
            return b'new-derivative'
        target, fresh = bounded_derivative(storage, 'generated/c.png', 512, encode=racing_encode)
        self.assertEqual((target, fresh), ('thumbs/512/generated/c.png.webp', None))
        self.assertEqual(storage.primary.objects['thumbs/512/generated/c.png.webp'][0], existing)

    def test_decode_failure_returns_original(self):
        storage = self.storage_with('generated/bad.png', b'\x89PNG\r\n\x1a\nnot-really')
        self.assertEqual(bounded_derivative(storage, 'generated/bad.png', 512), ('generated/bad.png', None))
        self.assertLess(len(b'x'), MAX_INPUT_BYTES)


class MediaResolveTests(SharedMediaPolicyTests):
    def resolve(self, user, items):
        import json as _json
        storage = SignedRedirectStorage(self.storage.primary)
        if user is None:
            self.client.cookies.pop('veevee_session', None)
        else:
            self.client.cookies['veevee_session'] = sign_session(user)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            return self.client.post('/api/media-resolve', _json.dumps({'items': items}), content_type='application/json')

    def test_batch_resolution_follows_the_media_policy(self):
        ready = self.upload()
        unready = self.upload(state='uploading', finalized=False)
        self.storage.primary.put('generated/a.png', png((900, 600)), 'image/png', 'private')
        self.storage.primary.put('thumbs/512/generated/a.png.webp', b'thumb', 'image/webp', 'private')
        response = self.resolve(self.other, [
            {'ref': '/api/media/' + ready.key}, {'ref': '/api/media/' + unready.key},
            {'ref': '/api/media/exports/' + str(uuid4()) + '.zip'}, {'ref': 'https://elsewhere.example/a.png'},
            {'ref': '/api/media/generated/a.png', 'width': 400}, {'ref': '/api/media/generated/b.png', 'width': 400}])
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        urls = [item['url'] for item in response.json()['items']]
        self.assertTrue(urls[0].startswith('https://storage.invalid/signed/uploads/'))
        self.assertEqual(urls[1:4], [None, None, None])
        self.assertEqual(urls[4], 'https://storage.invalid/signed/thumbs/512/generated/a.png.webp?X-Goog-Expires=900')
        self.assertIsNone(urls[5])  # no derivative yet: the client uses /api/media, which creates it
        self.assertGreater(response.json()['items'][0]['expiresAt'], 0)

    def test_limits_and_authentication(self):
        self.assertEqual(self.resolve(None, []).status_code, 401)
        self.assertEqual(self.resolve(self.owner, [{'ref': '/api/media/x'}] * 101).status_code, 400)
