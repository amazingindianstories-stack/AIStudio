import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from threading import Barrier
from unittest.mock import patch
from django.db import close_old_connections
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.authentication.models import LoginAttempt
from apps.common.models import ActivityLog
from apps.common import leases
from apps.generation.models import Generation
from apps.library.models import GenerationNaming
from apps.media.storage import StorageService, MemoryAdapter
from .models import DepthWorker
from . import depth, maintenance, scheduler


@override_settings(ROOT_URLCONF='apps.workers.urls', DEPTH_WORKER_TOKEN='synthetic-depth', CRON_SECRET='synthetic-cron')
class DepthContractTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def post(self, operation, payload=None, token='Bearer synthetic-depth'):
        return self.client.post('/api/worker/depth/'+operation, payload or {}, content_type='application/json', HTTP_AUTHORIZATION=token)

    def row(self, **fields):
        base = dict(id=uuid.uuid4(), kind='depth', status='queued', prompt='Depth map', model='Depth Anything (Local)',
                    aspect_ratio='16:9', reference_videos=['uploads/synthetic.mov'], created_at=1, updated_at=1)
        base.update(fields)
        return Generation.objects.create(**base)

    def test_authentication_headers_and_session_boundaries(self):
        for operation in ['claim', 'heartbeat', 'progress', 'upload-url', 'complete']:
            self.assertEqual(self.post(operation, token='').json(), {'error': 'Unauthorized.'})
            self.assertEqual(self.post(operation, token='Bearer synthetic-depth ').status_code, 401)
            self.assertEqual(self.post(operation, token='bEaReR\t synthetic-depth').status_code, 400)
        for path in ['api/worker/depth/status', 'api/generate/depth/status']:
            self.assertEqual(self.client.get('/'+path, HTTP_AUTHORIZATION='Bearer synthetic-depth').status_code, 401)
        self.assertEqual(self.client.post('/api/generate/depth', {}, content_type='application/json').status_code, 401)
        with override_settings(DEPTH_WORKER_TOKEN=''):
            self.assertEqual(self.post('claim').status_code, 401)
        for name in ['depth-reconciliation', 'video-reconciliation', 'login-attempts']:
            self.assertEqual(self.client.get('/api/cron/'+name, HTTP_AUTHORIZATION='bearer synthetic-cron').json(), {'error': 'UNAUTHORIZED'})
        self.cookie()
        self.assertEqual(self.post('claim', token='').status_code, 401)

    def test_enqueue_shape_naming_status_and_no_provider_work(self):
        self.cookie()
        self.assertEqual(self.client.post('/api/generate/depth', {}, content_type='application/json').json(), {'error': 'An input video is required.'})
        response = self.client.post('/api/generate/depth', {'inputVideoKey': ' uploads/native.mov ', 'encoder': 'vitl',
            'trackCharacters': True, 'originalName': 'Native MOV'}, content_type='application/json')
        self.assertEqual(response.status_code, 200)
        item = response.json()
        self.assertEqual(set(item), {'id','kind','status','prompt','model','aspectRatio','resolution','trackCharacters','referenceVideos','userId','costCents','createdAt','updatedAt'})
        self.assertEqual((item['prompt'],item['model'],item['referenceVideos']), ('Depth map: Native MOV','Depth Anything (Local)',['uploads/native.mov']))
        row = Generation.objects.get(id=item['id'])
        self.assertTrue(GenerationNaming.objects.filter(generation_id=row.id).exists())
        self.assertEqual(ActivityLog.objects.get(action='generate').detail['id'], item['id'])
        status = self.client.get('/api/generate/depth/status', {'id': item['id']}).json()
        self.assertEqual(status['id'], item['id'])
        self.assertNotIn('providerResponses', status)
        self.assertEqual(self.client.get('/api/generate/depth/status').status_code, 400)
        self.assertEqual(self.client.get('/api/generate/depth/status', {'id':str(uuid.uuid4())}).status_code,404)
        self.assertEqual(self.client.get('/api/generate/depth/status', {'id':'invalid'}).status_code,500)
        self.assertEqual(self.client.post('/api/generate/depth', {'inputVideoKey':23}, content_type='application/json').content,b'')

    def test_internal_enqueue_and_signing_errors_are_private(self):
        self.cookie()
        with patch('apps.workers.views.Generation.objects.create',side_effect=ValueError('private-fixture-token')):
            response = self.client.post('/api/generate/depth',{'inputVideoKey':'uploads/fixture.mov'},content_type='application/json')
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Failed to save the generation request.'})
        self.assertFalse(Generation.objects.exists())
        row = self.row()
        with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            claim = self.post('claim',{'workerId':'fixture','protocolVersion':2}).json()['job']['claimId']
        with patch('apps.workers.views.get_storage') as get:
            get.return_value.signed_upload_url.side_effect = ValueError('private-fixture-token')
            response = self.post('upload-url',{'jobId':str(row.id),'claimId':claim})
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Failed to create an upload URL.'})
        row.refresh_from_db()
        self.assertEqual(row.status,'running')

    def test_fenced_claim_progress_upload_completion_and_retry(self):
        row = self.row(resolution='vits', track_characters=True)
        with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            response = self.post('claim', {'workerId':' gpu ', 'protocolVersion':2}).json()['job']
            self.assertEqual(response['id'], str(row.id))
            self.assertEqual((response['encoder'],response['trackCharacters']), ('vits', True))
            claim = response['claimId']
            payload = {'jobId':str(row.id),'claimId':claim}
            self.assertEqual(self.post('claim', {'workerId':'other','protocolVersion':2}).json(), {'job':None})
            self.assertEqual(self.post('progress', {**payload,'claimId':str(uuid.uuid4()),'percent':99}).status_code,409)
            self.assertEqual(self.post('progress', {**payload,'percent':'101.5','message':'x'*400}).json(), {'ok':True})
            row.refresh_from_db()
            self.assertEqual((row.progress_percent,len(row.progress_message)),(100,300))
            signed = self.post('upload-url',payload).json()
            self.assertEqual(signed['key'],f'depth-output/{row.id}/{claim}.mp4')
            self.assertEqual(self.post('complete',{**payload,'ok':True,'key':'ignored.mp4','aspectRatio':'9:16'}).json(), {'ok':True})
            row.refresh_from_db()
            self.assertEqual((row.status,row.url,row.aspect_ratio),('succeeded','/api/media/'+signed['key'],'9:16'))
            self.assertIsNone(row.depth_claim_id)
            self.assertIsNone(row.completed_at)
            self.assertEqual(self.post('complete',{**payload,'ok':True}).status_code,409)
            self.assertEqual(self.post('upload-url',payload).status_code,409)
            self.assertEqual(ActivityLog.objects.filter(action='depth_complete').count(),1)

    def test_legacy_claim_null_fencing_and_failure_inputs(self):
        row = self.row()
        with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            response = self.post('claim', {'workerId':'legacy'}).json()['job']
            self.assertNotIn('claimId', response)
            payload = {'jobId':str(row.id)}
            self.assertEqual(self.post('upload-url',payload).json()['key'],f'depth-output/{row.id}.mp4')
            self.assertEqual(self.post('complete',{**payload,'ok':True}).status_code,400)
            self.assertEqual(self.post('progress',payload).status_code,400)
            self.assertEqual(self.post('progress',{**payload,'percent':None}).status_code,200)
            self.assertEqual(self.post('complete',{**payload,'ok':False,'error':'e'*2100}).status_code,200)
            row.refresh_from_db()
            self.assertEqual((row.status,len(row.error)),('failed',2000))
            self.assertIsNone(row.depth_claim_worker_id)
        broken = self.row(reference_videos=[])
        self.assertEqual(self.post('claim', {'workerId':'w'}).json(), {'job':None})
        broken.refresh_from_db()
        self.assertEqual(broken.error,'No input video was attached to this job.')
        invalid = self.row(reference_videos=['../private'])
        with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            self.assertEqual(self.post('claim', {'workerId':'w','protocolVersion':2}).json(), {'job':None})
        invalid.refresh_from_db()
        self.assertTrue(invalid.error.startswith('Could not produce a download URL for the input video:'))

    def test_heartbeat_upsert_field_caps_and_status(self):
        row = self.row(status='running', progress_percent=42, progress_message='Tracking')
        payload = dict(workerId='worker', label='x'*210, device='d'*60,status='busy',currentJobId=str(row.id),
            currentClaimId=str(uuid.uuid4()),protocolVersion=2,ramLimitMb=1024.5,ramUsedMb='8')
        with patch('apps.workers.depth.leases.now_ms',return_value=100000):
            self.assertEqual(self.post('heartbeat',payload).status_code,200)
            worker = DepthWorker.objects.get(worker_id='worker')
            self.assertEqual((len(worker.label),len(worker.device),worker.ram_limit_mb,worker.ram_used_mb),(200,50,1025,None))
            self.cookie()
            self.assertEqual(self.client.get('/api/worker/depth/status').json(),dict(online=True,workerCount=1,queueDepth=0,
                currentJob=dict(id=str(row.id),progressPercent=42,progressMessage='Tracking')))
        with patch('apps.workers.depth.leases.now_ms',return_value=100001):
            self.post('heartbeat',dict(workerId='worker',protocolVersion=True,ramUsedMb=-1.5))
        worker.refresh_from_db()
        self.assertEqual((worker.created_at,worker.last_seen_at,worker.protocol_version,worker.status,worker.ram_used_mb),(100000,100001,1,'idle',-1))
        self.assertIsNone(worker.current_claim_id)
        self.assertFalse(depth.status(now=145001)['online'])

    def test_reaper_grace_heartbeat_triple_retry_cap_and_old_claim_fencing(self):
        now = 200000
        row = self.row(status='running', depth_claim_id=uuid.uuid4(),depth_claim_worker_id='worker',updated_at=now-60001)
        claim = row.depth_claim_id
        depth.heartbeat('worker',now=now-45000,current_job_id=row.id,current_claim_id=claim,protocol_version=2)
        self.assertEqual(depth.reap(force=True,now=now),0)
        self.assertEqual(depth.reap(force=True,now=now+1),1)
        row.refresh_from_db()
        self.assertEqual((row.status,row.depth_reap_attempts),('queued',1))
        claimed = depth.claim_next('next',2,now=now+1)
        self.assertNotEqual(claimed.depth_claim_id,claim)
        self.assertFalse(depth.complete(row.id,claim,ok=True,url='stale'))
        self.assertEqual(depth.reap(force=True,now=now+60001),0)
        self.assertEqual(depth.reap(force=True,now=now+60002),1)
        depth.claim_next('next',2,now=now+60002)
        self.assertEqual(depth.reap(force=True,now=now+120003),1)
        row.refresh_from_db()
        self.assertEqual((row.status,row.depth_reap_attempts,row.error),('failed',3,depth.REAP_ERROR))
        self.row(status='running', depth_claim_id=None,updated_at=0)
        self.assertEqual(depth.reap(force=True,now=now+999999),0)

    def test_reaper_cooldown_and_force_bypass(self):
        row = self.row(status='running',depth_claim_id=uuid.uuid4(),depth_claim_worker_id='missing')
        self.assertEqual(depth.reap(now=100000),1)
        depth.claim_next('missing',2,now=1)
        self.assertEqual(depth.reap(now=100001),0)
        self.assertEqual(depth.reap(force=True,now=100001),1)
        row.refresh_from_db()
        self.assertEqual(row.depth_reap_attempts,2)

    def test_parallel_claim_single_winner_and_heartbeat_identity(self):
        row = self.row()
        barrier = Barrier(2)
        def claim(index):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                result = depth.claim_next(f'worker{index}',2)
                return str(result.id) if result else None
            finally: close_old_connections()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(claim,range(2)))
        self.assertEqual(results.count(str(row.id)),1)
        self.assertEqual(results.count(None),1)

    def test_cron_cleanup_boundary_and_headers(self):
        LoginAttempt.objects.create(identifier='old',created_at=99999)
        LoginAttempt.objects.create(identifier='boundary',created_at=100000)
        LoginAttempt.objects.create(identifier='new',created_at=100001)
        with patch('apps.workers.maintenance.leases.now_ms',return_value=1000000):
            response = self.client.get('/api/cron/login-attempts',HTTP_AUTHORIZATION='Bearer synthetic-cron')
        self.assertEqual(response.json(),{'ok':True,'deleted':2})
        self.assertEqual(LoginAttempt.objects.get().identifier,'new')
        response = self.client.get('/api/cron/depth-reconciliation',HTTP_AUTHORIZATION='Bearer synthetic-cron')
        self.assertEqual(response.json(),{'reaped':0})
        self.assertEqual(response['Cache-Control'],'no-store')
        response = self.client.get('/api/cron/video-reconciliation',HTTP_AUTHORIZATION='Bearer synthetic-cron')
        self.assertEqual(response.json(),dict(ok=True,checked=0,succeeded=0,failed=0,pending=0,pollErrors=0,raced=0))
        self.assertEqual(response['Cache-Control'],'no-store')

    def test_video_due_selection_counts_errors_and_lease(self):
        now = 1000000
        rows = [self.row(kind='video',task_id=f't{i}',updated_at=now+i,next_poll_at=now) for i in range(6)]
        self.row(kind='video',task_id='future',next_poll_at=now+1)
        self.row(kind='video',task_id=None)
        self.assertEqual([r.id for r in maintenance.select_videos(now)],[r.id for r in rows[:5]])
        kinds = iter(['succeeded','failed','poll_error','raced','pending'])
        def advance(item, *, source, signal):
            self.assertEqual(source,'cron')
            signal.check()
            return {'kind':next(kinds)}
        counts = maintenance.reconcile_videos(now=now,advance=advance)
        self.assertEqual(counts,dict(ok=True,checked=5,succeeded=1,failed=1,pending=1,pollErrors=1,raced=1))
        def broken(*args,**kwargs): raise RuntimeError('synthetic')
        self.assertEqual(maintenance.reconcile_videos(now=now,advance=broken)['pollErrors'],1)
        self.assertFalse(maintenance.reconcile_videos(now=now,select=broken)['ok'])
        self.assertFalse(maintenance.reconcile_videos(now=now,deadline_ms=0)['ok'])
        leases.claim('lease:video-reconciliation','other',now=now,ttl_ms=100)
        self.assertEqual(maintenance.reconcile_videos(now=now,advance=broken)['checked'],0)

    def test_scheduler_utc_cadence_replica_slots_and_recovery(self):
        calls = []
        handlers = {key:lambda key=key: calls.append(key) for key in ('depth','video','login','exports')}
        now = int(datetime(2026,10,8,3,15,tzinfo=timezone.utc).timestamp()*1000)
        self.assertEqual(set(scheduler.tick(now=now,handlers=handlers)),{'depth','video','exports','login'})
        self.assertEqual(scheduler.tick(now=now+30000,handlers=handlers),{})
        self.assertEqual(set(scheduler.tick(now=now+120000,handlers=handlers)),{'depth','login'})
        self.assertEqual(calls,['depth','video','exports','login','depth','login'])
        # A cold replica catches up its current slot, even at minute 16.
        from apps.admin_dashboard.models import AppSetting
        AppSetting.objects.filter(key__startswith='lease:scheduler:').delete()
        self.assertEqual(set(scheduler.tick(now=now+60000,handlers=handlers)),{'depth','video','exports','login'})

    def test_invalid_json_wrong_types_and_implicit_methods(self):
        self.assertEqual(self.post('claim',{'workerId':True}).status_code,500)
        self.assertEqual(self.post('progress',{'jobId':str(uuid.uuid4()),'percent':'NaN'}).status_code,400)
        self.assertEqual(self.client.options('/api/worker/depth/claim')['Allow'],'OPTIONS, POST')
        self.assertEqual(self.client.get('/api/worker/depth/claim').status_code,405)
        self.assertEqual(self.client.post('/api/worker/depth/claim','{',content_type='application/json',HTTP_AUTHORIZATION='Bearer synthetic-depth').status_code,400)
