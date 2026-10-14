import base64
import hashlib
import hmac
import io
import json
from pathlib import Path
import tempfile
import time
from unittest.mock import Mock, patch
from uuid import uuid4
from django.test import SimpleTestCase, TransactionTestCase, RequestFactory, override_settings
from django.urls import path
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.generation.models import Generation
from . import views, audio
from .avatars import save_avatar_image, InvalidAvatarError, MAX_AVATAR_UPLOAD_BYTES
from .grants import sign_media_grant, verify_media_grant
from .keys import media_key_from_ref, validate_key, InvalidMediaKey
from .storage import StorageService, MemoryAdapter, FileSystemAdapter, GCSAdapter, S3Adapter, MediaNotFoundError, InvalidMediaRangeError, parse_range, get_storage
from .images import save_canvas_asset, split_data_url
from .uploads import create_upload_presign, sign_upload, verify_upload

urlpatterns = [path('api/media/<path:path>',views.media),path('api/media-grant',views.media_grant),
    path('api/uploads/presign',views.upload_presign),path('api/uploads/local',views.local_upload),
    path('api/generations/<str:id>/download',views.generation_download),path('api/audio/transcribe',audio.transcribe)]


class PrimitiveTests(SimpleTestCase):
    def test_audio_configured_transport_forwards_worker_signal(self):
        import os
        from apps.generation.providers.transport import HttpResult
        from apps.generation.services.deadline import Cancellation
        client=Mock()
        client.request.return_value=HttpResult(200,b'{"candidates":[{"content":{"parts":[{"text":"fixture transcript"}]}}]}',{})
        signal=Cancellation()
        with patch.dict(os.environ,{'GOOGLE_API_KEY':'disposable-fixture'}),patch('apps.generation.providers.transport.HttpTransport',return_value=client):
            provider=audio.configured_transcriber()
            self.assertEqual(provider.transcribe('encoded','audio/wav','fixture',signal=signal),'fixture transcript')
        self.assertIs(client.request.call_args.kwargs['signal'],signal)

    def test_audio_cancelled_input_stops_before_snapshot_read_or_provider(self):
        from types import SimpleNamespace
        from apps.generation.services.deadline import Cancellation, QueueExecutionDeadlineError
        from .audio_inputs import transcribe_audio_input
        store,provider=Mock(),Mock()
        signal=Cancellation()
        signal.cancelled.set()
        with self.assertRaises(QueueExecutionDeadlineError):
            transcribe_audio_input(SimpleNamespace(submission_input={}),provider,store,signal=signal)
        store.read_reference_bytes.assert_not_called()
        provider.transcribe.assert_not_called()

    def test_audio_transcriber_cancellation_reaches_transport_without_discarding_response(self):
        from apps.generation.services.deadline import Cancellation, QueueExecutionDeadlineError
        transport=Mock(return_value={'candidates':[{'content':{'parts':[{'text':'paid result'}]}}]})
        provider=audio.GeminiTranscriber('fixture',transport)
        signal=Cancellation()
        self.assertEqual(provider.transcribe('encoded','audio/wav','fixture',signal=signal),'paid result')
        self.assertIs(transport.call_args.kwargs['signal'],signal)
        transport.reset_mock()
        signal.cancelled.set()
        with self.assertRaises(QueueExecutionDeadlineError):
            provider.transcribe('encoded','audio/wav','fixture',signal=signal)
        transport.assert_not_called()
        active=Cancellation()
        def accepted(*args,**kwargs):
            active.cancelled.set()
            return {'candidates':[{'content':{'parts':[{'text':'accepted paid transcript'}]}}]}
        transport.side_effect=accepted
        self.assertEqual(provider.transcribe('encoded','audio/wav','fixture',signal=active),
                         'accepted paid transcript')


    def test_grant_golden_wire_contract_and_expiry(self):
        key='generated/video.mov'
        encoded=base64.urlsafe_b64encode(key.encode()).decode().rstrip('=')
        with override_settings(AUTH_SECRET='golden'):
            payload=f'{encoded}.901000'
            signature=base64.urlsafe_b64encode(hmac.new(b'golden',payload.encode(),hashlib.sha256).digest()).decode().rstrip('=')
            token=sign_media_grant(key,now=1000)
            self.assertEqual(token,payload+'.'+signature)
            self.assertEqual(verify_media_grant(token,now=901000),key)
            self.assertIsNone(verify_media_grant(token,now=901001))
            self.assertIsNone(verify_media_grant(token+'x',now=1000))

    def test_protected_and_traversal_namespace_security(self):
        for key in ('settings/token','MIGRATIONS/dump','thumbs/512/settings/token.webp',
                    'thumbs/1280/thumbs/512/settings/token.webp.webp','uploads/../settings/token',
                    'uploads/%2e%2e/settings/token','uploads/%252e%252e/settings/token',
                    '/uploads/a','uploads//a','uploads/a\\b','uploads/a\x00b'):
            with self.subTest(key=key), self.assertRaises(InvalidMediaKey):
                validate_key(key)
            with self.assertRaises(InvalidMediaKey):
                sign_media_grant(key)

    def test_compatibility_media_references(self):
        for ref in ('/api/media/generated/a%20b.mov?x=1',
                    'https://storage.googleapis.com/bucket/generated/a%20b.mov',
                    'https://bucket.storage.googleapis.com/generated/a%20b.mov',
                    'https://s3.us-east-1.amazonaws.com/bucket/generated/a%20b.mov',
                    'https://bucket.s3.amazonaws.com/generated/a%20b.mov',
                    'https://app.invalid/api/media/generated/a%20b.mov'):
            self.assertEqual(media_key_from_ref(ref),'generated/a b.mov')
        self.assertIsNone(media_key_from_ref('/api/media/settings/token'))
        self.assertIsNone(media_key_from_ref('https://localhost/private'))

    def test_range_boundaries(self):
        for raw, result in [('bytes=0-2',(0,2)),('bytes=2-',(2,9)),('bytes=-3',(7,9)),
                           ('bytes=-20',(0,9)),('bytes=3-999',(3,9))]:
            self.assertEqual(parse_range(raw,10),result)
        for raw in ('bytes=-0','bytes=10-','bytes=8-7','bytes=-','bytes=0-1,3-4','Bytes=0-1','garbage'):
            with self.assertRaises(InvalidMediaRangeError):
                parse_range(raw,10)

    def test_byte_exact_mov_and_range(self):
        adapter=MemoryAdapter()
        store=StorageService(adapter)
        master=b'\x00\x00\x00\x18ftypqt  '+bytes(range(256))*100
        url=store.upload_buffer(master,'generations/native.mov','mov')
        self.assertEqual(url,'/api/media/generations/native.mov')
        self.assertEqual(store.read('generations/native.mov'),master)
        response=store.open('generations/native.mov','bytes=-25')
        self.assertEqual(response.content_type,'video/quicktime')
        self.assertEqual(b''.join(response.stream),master[-25:])
        self.assertEqual(len(adapter.objects),1)

    def test_fallback_only_on_missing(self):
        primary,fallback=MemoryAdapter(),MemoryAdapter()
        fallback.put('assets/a',b'legacy','image/png','')
        store=StorageService(primary,fallback)
        self.assertEqual(store.read('assets/a'),b'legacy')
        with patch.object(primary,'open',side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                store.read('assets/a')
        store.upload_buffer(b'new','assets/a','png')
        self.assertEqual(fallback.objects['assets/a'][0],b'legacy')

    def test_stream_close_propagates(self):
        store=StorageService(MemoryAdapter())
        store.primary.put('assets/a',b'a'*600000,'image/png','')
        media=store.open('assets/a')
        iterator=iter(media.stream)
        next(iterator)
        iterator.close()
        self.assertTrue(media.stream.stream.closed)

    def test_filesystem_exact_bytes_and_traversal(self):
        with tempfile.TemporaryDirectory() as root:
            store=StorageService(FileSystemAdapter(root))
            store.upload_buffer(b'original','generated/a.mov','mov')
            self.assertEqual(store.read('generated/a.mov'),b'original')
            with self.assertRaises(InvalidMediaKey):
                store.read('../x')
            store.delete_by_urls(['/api/media/generated/a.mov'])
            self.assertFalse(store.exists('generated/a.mov'))

    def test_reference_fetch_is_explicit_and_protected(self):
        store=StorageService(MemoryAdapter())
        with self.assertRaises(ValueError):
            store.read_as_base64('http://169.254.169.254/latest/meta-data')
        with self.assertRaises(ValueError):
            store.read_as_base64('/api/media/settings/token')
        self.assertEqual(store.read_as_base64('data:audio/wav;base64,YWJj'),{'mimeType':'audio/wav','data':'YWJj'})

    def test_presign_golden_validation(self):
        signer=Mock(return_value='signed')
        status,result=create_upload_presign('user','image-reference',' IMAGE/PJPEG ',signer,lambda:'id')
        self.assertEqual((status,result),(200,{'key':'uploads/image-reference/user-id','uploadUrl':'signed'}))
        signer.assert_called_once_with('uploads/image-reference/user-id','image/jpeg')
        self.assertEqual(create_upload_presign(None,'image-reference','image/png',signer)[0],401)
        self.assertEqual(create_upload_presign('u','image-reference','image/svg+xml',signer)[0],400)
        self.assertEqual(create_upload_presign('u','invalid','image/png',signer)[0],400)
        self.assertEqual(create_upload_presign('u','video-reference','video/quicktime',signer)[0],200)

    def test_upload_token_is_domain_separated(self):
        token=sign_upload('uploads/image-reference/user-id','image/png')
        self.assertEqual(verify_upload(token)['type'],'image/png')
        self.assertIsNone(verify_media_grant(token))
        self.assertIsNone(verify_upload(token+'x'))
        self.assertEqual(verify_upload(sign_upload('depth-output/job/claim.mp4','video/mp4'))['key'],'depth-output/job/claim.mp4')
        self.assertIsNone(verify_upload(sign_upload('generations/job/master.mov','video/quicktime')), 'protected namespaces stay closed')

    def test_image_data_allowlist_and_canvas_limit(self):
        with self.assertRaises(ValueError):
            split_data_url('data:image/svg+xml;base64,YWJj')
        with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            self.assertRegex(save_canvas_asset('data:image/png;base64,YWJj','board'),r'^/api/media/canvas/board/.*\.png$')
            with self.assertRaisesRegex(ValueError,'8 MB'):
                save_canvas_asset('data:image/png;base64,'+base64.b64encode(b'a'*(8*1024*1024+1)).decode(),'board')

    def test_canvas_encoded_limit_precedes_decode_and_preserves_exact_boundary(self):
        store = StorageService(MemoryAdapter())
        with patch('apps.media.images.MAX_CANVAS_UPLOAD_BYTES',8), override_settings(VEEVEE_MEDIA_STORAGE=store):
            with patch('apps.media.images.base64.b64decode') as decode:
                with self.assertRaisesRegex(ValueError,'8 MB'):
                    save_canvas_asset('data:image/png;base64,'+'A'*16,'board')
                decode.assert_not_called()
            data = b'12345678'
            url = save_canvas_asset('data:image/png;base64,'+base64.b64encode(data).decode(),'board')
            self.assertEqual(store.read(media_key_from_ref(url)),data)
            # Eight and nine bytes have the same encoded length: the decoded
            # check must still reject the latter without uploading an object.
            with patch.object(store,'upload_buffer') as upload:
                with self.assertRaisesRegex(ValueError,'8 MB'):
                    save_canvas_asset('data:image/png;base64,'+base64.b64encode(data+b'9').decode(),'board')
                upload.assert_not_called()

    def test_avatar_normalization_and_limits(self):
        from PIL import Image
        data=io.BytesIO()
        Image.new('RGB',(100,200),'red').save(data,format='PNG')
        store=StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=store):
            url=save_avatar_image(data.getvalue())
            normalized=store.read(media_key_from_ref(url))
            with Image.open(io.BytesIO(normalized)) as image:
                self.assertEqual(image.size,(512,512))
                self.assertEqual(image.format,'WEBP')
            for invalid,message in [(b'','empty'),(b'a'*(MAX_AVATAR_UPLOAD_BYTES+1),'3 MB'),(b'bad','valid image')]:
                with self.assertRaisesRegex(InvalidAvatarError,message):
                    save_avatar_image(invalid)

    def test_storage_unconfigured_fails_closed(self):
        from django.core.exceptions import ImproperlyConfigured
        with override_settings(VEEVEE_MEDIA_STORAGE=None,VEEVEE_MEDIA_CONFIG={}):
            with self.assertRaises(ImproperlyConfigured):
                get_storage()

    def test_s3_mock_range_contract(self):
        client=Mock()
        client.head_object.return_value={'ContentLength':9}
        client.get_object.return_value={'Body':io.BytesIO(b'345'),'ContentType':'video/quicktime'}
        media=S3Adapter(client,'legacy').open('generated/m.mov','bytes=3-5')
        client.get_object.assert_called_once_with(Bucket='legacy',Key='generated/m.mov',Range='bytes=3-5')
        self.assertEqual((media.status,media.content_range,b''.join(media.stream)),(206,'bytes 3-5/9',b'345'))

    def test_gcs_mock_upload_uses_crc_and_native_type(self):
        client=Mock()
        blob=client.bucket.return_value.blob.return_value
        GCSAdapter(client,'bucket').put('generated/m.mov',b'master','video/quicktime','immutable')
        blob.upload_from_string.assert_called_once_with(b'master',content_type='video/quicktime',checksum='crc32c',timeout=15)

    def test_transcriber_golden_payload(self):
        transport=Mock(return_value={'candidates':[{'content':{'parts':[{'text':'one'},{'text':'two'}]}}]})
        provider=audio.GeminiTranscriber('mock-key',transport)
        self.assertEqual(provider.transcribe('YWJj','audio/wav','gemini-2.5-flash'),'one\ntwo')
        url,payload,headers=transport.call_args.args
        self.assertTrue(url.endswith('/gemini-2.5-flash:generateContent'))
        self.assertEqual(payload['contents'][0]['parts'][0],{'inlineData':{'mimeType':'audio/wav','data':'YWJj'}})
        self.assertEqual(payload['generationConfig'],{'temperature':0.1})

    def test_audio_snapshot_preserves_each_accepted_mime_and_original_bytes(self):
        from .audio_inputs import AUDIO_EXTENSIONS, capture_audio_input, transcribe_audio_input
        from types import SimpleNamespace
        store=StorageService(MemoryAdapter())
        data=b'original audio bytes\x00\xff'
        for mime in AUDIO_EXTENSIONS:
            with self.subTest(mime=mime):
                identifier=uuid4()
                intent=capture_audio_input(store,'data:'+mime+';base64,'+base64.b64encode(data).decode(),
                    identifier,model='fixture-model',name='fixture')
                provider=Mock()
                provider.transcribe.return_value='fixture transcript'
                item=SimpleNamespace(id=identifier,model='Gemini (fixture-model)',submission_input=intent)
                self.assertEqual(transcribe_audio_input(item,provider,store),'fixture transcript')
                provider.transcribe.assert_called_once_with(base64.b64encode(data).decode(),mime,'fixture-model')
                self.assertEqual(store.read(media_key_from_ref(intent['source'])),data)
                self.assertEqual((intent['byteLength'],intent['sha256']),
                    (len(data),hashlib.sha256(data).hexdigest()))

    def test_audio_snapshot_integrity_and_job_scope_reject_before_provider(self):
        from .audio_inputs import capture_audio_input, transcribe_audio_input
        from types import SimpleNamespace
        store=StorageService(MemoryAdapter())
        identifier=uuid4()
        intent=capture_audio_input(store,'data:audio/wav;base64,YWJj',identifier,model='fixture',name='fixture')
        key=media_key_from_ref(intent['source'])
        for change in ({'source':'https://source.invalid/expired.wav'},
                {'source':intent['source'].replace(str(identifier),str(uuid4()))},
                {'sha256':'0'*64},{'byteLength':True},{'mimeType':'video/mp4'},
                {'model':'other'},{'version':1},{'version':True},{'mimeType':[]}):
            with self.subTest(change=change):
                provider=Mock()
                with self.assertRaises(ValueError):
                    transcribe_audio_input(SimpleNamespace(id=identifier,model='Gemini (fixture)',
                        submission_input={**intent,**change}),provider,store)
                provider.transcribe.assert_not_called()
        for data,mime in ((b'xyz','audio/wav'),(b'abc','audio/mpeg')):
            store.primary.put(key,data,mime,'')
            provider=Mock()
            with self.assertRaises(ValueError):
                transcribe_audio_input(SimpleNamespace(id=identifier,model='Gemini (fixture)',
                    submission_input=intent),provider,store)
            provider.transcribe.assert_not_called()


