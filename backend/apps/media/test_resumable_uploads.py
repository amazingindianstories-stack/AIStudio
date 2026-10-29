"""Offline qualification of the native GCS protocol and isolated local equivalent."""
import hashlib
import io
import tempfile
from datetime import timedelta
from unittest.mock import Mock, patch
from uuid import uuid4
from django.test import TransactionTestCase, RequestFactory, override_settings
from django.utils import timezone
from apps.authentication.models import User
from apps.authentication.session import sign_session
from .models import UploadSession
from .storage import FileSystemAdapter, GCSAdapter, StorageService
from .uploads import (initialize_upload, finalize_upload, upload_status, stream_local_chunk, store_upload,
    resolve_ready_upload, cancel_upload, cleanup_expired_uploads, UploadError, CHUNK_BYTES)

PNG = b'\x89PNG\r\n\x1a\n'+b'fixture'


class ResumableUploadTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(id=uuid4(), email='upload@example.test', name='Uploader',
            role='user', password_hash='x', password_salt='', created_at=1)
        self.other = User.objects.create(id=uuid4(), email='other@example.test', name='Other',
            role='user', password_hash='x', password_salt='', created_at=1)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.storage = StorageService(FileSystemAdapter(self.temporary.name))
        self.factory = RequestFactory()

    def begin(self, data=PNG, **kwargs):
        body = {'purpose': 'image-reference', 'contentType': 'image/png', 'byteSize': len(data),
            'filename': 'image.png', 'requestKey': str(uuid4()), **kwargs}
        return initialize_upload(self.user.id, body, self.storage), body

    def chunk(self, session, data, start=0, size=None):
        size = size or session['byteSize']
        request = self.factory.put('/fixture', data=data, content_type=session['contentType'],
            HTTP_CONTENT_RANGE=f'bytes {start}-{start+len(data)-1}/{size}')
        return stream_local_chunk(self.user.id, session['uploadId'], request, self.storage)

    def assertCode(self, code, callback, *args, **kwargs):
        with self.assertRaises(UploadError) as caught:
            callback(*args, **kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_metadata_handshake_preserves_bytes_and_reuses_ready_reference(self):
        session, body = self.begin(sha256=hashlib.sha256(PNG).hexdigest())
        self.assertEqual(self.chunk(session, PNG), (200, len(PNG)))
        result = finalize_upload(self.user.id, session['uploadId'], self.storage)
        self.assertEqual(result['state'], 'ready')
        self.assertEqual(result['referenceId'], session['uploadId'])
        self.assertEqual(finalize_upload(self.user.id, session['uploadId'], self.storage), result)
        self.assertEqual(initialize_upload(self.user.id, body, self.storage), result)
        media = self.storage.open(result['key'])
        try:
            self.assertEqual(b''.join(media.stream), PNG)
        finally:
            media.stream.close()
        self.assertEqual(resolve_ready_upload(self.user.id, result['referenceId']).key, result['key'])

    def test_resumable_large_original_exceeds_32mib_without_json_bytes(self):
        size = 33*1024*1024+123
        session, body = self.begin(b'x', purpose='video-reference', contentType='video/quicktime', byteSize=size,
            filename='original.mov')
        digest = hashlib.sha256()
        offset = 0
        while offset < size:
            length = min(CHUNK_BYTES, size-offset)
            data = (b'\x00\x00\x00\x18ftypqt  '+b'x'*(length-12)) if offset == 0 else b'x'*length
            digest.update(data)
            status, accepted = self.chunk(session, data, offset, size)
            offset += length
            self.assertEqual(accepted, offset)
            self.assertEqual(status, 200 if offset == size else 308)
        ready = finalize_upload(self.user.id, session['uploadId'], self.storage)
        row = UploadSession.objects.get(id=session['uploadId'])
        self.assertEqual(row.sha256, digest.hexdigest())
        self.assertEqual(ready['contentType'], 'video/quicktime')
        self.assertLess(len(str(body)), 1024)

    def test_308_offset_query_and_lost_ack_resume(self):
        data = PNG+b'x'*(256*1024-len(PNG))+b'final'
        session, _ = self.begin(data)
        self.assertEqual(self.chunk(session, data[:256*1024]), (308, 256*1024))
        request = self.factory.put('/fixture', data=b'', HTTP_CONTENT_RANGE=f'bytes */{len(data)}')
        self.assertEqual(stream_local_chunk(self.user.id, session['uploadId'], request, self.storage), (308, 256*1024))
        self.assertEqual(upload_status(self.user.id, session['uploadId'], self.storage)['uploadedBytes'], 256*1024)
        self.assertCode('UPLOAD_OFFSET_CONFLICT', self.chunk, session, data[:256*1024])
        self.assertEqual(self.chunk(session, data[256*1024:], 256*1024), (200, len(data)))
        # Last-chunk ACK can also be lost; retry/query reports complete.
        self.assertEqual(stream_local_chunk(self.user.id, session['uploadId'], request, self.storage), (200, len(data)))
        self.assertEqual(upload_status(self.user.id, session['uploadId'], self.storage)['uploadedBytes'], len(data))

    def test_owner_scope_expiry_and_purpose_do_not_weaken_authorization(self):
        session, _ = self.begin()
        for function in (upload_status, finalize_upload):
            self.assertCode('UPLOAD_NOT_FOUND', function, self.other.id, session['uploadId'], self.storage)
        self.assertCode('UPLOAD_NOT_READY', resolve_ready_upload, self.user.id, session['referenceId'])
        self.chunk(session, PNG)
        finalize_upload(self.user.id, session['uploadId'], self.storage)
        # Shared READY reference for other actors; status/finalize above stay owner-only.
        self.assertEqual(str(resolve_ready_upload(self.other.id, session['referenceId']).id), session['referenceId'])
        self.assertCode('UPLOAD_PURPOSE_MISMATCH', resolve_ready_upload, self.user.id, session['referenceId'], purposes={'portrait'})
        expired, _ = self.begin()
        UploadSession.objects.filter(id=expired['uploadId']).update(expires_at=timezone.now()-timedelta(seconds=1))
        self.assertCode('UPLOAD_EXPIRED', finalize_upload, self.user.id, expired['uploadId'], self.storage)

    def test_integrity_rejects_mime_size_and_checksum_corruption(self):
        for kind, expected in (('size', 'UPLOAD_SIZE_MISMATCH'), ('mime', 'UPLOAD_CONTENT_TYPE_MISMATCH'),
                               ('signature', 'UPLOAD_SIGNATURE_MISMATCH'), ('checksum', 'UPLOAD_CHECKSUM_MISMATCH')):
            session, _ = self.begin(sha256='0'*64 if kind == 'checksum' else '')
            content = b'X'*len(PNG) if kind == 'signature' else PNG+b'x' if kind == 'size' else PNG
            self.storage.primary.put(session['key'], content, 'image/jpeg' if kind == 'mime' else 'image/png', '')
            self.assertCode(expected, finalize_upload, self.user.id, session['uploadId'], self.storage)
            self.assertIsNone(UploadSession.objects.get(id=session['uploadId']).finalized_at)

    def test_admission_idempotency_quota_and_50_metadata_sessions(self):
        session, body = self.begin()
        self.assertEqual(initialize_upload(self.user.id, body, self.storage)['uploadId'], session['uploadId'])
        self.assertCode('UPLOAD_IDEMPOTENCY_CONFLICT', initialize_upload, self.user.id,
            {**body, 'byteSize': len(PNG)+1}, self.storage)
        for _ in range(49): self.begin()
        self.assertEqual(UploadSession.objects.filter(actor_id=self.user.id).count(), 50)
        with override_settings(VEEVEE_UPLOAD_MAX_INFLIGHT=50):
            self.assertCode('UPLOAD_INFLIGHT_LIMIT', self.begin)
        with override_settings(VEEVEE_UPLOAD_INFLIGHT_BYTES=1):
            self.assertCode('UPLOAD_QUOTA_EXCEEDED', self.begin)

    def test_gcs_contract_uses_exact_size_origin_precondition_and_encrypted_uri(self):
        blob = Mock()
        blob.create_resumable_upload_session.return_value = 'https://storage.googleapis.com/private-bearer'
        client = Mock()
        client.bucket.return_value.blob.return_value = blob
        adapter = GCSAdapter(client, 'fixture-bucket')
        storage = StorageService(adapter)
        body = {'purpose':'image-reference', 'contentType':'image/png', 'byteSize':len(PNG), 'requestKey':'same'}
        result = initialize_upload(self.user.id, body, storage, origin='http://localhost:3000')
        self.assertEqual(result['uploadUrl'], blob.create_resumable_upload_session.return_value)
        blob.create_resumable_upload_session.assert_called_once_with(content_type='image/png', size=len(PNG),
            origin='http://localhost:3000', if_generation_match=0, timeout=15)
        row = UploadSession.objects.get(id=result['uploadId'])
        self.assertNotIn('private-bearer', row.session_uri)
        self.assertEqual(upload_status(self.user.id, row.id, storage)['uploadUrl'], result['uploadUrl'])
        initialize_upload(self.user.id, body, storage)
        self.assertEqual(blob.create_resumable_upload_session.call_count, 1)

    def test_server_side_store_uses_the_session_checks_replays_and_deletes_rejected_bytes(self):
        body = {'purpose': 'image-reference', 'contentType': 'image/png', 'byteSize': len(PNG), 'filename': 'image.png',
                'sha256': hashlib.sha256(PNG).hexdigest(), 'requestKey': 'server-side'}
        result = store_upload(self.user.id, body, io.BytesIO(PNG), self.storage)
        self.assertEqual((result['state'], result['byteSize']), ('ready', len(PNG)))
        self.assertEqual(self.storage.read(result['key']), PNG)
        self.assertEqual(store_upload(self.user.id, body, io.BytesIO(PNG), self.storage), result)
        self.assertEqual(UploadSession.objects.count(), 1)
        bad = {**body, 'requestKey': 'server-side-bad', 'sha256': ''}
        self.assertCode('UPLOAD_SIGNATURE_MISMATCH', store_upload, self.user.id, {**bad, 'byteSize': 7}, io.BytesIO(b'garbage'), self.storage)
        row = UploadSession.objects.get(request_key='server-side-bad')
        self.assertEqual(row.state, 'cancelled')
        self.assertFalse(self.storage.primary._path(row.key).exists())
        # On GCS the server writes the object itself: no browser session is opened, and an unfinished replay has no URI.
        blob, client = Mock(), Mock()
        client.bucket.return_value.blob.return_value = blob
        gcs = StorageService(GCSAdapter(client, 'fixture-bucket'))
        session = initialize_upload(self.user.id, {**body, 'requestKey': 'gcs-server-side'}, gcs, server_side=True)
        blob.create_resumable_upload_session.assert_not_called()
        self.assertNotIn('uploadUrl', session)
        self.assertNotIn('uploadUrl', upload_status(self.user.id, session['uploadId'], gcs))

    def test_cancel_and_ttl_collect_only_unpublished_new_objects(self):
        ready, _ = self.begin()
        self.chunk(ready, PNG)
        finalize_upload(self.user.id, ready['uploadId'], self.storage)
        expired, _ = self.begin()
        self.storage.primary.put(expired['key'], PNG, 'image/png', '')
        self.storage.primary.put('assets/legacy-original.png', PNG, 'image/png', '')
        UploadSession.objects.filter(id=expired['uploadId']).update(expires_at=timezone.now()-timedelta(seconds=1))
        self.assertEqual(cleanup_expired_uploads(self.storage), 1)
        self.assertTrue(self.storage.exists(ready['key']))
        self.assertTrue(self.storage.exists('assets/legacy-original.png'))
        self.assertFalse(self.storage.exists(expired['key']))
        self.assertEqual(cancel_upload(self.user.id, expired['uploadId'], self.storage)['state'], 'cancelled')
        self.assertCode('UPLOAD_ALREADY_READY', cancel_upload, self.user.id, ready['uploadId'], self.storage)

    def test_endpoints_metadata_authenticated_no_store_and_finalize(self):
        token = sign_session(self.user)
        self.client.cookies['veevee_session'] = token
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            result = self.client.post('/api/uploads/init', {'purpose':'image-reference', 'contentType':'image/png',
                'byteSize':len(PNG)}, content_type='application/json')
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result['Cache-Control'], 'private, no-store')
            session = result.json()
            response = self.client.put(session['uploadUrl'], PNG, content_type='image/png',
                HTTP_CONTENT_RANGE=f'bytes 0-{len(PNG)-1}/{len(PNG)}')
            self.assertEqual(response.status_code, 200)
            result = self.client.post(f'/api/uploads/{session["uploadId"]}/finalize', {}, content_type='application/json')
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['state'], 'ready')

    def test_new_private_grants_require_actor_ready_and_preserve_legacy_tokens(self):
        from .grants import sign_media_grant, verify_media_grant
        session, _ = self.begin()
        with self.assertRaises(ValueError):
            sign_media_grant(session['key'], actor_id=self.user.id)
        self.chunk(session, PNG)
        finalize_upload(self.user.id, session['uploadId'], self.storage)
        # Shared READY policy: other actors may obtain a read grant once the upload is READY.
        self.assertEqual(verify_media_grant(sign_media_grant(session['key'], actor_id=self.other.id)), session['key'])
        token = sign_media_grant(session['key'], actor_id=self.user.id)
        self.assertEqual(len(token.split('.')), 4)
        self.assertEqual(verify_media_grant(token), session['key'])
        self.assertEqual(len(sign_media_grant('generated/legacy.mov').split('.')), 3)
        self.assertIsNone(verify_media_grant(token+'x'))
        # A formerly READY reference cannot outlive removal/revocation.
        UploadSession.objects.filter(id=session['uploadId']).update(state='cancelled')
        self.assertIsNone(verify_media_grant(token))

    def test_media_route_hides_private_and_unfinalized_new_staging(self):
        session, _ = self.begin()
        self.chunk(session, PNG)
        self.client.cookies['veevee_session'] = sign_session(self.user)
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            self.assertEqual(self.client.get('/api/media/'+session['key']).status_code, 404)
            finalize_upload(self.user.id, session['uploadId'], self.storage)
            response = self.client.get('/api/media/'+session['key']+'?inline=1')
            self.assertEqual(response.status_code, 200)
            response.close()
            self.client.cookies['veevee_session'] = sign_session(self.other)
            shared = self.client.get('/api/media/'+session['key'])
            self.assertEqual(shared.status_code, 200)
            shared.close()
            from apps.assets.models import Asset
            Asset.objects.create(id=uuid4(), name='Published material', slug='published', kind='other',
                images=['/api/media/'+session['key']], created_at=1, updated_at=1)
            response = self.client.get('/api/media/'+session['key']+'?inline=1')
            self.assertEqual(response.status_code, 200)
            response.close()

    def test_simultaneous_duplicate_finalize_returns_one_ready_identity(self):
        from concurrent.futures import ThreadPoolExecutor
        from django.db import close_old_connections, connections
        session, _ = self.begin()
        self.chunk(session, PNG)
        def finish():
            close_old_connections()
            try:
                return finalize_upload(self.user.id, session['uploadId'], self.storage)
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: finish(), range(2)))
        self.assertEqual(results[0], results[1])
        self.assertEqual(UploadSession.objects.filter(id=session['uploadId'], state='ready').count(), 1)

    def test_incomplete_chunk_rolls_back_offset_and_small_metadata_limit_is_explicit(self):
        session, _ = self.begin()
        request = self.factory.put('/fixture', data=PNG[:-1], content_type='image/png',
            HTTP_CONTENT_RANGE=f'bytes 0-{len(PNG)-1}/{len(PNG)}', CONTENT_LENGTH=str(len(PNG)))
        # Actual socket streams return EOF on truncated bodies; Django's test
        # FakePayload raises an assertion instead, so model that socket behavior.
        request._stream = io.BytesIO(PNG[:-1])
        self.assertCode('UPLOAD_CHUNK_LENGTH_MISMATCH', stream_local_chunk,
            self.user.id, session['uploadId'], request, self.storage)
        self.assertEqual(upload_status(self.user.id, session['uploadId'], self.storage)['uploadedBytes'], 0)
        self.client.cookies['veevee_session'] = sign_session(self.user)
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            response = self.client.post('/api/uploads/init', {'dataUrl':'x'*5000}, content_type='application/json')
            self.assertEqual(response.status_code, 413)
            self.assertEqual(response.json()['error'], 'UPLOAD_METADATA_TOO_LARGE')

    def test_goal3_thumbnail_grants_and_metadata_reinit_boundaries(self):
        from .grants import sign_media_grant, verify_media_grant
        session, body = self.begin()
        for field, value in (('filename','other.png'), ('contentType','image/jpeg')):
            self.assertCode('UPLOAD_IDEMPOTENCY_CONFLICT', initialize_upload,
                self.user.id, {**body, field:value}, self.storage)
        self.chunk(session, PNG)
        finalize_upload(self.user.id, session['uploadId'], self.storage)
        derivative = 'thumbs/512/'+session['key']+'.webp'
        self.assertTrue(sign_media_grant(derivative, actor_id=self.other.id))
        token = sign_media_grant(derivative, actor_id=self.user.id, ttl_seconds=300, now=1000)
        self.assertEqual(verify_media_grant(token, now=301000), derivative)
        self.assertIsNone(verify_media_grant(token, now=301001))

    def test_goal3_gcs_session_redirect_is_never_followed_on_cancel(self):
        blob, client = Mock(), Mock()
        client.bucket.return_value.blob.return_value = blob
        blob.create_resumable_upload_session.return_value = 'https://storage.googleapis.com/upload?id=opaque'
        storage = StorageService(GCSAdapter(client, 'fixture'))
        body = {'purpose':'image-reference', 'contentType':'image/png', 'byteSize':len(PNG), 'requestKey':'cancel'}
        result = initialize_upload(self.user.id, body, storage)
        with patch('requests.delete', return_value=Mock(status_code=307)) as delete:
            self.assertCode('UPLOAD_CANCEL_UNAVAILABLE', cancel_upload, self.user.id, result['uploadId'], storage)
            delete.assert_called_once_with(blob.create_resumable_upload_session.return_value,
                timeout=15, allow_redirects=False)
        self.assertEqual(UploadSession.objects.get(id=result['uploadId']).state, 'uploading')

    def test_goal3_untrusted_sdk_session_is_not_saved(self):
        client = Mock()
        client.bucket.return_value.blob.return_value.create_resumable_upload_session.return_value = 'https://attacker.example/upload'
        with self.assertRaises(ValueError):
            initialize_upload(self.user.id, {'purpose':'image-reference', 'contentType':'image/png',
                'byteSize':len(PNG)}, StorageService(GCSAdapter(client, 'fixture')))
        self.assertEqual(UploadSession.objects.count(), 0)
