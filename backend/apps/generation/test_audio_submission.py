from uuid import uuid4
from django.test import TransactionTestCase
from apps.generation.models import Generation
from apps.generation.services.audio_submission import AUDIO_READY, claim_audio


class AudioClaimTests(TransactionTestCase):
    def test_full_account_audio_backlog_cannot_hide_unrelated_work(self):
        from apps.generation.services.coordinator import select_due_generations
        from django.test import override_settings
        owner=uuid4()
        self.job(user_id=owner,status='running',provider_status='SUBMISSION_UNCERTAIN')
        backlog=[self.job(user_id=owner,created_at=i+2) for i in range(30)]
        other=self.job(created_at=100)
        image=self.job(kind='image',created_at=101)
        with override_settings(AUDIO_MAX_CONCURRENT=2,AUDIO_MAX_PER_USER=1):
            selected=select_due_generations(now=1000)
        self.assertEqual([row.id for row in selected],[other.id,image.id])
        self.assertTrue(all(row.status=='queued' for row in Generation.objects.filter(pk__in=[r.id for r in backlog])))

    def test_audio_selection_apportions_free_slots_before_batch_limit(self):
        from apps.generation.services.coordinator import select_due_generations
        from django.test import override_settings
        owner=uuid4()
        first=self.job(user_id=owner,created_at=1)
        for i in range(30):self.job(user_id=owner,created_at=i+2)
        other=self.job(created_at=100)
        image=self.job(kind='image',created_at=101)
        with override_settings(AUDIO_MAX_CONCURRENT=2,AUDIO_MAX_PER_USER=1):
            self.assertEqual([row.id for row in select_due_generations(now=1000)],
                             [first.id,other.id,image.id])
        with override_settings(AUDIO_MAX_CONCURRENT=3,AUDIO_MAX_PER_USER=2):
            selected=select_due_generations(now=1000)
            self.assertEqual([row.user_id for row in selected if row.kind=='audio'],[owner,owner,other.user_id])

    def test_blocked_audio_does_not_read_snapshot_or_resolve_provider(self):
        from unittest.mock import Mock,patch
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        from django.test import override_settings
        row,store=self.prepared_job()
        self.job(user_id=row.user_id,status='running',provider_status='SUBMISSION_PENDING')
        before=Generation.objects.filter(pk=row.id).values().get()
        with override_settings(AUDIO_MAX_CONCURRENT=2,AUDIO_MAX_PER_USER=1),patch('apps.media.audio_inputs.validated_audio_input') as validate,patch('apps.media.audio.get_transcriber') as resolve:
            self.assertEqual(process_audio(row.id,'audio:blocked',signal=Cancellation(),storage=store),{'kind':'unclaimed'})
        validate.assert_not_called()
        resolve.assert_not_called()
        self.assertEqual(Generation.objects.filter(pk=row.id).values().get(),before)

    def test_invalid_oldest_snapshot_does_not_hide_valid_same_account(self):
        from unittest.mock import Mock,patch
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.coordinator import select_due_generations
        from apps.generation.services.deadline import Cancellation
        bad,store=self.prepared_job()
        valid=self.job(user_id=bad.user_id,created_at=bad.created_at+1)
        provider=Mock()
        with patch('apps.media.audio_inputs.validated_audio_input',side_effect=ValueError('Audio snapshot integrity failed.')):
            result=process_audio(bad.id,'audio:invalid',signal=Cancellation(),provider=provider,storage=store)
        self.assertEqual(result,{'kind':'failed'})
        bad.refresh_from_db()
        self.assertEqual((bad.status,bad.provider_status),('failed','AUDIO_INPUT_INVALID'))
        self.assertEqual(bad.error,'Audio input is invalid or unavailable.')
        self.assertIsNone(bad.submitted_at)
        provider.transcribe.assert_not_called()
        self.assertIn(valid.id,[row.id for row in select_due_generations()])

    def test_preparation_outage_backs_off_without_paid_admission_or_immediate_retry(self):
        from unittest.mock import Mock,patch
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.coordinator import select_due_generations
        from apps.generation.services.deadline import Cancellation
        row,store=self.prepared_job()
        later=self.job(user_id=row.user_id,created_at=row.created_at+1)
        with patch('apps.media.audio_inputs.validated_audio_input',side_effect=RuntimeError('private-storage-secret')) as validate, \
             patch('apps.media.audio.get_transcriber') as resolve:
            self.assertEqual(process_audio(row.id,'audio:outage',signal=Cancellation(),storage=store),{'kind':'deferred'})
            self.assertEqual(process_audio(row.id,'audio:immediate',signal=Cancellation(),storage=store),{'kind':'unclaimed'})
        self.assertEqual(validate.call_count,1)
        resolve.assert_not_called()
        row.refresh_from_db()
        self.assertEqual((row.status,row.provider_status),('queued',AUDIO_READY))
        self.assertIsNone(row.error)
        self.assertIsNone(row.submitted_at)
        self.assertIsNotNone(row.next_poll_at)
        self.assertEqual([r.id for r in select_due_generations()],[later.id])

    def test_provider_configuration_failure_is_deferred_not_invalid_input(self):
        from unittest.mock import patch
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        row,store=self.prepared_job()
        with patch('apps.media.audio.get_transcriber',side_effect=ValueError('private-config-secret')):
            self.assertEqual(process_audio(row.id,'audio:config',signal=Cancellation(),storage=store),{'kind':'deferred'})
        row.refresh_from_db()
        self.assertEqual((row.status,row.provider_status),('queued',AUDIO_READY))
        self.assertIsNotNone(row.next_poll_at)

    def test_preparation_failure_does_not_overwrite_changed_or_claimed_intent(self):
        from unittest.mock import Mock,patch
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        for changed in ({'model':'Gemini (changed)'},
                        {'status':'running','provider_status':'SUBMISSION_PENDING','worker_lease_id':'winner'}):
            row,store=self.prepared_job()
            def failed(*args,**kwargs):
                Generation.objects.filter(pk=row.id).update(**changed)
                raise ValueError('Audio snapshot integrity failed.')
            provider=Mock()
            with patch('apps.media.audio_inputs.validated_audio_input',side_effect=failed):
                result=process_audio(row.id,'audio:loser',signal=Cancellation(),provider=provider,storage=store)
            self.assertEqual(result,{'kind':'unclaimed'})
            row.refresh_from_db()
            for field,value in changed.items():self.assertEqual(getattr(row,field),value)
            self.assertIsNone(row.error)
            provider.transcribe.assert_not_called()

    def test_invalid_preparation_preserves_concurrent_library_metadata(self):
        from unittest.mock import Mock,patch
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        row,store=self.prepared_job()
        def invalid(*args,**kwargs):
            Generation.objects.filter(pk=row.id).update(is_favorite=True,updated_at=row.updated_at+10)
            raise ValueError('Audio snapshot integrity failed.')
        provider=Mock()
        with patch('apps.media.audio_inputs.validated_audio_input',side_effect=invalid):
            self.assertEqual(process_audio(row.id,'audio:metadata',signal=Cancellation(),provider=provider,storage=store),{'kind':'failed'})
        row.refresh_from_db()
        self.assertTrue(row.is_favorite)
        self.assertEqual(row.status,'failed')
        provider.transcribe.assert_not_called()

    def job(self, **changes):
        values=dict(kind='audio',status='queued',prompt='',model='Gemini (fixture)',
            aspect_ratio='audio',user_id=uuid4(),provider_status=AUDIO_READY,
            submission_input={'version':2,'operation':'audio-transcription'},
            created_at=1,updated_at=1)
        values.update(changes)
        return Generation.objects.create(**values)

    def test_history_lists_a_transcription_under_its_file_name(self):
        from apps.generation.serialization import generation_item
        row=self.job(status='succeeded',prompt='[00:00.000 - 00:01.000] Speaker: hello',reference_audios=['/api/media/uploads/a.wav'],
            submission_input={'version':2,'operation':'audio-transcription','originalName':'take 3.wav'})
        self.assertEqual(generation_item(row)['productionMetadata'],{'type':'audio-transcription','originalName':'take 3.wav',
            'transcript':'[00:00.000 - 00:01.000] Speaker: hello','sourceAudio':'/api/media/uploads/a.wav'})
        self.assertNotIn('productionMetadata',generation_item(self.job(kind='image',submission_input=None)))

    def test_worker_cancellation_before_claim_and_during_response_preserves_evidence(self):
        from unittest.mock import Mock
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation, QueueExecutionDeadlineError
        row,store=self.prepared_job()
        provider=Mock()
        stopped=Cancellation()
        stopped.cancelled.set()
        with self.assertRaises(QueueExecutionDeadlineError):
            process_audio(row.id,'audio:stopped',signal=stopped,provider=provider,storage=store)
        provider.transcribe.assert_not_called()
        row.refresh_from_db()
        self.assertEqual((row.status,row.provider_status),('queued',AUDIO_READY))
        active=Cancellation()
        def response(*args,**kwargs):
            active.cancelled.set()
            return 'paid response during cancellation'
        provider.transcribe.side_effect=response
        result=process_audio(row.id,'audio:restart',signal=active,provider=provider,storage=store)
        self.assertEqual(result['kind'],'completed')
        row.refresh_from_db()
        self.assertEqual((row.status,row.prompt),('succeeded','paid response during cancellation'))
        provider.transcribe.assert_called_once()

    def test_interrupted_pending_submission_remains_held_after_worker_restart(self):
        from unittest.mock import Mock
        from apps.generation.services.audio_submission import process_audio
        from apps.generation.services.deadline import Cancellation
        from apps.generation.services import coordinator
        row,store=self.prepared_job()
        claim_audio(row.id,'audio:lost-process',now=100,ttl_ms=1)
        provider=Mock()
        self.assertEqual(process_audio(row.id,'audio:restarted',signal=Cancellation(),provider=provider,storage=store),
                         {'kind':'unclaimed'})
        provider.transcribe.assert_not_called()
        self.assertNotIn(row.id,[r.id for r in coordinator.select_due_generations(now=10000)])
        row.refresh_from_db()
        self.assertEqual((row.status,row.provider_status,row.worker_lease_id),
                         ('running','SUBMISSION_PENDING','audio:lost-process'))

    def test_different_jobs_racing_distributed_capacity_have_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import connections
        from django.test import override_settings
        rows=[self.job(),self.job()]
        barrier=Barrier(2)
        def claim(row):
            try:
                barrier.wait(timeout=10)
                result=claim_audio(row.id,'audio:'+str(row.id),now=100)
                return result.id if result else None
            finally:
                connections.close_all()
        with override_settings(AUDIO_MAX_CONCURRENT=1,AUDIO_MAX_PER_USER=1),ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(claim,rows))
        self.assertEqual(sum(value is not None for value in outcomes),1)
        self.assertEqual(Generation.objects.filter(pk__in=[r.id for r in rows],provider_status='SUBMISSION_PENDING').count(),1)
        self.assertEqual(Generation.objects.filter(pk__in=[r.id for r in rows],status='queued',provider_status=AUDIO_READY).count(),1)

    def test_distributed_audio_capacity_reserves_uncertain_outcomes(self):
        from django.test import override_settings
        with override_settings(AUDIO_MAX_CONCURRENT=2,AUDIO_MAX_PER_USER=1):
            first=self.job()
            self.assertIsNotNone(claim_audio(first.id,'audio:first',now=100))
            same=self.job(user_id=first.user_id)
            self.assertIsNone(claim_audio(same.id,'audio:same',now=999999))
            second=self.job()
            self.assertIsNotNone(claim_audio(second.id,'audio:second',now=100))
            third=self.job()
            Generation.objects.filter(pk=first.id).update(provider_status='SUBMISSION_UNCERTAIN')
            self.assertIsNone(claim_audio(third.id,'audio:third',now=999999))
            Generation.objects.filter(pk=second.id).update(status='succeeded',provider_status='COMPLETED')
            self.assertIsNotNone(claim_audio(third.id,'audio:third',now=999999))

    def test_result_waiter_reads_completion_and_preserves_pending_without_provider_work(self):
        from unittest.mock import Mock, patch
        from apps.media.audio_wait import wait_for_audio, AudioResultPending
        row,store=self.prepared_job()
        with self.assertRaises(AudioResultPending):
            wait_for_audio(row,timeout=0)
        row.refresh_from_db()
        self.assertEqual((row.status,row.provider_status),('queued',AUDIO_READY))
        def complete(*args):
            Generation.objects.filter(pk=row.id).update(status='succeeded',provider_status='COMPLETED',prompt='saved transcript')
        with patch('apps.media.audio_wait.time.sleep',side_effect=complete),patch('apps.media.audio.get_transcriber') as provider:
            saved=wait_for_audio(row,timeout=1)
        self.assertEqual(saved.prompt,'saved transcript')
        provider.assert_not_called()
        Generation.objects.filter(pk=row.id).update(user_id=uuid4())
        with self.assertRaisesRegex(RuntimeError,'identity changed'):
            wait_for_audio(row,timeout=0)

    def test_worker_dispatches_audio_directly_and_holds_pending_from_selection(self):
        from unittest.mock import Mock, patch
        from apps.generation.worker import run_once
        from apps.generation.services import coordinator
        row,store=self.prepared_job()
        provider=Mock()
        provider.transcribe.return_value='dispatched transcript'
        with patch('apps.media.audio.get_transcriber',return_value=provider),patch('apps.media.storage.get_storage',return_value=store),patch('apps.generation.services.admission.admit_job') as admission:
            result=run_once(concurrency=1)
        self.assertEqual(result['outcomes'],{'completed':1})
        admission.assert_not_called()
        provider.transcribe.assert_called_once()
        row.refresh_from_db()
        self.assertEqual((row.status,row.prompt),('succeeded','dispatched transcript'))
        pending=self.job(status='running',provider_status='SUBMISSION_PENDING')
        uncertain=self.job(status='running',provider_status='SUBMISSION_UNCERTAIN')
        self.assertNotIn(pending.id,[r.id for r in coordinator.select_due_generations()])
        self.assertNotIn(uncertain.id,[r.id for r in coordinator.select_due_generations()])

    def prepared_job(self):
        from apps.media.storage import StorageService, MemoryAdapter
        from apps.media.audio_inputs import capture_audio_input
        store=StorageService(MemoryAdapter())
        row=self.job()
        row.submission_input=capture_audio_input(store,'data:audio/wav;base64,YWJj',row.id,model='fixture',name='fixture')
        row.save(update_fields=['submission_input'])
        return row,store

    def test_worker_completion_and_failure_never_repeat_provider(self):
        from unittest.mock import Mock
        from apps.generation.services.deadline import Cancellation
        from apps.generation.services.audio_submission import process_audio
        for fails in (False,True):
            with self.subTest(fails=fails):
                row,store=self.prepared_job()
                provider=Mock()
                def transcribe(*args,**kwargs):
                    current=Generation.objects.get(pk=row.id)
                    self.assertEqual((current.status,current.provider_status,current.worker_lease_id),
                                     ('running','SUBMISSION_PENDING','audio:test'))
                    if fails:raise RuntimeError('offline ambiguous failure')
                    return 'worker transcript'
                provider.transcribe.side_effect=transcribe
                if fails:
                    with self.assertRaisesRegex(RuntimeError,'offline ambiguous'):
                        process_audio(row.id,'audio:test',signal=Cancellation(),provider=provider,storage=store)
                else:
                    result=process_audio(row.id,'audio:test',signal=Cancellation(),provider=provider,storage=store)
                    self.assertEqual(result['kind'],'completed')
                provider.transcribe.assert_called_once()
                row.refresh_from_db()
                self.assertEqual(row.provider_status,'SUBMISSION_UNCERTAIN' if fails else 'COMPLETED')
                self.assertIsNone(row.worker_lease_id)
                self.assertEqual(process_audio(row.id,'audio:retry',signal=Cancellation(),provider=provider,storage=store),
                                 {'kind':'unclaimed'})
                provider.transcribe.assert_called_once()

    def test_first_filing_during_transcription_keeps_the_paid_outcome_without_repeat(self):
        from unittest.mock import Mock
        from apps.generation.services.deadline import Cancellation
        from apps.generation.services.audio_submission import process_audio
        from apps.library.services import folder_engine
        for fails in (False,True):
            with self.subTest(fails=fails):
                row,store=self.prepared_job()
                folder=folder_engine.create_folder(name=f'Interview {fails}')
                provider=Mock()
                def transcribe(*args,**kwargs):
                    folder_engine.move_generations(ids=[str(row.id)],destination={'type':'folder','folderId':folder['id']})
                    if fails:raise RuntimeError('offline ambiguous failure')
                    return 'filed transcript'
                provider.transcribe.side_effect=transcribe
                if fails:
                    with self.assertRaisesRegex(RuntimeError,'offline ambiguous'):
                        process_audio(row.id,'audio:test',signal=Cancellation(),provider=provider,storage=store)
                else:
                    self.assertEqual(process_audio(row.id,'audio:test',signal=Cancellation(),provider=provider,storage=store)['kind'],'completed')
                row.refresh_from_db()
                self.assertEqual((str(row.folder_id),row.permanent_name),(folder['id'],f'Interview_{fails}_0001'))
                self.assertEqual(row.provider_status,'SUBMISSION_UNCERTAIN' if fails else 'COMPLETED')
                self.assertEqual(process_audio(row.id,'audio:retry',signal=Cancellation(),provider=provider,storage=store),
                                 {'kind':'unclaimed'})
                provider.transcribe.assert_called_once()

    def test_validated_identity_change_cannot_claim_but_metadata_is_preserved(self):
        for changes in ({'user_id':uuid4()},{'submission_input':{'version':2,'operation':'audio-transcription','changed':True}},
                        {'model':'different'}):
            with self.subTest(changes=changes):
                row=self.job()
                Generation.objects.filter(pk=row.id).update(**changes)
                before=Generation.objects.filter(pk=row.id).values().get()
                self.assertIsNone(claim_audio(row.id,'audio:test',now=100,expected=row))
                self.assertEqual(Generation.objects.filter(pk=row.id).values().get(),before)
        row=self.job()
        Generation.objects.filter(pk=row.id).update(is_favorite=True,favorited_at=42,updated_at=1000)
        result=claim_audio(row.id,'audio:test',now=100,expected=row)
        self.assertEqual((result.is_favorite,result.favorited_at,result.updated_at),(True,42,1001))

    def test_first_filing_before_claim_retains_an_uncertain_paid_receipt_without_replay(self):
        from unittest.mock import Mock, patch
        from apps.generation.services.deadline import Cancellation
        from apps.generation.services.audio_submission import process_audio
        from apps.library.services import folder_engine
        from apps.media.audio_inputs import validated_audio_input
        row, storage = self.prepared_job()
        folder = folder_engine.create_folder(name='Validated interview')
        def file_after_validation(expected, *args, **kwargs):
            result = validated_audio_input(expected, *args, **kwargs)
            folder_engine.move_generations(ids=[str(row.id)], destination={'type': 'folder', 'folderId': folder['id']})
            return result
        provider = Mock()
        provider.transcribe.side_effect = RuntimeError('offline ambiguous failure')
        with patch('apps.media.audio_inputs.validated_audio_input', side_effect=file_after_validation):
            with self.assertRaisesRegex(RuntimeError, 'offline ambiguous'):
                process_audio(row.id, 'audio:test', signal=Cancellation(), provider=provider, storage=storage)
        row.refresh_from_db()
        self.assertEqual((row.name_owner_id, row.permanent_name), (row.id, 'Validated_interview_0001'))
        self.assertEqual(row.provider_status, 'SUBMISSION_UNCERTAIN')
        self.assertIsNone(row.worker_lease_id)
        self.assertEqual(process_audio(row.id, 'audio:retry', signal=Cancellation(), provider=provider, storage=storage), {'kind': 'unclaimed'})
        provider.transcribe.assert_called_once()

    def test_two_workers_racing_claim_have_exactly_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import connections
        row=self.job()
        barrier=Barrier(2)
        def claim(owner):
            try:
                barrier.wait(timeout=10)
                result=claim_audio(row.id,owner,now=100)
                return result.worker_lease_id if result else None
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes=list(pool.map(claim,('audio:first','audio:second')))
        winners=[value for value in outcomes if value]
        self.assertEqual(len(winners),1)
        row.refresh_from_db()
        self.assertEqual((row.worker_lease_id,row.provider_status),(winners[0],'SUBMISSION_PENDING'))

    def test_claim_commits_pending_and_second_owner_cannot_replay_after_expiry(self):
        row=self.job(updated_at=1000)
        claimed=claim_audio(row.id,'audio:first',now=100,ttl_ms=10)
        self.assertEqual((claimed.status,claimed.provider_status,claimed.worker_lease_id),
                         ('running','SUBMISSION_PENDING','audio:first'))
        self.assertEqual((claimed.submitted_at,claimed.updated_at),(100,1001))
        self.assertIsNone(claim_audio(row.id,'audio:second',now=9999))
        row.refresh_from_db()
        self.assertEqual(row.worker_lease_id,'audio:first')

    def test_legacy_ownerless_uncertain_and_foreign_leases_are_held_unchanged(self):
        for changes in ({'user_id':None},{'provider_status':'SUBMISSION_UNCERTAIN'},
                        {'provider_status':'SUBMISSION_PENDING'},
                        {'submission_input':{'version':1,'operation':'audio-transcription'}},
                        {'submission_input':{'version':True,'operation':'audio-transcription'}},
                        {'submission_input':{'version':2,'operation':'wrong'}},
                        {'submission_input':None},
                        {'worker_lease_id':'foreign','worker_lease_until':1000},
                        {'status':'running'},{'kind':'video'}):
            with self.subTest(changes=changes):
                row=self.job(**changes)
                before=Generation.objects.filter(pk=row.id).values().get()
                self.assertIsNone(claim_audio(row.id,'audio:test',now=100))
                self.assertEqual(Generation.objects.filter(pk=row.id).values().get(),before)