@override_settings(ROOT_URLCONF=__name__)
class EndpointTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(id=uuid4(),email='media@example.test',password_hash='x',name='Media',role='user',
            color='#123456',created_at=1)
        self.token=sign_session(self.user)
        self.client.cookies['veevee_session']=self.token
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.store=StorageService(MemoryAdapter())
        self.override=override_settings(VEEVEE_MEDIA_STORAGE=self.store)
        self.override.enable()
        self.addCleanup(self.override.disable)
        # Explicit offline worker drive for endpoint fault tests; production API
        # never runs providers while waiting. Separate tests use real workers.
        def drive_audio_worker(intent):
            from apps.generation.services.audio_submission import process_audio
            from apps.generation.services.deadline import Cancellation
            result=process_audio(intent.id,'audio:endpoint-fixture',signal=Cancellation(),storage=self.store)
            if result['kind']!='completed':
                raise RuntimeError('Fixture audio worker did not complete.')
            return result['item']
        worker_wait=patch.object(audio,'wait_for_audio',side_effect=drive_audio_worker)
        worker_wait.start()
        self.addCleanup(worker_wait.stop)
        self.store.upload_buffer(b'0123456789','generated/movie.mov','mov')

    def test_media_auth_range_and_not_found(self):
        response=self.client.get('/api/media/generated/movie.mov',HTTP_RANGE='bytes=2-4')
        self.assertEqual(response.status_code,206)
        self.assertEqual(response['Content-Type'],'video/quicktime')
        self.assertEqual(response['Content-Range'],'bytes 2-4/10')
        self.assertEqual(b''.join(response.streaming_content),b'234')
        self.assertEqual(self.client.get('/api/media/generated/movie.mov',HTTP_RANGE='bytes=20-').status_code,416)
        self.assertEqual(self.client.get('/api/media/settings/token').status_code,404)
        self.assertEqual(self.client.get('/api/media/generated/missing').status_code,404)
        self.client.cookies['veevee_session']='garbage'
        self.assertEqual(self.client.get('/api/media/generated/movie.mov').status_code,401)

    def test_media_cookie_validation_checks_current_user(self):
        with self.assertNumQueries(1):
            response=self.client.get('/api/media/generated/movie.mov')
        response.close()

    def test_grants_session_free_and_object_scoped(self):
        self.client.cookies.clear()
        token=sign_media_grant('generated/movie.mov')
        response=self.client.get('/api/media-grant',{'t':token,'path':'settings/token'})
        self.assertEqual(b''.join(response.streaming_content),b'0123456789')
        self.assertEqual(response['Cache-Control'],'private, max-age=300')
        self.assertEqual(self.client.get('/api/media-grant',{'t':token+'x'}).status_code,403)
        self.assertEqual(self.client.get('/api/media-grant',{'t':token},HTTP_RANGE='bytes=22-').status_code,416)

    def _generation(self,**kwargs):
        return Generation.objects.create(id=uuid4(),kind='video',status='succeeded',prompt='p',model='Seedance 2.5',
            aspect_ratio='16:9',url=' /api/media/generated/movie.mov'.strip(),created_at=1,updated_at=1,**kwargs)

    def test_download_get_head_native_mime_and_filename(self):
        generation=self._generation()
        url=f'/api/generations/{generation.id}/download'
        response=self.client.get(url)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response['Content-Type'],'video/quicktime')
        self.assertIn('unsorted_0001.mov',response['Content-Disposition'])
        self.assertEqual(b''.join(response.streaming_content),b'0123456789')
        response=self.client.head(url)
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.content,b'')
        self.assertEqual(response['Content-Length'],'10')
        self.assertEqual(response['Cache-Control'],'private, no-cache, no-store, must-revalidate')

    def test_download_state_and_protected_key_errors(self):
        generation=self._generation()
        url=f'/api/generations/{generation.id}/download'
        for status,error in [('running','GENERATION_PROCESSING'),('pending','GENERATION_PROCESSING'),('failed','GENERATION_FAILED')]:
            Generation.objects.filter(id=generation.id).update(status=status)
            response=self.client.get(url)
            self.assertEqual((response.status_code,response.json()['error']),(409,error))
        Generation.objects.filter(id=generation.id).update(status='succeeded',url='/api/media/thumbs/512/settings/token.webp')
        self.assertEqual(self.client.get(url).status_code,404)

    def test_presign_and_local_upload(self):
        response=self.client.post('/api/uploads/presign',{'purpose':'video-reference','contentType':'video/quicktime'},content_type='application/json')
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json()['key'].startswith(f'uploads/video-reference/{self.user.id}-'))
        with tempfile.TemporaryDirectory() as root,override_settings(VEEVEE_MEDIA_STORAGE=StorageService(FileSystemAdapter(root))):
            response=self.client.post('/api/uploads/presign',{'purpose':'video-reference','contentType':'video/quicktime'},content_type='application/json')
            url=response.json()['uploadUrl']
            self.assertEqual(self.client.put(url,b'native',content_type='video/quicktime').status_code,200)
            self.assertEqual(get_storage().read(response.json()['key']),b'native')
            self.assertEqual(self.client.put(url,b'native',content_type='text/html').status_code,400)
            with override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=1):
                self.assertEqual(self.client.put(url,b'native',content_type='video/quicktime').status_code,200)
            with override_settings(VEEVEE_LOCAL_UPLOAD_MAX_BYTES=2):
                self.assertEqual(self.client.put(url,b'native',content_type='video/quicktime').status_code,413)

    def test_audio_api_waits_for_independent_worker_connection(self):
        from concurrent.futures import ThreadPoolExecutor
        import time
        from django.db import connections
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        from .audio_wait import wait_for_audio
        provider=Mock()
        provider.transcribe.return_value='independent worker transcript'
        def worker():
            try:
                deadline=time.monotonic()+5
                while time.monotonic()<deadline:
                    row=Generation.objects.filter(kind='audio',provider_status='AUDIO_READY').first()
                    if row:
                        return process_audio(row.id,'audio:independent',signal=Cancellation(),provider=provider,storage=self.store)
                    time.sleep(.01)
                raise RuntimeError('Fixture admission did not appear')
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            future=pool.submit(worker)
            with patch.object(audio,'wait_for_audio',side_effect=lambda intent:wait_for_audio(intent,timeout=5,interval=.01)),patch.object(audio,'get_transcriber') as api_provider:
                response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
            outcome=future.result(timeout=6)
        self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(response.json()['transcript'],'independent worker transcript')
        self.assertEqual(outcome['kind'],'completed')
        api_provider.assert_not_called()
        provider.transcribe.assert_called_once()

    def test_audio_api_commits_queue_and_waits_without_provider_fallback(self):
        from .audio_wait import AudioResultPending
        def wait(intent):
            row=Generation.objects.get(pk=intent.id)
            self.assertEqual((row.status,row.provider_status,row.user_id),('queued','AUDIO_READY',self.user.id))
            self.assertEqual(row.submission_input['version'],2)
            raise AudioResultPending(row.id)
        with patch.object(audio,'wait_for_audio',side_effect=wait),patch.object(audio,'get_transcriber') as provider:
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,504)
        provider.assert_not_called()
        row=Generation.objects.get(pk=response.json()['id'])
        self.assertEqual((row.status,row.provider_status),('queued','AUDIO_READY'))

    def test_audio_api_returns_worker_transcript_using_existing_response_contract(self):
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        provider=Mock()
        provider.transcribe.return_value='worker saved transcript'
        def wait(intent):
            return process_audio(intent.id,'audio:test',signal=Cancellation(),provider=provider,storage=self.store)['item']
        with patch.object(audio,'wait_for_audio',side_effect=wait):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj','name':'sample'},content_type='application/json')
        self.assertEqual(response.status_code,200,response.content)
        self.assertEqual(response.json()['transcript'],'worker saved transcript')
        provider.transcribe.assert_called_once()
        row=Generation.objects.get(pk=response.json()['id'])
        self.assertEqual((row.status,row.prompt),('succeeded','worker saved transcript'))

    def test_audio_transcription_mock_and_persisted_row(self):
        provider=Mock()
        provider.transcribe.return_value='[00:00.000 - 00:01.000] Speaker: Hello.'
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj','name':'sample'},content_type='application/json')
        self.assertEqual(response.status_code,200)
        item=response.json()
        self.assertEqual(item['transcript'],provider.transcribe.return_value)
        row=Generation.objects.get(id=item['id'])
        self.assertEqual((row.kind,row.cost_cents,row.reference_audios),('audio',0,['data:audio/wav;base64,YWJj']))
        self.assertEqual(self.client.post('/api/audio/transcribe',{},content_type='application/json').status_code,400)
        self.assertEqual(self.client.post('/api/audio/transcribe',{'audioRef':'data:image/png;base64,YWJj'},content_type='application/json').status_code,400)

    def test_oversized_audio_rejected_before_read_transcription_or_history(self):
        from .storage import MediaObject
        stream=Mock()
        provider=Mock()
        before=Generation.objects.count()
        with patch.object(self.store,'open',return_value=MediaObject(stream,'audio/wav',16*1024*1024)), override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'/api/media/uploads/large.wav'},content_type='application/json')
        self.assertEqual(response.status_code,413)
        provider.transcribe.assert_not_called()
        stream.close.assert_called_once()
        self.assertEqual(stream.mock_calls[:-1],[])
        self.assertEqual(Generation.objects.count(),before)

    def test_audio_provider_failures_do_not_disclose_credentials_or_create_success_history(self):
        before = Generation.objects.count()
        for index,error in enumerate((
            ValueError('provider URL https://example.invalid/?key=private-fixture-token'),
            RuntimeError('Authorization: Bearer private-fixture-token'),
        )):
            with self.subTest(error=type(error).__name__):
                provider = Mock()
                provider.transcribe.side_effect = error
                with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider,AUDIO_MAX_PER_USER=2):
                    response = self.client.post('/api/audio/transcribe',
                        {'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
                self.assertEqual(response.status_code,500)
                self.assertEqual(response.json(),{'error':'Transcription failed.'})
                provider.transcribe.assert_called_once()
                self.assertEqual(Generation.objects.count(),before+index+1)
                self.assertEqual(Generation.objects.filter(status='succeeded').count(),before)
                self.assertEqual(Generation.objects.filter(provider_status='SUBMISSION_UNCERTAIN').count(),index+1)

    def test_audio_intent_database_failure_prevents_paid_call(self):
        from django.db import OperationalError
        provider = Mock()
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider), patch.object(
                Generation.objects,'create',side_effect=OperationalError('fixture unavailable')):
            response = self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,500)
        provider.transcribe.assert_not_called()
        self.assertFalse(Generation.objects.exists())

    def test_audio_snapshot_storage_failure_prevents_intent_and_paid_call(self):
        provider=Mock()
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider),patch.object(
                self.store.primary,'put',side_effect=OSError('fixture storage unavailable')):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Transcription failed.'})
        provider.transcribe.assert_not_called()
        self.assertFalse(Generation.objects.exists())

    def test_audio_execution_uses_snapshot_after_original_source_changes_or_expires(self):
        provider=Mock()
        provider.transcribe.return_value='fixture transcript'
        original_create=Generation.objects.create
        reference='https://source.invalid/audio?expiring=fixture'
        fetcher=Mock(side_effect=[(b'original','audio/mp4'),OSError('expired')])
        self.store.reference_fetcher=fetcher
        def create(**values):
            row=original_create(**values)
            self.assertNotEqual(row.submission_input['source'],reference)
            self.assertEqual(row.submission_input['mimeType'],'audio/mp4')
            self.assertNotIn('expiring',json.dumps(row.submission_input))
            # The caller-controlled source is now expired; execution must use
            # only the committed job-specific snapshot.
            return row
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider),patch.object(Generation.objects,'create',side_effect=create):
            response=self.client.post('/api/audio/transcribe',{'audioRef':reference},content_type='application/json')
        self.assertEqual(response.status_code,200,response.content)
        fetcher.assert_called_once_with(reference)
        provider.transcribe.assert_called_once()
        self.assertEqual(provider.transcribe.call_args.args,(base64.b64encode(b'original').decode(),'audio/mp4','gemini-2.5-flash'))
        self.assertIn('signal',provider.transcribe.call_args.kwargs)
        row=Generation.objects.get(id=response.json()['id'])
        self.assertEqual(row.reference_audios,[reference])
        self.assertEqual(response.json()['referenceAudios'],[reference])

    def test_audio_intent_is_committed_before_provider_on_another_connection(self):
        from concurrent.futures import ThreadPoolExecutor
        from django.db import connections
        provider = Mock()
        def read():
            try:
                row = Generation.objects.get(kind='audio')
                return row.status,row.provider_status,row.submission_input['operation']
            finally:connections.close_all()
        def transcribe(*args,**kwargs):
            with ThreadPoolExecutor(max_workers=1) as pool:
                self.assertEqual(pool.submit(read).result(timeout=5),('running','SUBMISSION_PENDING','audio-transcription'))
            return 'fixture transcript'
        provider.transcribe.side_effect=transcribe
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,200,response.content)

    def test_audio_failure_marking_preserves_identity_and_metadata_watermark(self):
        for mode in ('metadata','account'):
            with self.subTest(mode=mode):
                Generation.objects.all().delete()
                provider=Mock()
                account=uuid4()
                watermark=9999999999999
                def transcribe(*args,**kwargs):
                    changes={'is_favorite':True,'favorited_at':888,'updated_at':watermark}
                    if mode=='account':changes['user_id']=account
                    Generation.objects.filter(kind='audio').update(**changes)
                    raise RuntimeError('offline provider failure')
                provider.transcribe.side_effect=transcribe
                with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
                    response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
                self.assertEqual(response.status_code,500)
                provider.transcribe.assert_called_once()
                row=Generation.objects.get()
                self.assertEqual((row.is_favorite,row.favorited_at),(True,888))
                if mode=='metadata':
                    self.assertGreater(row.updated_at,watermark)
                    self.assertEqual(row.provider_status,'SUBMISSION_UNCERTAIN')
                else:
                    self.assertEqual((row.user_id,row.updated_at,row.provider_status),
                                     (account,watermark,'SUBMISSION_PENDING'))

    def test_audio_lost_ack_readback_fences_identity_and_preserves_metadata(self):
        from django.db import OperationalError, transaction
        from django.db.models.query import QuerySet
        original=QuerySet.update
        for mode in ('metadata','account'):
            with self.subTest(mode=mode):
                Generation.objects.all().delete()
                provider=Mock()
                provider.transcribe.return_value='recovery transcript'
                writes=[]
                changed_account=uuid4()
                def update(query,**values):
                    result=original(query,**values)
                    if values.get('status')=='succeeded':
                        writes.append(True)
                        def after_commit():
                            current=Generation.objects.get(kind='audio')
                            changes=({'is_favorite':True,'favorited_at':789,'updated_at':9999999999999}
                                     if mode=='metadata' else {'user_id':changed_account})
                            original(Generation.objects.filter(pk=current.id),**changes)
                            raise OperationalError('fixture committed acknowledgement loss')
                        transaction.on_commit(after_commit)
                    return result
                with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider),patch.object(QuerySet,'update',update):
                    response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
                self.assertEqual(response.status_code,200 if mode=='metadata' else 500)
                provider.transcribe.assert_called_once()
                self.assertEqual(len(writes),1)
                row=Generation.objects.get()
                self.assertEqual((row.status,row.prompt),('succeeded','recovery transcript'))
                if mode=='metadata':
                    self.assertEqual((row.is_favorite,row.favorited_at,row.updated_at),(True,789,9999999999999))
                    self.assertEqual(response.json()['updatedAt'],row.updated_at)
                else:
                    self.assertEqual(row.user_id,changed_account)

    def test_audio_completion_preserves_metadata_and_monotonic_watermark(self):
        provider=Mock()
        watermark=9999999999999
        def transcribe(*args,**kwargs):
            Generation.objects.filter(kind='audio').update(is_favorite=True,favorited_at=777,
                flagged=True,flagged_at=778,flag_reason='review',updated_at=watermark)
            return 'metadata transcript'
        provider.transcribe.side_effect=transcribe
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,200)
        provider.transcribe.assert_called_once()
        row=Generation.objects.get(pk=response.json()['id'])
        self.assertEqual((row.is_favorite,row.favorited_at,row.flagged,row.flagged_at,row.flag_reason),
                         (True,777,True,778,'review'))
        self.assertGreater(row.updated_at,watermark)
        self.assertEqual(response.json()['updatedAt'],row.updated_at)

    def test_audio_result_rejects_changed_execution_identity(self):
        from uuid import uuid4
        for field,value in (('user_id',uuid4()),('kind','video'),('model','changed'),
                            ('submission_input',{'version':2,'source':'changed'})):
            with self.subTest(field=field):
                Generation.objects.all().delete()
                provider=Mock()
                def transcribe(*args,**kwargs):
                    row=Generation.objects.get(kind='audio')
                    Generation.objects.filter(pk=row.id).update(**{field:value})
                    return 'identity race transcript'
                provider.transcribe.side_effect=transcribe
                with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
                    response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
                self.assertEqual(response.status_code,500)
                provider.transcribe.assert_called_once()
                row=Generation.objects.get()
                self.assertEqual(getattr(row,field),value)
                self.assertNotEqual(row.status,'succeeded')
                self.assertEqual(row.prompt,'')

    def test_audio_exhausted_result_writes_preserve_uncertainty_without_resubmission(self):
        from django.db import OperationalError
        from django.db.models.query import QuerySet
        original = QuerySet.update
        calls = []
        def update(query,**values):
            if values.get('status')=='succeeded':
                calls.append(True)
                raise OperationalError('fixture permanent write failure')
            return original(query,**values)
        provider=Mock()
        provider.transcribe.return_value='fixture transcript'
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider),patch.object(QuerySet,'update',update):
            response=self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,500)
        self.assertEqual(len(calls),3)
        provider.transcribe.assert_called_once()
        row=Generation.objects.get(kind='audio')
        self.assertEqual((row.status,row.provider_status,row.prompt),('running','SUBMISSION_UNCERTAIN',''))

    def test_audio_local_result_retry_and_lost_ack_never_repeat_provider(self):
        from django.db import OperationalError
        from django.db.models.query import QuerySet
        original = QuerySet.update
        for mode in ('transient','lost-ack'):
            calls = []
            provider = Mock()
            provider.transcribe.return_value = 'fixture transcript '+mode
            def update(query,**values):
                if values.get('status')=='succeeded':
                    calls.append(True)
                    if len(calls)==1:
                        if mode=='lost-ack':
                            from django.db import transaction
                            result=original(query,**values)
                            def lost_ack():
                                raise OperationalError('fixture committed acknowledgement failure')
                            transaction.on_commit(lost_ack)
                            return result
                        raise OperationalError('fixture acknowledgement failure')
                return original(query,**values)
            with self.subTest(mode=mode), override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider), patch.object(QuerySet,'update',update):
                response = self.client.post('/api/audio/transcribe',{'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
            self.assertEqual(response.status_code,200,response.content)
            provider.transcribe.assert_called_once()
            self.assertEqual(len(calls),2 if mode=='transient' else 1)
            row = Generation.objects.get(pk=response.json()['id'])
            self.assertEqual((row.status,row.prompt,row.provider_status),('succeeded',provider.transcribe.return_value,'COMPLETED'))

    def test_audio_known_public_failure_remains_actionable(self):
        provider = Mock()
        provider.transcribe.return_value = ''
        with override_settings(VEEVEE_AUDIO_TRANSCRIBER=provider):
            response = self.client.post('/api/audio/transcribe',
                {'audioRef':'data:audio/wav;base64,YWJj'},content_type='application/json')
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Gemini returned an empty transcription.'})

    def test_response_close_closes_upstream(self):
        raw=self.store.open('generated/movie.mov')
        with patch.object(self.store,'open',return_value=raw):
            response=self.client.get('/api/media/generated/movie.mov')
            response.close()
        self.assertTrue(raw.stream.stream.closed)
