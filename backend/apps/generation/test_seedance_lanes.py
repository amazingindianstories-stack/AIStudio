"""Per-model Seedance lanes: BytePlus runs at most N tasks per model per account and queues the rest out of sight,
so admission keeps the excess in Veevee's own queue, first come first served, with a visible reason."""
from uuid import uuid4

from django.test import TransactionTestCase

from apps.admin_dashboard.models import AppSetting, UserLimit
from .models import Generation
from .services import admission, executor


class SeedanceLaneTests(TransactionTestCase):
    def job(self, model='Seedance 2.5', **values):
        data = {'kind': 'video', 'status': 'queued', 'prompt': 'lane fixture', 'model': model, 'aspect_ratio': '16:9',
                'created_at': 1000000, 'updated_at': 1000000, 'user_id': uuid4()}
        data.update(values)
        return Generation.objects.create(**data)

    def test_models_of_one_byteplus_model_share_a_lane_and_others_do_not(self):
        self.assertIn('Seedance 2.5', admission.lane_models(self.job()))
        self.assertNotIn('Seedance 2.0', admission.lane_models(self.job()))
        self.assertEqual(admission.lane_models(self.job(model='Higgsfield Seedance 2.0')), [], 'not a BytePlus model')
        self.assertEqual(admission.lane_models(self.job(kind='image', model='Seedance 2.5')), [])

    def test_default_lane_admits_three_per_model_and_each_model_has_its_own_lane(self):
        self.assertEqual(admission.lane_capacity(), 3)
        newest = [self.job(created_at=1000000 + i) for i in range(4)]
        admitted = [admission.admit_job(item.id, now=1000100) for item in newest]
        self.assertEqual([value is not None for value in admitted], [True, True, True, False])
        self.assertIsNotNone(admission.admit_job(self.job(model='Seedance 2.0', created_at=1000010).id, now=1000100),
                             'Seedance 2.0 counts against its own BytePlus model')
        held = []
        self.assertIsNone(admission.admit_job(newest[3].id, now=1000100, held=held))
        self.assertEqual(held, ['lane'])
        status = admission.queue_position(newest[3].id, now=1000100)
        self.assertEqual((status['position'], status['heldForProvider']), (1, True))
        self.assertIn('Seedance 2.5', status['heldReason'])

    def test_a_freed_slot_goes_to_the_oldest_waiting_job(self):
        running = [self.job(status='running', created_at=999000 + i) for i in range(3)]
        older, newer = self.job(created_at=1000001), self.job(created_at=1000002)
        Generation.objects.filter(pk=running[0].id).update(status='succeeded')
        self.assertIsNone(admission.admit_job(newer.id, now=1000100), 'the newer job may not jump the queue')
        self.assertIsNotNone(admission.admit_job(older.id, now=1000100))
        self.assertIsNone(admission.admit_job(newer.id, now=1000100), 'the lane is full again')

    def test_admin_setting_raises_the_lane_within_its_bounds(self):
        for item in [self.job(status='running', created_at=999000 + i) for i in range(3)]:
            self.assertEqual(item.status, 'running')
        waiting = self.job(created_at=1000001)
        self.assertIsNone(admission.admit_job(waiting.id, now=1000100))
        AppSetting.objects.create(key='seedanceConcurrency', value='10', updated_at=1)
        self.assertEqual(admission.lane_capacity(), 10)
        self.assertIsNotNone(admission.admit_job(waiting.id, now=1000100))
        AppSetting.objects.filter(key='seedanceConcurrency').update(value='0')
        self.assertEqual(admission.lane_capacity(), 3, 'below the minimum falls back to the default')
        AppSetting.objects.filter(key='seedanceConcurrency').update(value='500')
        self.assertEqual(admission.lane_capacity(), 50)

    def test_lane_never_lifts_the_overall_or_per_user_limits(self):
        owner = uuid4()
        UserLimit.objects.create(user_id=owner, key='maxConcurrentJobs', value='1', updated_at=1)
        AppSetting.objects.create(key='seedanceConcurrency', value='50', updated_at=1)
        first, second = self.job(user_id=owner), self.job(user_id=owner, created_at=1000001)
        self.assertIsNotNone(admission.admit_job(first.id, now=1000100))
        self.assertIsNone(admission.admit_job(second.id, now=1000100), 'per-user limit still applies')
        items = [self.job(created_at=1000100 + i) for i in range(admission.MAX_CONCURRENT['video'])]
        admitted = sum(admission.admit_job(item.id, now=1000200) is not None for item in items)
        self.assertEqual(admitted, admission.MAX_CONCURRENT['video'] - 1, 'overall video limit still applies')

    def test_worker_shows_the_slot_wait_on_the_card_and_clears_it_on_admission(self):
        running = [self.job(status='running', created_at=999000 + i) for i in range(3)]
        waiting = self.job(created_at=1000001)
        self.assertEqual(executor.process_generation(waiting.id, heartbeat=False)['kind'], 'not_admitted')
        waiting.refresh_from_db()
        self.assertEqual((waiting.status, waiting.provider_status), ('queued', admission.SLOT_WAITING))
        self.assertIn('Waiting for a free Seedance 2.5 slot', waiting.progress_message)
        Generation.objects.filter(pk=running[0].id).update(status='succeeded')
        self.assertIsNotNone(admission.admit_job(waiting.id, now=waiting.updated_at + 1))
        waiting.refresh_from_db()
        self.assertEqual((waiting.status, waiting.provider_status, waiting.progress_message), ('running', None, None))


class SeedanceLaneSettingTests(TransactionTestCase):
    def test_the_lane_is_a_global_admin_limit_without_per_user_overrides(self):
        from apps.admin_dashboard.views import GLOBAL_ONLY, LIMITS, USER_LIMITS
        self.assertEqual(LIMITS['seedanceConcurrency'], (3, 1, 50))
        self.assertIn('seedanceConcurrency', GLOBAL_ONLY)
        self.assertNotIn('seedanceConcurrency', USER_LIMITS)
