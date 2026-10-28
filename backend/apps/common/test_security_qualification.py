"""Concrete security regressions and concurrent storage/DB fence qualification."""
import io
import json
import threading
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import Mock, patch
from uuid import uuid4

from django.db import OperationalError, connections, connection
from django.http import QueryDict
from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.exports.models import MediaExport
from apps.exports.services import create_export
from apps.generation.models import Generation
from apps.generation.services import coordinator, executor, poller
from apps.generation.services.deadline import Cancellation
from apps.media.persistence import save_buffer_with_metadata
from apps.integrations.remote import SafeMediaFetcher, UnsafeMediaURL
from apps.media.storage import StorageService, MemoryAdapter
from apps.media.keys import media_key_from_ref
from apps.common import test_api_coverage as _coverage


def job(**values):
    return Generation.objects.create(**{'kind':'video','status':'running','model':'Seedance 2.5',
        'prompt':'security fixture','aspect_ratio':'16:9','task_id':'task-original',
        'cost_cents':40,'created_at':100,'updated_at':200, **values})


class MasterFenceSecurityTests(TransactionTestCase):
    def test_stale_bestof_upload_cannot_replace_committed_native_master(self):
        item=job(candidate_task_ids=['candidate'])
        store=StorageService(MemoryAdapter())
        winner_done=threading.Event()
        snapshots=threading.Barrier(2)
        winner_bytes=b'\x00\x00\x00\x14ftypqt  winner-original'
        stale_bytes=b'\x00\x00\x00\x14ftypqt  stale-different'
        def run(stale):
            try:
                observed=Generation.objects.get(pk=item.id)
                snapshots.wait(timeout=10)
                def save(url, ext, identifier, metadata):
                    if stale:
                        self.assertTrue(winner_done.wait(timeout=10))
                    return save_buffer_with_metadata(stale_bytes if stale else winner_bytes,ext,identifier,metadata)
                deps=poller.Dependencies(now=lambda:10000,mock=lambda:False,publish=lambda item:None,
                    get_video=lambda *args,**kwargs:{'status':'succeeded','videoUrl':'https://fixture/master.mov','outputFormat':'mov'},
                    save_url=save)
                result=poller.advance(observed,dependencies=deps)
                if not stale:
                    winner_done.set()
                return result['kind']
            finally:
                connections.close_all()
        with override_settings(VEEVEE_MEDIA_STORAGE=store), patch('apps.media.persistence.measure_generated_media',return_value={'aspectRatio':'16:9'}):
            with ThreadPoolExecutor(max_workers=2) as pool:
                winner=pool.submit(run,False)
                stale=pool.submit(run,True)
                self.assertEqual(winner.result(timeout=15),'succeeded')
                self.assertEqual(stale.result(timeout=15),'raced')
        item.refresh_from_db()
        self.assertEqual(store.read(media_key_from_ref(item.url)),winner_bytes)
        masters=[key for key in store.primary.objects if key.startswith(f'generations/{item.id}/')]
        self.assertEqual(len(masters),2)
        self.assertTrue(all(key.endswith('.mov') for key in masters))

    def test_transient_receipt_db_failure_retries_receipt_not_submission(self):
        item=job(task_id=None,worker_lease_id='owner',worker_lease_until=9999999999999)
        real=executor._persist_task_receipt
        attempts=[]
        def update(item,owner,values):
            if values.get('task_id'):
                attempts.append(values['task_id'])
                if len(attempts)==1:
                    raise OperationalError('synthetic receipt write failure')
            return real(item,owner,values)
        submissions=[]
        def submit(item,*,on_task,**kwargs):
            submissions.append('submit')
            on_task('accepted-task')
            return {'status':'running','task_id':'accepted-task'}
        with patch.object(executor,'_persist_task_receipt',side_effect=update):
            result=executor.execute_admitted(item,owner='owner',video_submit=submit,env={})
        self.assertEqual(result['kind'],'running')
        self.assertEqual(submissions,['submit'])
        self.assertEqual(attempts,['accepted-task','accepted-task'])
        item.refresh_from_db()
        self.assertEqual(item.task_id,'accepted-task')

    def test_unrecoverable_receipt_is_not_provider_failure_or_resubmitted(self):
        item=job(kind='image',model='Kling Image 3.0',task_id=None,worker_lease_id='owner',worker_lease_until=9999999999999)
        submitted=[]
        def generate(item,*,on_task,**kwargs):
            submitted.append(True)
            on_task('accepted-task')
            self.fail('Work continued after lost receipt')
        with patch.object(executor,'_persist_task_receipt',side_effect=OperationalError('synthetic database unavailable')):
            with self.assertRaises(executor.ReceiptPersistenceError):
                executor.execute_admitted(item,owner='owner',image_execute=generate,env={})
        item.refresh_from_db()
        self.assertEqual((item.status,item.task_id,item.error),('running',None,None))
        self.assertEqual(submitted,[True])
        self.assertIsNone(coordinator.claim_generation(item.id,'next-worker',now=10000000000000))

    def test_lost_commit_acknowledgement_recovers_already_saved_receipt(self):
        item=job(task_id=None,worker_lease_id='owner',worker_lease_until=9999999999999)
        real=executor._persist_task_receipt
        once=[]
        def update(item,owner,values):
            persisted=real(item,owner,values)
            if values.get('task_id') and not once:
                once.append(True)
                raise OperationalError('synthetic lost commit acknowledgement')
            return persisted
        submit=Mock(side_effect=lambda item,on_task,**kwargs: (on_task('accepted-task') or {'status':'running','task_id':'accepted-task'}))
        with patch.object(executor,'_persist_task_receipt',side_effect=update):
            result=executor.execute_admitted(item,owner='owner',video_submit=submit,env={})
        self.assertEqual(result['item'].task_id,'accepted-task')
        self.assertEqual(submit.call_count,1)


