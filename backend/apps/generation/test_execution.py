import base64
from concurrent.futures import ThreadPoolExecutor
import io
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.db import connections, OperationalError
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from PIL import Image

from apps.library.models import GenerationNaming
from .models import Generation
from .services import admission, coordinator, executor, video_execution
from .services.deadline import Cancellation
from .providers.transport import ProviderError
from .callbacks import extract_task_id, token_matches


class VideoPreparationTests(SimpleTestCase):
    def item(self, **values):
        return SimpleNamespace(**{'id': uuid4(), 'status': 'running', 'task_id': None, 'draft_task_id': None,
            'model': 'Seedance 2.5', 'prompt': '@sati and @img2 then @vid3 with @audio2', 'aspect_ratio': '16:9',
            'duration': 5, 'resolution': '1080p', 'reference_images': ['one', 'two'], 'reference_videos': ['v1', 'v2', 'v3'],
            'reference_audios': ['a1', 'a2'], 'project_id': None, 'continuation_frame_url': None, 'last_frame_url': None,
            'generate_audio': True, 'draft_mode': False, 'bitrate_mode': 'high', 'video_task_mode': None,
            'seed': 17, 'cost_cents': 120, **values})

    def test_reference_groups_order_remapping_and_partial_receipts(self):
        calls, receipts = [], []
        deps = video_execution.Dependencies()
        deps.assets = lambda _: [{'slug': 'sati', 'kind': 'character', 'name': 'Sati', 'images': ['sati-url']}]
        deps.inline = lambda refs, signal: ['inline:' + ref for ref in refs]
        deps.sign = lambda ref: 'signed:' + ref
        def submit(input, *, signal):
            calls.append(input)
            if len(calls) == 2:
                raise ProviderError('candidate rejected', provider_response={'code': 'fixture'},may_have_submitted=False)
            return 'task-' + str(len(calls))
        deps.seedance_submit = submit
        outcome = video_execution.submit_video(self.item(), signal=Cancellation(), on_task=lambda *args: receipts.append(args), count=3, dependencies=deps, env={})
        self.assertEqual(receipts, [('task-1', 0, 3), ('task-3', 2, 3)])
        self.assertEqual((outcome['task_id'], outcome['candidate_task_ids'], outcome['cost_cents']), ('task-1', ['task-3'], 80))
        self.assertEqual([call['seed'] for call in calls], [17, 18, 19])
        self.assertEqual(calls[0]['referenceVideoUrls'], ['signed:v3'])
        self.assertEqual(calls[0]['referenceAudioUrls'], ['signed:a2'])
        self.assertEqual(calls[0]['prompt'], '@sati and @img2 then @vid1 with @audio1')
        self.assertEqual([ref['tag'] for ref in calls[0]['references']], ['@sati', '@img2'])
        self.assertEqual([ref['dataUrl'] for ref in calls[0]['references']], ['inline:sati-url', 'inline:two'])

    def test_receipt_failure_stops_further_billed_submissions(self):
        deps = video_execution.Dependencies()
        deps.assets, deps.inline, deps.sign = lambda _: [], lambda refs, signal: [], lambda ref: ref
        submitted = []
        deps.seedance_submit = lambda *args, **kwargs: submitted.append('accepted') or 'real-task'
        def persist(*args):
            raise RuntimeError('DB unavailable after provider acceptance')
        with self.assertRaisesRegex(RuntimeError, 'DB unavailable'):
            video_execution.submit_video(self.item(reference_images=[]), signal=Cancellation(), on_task=persist, count=3, dependencies=deps, env={})
        self.assertEqual(submitted, ['accepted'])

    def test_ambiguous_candidate_timeout_stops_later_paid_submissions(self):
        deps = video_execution.Dependencies()
        deps.assets, deps.inline, deps.sign = lambda _: [], lambda refs, signal: [], lambda ref: ref
        submitted=[]
        def submit(*args,**kwargs):
            submitted.append('remote-attempt')
            if len(submitted)==1:
                raise TimeoutError('remote acceptance acknowledgment lost')
            return 'later-task'
        deps.seedance_submit=submit
        with self.assertRaisesRegex(TimeoutError,'acknowledgment lost'):
            video_execution.submit_video(self.item(reference_images=[]),signal=Cancellation(),on_task=lambda *args:None,
                count=3,dependencies=deps,env={})
        self.assertEqual(submitted,['remote-attempt'])

    def test_accepted_candidate_receipt_precedes_later_ambiguous_timeout(self):
        deps = video_execution.Dependencies()
        deps.assets, deps.inline, deps.sign = lambda _: [], lambda refs, signal: [], lambda ref: ref
        submitted,receipts=[],[]
        def submit(*args,**kwargs):
            submitted.append('remote-attempt')
            if len(submitted)==2:
                raise TimeoutError('second task acknowledgment lost')
            return 'first-receipt'
        deps.seedance_submit=submit
        with self.assertRaisesRegex(TimeoutError,'acknowledgment lost'):
            video_execution.submit_video(self.item(reference_images=[]),signal=Cancellation(),on_task=lambda *args:receipts.append(args),
                count=3,dependencies=deps,env={})
        self.assertEqual(submitted,['remote-attempt','remote-attempt'])
        self.assertEqual(receipts,[('first-receipt',0,3)])

    def test_draft_finalization_bypasses_prompt_reference_and_bestof(self):
        deps = video_execution.Dependencies()
        calls = []
        deps.seedance_final = lambda input, **kwargs: calls.append(input) or 'final-task'
        deps.assets = lambda _: self.fail('Draft finalization assembled references')
        outcome = video_execution.submit_video(self.item(draft_task_id='draft-id'), signal=Cancellation(), on_task=lambda *args: None,
            count=3, dependencies=deps, env={'SEEDANCE_CALLBACK_URL': 'https://app.example/api/webhooks/seedance?token=old', 'SEEDANCE_CALLBACK_SECRET': 'fixture'})
        self.assertEqual(outcome['task_id'], 'final-task')
        self.assertEqual(calls, [{'modelDisplay': 'Seedance 2.5', 'draftTaskId': 'draft-id', 'callbackUrl': 'https://app.example/api/webhooks/seedance?token=fixture'}])

    def test_portrait_asset_uri_shortcuts_and_nonjpeg_conversion(self):
        buffer = io.BytesIO()
        Image.new('RGB', (512, 512), 'red').save(buffer, format='WEBP')
        data = base64.b64encode(buffer.getvalue()).decode()
        reads = []
        def read(ref):
            reads.append(ref)
            return {'mimeType': 'image/webp', 'data': data}
        output = video_execution.to_provider_data_urls(['asset://native', '/api/media/one?bp_asset_id=remote%3Aid', 'portrait', 'webp'],
            Cancellation(), read=read, prepare=lambda mime, data: {'mimeType': mime, 'data': data},
            portrait_lookup=lambda ref: {'byteplusAssetId': 'portrait-id', 'status': 'Active'} if ref == 'portrait' else None)
        self.assertEqual(output[:3], ['asset://native', 'asset://remote:id', 'asset://portrait-id'])
        self.assertEqual(reads, ['webp'])
        self.assertTrue(output[-1].startswith('data:image/jpeg;base64,'))

    def test_task_id_and_callback_credentials_are_strict(self):
        for payload in ({'id': 'task.ok-1:2'}, {'task_id': ' task.ok-1:2 '}, {'data': {'id': 'task.ok-1:2'}}):
            self.assertEqual(extract_task_id(payload), 'task.ok-1:2')
        for payload in ({'id': '../private'}, {'id': 'x' * 257}, {'id': ''}, {'id': 1}, None):
            self.assertIsNone(extract_task_id(payload))
        self.assertTrue(token_matches('fixture', 'fixture'))
        self.assertFalse(token_matches('', ''))
        self.assertFalse(token_matches('fixture', 'different'))


