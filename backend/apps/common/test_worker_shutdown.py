import io
import threading
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.db import connections
from django.test import SimpleTestCase, TransactionTestCase
from apps.generation import worker
from apps.generation.models import Generation
from apps.generation.services import executor, coordinator
from apps.generation.services.deadline import QueueExecutionDeadlineError
from apps.exports import worker as export_worker, services
from apps.exports.models import MediaExport
from apps.media.storage import StorageService, MemoryAdapter
from apps.authentication.models import User


class WorkerShutdownTests(SimpleTestCase):
    def test_stop_prevents_all_queued_batch_entries_from_starting(self):
        stop=threading.Event()
        started=[]
        def process(identifier, **kwargs):
            started.append(identifier)
            stop.set()
            return {'kind':'pending'}
        with patch.object(worker,'reap_stale_running_images'),patch.object(worker,'select_due_generations',
                return_value=[SimpleNamespace(id=index) for index in range(25)]):
            result=worker.run_once(concurrency=1,process=process,stop=stop)
        self.assertEqual(started,[0])
        self.assertEqual(result['outcomes'],{'pending':1,'stopped':24})

    def test_stop_wakes_active_poll_wait_and_prevents_more_jobs(self):
        stop=threading.Event()
        active=threading.Event()
        seen=[]
        def process(identifier, *, signal, **kwargs):
            seen.append(identifier)
            active.set()
            try:
                signal.wait(60000)
            except QueueExecutionDeadlineError:
                return {'kind':'pending'}
            self.fail('Wait did not observe shutdown')
        with patch.object(worker,'reap_stale_running_images'),patch.object(worker,'select_due_generations',
                return_value=[SimpleNamespace(id=index) for index in range(3)]):
            with ThreadPoolExecutor(max_workers=1) as pool:
                future=pool.submit(worker.run_once,concurrency=1,process=process,stop=stop)
                self.assertTrue(active.wait(2))
                stop.set()
                result=future.result(timeout=2)
        self.assertEqual(seen,[0])
        self.assertEqual(result['outcomes'],{'pending':1,'stopped':2})

    def test_already_stopped_worker_never_claims_or_opens_storage(self):
        stop=threading.Event();stop.set()
        with patch.object(worker,'select_due_generations',side_effect=AssertionError('queried')),patch.object(services,'claim_export',side_effect=AssertionError('claimed')):
            self.assertEqual(worker.run_once(stop=stop)['processed'],0)
            self.assertEqual(export_worker.run_once(stop=stop),{'claimed':0})

    def test_lease_loss_cancels_only_one_job(self):
        stop=threading.Event()
        first,second=worker.WorkerCancellation(stop),worker.WorkerCancellation(stop)
        first.cancelled.set()
        with self.assertRaises(QueueExecutionDeadlineError):
            first.check()
        second.check()
        self.assertFalse(stop.is_set())


class WorkerShutdownPersistenceTests(TransactionTestCase):
    def test_accepted_task_survives_shutdown_and_worker_releases_lease(self):
        item=Generation.objects.create(kind='image',status='queued',model='Kling Image 3.0',prompt='fixture',
            aspect_ratio='1:1',cost_cents=1,created_at=1,updated_at=1,user_id=uuid4())
        stop=threading.Event()
        def image(item, *, on_task, signal, **kwargs):
            on_task('accepted-before-shutdown')
            stop.set()
            signal.check()
        outcome=executor.process_generation(item.id,owner='shutdown-worker',signal=worker.WorkerCancellation(stop),
            image_execute=image,heartbeat=False,env={})
        self.assertEqual(outcome['kind'],'pending')
        item.refresh_from_db()
        self.assertEqual((item.status,item.task_id,item.worker_lease_id),('running','accepted-before-shutdown',None))
        self.assertIsNone(item.worker_lease_until)
        self.assertIsNotNone(coordinator.claim_generation(item.id,'successor'))

    def test_export_stop_closes_stream_requeues_and_never_uploads_partial_zip(self):
        user=User.objects.create(email='shutdown@example.test',name='Fixture',password_hash='x',created_at=1)
        item=Generation.objects.create(kind='image',status='succeeded',model='Nano Banana Pro',prompt='fixture',
            aspect_ratio='1:1',url='/api/media/generations/source.png',user_id=user.id,created_at=1,updated_at=1)
        created=services.create_export(user.id)
        services.append_items(created['id'],user.id,[str(item.id)])
        services.finalize_export(created['id'],user.id)
        stop=threading.Event()
        class Stream:
            closed=False
            def __iter__(self):
                yield b'first'
                stop.set()
                yield b'last'
            def close(self): self.closed=True
        stream=Stream()
        storage=StorageService(MemoryAdapter())
        media=SimpleNamespace(stream=stream,content_length=9,content_type='image/png')
        with patch.object(storage,'open',return_value=media),patch.object(storage,'upload_stream',side_effect=AssertionError('partial ZIP uploaded')):
            outcome=export_worker.run_once(storage=storage,stop=stop)
        self.assertEqual(outcome['completed'],0)
        self.assertTrue(stream.closed)
        current=MediaExport.objects.get(pk=created['id'])
        self.assertEqual(current.status,'queued')
        self.assertIsNone(current.lease_owner)
        self.assertIsNone(current.output_key)

    def test_export_upload_observes_stop_before_reading_or_completing(self):
        user=User.objects.create(email='upload-stop@example.test',name='Fixture',password_hash='x',created_at=1)
        item=Generation.objects.create(kind='image',status='succeeded',model='Nano Banana Pro',prompt='fixture',
            aspect_ratio='1:1',url='/api/media/generations/source.png',user_id=user.id,created_at=1,updated_at=1)
        created=services.create_export(user.id)
        services.append_items(created['id'],user.id,[str(item.id)])
        services.finalize_export(created['id'],user.id)
        storage=StorageService(MemoryAdapter())
        storage.upload_buffer(b'original','generations/source.png','png')
        stop=threading.Event()
        upload=storage.upload_stream
        def interrupted(stream,key,**kwargs):
            stop.set()
            return upload(stream,key,**kwargs)
        with patch.object(storage,'upload_stream',side_effect=interrupted):
            outcome=export_worker.run_once(storage=storage,stop=stop)
        self.assertEqual(outcome['completed'],0)
        current=MediaExport.objects.get(pk=created['id'])
        self.assertEqual(current.status,'queued')
        self.assertIsNone(current.output_key)
        self.assertEqual(list(storage.primary.objects),['generations/source.png'])


class WorkerSignalLifecycleTests(SimpleTestCase):
    def test_once_commands_install_stop_handlers_and_restore_them(self):
        from importlib import import_module
        for name in ('apps.generation.management.commands.generation_worker','apps.exports.management.commands.media_export_worker'):
            module=import_module(name)
            previous=object()
            installed={}
            def once(*,stop,**kwargs):
                self.assertFalse(stop.is_set())
                installed[module.signal.SIGTERM](module.signal.SIGTERM,None)
                self.assertTrue(stop.is_set())
                return {'stopped':True}
            with self.subTest(command=name),patch.object(module.signal,'getsignal',return_value=previous),patch.object(module.signal,'signal',side_effect=lambda signum,handler:installed.update({signum:handler})),patch.object(module,'run_once',side_effect=once):
                module.Command(stdout=io.StringIO()).handle(once=True,interval=2,concurrency=2)
            self.assertEqual(installed,{module.signal.SIGINT:previous,module.signal.SIGTERM:previous})
