import json
from unittest.mock import Mock, patch
from django.test import SimpleTestCase,TransactionTestCase
from apps.generation.prompting.golden_fixtures import HIGGSFIELD_GOLDENS
from apps.generation.providers.higgsfield import HiggsfieldClient,DatabaseLease,video_payload,image_payload,is_fresh,parse_json_rpc_messages,job_id_from,TOKEN_OBJECT_KEY,REFRESH_LEASE_KEY,ROTATION_STATE_KEY,token_identity
from apps.generation.providers.transport import HttpResult,ProviderError
from apps.media.storage import StorageService,MemoryAdapter


class HiggsfieldTests(SimpleTestCase):
    def make_client(self,transport=None,token=None,now=None,lease=None):
        storage=StorageService(MemoryAdapter())
        token=token or {'access_token':'mock','refresh_token':'refresh','client_id':'client','obtained_at':1000,'expires_in':3600}
        storage.write_private_buffer(json.dumps(token).encode(),TOKEN_OBJECT_KEY,'application/json')
        lease=lease or Mock(claim=Mock(return_value=True))
        marker={}
        def reconcile(owner,current,now):
            if marker:
                if current and is_fresh(current,now) and token_identity(current)!=marker['previous']:
                    marker.clear()
                else:
                    raise ProviderError('Higgsfield OAuth rotation is uncertain.',code='oauth_rotation_uncertain')
        def begin(owner,current,now):
            if marker:
                raise ProviderError('Higgsfield OAuth rotation is uncertain.',code='oauth_rotation_uncertain')
            marker.update(owner=owner,previous=token_identity(current))
        def persist(owner,now,write):
            self.assertEqual(marker['owner'],owner)
            write()
            marker.clear()
        lease.reconcile_rotation.side_effect=reconcile
        lease.begin_rotation.side_effect=begin
        lease.persist_rotation.side_effect=persist
        return HiggsfieldClient(transport=transport or Mock(),storage=storage,lease=lease,env={},now=now or (lambda:2000),request_id=lambda:123)

    def test_node_generation_payload_goldens(self):
        for fixture in HIGGSFIELD_GOLDENS:
            with self.subTest(input=fixture['input']):
                builder=image_payload if fixture['image'] else video_payload
                self.assertEqual(builder(fixture['input'],{}),fixture['output'])

    def test_sse_selects_only_matching_response(self):
        transport=Mock();transport.request.return_value=HttpResult(200,
            b'data: {"jsonrpc":"2.0","method":"notice"}\n\ndata: {"id":999,"result":{"wrong":true}}\n\ndata: {"id":123,\ndata: "result":{"correct":true}}\n\n',
            {'Content-Type':'text/event-stream','mcp-session-id':'session'})
        client=self.make_client(transport)
        self.assertEqual(client.rpc('tools/call',{}),{'id':123,'result':{'correct':True}})
        self.assertEqual(client.session,'session')
        transport.request.return_value=HttpResult(200,b'{"id":999,"result":{}}')
        with self.assertRaisesRegex(ProviderError,'matching request id'):
            client.rpc('tools/call',{})

    def test_session_initialize_notification_and_tool_contract(self):
        transport=Mock()
        transport.request.side_effect=[HttpResult(200,b'{"id":123,"result":{}}',{'mcp-session-id':'session'}),
            HttpResult(202,b''),HttpResult(200,b'{"id":123,"result":{"structuredContent":{"results":[{"id":"job"}]}}}')]
        client=self.make_client(transport)
        self.assertEqual(client.generate_video({'model':'Higgsfield Seedance 2.0','prompt':'Literal','mediaIds':[]}),'job')
        bodies=[call.kwargs['body'] for call in transport.request.call_args_list]
        self.assertEqual([body['method'] for body in bodies],['initialize','notifications/initialized','tools/call'])
        self.assertNotIn('id',bodies[1])
        self.assertEqual(bodies[2]['params']['name'],'generate_video')

    def test_tool_failures_and_terminal_status(self):
        client=self.make_client()
        client.call_tool=Mock(return_value={'isError':True,'content':[{'text':'gone'}],'structuredContent':{'retryable':False}})
        with patch('apps.generation.provider_errors.now_ms',return_value=7):
            self.assertEqual(client.job_status('missing'),{'status':'failed','error':'Higgsfield job_status: gone',
                'providerError':{'provider':'higgsfield','phase':'task','source':'provider','code':'tool_error',
                                 'message':'Higgsfield job_status: gone','taskId':'missing','receivedAt':7}})
        client.call_tool.return_value={'isError':True,'content':[{'text':'retry'}]}
        with self.assertRaises(ProviderError) as raised:
            client.job_status('transient')
        self.assertEqual({key:raised.exception.provider_response[key] for key in ('phase','code','taskId')},
                         {'phase':'status','code':'tool_error','taskId':'transient'})
        for source,status in [('completed','succeeded'),('in_progress','running'),('waiting','queued'),('nsfw','failed'),('ip_detect','failed')]:
            client.call_tool.return_value={'structuredContent':{'generation':{'status':source,'results':{'rawUrl':'raw','minUrl':'compressed'}}}}
            result=client.job_status('job')
            self.assertEqual(result['status'],status)
            if source == 'completed':
                self.assertEqual(result['url'],'raw')
            if status == 'failed':
                # Higgsfield's terminal status is the exact code (nsfw, ip_detect), with the task it ended.
                self.assertEqual((result['providerError']['code'],result['providerError']['taskId']),(source,'job'))

    def test_preset_notice_retries_only_explicit_non_submission(self):
        client=self.make_client()
        preset='11111111-1111-4111-8111-111111111111'
        client.call_tool=Mock(side_effect=[{'content':[{'text':'Preset id: '+preset}]},{'structuredContent':{'results':[{'id':'job'}]}}])
        self.assertEqual(client.generate_image({'model':'Higgsfield Soul','prompt':'Literal'}),'job')
        self.assertEqual(client.call_tool.call_args.kwargs['signal'],None)
        self.assertEqual(client.call_tool.call_args.args[1]['params']['declined_preset_id'],preset)
        self.assertIsNone(job_id_from({'content':[{'text':'Media id: '+preset}]}))

    def test_upload_confirm_keeps_original_bytes(self):
        client=self.make_client()
        client.transport.request.return_value=HttpResult(200,b'')
        client.call_tool=Mock(side_effect=[{'structuredContent':{'uploads':[{'upload_url':'https://cdn.invalid/put','media_id':'media'}]}},{}])
        self.assertEqual(client.upload_image('YWJj','image/jpeg'),'media')
        self.assertEqual(client.transport.request.call_args.kwargs['body'],b'abc')
        self.assertEqual(client.call_tool.call_args.args,('media_confirm',{'type':'image','media_id':'media'}))

    def test_unknown_age_refreshes_and_persists_rotation(self):
        token={'access_token':'old','refresh_token':'refresh','client_id':'client'}
        client=self.make_client(token=token)
        client.transport.request.return_value=HttpResult(200,b'{"access_token":"new","refresh_token":"rotated","expires_in":3600}')
        self.assertEqual(client.access_token(),'new')
        stored=json.loads(client.storage.read_private_buffer(TOKEN_OBJECT_KEY))
        self.assertEqual(stored['refresh_token'],'rotated')
        self.assertEqual(client.transport.request.call_args.kwargs['body'],'grant_type=refresh_token&refresh_token=refresh&client_id=client')
        client.lease.release.assert_called_once()

    def test_new_fresh_central_token_avoids_double_rotation(self):
        client=self.make_client()
        client.token={'access_token':'stale','refresh_token':'old','client_id':'client'}
        self.assertEqual(client.access_token(),'mock')
        client.transport.request.assert_not_called()

    def test_refresh_loser_adopts_winner(self):
        current={'access_token':'','refresh_token':'old','client_id':'client'}
        client=self.make_client(token=current)
        fresh={'access_token':'winner','refresh_token':'new','client_id':'client','obtained_at':1500,'expires_in':3600}
        client.read_stored_token=Mock(side_effect=[current,current,fresh])
        client.transport.request.return_value=HttpResult(400,b'{"error":"invalid_grant"}')
        self.assertEqual(client.access_token(),'winner')
        client.transport.request.assert_called_once()

    def test_bounded_wait_and_failure_clears_memory(self):
        clock=[2000]
        client=self.make_client(token={'access_token':'','refresh_token':'old','client_id':'client'},now=lambda:clock[0],lease=Mock(claim=Mock(return_value=False)))
        client.wait=lambda ms:clock.__setitem__(0,clock[0]+ms)
        with self.assertRaisesRegex(ProviderError,'Timed out waiting'):
            client.access_token()
        self.assertIsNone(client.token)
        self.assertEqual(clock[0],37000)

    def test_fresh_requires_explicit_age_and_five_minute_buffer(self):
        self.assertFalse(is_fresh({'access_token':'x'}))
        token={'access_token':'x','obtained_at':1000,'expires_in':3600}
        self.assertTrue(is_fresh(token,1000+3299*1000))
        self.assertFalse(is_fresh(token,1000+3300*1000))

    def test_concurrent_local_callers_rotate_once(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        client=self.make_client(token={'access_token':'','refresh_token':'old','client_id':'client'})
        client.transport.request.return_value=HttpResult(200,b'{"access_token":"new","refresh_token":"rotated","expires_in":3600}')
        barrier=threading.Barrier(8)
        def access(_):
            barrier.wait(timeout=5)
            return client.access_token()
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(list(pool.map(access,range(8))),['new']*8)
        client.transport.request.assert_called_once()

    def test_rotation_write_failure_does_not_expose_stale_token_to_second_client(self):
        first=self.make_client(token={'access_token':'','refresh_token':'old','client_id':'client'})
        second=HiggsfieldClient(storage=first.storage,transport=Mock(),lease=first.lease,env={},now=first.now)
        first.transport.request.return_value=HttpResult(200,b'{"access_token":"new","refresh_token":"rotated","expires_in":3600}')
        second.transport.request.return_value=HttpResult(400,b'{"error":"invalid_grant"}')
        write=first.storage.write_private_buffer
        attempts=[0]
        def transient_write(*args,**kwargs):
            attempts[0]+=1
            if attempts[0]==1:
                raise OSError('injected durable write failure')
            return write(*args,**kwargs)
        with patch.object(first.storage,'write_private_buffer',side_effect=transient_write):
            self.assertEqual(first.access_token(),'new')
        self.assertEqual(second.access_token(),'new')
        second.transport.request.assert_not_called()

    def test_slow_rotation_cannot_overlap_second_client_after_lease_expiry(self):
        clock=[2000]
        held={'owner':None,'until':0}
        lease=Mock()
        def claim(key,owner,now,ttl):
            if held['owner'] and held['until']>now:
                return False
            held.update(owner=owner,until=now+ttl)
            return True
        def release(key,owner):
            if held['owner']==owner:
                held.update(owner=None,until=0)
        lease.claim.side_effect=claim
        lease.release.side_effect=release
        first=self.make_client(token={'access_token':'','refresh_token':'old','client_id':'client'},now=lambda:clock[0],lease=lease)
        second=HiggsfieldClient(storage=first.storage,transport=Mock(),lease=lease,env={},now=first.now,
            wait=lambda ms:clock.__setitem__(0,clock[0]+ms))
        second.transport.request.return_value=HttpResult(200,b'{"access_token":"second","refresh_token":"second-rotation","expires_in":3600}')
        def slow_refresh(*args,**kwargs):
            clock[0]+=30001
            try:
                second.access_token()
            except ProviderError:
                pass
            return HttpResult(200,b'{"access_token":"first","refresh_token":"first-rotation","expires_in":3600}')
        first.transport.request.side_effect=slow_refresh
        first.access_token()
        second.transport.request.assert_not_called()

    def test_exhausted_storage_failure_blocks_new_client_after_expiry(self):
        clock=[2000]
        first=self.make_client(token={'access_token':'','refresh_token':'old','client_id':'client'},now=lambda:clock[0])
        first.transport.request.return_value=HttpResult(200,b'{"access_token":"new","refresh_token":"rotated","expires_in":3600}')
        with patch.object(first.storage,'write_private_buffer',side_effect=OSError('unavailable')):
            with self.assertRaises(ProviderError):
                first.access_token()
        clock[0]+=60000
        second=HiggsfieldClient(storage=first.storage,transport=Mock(),lease=first.lease,env={},now=first.now)
        with self.assertRaisesRegex(ProviderError,'uncertain'):
            second.access_token()
        second.transport.request.assert_not_called()

    def test_token_write_ack_loss_does_not_repeat_oauth(self):
        client=self.make_client(token={'access_token':'','refresh_token':'old','client_id':'client'})
        client.transport.request.return_value=HttpResult(200,b'{"access_token":"new","refresh_token":"rotated","expires_in":3600}')
        write=client.storage.write_private_buffer
        def lost_ack(*args,**kwargs):
            write(*args,**kwargs)
            raise OSError('ack lost')
        with patch.object(client.storage,'write_private_buffer',side_effect=lost_ack):
            self.assertEqual(client.access_token(),'new')
        client.transport.request.assert_called_once()


class HiggsfieldLeaseTests(TransactionTestCase):
    def test_real_lease_marker_blocks_replica_after_unpersisted_rotation(self):
        from apps.admin_dashboard.models import AppSetting
        storage=StorageService(MemoryAdapter())
        storage.write_private_buffer(json.dumps({'access_token':'old','refresh_token':'old','client_id':'fixture'}).encode(),TOKEN_OBJECT_KEY,'application/json')
        transport=Mock(request=Mock(return_value=HttpResult(200,b'{"access_token":"new","refresh_token":"rotated","expires_in":3600}')))
        clock=[1000]
        first=HiggsfieldClient(storage=storage,transport=transport,lease=DatabaseLease(),env={},now=lambda:clock[0])
        with patch.object(storage,'write_private_buffer',side_effect=OSError('unavailable')):
            with self.assertRaisesRegex(ProviderError,'durably stored'):
                first.access_token()
        self.assertTrue(AppSetting.objects.filter(pk=ROTATION_STATE_KEY).exists())
        clock[0]+=60000
        second=HiggsfieldClient(storage=storage,transport=Mock(),lease=DatabaseLease(),env={},now=first.now)
        with self.assertRaisesRegex(ProviderError,'uncertain'):
            second.access_token()
        second.transport.request.assert_not_called()
        transport.request.assert_called_once()

    def test_uncertain_crash_marker_fences_expiry_and_allows_fresh_reseed(self):
        from apps.admin_dashboard.models import AppSetting
        lease=DatabaseLease()
        old={'access_token':'old','refresh_token':'old','client_id':'fixture'}
        self.assertTrue(lease.claim(REFRESH_LEASE_KEY,'first',1000,30000))
        lease.begin_rotation('first',old,1000)
        self.assertNotIn('"old"',AppSetting.objects.get(pk=ROTATION_STATE_KEY).value)
        self.assertTrue(lease.claim(REFRESH_LEASE_KEY,'second',31001,30000))
        with self.assertRaisesRegex(ProviderError,'uncertain'):
            lease.reconcile_rotation('second',old,31001)
        unchanged={**old,'obtained_at':31001,'expires_in':3600}
        with self.assertRaisesRegex(ProviderError,'uncertain'):
            lease.reconcile_rotation('second',unchanged,31001)
        wrote=Mock()
        with self.assertRaisesRegex(ProviderError,'lease lost'):
            lease.persist_rotation('first',31001,wrote)
        wrote.assert_not_called()
        fresh={'access_token':'new','refresh_token':'new','obtained_at':31001,'expires_in':3600}
        lease.reconcile_rotation('second',fresh,31001)
        self.assertFalse(AppSetting.objects.filter(pk=ROTATION_STATE_KEY).exists())

    def test_lease_expiry_and_stale_release_fencing(self):
        lease=DatabaseLease()
        self.assertTrue(lease.claim(REFRESH_LEASE_KEY,'first',1000,30000))
        self.assertFalse(lease.claim(REFRESH_LEASE_KEY,'second',2000,30000))
        self.assertTrue(lease.claim(REFRESH_LEASE_KEY,'second',31000,30000))
        self.assertFalse(lease.release(REFRESH_LEASE_KEY,'first'))
        self.assertTrue(lease.release(REFRESH_LEASE_KEY,'second'))

    def test_concurrent_database_claims_have_one_winner(self):
        import threading
        from concurrent.futures import ThreadPoolExecutor
        from django.db import connections
        barrier=threading.Barrier(8)
        def claim(index):
            try:
                barrier.wait(timeout=5)
                return DatabaseLease().claim(REFRESH_LEASE_KEY,f'owner-{index}',1000,30000)
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(claim,range(8))),1)