class MediaAuthorizationSecurityTests(TransactionTestCase):
    def setUp(self):
        self.user=User.objects.create(email='security@example.test',name='Fixture',role='user',
            password_hash='fixture',created_at=1)
        self.client.cookies['veevee_session']=sign_session(self.user)
        self.store=StorageService(MemoryAdapter())
        self.store.upload_buffer(b'native-master','generations/file.v1.mov','mov')
        self.override=override_settings(VEEVEE_MEDIA_STORAGE=self.store)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.item=job(status='succeeded',url='/api/media/generations/file.v1.mov')

    def test_disabled_revoked_and_deleted_users_cannot_read_media_or_download(self):
        for values in [{'is_active':False},{'is_active':True,'auth_version':1}]:
            User.objects.filter(pk=self.user.id).update(**values)
            with patch('apps.media.views.get_storage',side_effect=AssertionError('Storage reached before authorization')):
                for url in ['/api/media/generations/file.v1.mov',f'/api/generations/{self.item.id}/download']:
                    self.assertEqual(self.client.get(url).status_code,401)
        self.user.delete()
        self.assertEqual(self.client.get('/api/media/generations/file.v1.mov').status_code,401)

    def test_dotted_master_headers_and_authenticated_cache_are_private(self):
        response=self.client.get('/api/media/generations/file.v1.mov',HTTP_RANGE='bytes=0-5')
        self.assertEqual(response.status_code,206)
        self.assertEqual(response['Content-Type'],'video/quicktime')
        self.assertEqual(response['Content-Range'],'bytes 0-5/13')
        self.assertEqual(response['X-Content-Type-Options'],'nosniff')
        self.assertTrue(response['Cache-Control'].startswith('private,'))
        self.assertEqual(b''.join(response.streaming_content),b'native')

    def test_cookie_route_cannot_bypass_private_export_ownership_or_expiry(self):
        key=f'exports/{self.user.id}/private.zip'
        self.store.upload_stream(io.BytesIO(b'zip'),key)
        self.assertEqual(self.client.get('/api/media/'+key).status_code,404)
        created=create_export(self.user.id)
        MediaExport.objects.filter(pk=created['id']).update(status='ready',output_key=key,expires_at=9999999999999)
        response=self.client.get(f"/api/history/exports/{created['id']}/download")
        self.assertEqual(response.status_code,200)
        self.assertEqual(response['Cache-Control'],'private, no-store')
        self.assertTrue(response['Content-Disposition'].startswith('attachment;'))
        self.assertEqual(b''.join(response.streaming_content), b'zip')
        with patch.object(self.store, 'signed_export_download_url', return_value='https://storage.invalid/private-grant') as signer:
            cloud = self.client.get(f"/api/history/exports/{created['id']}/download")
            self.assertEqual(cloud.status_code, 307)
            self.assertEqual(cloud['Location'], 'https://storage.invalid/private-grant')
            self.assertEqual(cloud['Cache-Control'], 'private, no-store')
            self.assertEqual(signer.call_args.args[0], key)
        other=User.objects.create(email='other@example.test',name='Other',role='user',password_hash='fixture',created_at=1)
        self.client.cookies['veevee_session']=sign_session(other)
        self.assertEqual(self.client.get(f"/api/history/exports/{created['id']}/download").status_code,404)
        self.client.cookies['veevee_session']=sign_session(self.user)
        MediaExport.objects.filter(pk=created['id']).update(expires_at=1)
        self.assertEqual(self.client.get(f"/api/history/exports/{created['id']}/download").status_code,410)

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=64)
    def test_large_json_and_malformed_non_json_do_not_mutate_jobs(self):
        count=Generation.objects.count()
        response=self.client.post('/api/generate/image',json.dumps({'prompt':'x'*128}),content_type='application/json',HTTP_SEC_FETCH_SITE='same-origin')
        self.assertEqual(response.status_code,413)
        self.assertEqual(Generation.objects.count(),count)
        response=self.client.post('/api/generate/image','not-json',content_type='text/plain',HTTP_SEC_FETCH_SITE='same-origin')
        self.assertEqual(response.status_code,400)
        self.assertEqual(Generation.objects.count(),count)


