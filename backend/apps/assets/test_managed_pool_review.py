"""Regression tests for review findings in the automatic portrait pool (timeouts, eviction, quota backoff, storage failures, queue order)."""
import re
from unittest.mock import patch

from apps.admin_dashboard.models import AppSetting
from apps.generation.models import Generation
from apps.generation.services import executor

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool
from .test_portrait_gallery import GalleryBase, face_variant, landscape


def asset_calls(fake, action):
    return len([call for call in fake.calls if re.search(f'Action={action}(&|$)', call[1])])


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


class EvictionTests(GalleryBase):
    def test_a_failing_delete_does_not_cascade_into_evicting_the_rest_of_the_pool(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='2', updated_at=0)
        for n in (1, 2):
            self.assertEqual(self.run_worker(self.enqueue([self.upload(face_variant(n))])).status, 'succeeded')
        original = self.fake.asset_api

        def broken_delete(action, body):
            if action == 'DeleteAsset':
                return 500, {'ResponseMetadata': {'Error': {'Code': 'InternalError', 'Message': 'try later'}}}
            return original(action, body)
        newcomer = self.enqueue([self.upload(face_variant(3))])
        with patch.object(self.fake, 'asset_api', broken_delete):
            for _ in range(5):
                Generation.objects.filter(pk=newcomer).update(next_poll_at=0)
                executor.process_generation(newcomer, heartbeat=False)
            self.assertEqual(sorted(ManagedPortraitAsset.objects.values_list('status', flat=True)), ['ACTIVE', 'UNCERTAIN'], 'one eviction, then it waits')
            self.assertEqual(asset_calls(self.fake, 'DeleteAsset'), 1)
            self.assertFalse(managed_pool.has_room(), 'the Gallery does not promise room while a delete is unresolved')
        self.assertEqual(self.fake.live_asset_count(), 2)
        managed_pool.janitor()          # the delete works again: the unresolved one is reconciled, then the newcomer gets its slot
        self.assertEqual(self.run_worker(newcomer).status, 'succeeded')
        self.assertEqual(self.fake.live_asset_count(), 2)


class QuotaBackoffTests(GalleryBase):
    def test_quota_used_up_outside_the_pool_stops_registrations_until_the_backoff_ends(self):
        self.fake.asset_capacity = 0                  # BytePlus refuses everything although the pool holds nothing
        job = self.enqueue([self.upload(face_variant(1))])
        self.add(landscape(1))
        for _ in range(4):
            Generation.objects.filter(pk=job).update(next_poll_at=0)
            executor.process_generation(job, heartbeat=False)
            managed_pool.process_uploads()
        self.assertEqual(asset_calls(self.fake, 'CreateAsset'), 1, 'one refusal, then nobody asks BytePlus again during the backoff')
        self.assertEqual(ManagedPortraitPool.objects.get().observed_capacity, 0)
        self.assertFalse(managed_pool.has_room())
        self.assertEqual(Generation.objects.get(pk=job).provider_status, 'PORTRAIT_WAITING')
        self.fake.asset_capacity = None
        ManagedPortraitPool.objects.update(last_quota_error_at=managed_pool.now_ms() - managed_pool.QUOTA_BACKOFF_MS - 1)
        self.assertTrue(managed_pool.has_room())
        self.settle_uploads()                                            # the upload is first in line and probes
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        self.assertEqual(self.fake.live_asset_count(), 2)
        self.assertGreaterEqual(ManagedPortraitPool.objects.get().observed_capacity, 2, 'the quota has grown again')


class StorageFailureTests(GalleryBase):
    def broken_storage(self):
        return patch.object(self.storage, 'write_private_buffer', side_effect=OSError('disk full'))

    def test_an_upload_whose_derived_copy_cannot_be_stored_fails_visibly_and_releases_its_pin(self):
        self.add(landscape(1))
        with patch.object(managed_pool, 'bounded_copy', return_value=b'jpeg'), self.broken_storage():
            managed_pool.process_uploads()
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, asset.error_code), ('FAILED', 'storage_unwritable'))
        self.assertFalse(ManagedPortraitPin.objects.exists())
        self.assertEqual(self.listing()['portraits'][0]['state'], 'unusable')
        self.assertEqual(asset_calls(self.fake, 'CreateAsset'), 0)

    def test_a_generation_whose_derived_copy_cannot_be_stored_fails_not_charged_and_releases_its_pin(self):
        job = self.enqueue([self.upload(face_variant(1))])
        with patch.object(managed_pool, 'bounded_copy', return_value=b'jpeg'), self.broken_storage():
            row = self.run_worker(job, passes=2)
        self.assertEqual(row.status, 'failed')
        self.assertIn('not charged', row.error)
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'FAILED')
        self.assertFalse(ManagedPortraitPin.objects.exists())
        self.assertEqual(self.fake.seedance_payloads, [])
