"""Regression tests for review findings in the automatic portrait pool (timeouts, eviction, quota backoff, storage failures, queue order)."""
from apps.generation.models import Generation
from apps.generation.services import executor

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin
from .test_portrait_gallery import GalleryBase, face_variant, landscape


def asset_calls(fake, action):
    return len([call for call in fake.calls if f'Action={action}' in call[1]])


class ProcessingTimeoutTests(GalleryBase):
    def test_an_upload_that_waited_in_the_queue_gets_its_full_processing_time(self):
        self.fake.asset_activation_polls = 3
        self.add(landscape(1))
        ManagedPortraitAsset.objects.update(created_at=managed_pool.now_ms() - 10 * 60 * 1000)     # it sat QUEUED for ten minutes
        managed_pool.process_uploads()
        asset = ManagedPortraitAsset.objects.get()
        self.assertIn(asset.status, ('PROCESSING', 'ACTIVE'), asset.error_code)
        self.assertIsNone(asset.error_code)
        self.assertEqual(self.fake.live_asset_count(), 1, 'not deleted on its first poll')
        self.settle_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'ACTIVE')

    def test_a_timed_out_asset_held_by_a_generation_fails_it_cleanly_and_is_deleted_after_release(self):
        self.fake.asset_activation_polls = 999
        job = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(job, heartbeat=False)
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(asset.status, 'PROCESSING')
        ManagedPortraitAsset.objects.update(receipt={**asset.receipt, 'registered_at': managed_pool.now_ms() - 10 * 60 * 1000})
        row = self.run_worker(job, passes=1)
        self.assertEqual(row.status, 'failed')
        self.assertIn('not charged', row.error)
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'PROCESSING', 'not deleted under the generation that held it')
        self.assertEqual(self.fake.live_asset_count(), 1)
        self.assertFalse(ManagedPortraitPin.objects.exists())
        managed_pool.janitor()
        self.assertEqual((ManagedPortraitAsset.objects.get().status, self.fake.live_asset_count()), ('DELETED', 0), 'deleted once nothing holds it')

    def test_a_settled_row_is_not_condemned_by_a_stale_poll(self):
        self.fake.asset_activation_polls = 999
        self.add(landscape(1))
        managed_pool.process_uploads()
        asset = ManagedPortraitAsset.objects.get()
        ManagedPortraitAsset.objects.update(status='ACTIVE')            # another process activated it meanwhile
        stale = ManagedPortraitAsset.objects.get()
        stale.status, stale.created_at = 'PROCESSING', 1
        stale.receipt = {**stale.receipt, 'registered_at': 1}
        outcome = managed_pool._poll(stale, managed_pool.default_client())
        self.assertEqual(outcome.kind, 'wait')
        self.assertEqual((ManagedPortraitAsset.objects.get().status, self.fake.live_asset_count()), ('ACTIVE', 1))
        self.assertEqual(asset.pk, ManagedPortraitAsset.objects.get().pk)