class RemoteMediaSecurityTests(SimpleTestCase):
    def test_redirect_private_dns_and_mixed_public_private_answers_never_connect(self):
        addresses=lambda *args,**kwargs:[(2,1,6,'',('93.184.216.34',443)),(2,1,6,'',('127.0.0.1',443))]
        connection=Mock()
        with self.assertRaises(UnsafeMediaURL):
            SafeMediaFetcher(['media.example.test'],resolver=addresses,connection=connection)('https://media.example.test/master.mov')
        connection.assert_not_called()
        public=lambda *args,**kwargs:[(2,1,6,'',('93.184.216.34',443))]
        response=Mock(status=302)
        response.getheader.return_value='http://169.254.169.254/latest/meta-data/'
        connection.return_value.getresponse.return_value=response
        with self.assertRaises(UnsafeMediaURL):
            SafeMediaFetcher(['media.example.test'],resolver=public,connection=connection)('https://media.example.test/master.mov')
        self.assertEqual(connection.call_count,1)
        headers=connection.return_value.request.call_args.kwargs['headers']
        self.assertNotIn('Cookie',headers)
        self.assertNotIn('Authorization',headers)
        connection.return_value.close.assert_called_once()


class HistoryKeysetQualificationTests(TransactionTestCase):
    def setUp(self):
        from testsupport.test_history_plans import HistoricalHistoryPlanTests
        HistoricalHistoryPlanTests.setUp(self)

    def test_representative_folder_cursor_uses_bounded_index_scan(self):
        from apps.generation.history import query_history
        params=QueryDict(mutable=True)
        params.update({'folderId':str(self.root.id),'limit':'20','cursor':'2500.ffffffff-ffff-4fff-8fff-ffffffffffff'})
        with connection.cursor() as cursor:
            cursor.execute('ANALYZE generations')
        captured=[]
        def capture(execute,statement,bindings,many,context):
            if not captured:
                captured.append((statement,bindings))
            return execute(statement,bindings,many,context)
        with connection.execute_wrapper(capture):
            result=query_history(params)
        self.assertEqual(len(result['items']),20)
        with connection.cursor() as cursor:
            cursor.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+captured[0][0],captured[0][1])
            plan=cursor.fetchone()[0][0]['Plan']
        def nodes(node):
            return [node]+[child for plan in node.get('Plans',[]) for child in nodes(plan)]
        indexes=[node for node in nodes(plan) if node.get('Index Name')]
        self.assertTrue(indexes,plan)
        self.assertTrue(any(node['Index Name'] in ('generations_folder_keyset_idx','generations_created_keyset_idx') for node in indexes),plan)
        self.assertFalse(any('Sort' in node['Node Type'] for node in nodes(plan)),plan)
        self.assertLessEqual(sum(node['Actual Rows'] for node in indexes),21)

    def test_favorite_legacy_null_order_and_cursor_semantics_are_preserved(self):
        from apps.generation.history import query_history
        Generation.objects.update(is_favorite=False)
        for identifier, timestamp in [(self.ids[5],None),(self.ids[4],100),(self.ids[0],90)]:
            Generation.objects.filter(pk=identifier).update(is_favorite=True,favorited_at=timestamp)
        params=QueryDict('favorite=1')
        self.assertEqual([item['id'] for item in query_history(params)['items']], [self.ids[5],self.ids[4],self.ids[0]])
        params=QueryDict('favorite=1&cursor=100.'+self.ids[4])
        self.assertEqual([item['id'] for item in query_history(params)['items']],[self.ids[0]])


class BodyStreamSecurityTests(SimpleTestCase):
    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=64)
    def test_unknown_length_json_is_bounded_before_handler(self):
        from django.test import RequestFactory
        from django.http import HttpResponse
        from apps.canvas.views import node_route
        handler=Mock(return_value=HttpResponse('should-not-run'))
        handler.__name__='fixture'
        request=RequestFactory().post('/api/fixture',data='x'*1000,content_type='application/json')
        request.META.pop('CONTENT_LENGTH',None)
        stream=io.BytesIO(b'x'*1000)
        request._stream=stream
        response=node_route(['POST'])(handler)(request)
        self.assertEqual(response.status_code,413)
        self.assertEqual(stream.tell(),65)
        handler.assert_not_called()