class ExecutionPersistenceTests(TransactionTestCase):
    def job(self, **values):
        return Generation.objects.create(**{'kind': 'image', 'status': 'queued', 'model': 'Nano Banana Pro', 'prompt': 'fixture',
            'aspect_ratio': '1:1', 'created_at': 100, 'updated_at': 100, 'cost_cents': 14, 'user_id':uuid4(), **values})

    def test_transient_naming_failure_recovers_uploaded_image_without_provider_replay(self):
        from apps.media.storage import StorageService,MemoryAdapter
        storage=StorageService(MemoryAdapter())
        item=self.job()
        calls=[]
        master=b'original synchronous master bytes'
        real=executor.assign_generation_naming
        naming=[]
        def name(*args,**kwargs):
            naming.append(True)
            if len(naming)==1:
                raise OperationalError('injected transient naming persistence failure')
            return real(*args,**kwargs)
        def image(job,**kwargs):
            calls.append(True)
            return {'status':'succeeded','url':storage.upload_buffer(master,'generations/immutable-master.png','png')}
        with patch.object(executor,'assign_generation_naming',side_effect=name):
            outcome=executor.process_generation(item.id,owner='image-worker',image_execute=image,heartbeat=False,env={})
        self.assertEqual(outcome['kind'],'succeeded')
        item.refresh_from_db()
        self.assertEqual((item.status,len(calls),len(naming)),('succeeded',1,2))
        self.assertEqual(storage.read('generations/immutable-master.png'),master)
        self.assertEqual(GenerationNaming.objects.filter(generation_id=item.id).count(),1)

    def test_completion_commit_ack_loss_recognizes_exact_master_without_provider_replay(self):
        item=self.job()
        calls=[]
        real=executor._persist_completion
        def committed(*args,**kwargs):
            real(*args,**kwargs)
            raise OperationalError('injected completed transaction ack loss')
        def image(job,**kwargs):
            calls.append(True)
            return {'status':'succeeded','url':'/api/media/generations/immutable-master.png'}
        with patch.object(executor,'_persist_completion',side_effect=committed) as writes:
            outcome=executor.process_generation(item.id,owner='image-worker',image_execute=image,heartbeat=False,env={})
        self.assertEqual(outcome['kind'],'succeeded')
        self.assertEqual((len(calls),writes.call_count),(1,1))
        self.assertEqual(GenerationNaming.objects.filter(generation_id=item.id).count(),1)

    def test_completed_image_survives_history_metadata_changes_without_repeating_provider(self):
        from apps.projects.models import Project
        from .history_writes import patch_metadata
        from apps.common.leases import now_ms
        from apps.library.services.naming import namespace_for
        project=Project.objects.create(name='Completed image destination',created_at=1,updated_at=1)
        for metadata in ({'isFavorite':True},{'flagged':True,'flagReason':'fixture'},
                {'projectId':str(project.id)}):
            with self.subTest(metadata=metadata):
                item=self.job();calls=[];timestamp=now_ms()+1000
                def image(job,**kwargs):
                    calls.append(True)
                    with patch('apps.generation.history_writes.now_ms',return_value=timestamp),patch(
                            'apps.library.services.folder_engine.now_ms',return_value=timestamp):
                        patch_metadata({'id':str(job.id),**metadata})
                    return {'status':'succeeded','url':f'/api/media/generations/{job.id}/original-master.png'}
                result=executor.process_generation(item.id,owner='image-worker',image_execute=image,heartbeat=False,env={})
                self.assertEqual(result['kind'],'succeeded')
                item.refresh_from_db()
                self.assertEqual(len(calls),1)
                self.assertGreater(item.updated_at,timestamp)
                if 'isFavorite' in metadata:self.assertTrue(item.is_favorite)
                if 'flagged' in metadata:self.assertEqual((item.flagged,item.flag_reason),(True,'fixture'))
                if 'projectId' in metadata:self.assertEqual(item.project_id,project.id)
                naming=GenerationNaming.objects.get(generation_id=item.id)
                self.assertEqual(naming.namespace,namespace_for(item.folder_id,item.project_id))
                self.assertEqual(executor.process_generation(item.id,image_execute=image,heartbeat=False,env={})['kind'],'unclaimed')
                self.assertEqual(len(calls),1)

    def test_completion_lost_ack_with_later_metadata_change_recognizes_committed_master(self):
        from .history_writes import patch_metadata
        from apps.common.leases import now_ms
        item=self.job();calls=[];real=executor._persist_completion
        def committed(*args,**kwargs):
            current=real(*args,**kwargs)
            with patch('apps.generation.history_writes.now_ms',return_value=now_ms()+1000):
                patch_metadata({'id':str(current.id),'isFavorite':True})
            raise OperationalError('fixture completion acknowledgement lost')
        def image(job,**kwargs):
            calls.append(True)
            return {'status':'succeeded','url':f'/api/media/generations/{job.id}/original-master.png'}
        with patch.object(executor,'_persist_completion',side_effect=committed) as writes:
            result=executor.process_generation(item.id,owner='image-worker',image_execute=image,heartbeat=False,env={})
        self.assertEqual(result['kind'],'succeeded')
        self.assertEqual((len(calls),writes.call_count),(1,1))
        item.refresh_from_db();self.assertTrue(item.is_favorite)
        self.assertEqual(GenerationNaming.objects.filter(generation_id=item.id).count(),1)

    def test_completed_image_cannot_overwrite_changed_execution_or_winning_master(self):
        for changed in ({'worker_lease_id':'other-worker'},{'user_id':uuid4()},
                {'reference_images':['/api/media/references/changed-input.png']},
                {'status':'succeeded','url':'/api/media/generations/winner.png'}):
            with self.subTest(changed=changed):
                item=self.job();calls=[]
                before=list(GenerationNaming.objects.filter(generation_id=item.id).values())
                def image(job,**kwargs):
                    calls.append(True)
                    Generation.objects.filter(pk=job.id).update(**changed)
                    return {'status':'succeeded','url':'/api/media/generations/stale-master.png'}
                with self.assertRaises(executor.LeaseLost):
                    executor.process_generation(item.id,owner='image-worker',image_execute=image,heartbeat=False,env={})
                item.refresh_from_db()
                self.assertNotEqual(item.url,'/api/media/generations/stale-master.png')
                self.assertEqual(len(calls),1)
                for field,value in changed.items():
                    self.assertEqual(getattr(item,field),value)
                self.assertEqual(list(GenerationNaming.objects.filter(generation_id=item.id).values()),before)

    def test_persistent_naming_database_failure_remains_fail_closed_without_replay(self):
        item=self.job()
        before=list(GenerationNaming.objects.filter(generation_id=item.id).values())
        calls=[]
        def image(job,**kwargs):
            calls.append(True)
            return {'status':'succeeded','url':'/api/media/generations/orphaned-master.png'}
        with patch.object(executor,'assign_generation_naming',side_effect=OperationalError('persistent naming DB failure')) as naming:
            with self.assertRaises(OperationalError):
                executor.process_generation(item.id,owner='image-worker',image_execute=image,heartbeat=False,env={})
        item.refresh_from_db()
        self.assertEqual((item.status,item.url,item.worker_lease_id,naming.call_count),('running',None,None,3))
        self.assertEqual(executor.process_generation(item.id,image_execute=image,heartbeat=False,env={})['kind'],'unclaimed')
        self.assertEqual(len(calls),1)
        self.assertEqual(list(GenerationNaming.objects.filter(generation_id=item.id).values()),before)

    def test_naming_validation_failure_is_not_retried_as_database_transience(self):
        item=self.job()
        with patch.object(executor,'assign_generation_naming',side_effect=ValueError('invalid naming scope')) as naming:
            with self.assertRaisesRegex(ValueError,'invalid naming scope'):
                executor.process_generation(item.id,owner='image-worker',image_execute=lambda *args,**kwargs:
                    {'status':'succeeded','url':'/api/media/generations/master.png'},heartbeat=False,env={})
        self.assertEqual(naming.call_count,1)

    def test_shared_receipt_transient_write_retries_without_resubmission(self):
        item=self.job(kind='video',model='Seedance 2.5')
        submit_calls,receipt_writes=[],[]
        real=executor._persist_task_receipt
        def write(job,owner,updates):
            if updates.get('task_id')=='accepted':
                receipt_writes.append(True)
                if len(receipt_writes)==1:
                    raise OperationalError('injected receipt write failure')
            return real(job,owner,updates)
        def submit(job,*,on_task,**kwargs):
            submit_calls.append(True)
            on_task('accepted')
            return {'status':'running'}
        with patch.object(executor,'_persist_task_receipt',side_effect=write):
            outcome=executor.process_generation(item.id,owner='receipt-worker',video_submit=submit,heartbeat=False,env={})
        self.assertEqual(outcome['kind'],'running')
        item.refresh_from_db()
        self.assertEqual((len(submit_calls),len(receipt_writes),item.task_id),(1,2,'accepted'))

    def test_accepted_video_receipt_survives_history_metadata_changes(self):
        from apps.projects.models import Project
        from .history_writes import patch_metadata
        from apps.common.leases import now_ms
        project=Project.objects.create(name='Receipt destination',created_at=1,updated_at=1)
        for metadata in ({'isFavorite':True},{'flagged':True,'flagReason':'fixture'},
                {'projectId':str(project.id)}):
            with self.subTest(metadata=metadata):
                item=self.job(kind='video',model='Seedance 2.5')
                calls=[]
                metadata_time=now_ms()+1000
                def submit(job,*,on_task,**kwargs):
                    calls.append(True)
                    with patch('apps.generation.history_writes.now_ms',return_value=metadata_time),patch(
                            'apps.library.services.folder_engine.now_ms',return_value=metadata_time):
                        patch_metadata({'id':str(job.id),**metadata})
                    on_task('accepted-after-metadata')
                    return {'status':'running'}
                result=executor.process_generation(item.id,owner='receipt-worker',video_submit=submit,heartbeat=False,env={})
                self.assertEqual(result['kind'],'running')
                item.refresh_from_db()
                self.assertEqual(item.task_id,'accepted-after-metadata')
                self.assertGreater(item.updated_at,metadata_time)
                if 'isFavorite' in metadata:self.assertTrue(item.is_favorite)
                if 'flagged' in metadata:self.assertEqual((item.flagged,item.flag_reason),(True,'fixture'))
                if 'projectId' in metadata:self.assertEqual(item.project_id,project.id)
                with patch.object(executor.poller,'advance',return_value={'kind':'pending'}):
                    executor.process_generation(item.id,video_submit=submit,heartbeat=False,env={})
                self.assertEqual(len(calls),1)

    def test_shared_receipt_commit_ack_loss_is_read_back_without_resubmission(self):
        item=self.job(kind='video',model='Seedance 2.5')
        submit_calls,receipt_writes=[],[]
        real=executor._persist_task_receipt
        def write(job,owner,updates):
            result=real(job,owner,updates)
            if updates.get('task_id')=='accepted':
                receipt_writes.append(True)
                raise OperationalError('injected committed receipt ack loss')
            return result
        def submit(job,*,on_task,**kwargs):
            submit_calls.append(True)
            on_task('accepted')
            return {'status':'running'}
        with patch.object(executor,'_persist_task_receipt',side_effect=write):
            outcome=executor.process_generation(item.id,owner='receipt-worker',video_submit=submit,heartbeat=False,env={})
        self.assertEqual(outcome['kind'],'running')
        item.refresh_from_db()
        self.assertEqual((len(submit_calls),len(receipt_writes),item.task_id),(1,1,'accepted'))

    def test_accepted_receipt_cannot_cross_execution_ownership_or_prior_receipt(self):
        for changed in ({'worker_lease_id':'other'},{'task_id':'other-task'},
                {'user_id':uuid4()},{'status':'failed'}):
            with self.subTest(changed=changed):
                item=self.job(kind='video',model='Seedance 2.5')
                calls=[]
                def submit(job,*,on_task,**kwargs):
                    calls.append(True)
                    Generation.objects.filter(pk=job.id).update(**changed)
                    on_task('must-not-overwrite')
                    return {'status':'running'}
                result=executor.process_generation(item.id,owner='receipt-worker',video_submit=submit,heartbeat=False,env={})
                self.assertEqual(result['kind'],'raced')
                item.refresh_from_db()
                self.assertNotEqual(item.task_id,'must-not-overwrite')
                for field,value in changed.items():
                    if field!='worker_lease_id':self.assertEqual(getattr(item,field),value)
                if 'worker_lease_id' in changed:self.assertEqual(item.worker_lease_id,'other')
                self.assertEqual(len(calls),1)

    def test_shared_receipt_exhausted_writes_never_replay_paid_submission(self):
        item=self.job(kind='video',model='Seedance 2.5')
        submit_calls,receipt_writes=[],[]
        real=executor._persist_task_receipt
        def write(job,owner,updates):
            if updates.get('task_id')=='accepted':
                receipt_writes.append(True)
                raise OperationalError('injected persistent receipt write failure')
            return real(job,owner,updates)
        def submit(job,*,on_task,**kwargs):
            submit_calls.append(True)
            on_task('accepted')
            self.fail('Execution continued after unpersisted receipt')
        with patch.object(executor,'_persist_task_receipt',side_effect=write):
            with self.assertRaises(executor.ReceiptPersistenceError):
                executor.process_generation(item.id,owner='receipt-worker',video_submit=submit,heartbeat=False,env={})
        item.refresh_from_db()
        self.assertEqual((len(submit_calls),len(receipt_writes),item.status,item.task_id,item.worker_lease_id),(1,3,'running',None,None))
        self.assertEqual(executor.process_generation(item.id,video_submit=submit,heartbeat=False,env={})['kind'],'pending')
        self.assertEqual(len(submit_calls),1)

    def test_execute_once_fenced_completion_and_naming(self):
        item = self.job()
        calls = []
        def image(job, **options):
            calls.append(job.seed)
            return {'status': 'succeeded', 'url': '/api/media/generations/master.png', 'cost_cents': 28}
        outcome = executor.process_generation(item.id, owner='worker', image_execute=image, heartbeat=False, env={})
        self.assertEqual(outcome['kind'], 'succeeded')
        self.assertIsInstance(calls[0], int)
        self.assertEqual(GenerationNaming.objects.filter(generation_id=item.id).count(), 1)
        self.assertEqual(executor.process_generation(item.id, image_execute=image, heartbeat=False)['kind'], 'unclaimed')
        self.assertEqual(len(calls), 1)
        item.refresh_from_db()
        self.assertIsNone(item.worker_lease_id)

    def test_partial_video_receipt_survives_process_failure_and_never_resubmits(self):
        item = self.job(kind='video', model='Seedance 2.5', reference_images=['ref'], cost_cents=40)
        submitted=[]
        deps=video_execution.Dependencies()
        deps.assets,deps.inline,deps.sign=lambda _:[],lambda refs,signal:['inline:'+ref for ref in refs],lambda ref:ref
        def remote(*args,**kwargs):
            submitted.append('remote-attempt')
            if len(submitted)==2:
                raise TimeoutError('remaining candidate acknowledgment lost')
            return 'accepted-remote'
        deps.seedance_submit=remote
        def submit(job, *, on_task, **options):
            self.assertEqual(job.cost_cents, 120)
            return video_execution.submit_video(job,on_task=on_task,dependencies=deps,**options)
        outcome = executor.process_generation(item.id, owner='worker', video_submit=submit, heartbeat=False, env={'VIDEO_BEST_OF': '3'})
        self.assertEqual(outcome['kind'], 'pending')
        self.assertEqual(submitted,['remote-attempt','remote-attempt'])
        item.refresh_from_db()
        self.assertEqual((item.status, item.task_id, item.cost_cents), ('running', 'accepted-remote', 40))
        with patch.object(executor.poller, 'advance', return_value={'kind': 'pending'}) as advance:
            self.assertEqual(executor.process_generation(item.id, video_submit=lambda *a, **kw: self.fail('resubmitted'), heartbeat=False)['kind'], 'pending')
        advance.assert_called_once()

    def test_late_result_after_deadline_cannot_finalize(self):
        item = self.job()
        cancellation = Cancellation()
        def image(job, **options):
            cancellation.cancelled.set()
            return {'status': 'succeeded', 'url': '/api/media/late.png'}
        outcome = executor.process_generation(item.id, owner='worker', signal=cancellation, image_execute=image, heartbeat=False, env={})
        self.assertEqual(outcome['kind'], 'failed')
        item.refresh_from_db()
        self.assertIsNone(item.url)
        self.assertIn('deadline', item.error)

    def test_success_persistence_error_is_not_provider_failure(self):
        item = self.job(status='running', worker_lease_id='worker', seed=42)
        with patch.object(executor, '_fenced_completion_update', side_effect=RuntimeError('database disconnected')):
            with self.assertRaisesRegex(RuntimeError, 'database disconnected'):
                executor.execute_admitted(item, owner='worker', env={}, image_execute=lambda *a, **kw: {'status': 'succeeded', 'url': 'original'})
        item.refresh_from_db()
        self.assertEqual(item.status, 'running')

    def test_active_lease_and_accepted_tasks_survive_stale_reaper(self):
        now = 1000000
        old = self.job(status='running', updated_at=1)
        active = self.job(status='running', updated_at=1, worker_lease_until=now + 1000)
        receipt = self.job(status='running', updated_at=1, model='Kling Image 3.0', task_id='accepted')
        magnific = self.job(status='running', updated_at=1, model='Magnific Creative', task_id='accepted')
        self.assertEqual(admission.reap_stale_running_images(now=now), 1)
        self.assertEqual(Generation.objects.get(pk=old.id).status, 'failed')
        self.assertEqual(Generation.objects.filter(pk__in=[active.id, receipt.id, magnific.id], status='running').count(), 3)
        self.assertIn(receipt.id, [item.id for item in coordinator.select_due_generations(now=now)])

    @override_settings(SEEDANCE_CALLBACK_SECRET='callback-fixture')
    def test_callback_auth_replay_unknown_and_fenced_terminal(self):
        path = '/api/webhooks/seedance'
        self.assertEqual(self.client.post(path, data={}, content_type='application/json').status_code, 401)
        self.assertEqual(self.client.post(path + '?token=callback-fixture', data={'id': '../bad'}, content_type='application/json').status_code, 400)
        response = self.client.post(path + '?token=callback-fixture', data={'id': 'unknown'}, content_type='application/json')
        self.assertEqual((response.status_code, response.json()), (202, {'accepted': False}))
        item = self.job(kind='video', status='running', model='Seedance 2.5', task_id='real-task')
        with patch('apps.generation.services.poller.Dependencies.mock', return_value=False):
            response = self.client.post(path + '?token=callback-fixture', data={'id': 'real-task', 'status': 'failed', 'error': {'message': 'provider rejected'}}, content_type='application/json')
        self.assertEqual(response.json(), {'accepted': True, 'outcome': 'failed'})
        item.refresh_from_db()
        self.assertEqual(item.status, 'failed')
        with patch('apps.generation.callbacks.poller.advance', side_effect=AssertionError('replayed terminal callback advanced')):
            response = self.client.post(path + '?token=callback-fixture', data={'id': 'real-task', 'status': 'failed'}, content_type='application/json')
            self.assertEqual(response.json()['outcome'], 'failed')

    @override_settings(GENERATION_WORKER_SECRET='worker-fixture')
    def test_http_executor_is_retired_without_provider_calls(self):
        self.assertEqual(self.client.post('/api/queue/execute', data={'id': str(uuid4())}, content_type='application/json').status_code, 401)
        response = self.client.post('/api/queue/execute', data={'id': str(uuid4())}, content_type='application/json', HTTP_X_GENERATION_WORKER_SECRET='worker-fixture')
        self.assertEqual((response.status_code, response.json()['error']), (410, 'QUEUE_EXECUTION_MOVED'))


class SubmissionUncertaintyTests(TransactionTestCase):
    def test_classification_is_conservative_for_definite_rejections(self):
        from .services.executor import submission_uncertain
        from .providers.transport import ProviderError
        self.assertTrue(submission_uncertain(TimeoutError('read timed out')))
        self.assertTrue(submission_uncertain(ProviderError('gateway', status=502)))
        self.assertTrue(submission_uncertain(ProviderError('timeout', status=408)))
        self.assertTrue(submission_uncertain(ProviderError('no response')))
        self.assertFalse(submission_uncertain(ProviderError('safety', status=400)))
        self.assertFalse(submission_uncertain(ProviderError('server', status=503, may_have_submitted=False)))
        self.assertFalse(submission_uncertain(ValueError('local validation')))
