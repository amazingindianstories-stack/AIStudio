from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
from django.db import OperationalError, connections
from django.test import TransactionTestCase,override_settings
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.library.models import GenerationNaming
from apps.media.storage import StorageService,MemoryAdapter
from .models import Generation
from . import enqueue_views as views
from .services import coordinator
from .test_enqueue import data_url,picture


class UpscaleIntentTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        user=User.objects.create(email='upscale-intent@example.test',name='Fixture',role='user',password_hash='x',created_at=1)
        self.client.cookies['veevee_session']=sign_session(user)
        self.storage=StorageService(MemoryAdapter())
        self.override=override_settings(VEEVEE_MEDIA_STORAGE=self.storage,VEEVEE_MAGNIFIC_UPSCALE=True)
        self.override.enable();self.addCleanup(self.override.disable)
        self.payload={'model':'Magnific Precision V2','image':data_url(picture(160,90)),
            'params':{'scaleFactor':'4x','flavor':'photo','sharpen':7,'smartGrain':7,'ultraDetail':30}}

    def post(self,**extra):
        return self.client.post('/api/generate/upscale',{**self.payload,**extra},content_type='application/json')

    def test_pricing_location_and_intent_db_failure_never_submit(self):
        with patch.object(views.magnific,'submit_upscale') as submit:
            with patch.object(views.submission,'read_pricing',return_value=[]):
                self.assertEqual(self.post().status_code,500)
            self.assertEqual(self.post(folderId=str(uuid4())).status_code,500)
            with patch.object(views.submission.enqueue,'persist',side_effect=OperationalError('synthetic DB unavailable')):
                self.assertEqual(self.post().status_code,500)
            submit.assert_not_called()
        self.assertEqual(Generation.objects.count(),0)

    def test_internal_admission_error_does_not_disclose_credentials_or_submit(self):
        with patch.object(views.submission,'read_pricing',side_effect=OperationalError('private-fixture-token')), patch.object(
                views.magnific,'submit_upscale') as submit:
            response = self.post()
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Failed to start upscale generation.'})
        submit.assert_not_called()
        self.assertEqual(Generation.objects.count(),0)

    def test_admission_commits_reference_params_and_name_without_paid_call(self):
        with patch.object(views.magnific,'submit_upscale') as provider:
            response=self.post()
        self.assertEqual(response.status_code,200,response.content)
        provider.assert_not_called()
        intent=Generation.objects.get()
        self.assertEqual((intent.status,intent.task_id,intent.provider_status),('queued',None,None))
        self.assertTrue(GenerationNaming.objects.filter(generation_id=intent.id).exists())
        self.assertEqual(intent.submission_input['params'],self.payload['params'])
        self.assertTrue(any(key.startswith('references/') for key in self.storage.primary.objects))
        def committed_on_another_connection():
            try:return Generation.objects.filter(pk=intent.id,status='queued',submission_input__isnull=False).exists()
            finally:connections.close_all()
        with ThreadPoolExecutor(max_workers=1) as pool:
            self.assertTrue(pool.submit(committed_on_another_connection).result(timeout=5))
        self.assertNotIn('taskId',response.json())

    def test_oversized_stored_input_rejected_before_read_or_paid_intent(self):
        from unittest.mock import Mock
        from apps.media.storage import MediaObject
        stream=Mock()
        with patch.object(self.storage,'open',return_value=MediaObject(stream,'image/png',21*1024*1024)), patch(
                'apps.generation.enqueue_views.magnific.submit_upscale') as submit:
            response=self.post(image='/api/media/uploads/too-large.png')
        self.assertEqual(response.status_code,400)
        submit.assert_not_called()
        stream.close.assert_called_once()
        self.assertEqual(stream.mock_calls[:-1],[])
        self.assertEqual(Generation.objects.count(),0)
        self.assertEqual(GenerationNaming.objects.count(),0)

    def test_read_capacity_busy_rejects_before_storage_intent_or_paid_call(self):
        from .services.deadline import QueueExecutionCapacityError
        with patch('apps.generation.services.submission.with_queue_execution_deadline',side_effect=QueueExecutionCapacityError()), patch.object(
                self.storage,'read_as_base64') as read, patch('apps.generation.enqueue_views.magnific.submit_upscale') as submit:
            response=self.post()
        self.assertEqual(response.status_code,429)
        self.assertEqual(response.json(),{'error':'MEDIA_READ_CAPACITY_BUSY'})
        self.assertEqual(response['Retry-After'],'1')
        read.assert_not_called();submit.assert_not_called()
        self.assertEqual(Generation.objects.count(),0)
        self.assertEqual(GenerationNaming.objects.count(),0)