@override_settings(VEEVEE_BROWSER_ORIGINS=('https://frontend.example',), PUBLIC_APP_URL='https://frontend.example')
class ProtocolBoundaryTests(TransactionTestCase):
    def setUp(self):
        from apps.common import test_api_coverage as coverage
        self.coverage = coverage
        coverage.CompleteApiNegativeBoundaryTests.setUp(self)

    snapshot = _coverage.CompleteApiNegativeBoundaryTests.snapshot

    def test_null_and_originless_site_metadata_deny_all_unsafe_methods_without_effects(self):
        coverage = self.coverage
        before = coverage.CompleteApiNegativeBoundaryTests.snapshot(self)
        with ExitStack() as stack:
            coverage.CompleteApiNegativeBoundaryTests.guard_effects(self, stack)
            for headers in ({'HTTP_ORIGIN': 'null'}, {'HTTP_SEC_FETCH_SITE': 'same-site'}, {'HTTP_SEC_FETCH_SITE': 'cross-site'},
                            {'HTTP_SEC_FETCH_SITE': ''}, {'HTTP_SEC_FETCH_SITE': 'none'}):
                for path, methods in coverage.EXPECTED.items():
                    for method in methods:
                        if method in ('GET', 'HEAD', 'OPTIONS'):
                            continue
                        with self.subTest(path=path, method=method, headers=headers):
                            response = coverage.CompleteApiNegativeBoundaryTests.request(self, path, method, self.valid, headers)
                            if path in coverage.COOKIELESS_OAUTH:
                                # Cross-origin by design and cookie-blind: the empty body is refused, nothing is granted.
                                self.assertEqual(response.status_code, coverage.NEGATIVE_STATUS[path][method])
                                self.assertNotEqual(response.json().get('error'), 'FORBIDDEN_ORIGIN')
                            else:
                                self.assertEqual(response.status_code, 403)
                                self.assertEqual(response.json(), {'error': 'FORBIDDEN_ORIGIN'})
            coverage.CompleteApiNegativeBoundaryTests.assert_no_effects(self, before)

    def test_method_override_headers_and_query_do_not_mutate_authenticated_get(self):
        coverage = self.coverage
        before = coverage.CompleteApiNegativeBoundaryTests.snapshot(self)
        with ExitStack() as stack:
            coverage.CompleteApiNegativeBoundaryTests.guard_effects(self, stack)
            for override in ('PATCH', 'DELETE', 'POST'):
                response = coverage.CompleteApiNegativeBoundaryTests.request(self, '/api/auth/me', 'GET', self.valid,
                    {'HTTP_X_HTTP_METHOD_OVERRIDE': override, 'HTTP_X_METHOD_OVERRIDE': override},
                    '?_method=' + override + '&name=must-not-change')
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()['user']['name'], 'Boundary admin')
            coverage.CompleteApiNegativeBoundaryTests.assert_no_effects(self, before)


@override_settings(SESSION_COOKIE_SECURE=True)
class CookieProtocolTests(TransactionTestCase):
    def setUp(self):
        from apps.admin_dashboard import tests as fixtures
        fixtures.SettingsTests.setUp(self)
        self.fixtures = fixtures

    def assert_cookie(self, response, max_age=2592000):
        cookie = response.cookies['veevee_session']
        self.assertTrue(cookie['secure'])
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['path'], '/')
        self.assertEqual(cookie['max-age'], max_age)

    def test_login_password_and_media_renewal_cookie_attributes(self):
        response = self.client.post('/api/auth/login', {'email': 'fixture@example.invalid', 'password': 'fixture-password'}, content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assert_cookie(response)
        response = self.client.patch('/api/auth/password', {'currentPassword': 'fixture-password', 'newPassword': 'ReplacementPassword!42'}, content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assert_cookie(response)
        self.fixtures.SettingsTests.cookie(self, version=1, age=172800000)
        storage = StorageService(MemoryAdapter())
        storage.primary.put('generations/renew.mov', b'native', 'video/quicktime', '')
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            response = self.client.get('/api/media/generations/renew.mov')
            self.assertEqual(response.status_code, 200)
            self.assert_cookie(response)
            self.assertEqual(b''.join(response.streaming_content), b'native')
        self.client.cookies['veevee_session'] = 'invalid'
        response = self.client.get('/api/auth/me')
        self.assert_cookie(response, max_age=0)
