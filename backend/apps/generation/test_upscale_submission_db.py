from uuid import uuid4
from unittest.mock import Mock
from django.test import TransactionTestCase
from apps.media.storage import StorageService,MemoryAdapter
from .models import Generation
from .test_enqueue import picture
from .services.deadline import Cancellation
from .services.upscale_submission import submit_claimed_upscale
from .services.executor import LeaseLost


class DurableUpscaleDatabaseTests(TransactionTestCase):
    def setUp(self):
        import os
        from unittest.mock import patch
        override=patch.dict(os.environ,{"MOCK_GENERATION":"0"})
        override.start();self.addCleanup(override.stop)

    def fixture(self):
        storage=StorageService(MemoryAdapter());storage.primary.put('references/job.png',picture(),'image/png','private')
        row=Generation.objects.create(kind='image',status='running',prompt='fixture',model='Magnific Precision V2',
            aspect_ratio='1:1',user_id=uuid4(),created_at=1,updated_at=1,worker_lease_id='owner',
            submission_input={'version':1,'source':'/api/media/references/job.png','params':{
                'scaleFactor':'4x','flavor':'photo','sharpen':7,'smartGrain':7,'ultraDetail':30}})
        return row,storage

    def test_intent_durable_before_single_submit_and_receipt_saved(self):
        row,storage=self.fixture()
        def submit(*args,**kwargs):
            row.refresh_from_db();self.assertEqual(row.provider_status,'SUBMISSION_PENDING')
            return {'taskId':'accepted'}
        submit=Mock(side_effect=submit)
        result=submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
        self.assertEqual((result.task_id,result.provider_status),('accepted','SUBMITTED'))
        submit.assert_called_once()
        with self.assertRaises(ValueError):
            submit_claimed_upscale(result,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
        submit.assert_called_once()

    def test_ambiguous_taskless_intent_cannot_replay(self):
        row,storage=self.fixture();submit=Mock(side_effect=TimeoutError())
        with self.assertRaises(TimeoutError):
            submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
        row.refresh_from_db();self.assertEqual(row.provider_status,'SUBMISSION_UNCERTAIN')
        with self.assertRaises(ValueError):
            submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
        submit.assert_called_once()

    def test_foreign_lease_never_submits(self):
        row,storage=self.fixture();submit=Mock()
        with self.assertRaises(LeaseLost):
            submit_claimed_upscale(row,owner='other',signal=Cancellation(),storage=storage,submit=submit)
        submit.assert_not_called()
        row.refresh_from_db();self.assertIsNone(row.provider_status)

    def test_ownerless_upscale_cannot_submit_even_with_a_worker_lease(self):
        row,storage=self.fixture();row.user_id=None;row.save()
        submit=Mock()
        with self.assertRaises(ValueError):
            submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
        submit.assert_not_called()
        row.refresh_from_db();self.assertIsNone(row.provider_status)

    def test_accepted_upscale_receipt_survives_metadata_change_during_submit(self):
        from unittest.mock import patch
        from apps.common.leases import now_ms
        from .history_writes import patch_metadata
        row,storage=self.fixture()
        timestamp=now_ms()+1000
        def submit(*args,**kwargs):
            with patch('apps.generation.history_writes.now_ms',return_value=timestamp):
                patch_metadata({'id':str(row.id),'isFavorite':True})
            return {'taskId':'accepted-after-favorite'}
        provider=Mock(side_effect=submit)
        result=submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=provider)
        self.assertEqual((result.task_id,result.provider_status,result.is_favorite),('accepted-after-favorite','SUBMITTED',True))
        self.assertGreater(result.updated_at,timestamp)
        provider.assert_called_once()

    def test_worker_uses_durable_submit_then_polls_receipt_without_resubmit(self):
        from unittest.mock import patch
        from .services.executor import process_generation
        row,storage=self.fixture()
        with patch('apps.generation.services.upscale_submission.get_storage',return_value=storage), patch(
                'apps.generation.providers.magnific.submit_upscale',return_value={'taskId':'accepted'}) as submit:
            result=process_generation(row.id,owner='owner',heartbeat=False)
            self.assertEqual(result['kind'],'pending')
            row.refresh_from_db();self.assertEqual(row.task_id,'accepted')
            with patch('apps.generation.services.executor.poller.advance',return_value={'kind':'pending'}) as poll:
                process_generation(row.id,owner='owner',heartbeat=False)
            submit.assert_called_once();poll.assert_called_once()

    def test_worker_holds_uncertain_intent_without_submit_or_poll(self):
        from unittest.mock import patch
        from .services.executor import process_generation
        row,storage=self.fixture();row.provider_status='SUBMISSION_UNCERTAIN';row.save()
        with patch('apps.generation.services.upscale_submission.submit_claimed_upscale') as submit, patch(
                'apps.generation.services.executor.poller.advance') as poll:
            result=process_generation(row.id,owner='owner',heartbeat=False)
        self.assertEqual(result['kind'],'submission_uncertain')
        submit.assert_not_called();poll.assert_not_called()

    def test_api_returns_durable_queue_without_paid_call_and_status_does_not_poll(self):
        from unittest.mock import patch
        from django.test import override_settings
        from apps.admin_dashboard.tests import SettingsTests,UID
        from .test_enqueue import data_url
        SettingsTests.setUp(self);SettingsTests.cookie(self)
        storage=StorageService(MemoryAdapter())
        payload={'model':'Magnific Precision V2','image':data_url(),'params':{
            'scaleFactor':'4x','flavor':'photo','sharpen':7,'smartGrain':7,'ultraDetail':30}}
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch('apps.generation.providers.magnific.submit_upscale') as submit:
            response=self.client.post('/api/generate/upscale',payload,content_type='application/json')
        self.assertEqual(response.status_code,200,response.content)
        row=Generation.objects.get(pk=response.json()['id'])
        self.assertEqual(row.status,'queued');self.assertEqual(str(row.user_id),UID)
        self.assertEqual(row.submission_input['params'],payload['params'])
        self.assertTrue(row.submission_input['source'].startswith('/api/media/references/'))
        self.assertNotIn('submissionInput',response.json());submit.assert_not_called()
        with patch('apps.generation.enqueue_views.advance_magnific') as poll:
            status=self.client.get('/api/generate/upscale/status',{'id':str(row.id)})
        self.assertEqual(status.status_code,200);self.assertEqual(status.json()['status'],'queued')
        poll.assert_not_called()

    def test_receipt_write_retry_and_lost_ack_do_not_resubmit(self):
        from unittest.mock import patch
        from django.db import OperationalError
        from .services import upscale_submission as module
        real=module._persist_receipt
        for mode in ['transient','lost-ack','permanent']:
            row,storage=self.fixture();submit=Mock(return_value={'taskId':'accepted-'+mode});attempts=[]
            def write(*args):
                attempts.append(1)
                if mode=='permanent' or mode=='transient' and len(attempts)==1:
                    raise OperationalError('receipt unavailable')
                real(*args)
                if mode=='lost-ack':raise OperationalError('ack lost')
            with patch.object(module,'_persist_receipt',side_effect=write):
                if mode=='permanent':
                    from .services.executor import ReceiptPersistenceError
                    with self.assertRaises(ReceiptPersistenceError):
                        submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
                else:
                    submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=submit)
            submit.assert_called_once();row.refresh_from_db()
            self.assertEqual(len(attempts),{'transient':2,'lost-ack':1,'permanent':3}[mode])
            self.assertEqual(row.provider_status,'SUBMISSION_UNCERTAIN' if mode=='permanent' else 'SUBMITTED')

    def test_receipt_readback_outage_does_not_abort_local_retry_or_resubmit(self):
        from unittest.mock import patch
        from django.db import OperationalError,InterfaceError
        from .services import upscale_submission as module
        real_write=module._persist_receipt
        real_filter=Generation.objects.filter
        for mode in ('transient','lost-ack'):
            with self.subTest(mode=mode):
                row,storage=self.fixture();task='accepted-'+mode+'-readback'
                provider=Mock(return_value={'taskId':task})
                writes,reads=[],[]
                def write(*args):
                    writes.append(True)
                    if len(writes)==1:
                        if mode=='lost-ack':real_write(*args)
                        raise OperationalError('fixture write acknowledgement unavailable')
                    return real_write(*args)
                def read(*args,**kwargs):
                    if kwargs.get('task_id')==task:
                        reads.append(True)
                        if len(reads)==1:raise InterfaceError('fixture readback unavailable')
                    return real_filter(*args,**kwargs)
                with patch.object(module,'_persist_receipt',side_effect=write),patch.object(Generation.objects,'filter',side_effect=read):
                    result=submit_claimed_upscale(row,owner='owner',signal=Cancellation(),storage=storage,submit=provider)
                self.assertEqual((result.task_id,result.provider_status),(task,'SUBMITTED'))
                provider.assert_called_once()
                self.assertEqual(len(writes),2)
                self.assertEqual(len(reads),1 if mode=='transient' else 2)

    def test_queued_worker_admits_then_submits_once(self):
        from unittest.mock import patch
        from .services.executor import process_generation
        row,storage=self.fixture();row.status='queued';row.worker_lease_id=None;row.save()
        with patch('apps.generation.services.upscale_submission.get_storage',return_value=storage), patch(
                'apps.generation.providers.magnific.submit_upscale',return_value={'taskId':'accepted'}) as submit:
            result=process_generation(row.id,owner='worker',heartbeat=False)
        self.assertEqual(result['kind'],'pending');submit.assert_called_once()
        row.refresh_from_db();self.assertEqual((row.status,row.task_id),('running','accepted'))
        self.assertIsNone(row.worker_lease_id)

    def test_worker_reloads_persisted_parameters_after_admission_client_exits(self):
        from unittest.mock import patch
        from .services.executor import process_generation
        row,storage=self.fixture();row.status='queued';row.worker_lease_id=None;row.save()
        identifier=row.id
        del row
        def submit(payload,**kwargs):
            self.assertEqual(payload['params']['scaleFactor'],'4x')
            self.assertEqual(payload['params']['ultraDetail'],30)
            self.assertTrue(payload['image'].startswith('data:image/png;base64,'))
            return {'taskId':'restart-receipt'}
        with patch('apps.generation.services.upscale_submission.get_storage',return_value=storage),patch(
                'apps.generation.providers.magnific.submit_upscale',side_effect=submit) as provider:
            result=process_generation(identifier,owner='restarted-worker',heartbeat=False)
        provider.assert_called_once();self.assertEqual(result['item'].task_id,'restart-receipt')

    def test_explicit_mock_worker_completes_without_paid_submit_or_status_call(self):
        import os
        from unittest.mock import patch
        from .services.executor import process_generation
        from .services import poller
        row,storage=self.fixture();row.status='queued';row.worker_lease_id=None;row.save()
        with patch.dict(os.environ,{'MOCK_GENERATION':'1'}),patch(
                'apps.generation.services.upscale_submission.get_storage',return_value=storage),patch(
                'apps.generation.providers.magnific.submit_upscale') as submit,patch(
                'apps.generation.services.poller.Dependencies.get_magnific') as status:
            first=process_generation(row.id,owner='mock-worker',heartbeat=False)
            self.assertEqual(first['kind'],'pending')
            second=process_generation(row.id,owner='mock-worker',heartbeat=False)
        self.assertEqual(second['kind'],'succeeded')
        row.refresh_from_db();self.assertEqual(row.provider_status,'MOCK_COMPLETED')
        self.assertEqual(row.url,row.submission_input['source'])
        submit.assert_not_called();status.assert_not_called()
