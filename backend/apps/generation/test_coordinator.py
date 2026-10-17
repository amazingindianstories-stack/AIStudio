from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from django.db import connections
from django.test import TransactionTestCase

from apps.admin_dashboard.models import AppSetting, UserLimit
from apps.admin_dashboard.tests import SettingsTests, UID
from apps.common import leases
from .models import Generation
from .services import admission, coordinator


class CoordinatorTests(TransactionTestCase):
    def test_held_ownerless_queue_cannot_starve_authenticated_admission(self):
        for kind,model in (('image','seedream-5-pro'),('video','Seedance 2.5')):
            with self.subTest(kind=kind):
                held=[self.job(kind=kind,model=model,user_id=None,created_at=100+i) for i in range(12)]
                owned=self.job(kind=kind,model=model,created_at=1000000)
                position=admission.queue_position(owned.id,now=1000010)
                self.assertEqual(position['position'],0)
                self.assertIsNotNone(admission.admit_job(owned.id,now=1000010))
                self.assertEqual(Generation.objects.filter(pk__in=[row.id for row in held],status='queued').count(),12)

    def test_ownerless_legacy_jobs_cannot_enter_paid_worker_admission(self):
        from unittest.mock import Mock
        from .services import executor
        for kind,model in (('image','Nano Banana Pro'),('video','Seedance 2.5'),('image','Magnific Precision V2')):
            for status in ('queued','running'):
                with self.subTest(kind=kind,model=model,status=status):
                    row=self.job(kind=kind,model=model,status=status,user_id=None)
                    provider=Mock()
                    self.assertIsNone(admission.admit_job(row.id))
                    if status=='queued':
                        self.assertTrue(admission.queue_position(row.id)['heldForAuthentication'])
                    self.assertNotIn(row.id,[item.id for item in coordinator.select_due_generations()])
                    result=executor.process_generation(row.id,image_execute=provider,video_submit=provider,heartbeat=False,env={})
                    self.assertEqual(result['kind'],'unclaimed')
                    provider.assert_not_called()
                    row.refresh_from_db()
                    self.assertEqual(row.status,status)
        accepted=self.job(kind='video',status='running',model='Seedance 2.5',user_id=None,task_id='legacy-accepted')
        self.assertIn(accepted.id,[item.id for item in coordinator.select_due_generations()])
        blank=self.job(kind='image',status='running',model='Magnific Precision V2',user_id=None,task_id='')
        self.assertNotIn(blank.id,[item.id for item in coordinator.select_due_generations()])
        with patch.object(executor.poller,'advance',return_value={'kind':'pending'}) as poll:
            provider=Mock()
            result=executor.process_generation(accepted.id,video_submit=provider,heartbeat=False,env={})
        self.assertEqual(result['kind'],'pending')
        provider.assert_not_called();poll.assert_called_once()

    def job(self, **values):
        data = {'kind': 'image', 'status': 'queued', 'prompt': 'isolated coordinator fixture',
                'model': 'seedream-5-pro', 'aspect_ratio': '1:1', 'created_at': 1000000,
                'updated_at': 1000000, 'user_id': uuid4()}
        data.update(values)
        return Generation.objects.create(**data)

    def race(self, functions):
        barrier = Barrier(len(functions))
        def run(function):
            try:
                barrier.wait(timeout=10)
                return function()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=len(functions)) as pool:
            return list(pool.map(run, functions))

    def test_lease_single_winner_expiry_and_stale_release(self):
        item = self.job()
        results = self.race([lambda owner=owner: coordinator.claim_generation(item.id, owner, now=100, ttl_ms=50)
                             for owner in ('worker-a', 'worker-b')])
        self.assertEqual(sum(result is not None for result in results), 1)
        owner = next(result.worker_lease_id for result in results if result)
        self.assertIsNotNone(coordinator.claim_generation(item.id, 'successor', now=151, ttl_ms=50))
        self.assertIsNone(coordinator.release_generation(item.id, owner))
        self.assertEqual(Generation.objects.get(pk=item.id).worker_lease_id, 'successor')
        self.assertIsNotNone(coordinator.release_generation(item.id, 'successor'))

    def test_due_selection_and_fenced_schedule(self):
        image = self.job()
        video = self.job(kind='video', status='running', created_at=1000001)
        magnific = self.job(status='running', model='Magnific Creative', created_at=1000002)
        self.job(status='running')
        self.job(kind='depth')
        self.job(next_poll_at=1000002)
        self.job(worker_lease_until=1000002)
        self.assertEqual([row.id for row in coordinator.select_due_generations(now=1000001)],
                         [image.id, video.id, magnific.id])
        claim = coordinator.claim_generation(image.id, 'owner', now=1000001)
        self.assertIsNotNone(coordinator.schedule_generation(claim, now=1000001, owner='owner'))
        self.assertIsNone(coordinator.schedule_generation(claim, now=1000002, owner='wrong'))
        Generation.objects.filter(pk=image.id).update(status='succeeded', updated_at=1000003)
        self.assertIsNone(coordinator.schedule_generation(claim, now=1000004))

    def test_callback_candidate_and_poll_terminal_race(self):
        item = self.job(kind='video', status='running', task_id='primary', candidate_task_ids=['candidate'])
        callback = coordinator.mark_callback_received('candidate', now=1000010, provider={'provider_status': 'succeeded'})
        self.assertEqual(callback.id, item.id)
        self.assertEqual(callback.callback_received_at, 1000010)
        results = self.race([lambda status=status: coordinator.compare_and_set_outcome(item,
            {'status': status, 'updated_at': 1000020}) for status in ('succeeded', 'failed')])
        self.assertEqual(sum(result is not None for result in results), 1)
        self.assertEqual(coordinator.record_poll_error(item, now=1000030), 0)

    def test_aggregate_user_limit_across_kinds_and_other_user_progress(self):
        owner = uuid4()
        items = [self.job(user_id=owner, kind='image' if i % 2 == 0 else 'video', created_at=1000000+i)
                 for i in range(admission.PER_USER_MAX + 1)]
        outcomes = self.race([lambda item=item: admission.admit_job(item.id, now=1000100) for item in items])
        self.assertEqual(sum(value is not None for value in outcomes), admission.PER_USER_MAX)
        self.assertIsNotNone(admission.admit_job(self.job().id, now=1000100))
        self.assertTrue(admission.queue_position(items[-1].id, now=1000100)['heldForConcurrency'])

    def test_global_image_and_video_ceilings_under_contention(self):
        for kind, cap in admission.MAX_CONCURRENT.items():
            items = [self.job(kind=kind, created_at=1000000+i) for i in range(cap+1)]
            results = self.race([lambda item=item: admission.admit_job(item.id, now=1000100) for item in items])
            self.assertEqual(sum(value is not None for value in results), cap)
            Generation.objects.all().delete()

    def test_personal_override_tie_order_and_ineligible_user_does_not_block(self):
        owner, other = uuid4(), uuid4()
        UserLimit.objects.create(user_id=owner, key='maxConcurrentJobs', value='1', updated_at=1)
        older = self.job(user_id=owner)
        newer = self.job(user_id=owner, created_at=1000001)
        self.assertIsNotNone(admission.admit_job(older.id, now=1000010))
        self.assertIsNone(admission.admit_job(newer.id, now=1000010))
        self.assertIsNotNone(admission.admit_job(self.job(user_id=other, created_at=1000002).id, now=1000010))

    def test_budget_busy_hold_empty_forward_progress_and_provider_exemption(self):
        billed = self.job(status='succeeded', model='Nano Banana Pro', cost_cents=140)
        next_item = self.job(model='Nano Banana Pro', cost_cents=20, created_at=1000001)
        with patch.dict('os.environ', {'GEMINI_SPEND_LIMIT_CENTS': '150', 'FACE_BEST_OF': '2'}):
            held = admission.queue_position(next_item.id, now=1000010)
            self.assertTrue(held['heldForBudget'])
            self.assertIsNone(admission.admit_job(next_item.id, now=1000010))
            self.assertIsNotNone(admission.admit_job(self.job().id, now=1000010))
            Generation.objects.filter(pk=billed.id).update(status='failed', error='provider 429')
            self.assertIsNotNone(admission.admit_job(next_item.id, now=1000010))

    def test_nano_banana_2_1_shares_the_gemini_spend_window_with_pro(self):
        # One Gemini key, one rolling window in estimator cents: Pro spend holds 2.1 and back.
        pro = self.job(status='succeeded', model='Nano Banana Pro', cost_cents=140)
        fast = self.job(model='Nano Banana 2.1', cost_cents=12, created_at=1000001)
        self.assertTrue(admission.bills_gemini(fast))
        with patch.dict('os.environ', {'GEMINI_SPEND_LIMIT_CENTS': '150', 'FACE_BEST_OF': '2'}):
            self.assertTrue(admission.queue_position(fast.id, now=1000010)['heldForBudget'])
            self.assertIsNone(admission.admit_job(fast.id, now=1000010))
            Generation.objects.filter(pk=pro.id).delete()
            # Empty-window forward progress: a single job above the limit still starts.
            large = self.job(model='Nano Banana 2.1', cost_cents=400, created_at=1000002)
            self.assertIsNotNone(admission.admit_job(large.id, now=1000010))
            # Its running spend (x best-of) now holds the next Gemini job of either model.
            later = self.job(model='Nano Banana Pro', cost_cents=14, created_at=1000003)
            self.assertTrue(admission.queue_position(later.id, now=1000010)['heldForBudget'])
            self.assertIsNone(admission.admit_job(fast.id, now=1000010))

    def test_stale_timeout_excludes_provider_backed_video(self):
        stale = self.job(status='running', updated_at=1)
        remote = self.job(kind='video', status='running', task_id='remote', updated_at=1)
        self.assertEqual(admission.reap_stale_running_images(now=1000000), 1)
        self.assertEqual(Generation.objects.get(pk=stale.id).status, 'failed')
        self.assertEqual(Generation.objects.get(pk=remote.id).status, 'running')

    def test_distributed_lease_concurrency_and_expired_reclamation(self):
        results = self.race([lambda owner=owner: leases.claim('lease:test', owner, now=1, ttl_ms=10)
                             for owner in ('first', 'second')])
        self.assertEqual(sum(results), 1)
        previous = leases.read('lease:test')['owner']
        self.assertTrue(leases.claim('lease:test', 'successor', now=11))
        self.assertFalse(leases.release('lease:test', previous))
        self.assertTrue(leases.release('lease:test', 'successor'))

    def test_provider_timestamps_seconds_milliseconds_iso(self):
        for value in (1788940000, 1788940000000):
            self.assertEqual(coordinator.provider_timestamp(value), 1788940000000)
        self.assertEqual(coordinator.provider_timestamp('2026-09-09T00:00:00.000Z'), 1788912000000)
        self.assertIsNone(coordinator.provider_timestamp(float('nan')))
        self.assertEqual(coordinator.provider_timestamps({'data': {'created_at': 10, 'updated_at': 20, 'status': 'running'}}),
            {'provider_created_at': 10000, 'provider_updated_at': 20000, 'provider_status': 'running'})


class QueueStatusTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def test_auth_first_query_parameter_status_and_missing(self):
        self.assertEqual(self.client.get('/api/queue/status').status_code, 401)
        self.cookie()
        self.assertEqual(self.client.get('/api/queue/status').json(), {'error': 'Missing id'})
        self.assertEqual(self.client.get('/api/queue/status?id=' + str(uuid4())).status_code, 404)
        self.assertEqual(self.client.get('/api/queue/status?id=bad').json(), {'error': 'Internal server error'})
        item = Generation.objects.create(kind='image', status='succeeded', model='fixture',
            prompt='fixture', aspect_ratio='1:1', user_id=UID, created_at=1, updated_at=1)
        response = self.client.get(f'/api/queue/status?id={item.id}&id=wrong')
        self.assertEqual(response.json()['item']['id'], str(item.id))
        self.assertEqual(response.json()['position'], 0)

    def test_job_access_precedes_queue_inspection_and_terminal_disclosure(self):
        self.cookie()
        for owner in [None,uuid4()]:
            for status in ['queued','running','succeeded','failed']:
                item=Generation.objects.create(kind='video',status=status,model='fixture',
                    prompt='private paid job',aspect_ratio='16:9',user_id=owner,created_at=1,updated_at=1)
                with patch('apps.generation.queue_views.queue_position') as inspect:
                    response=self.client.get('/api/queue/status',{'id':str(item.id)})
                self.assertEqual(response.status_code,403)
                self.assertEqual(response.json(),{'error':'FORBIDDEN'})
                inspect.assert_not_called()
                item.refresh_from_db()
                self.assertEqual(item.status,status)
        from apps.authentication.models import User
        User.objects.filter(pk=UID).update(role='admin')
        self.assertEqual(self.client.get('/api/queue/status',{'id':str(item.id)}).status_code,200)
