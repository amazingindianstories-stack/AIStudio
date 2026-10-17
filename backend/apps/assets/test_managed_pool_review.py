"""Regression tests for review findings in the automatic portrait pool (timeouts, eviction, quota backoff, storage failures, queue order)."""
import re
from unittest.mock import patch

from apps.admin_dashboard.models import AppSetting
from apps.generation.models import Generation
from apps.generation.services import executor
from apps.media.models import UploadSession

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool, ManagedPortraitWait
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


class QueuePlaceTests(GalleryBase):
    def test_time_spent_waiting_for_something_else_does_not_buy_a_place_in_the_slot_queue(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        holder = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(holder, heartbeat=False)                 # registers and pins the only slot
        first = self.enqueue([self.upload(face_variant(2))])
        executor.process_generation(first, heartbeat=False)                  # waits for a slot: first in line
        late = self.enqueue([self.upload(face_variant(3))])
        ManagedPortraitWait.objects.create(generation_id=late, started_at=managed_pool.now_ms() - 10 * 60 * 1000, reason='portrait_processing')
        executor.process_generation(late, heartbeat=False)                   # now it needs a slot too, but it queues behind `first`
        wait = ManagedPortraitWait.objects.get(generation_id=late)
        self.assertEqual(wait.reason, 'portrait_pool_full')
        self.assertGreater(wait.queued_at, ManagedPortraitWait.objects.get(generation_id=first).queued_at)
        self.assertLess(wait.started_at, wait.queued_at, 'the overall wait limit still counts from the first wait')
        self.assertEqual(self.run_worker(holder).status, 'succeeded')
        executor.process_generation(late, heartbeat=False)
        self.assertEqual(Generation.objects.get(pk=late).provider_status, 'PORTRAIT_WAITING', 'the older waiter goes first')
        self.assertEqual(ManagedPortraitAsset.objects.exclude(status='DELETED').count(), 1, 'nobody took the slot ahead of it')
        self.assertEqual(self.run_worker(first).status, 'succeeded')
        self.assertEqual(self.run_worker(late).status, 'succeeded')


class RetiredPortraitReferenceTests(GalleryBase):
    def url_of(self, ref):
        return '/api/media/' + UploadSession.objects.get(pk=ref['referenceId']).key

    def post(self, refs):
        payload = {'prompt': 'a slow pan across a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True,
                   'duration': 5, 'referenceImages': refs}
        return self.client.post('/api/generate/video', payload, content_type='application/json')

    def test_an_old_portrait_marker_on_an_image_is_pooled_by_its_bytes_not_checked_at_byteplus(self):
        from .byteplus import BytePlusAssetError

        class GoneClient:
            def get_asset(self, identifier, **kwargs):
                raise BytePlusAssetError('NotFound.asset_id', 'gone', 404)
        patcher = patch('apps.assets.byteplus_readonly.get_asset_client', return_value=GoneClient())      # cutover deleted the old asset
        patcher.start()
        self.addCleanup(patcher.stop)
        for number, marker in enumerate(('#bp_asset_id=asset-gone', '?bp_asset_id=asset-gone'), start=1):
            with self.subTest(marker=marker):
                key = f'assets/old-portrait-{number}.png'       # a legacy stored image: only upload-session URLs lose their marker on the way in
                self.storage.primary.put(key, face_variant(number), 'image/png', 'private, no-store')
                url = '/api/media/' + key + marker
                response = self.post([url])
                self.assertEqual(response.status_code, 200, response.content)
                row = self.run_worker(response.json()['id'])
                self.assertEqual(row.status, 'succeeded', row.error)
                self.assertNotIn('asset-gone', self.submitted_refs()[0], 'the retired asset is never sent')
                asset = ManagedPortraitAsset.objects.get(byteplus_asset_id=self.submitted_refs()[0][len('asset://'):])
                self.assertEqual(asset.source_key, key, 'its own bytes were pooled')
        self.assertFalse([call for call in self.fake.calls if 'asset-gone' in str(call)], 'nothing asked BytePlus about the retired asset')

    def test_a_bare_old_portrait_link_is_refused_with_the_reference_named(self):
        response = self.post([self.url_of(self.upload(landscape(1))), 'asset://asset-gone'])
        self.assertEqual(response.status_code, 400)
        body = response.json()
        self.assertEqual((body['code'], body['referenceIndex']), ('PORTRAIT_UNAVAILABLE', 2))
        self.assertIn('@img2 is an old portrait link that no longer exists. Add the image again', body['error'])
        self.assertFalse(Generation.objects.exists())


class RollbackPinTests(GalleryBase):
    def test_rollback_releases_pins_nobody_holds_and_still_refuses_for_running_generations(self):
        import io
        import uuid
        from django.core.management import call_command
        from django.core.management.base import CommandError
        from django.test import override_settings
        done = self.run_worker(self.enqueue([self.upload(face_variant(1))]))
        self.assertEqual(done.status, 'succeeded')
        self.add(landscape(1))
        managed_pool.process_uploads()
        asset, upload = ManagedPortraitAsset.objects.get(origin='reference'), ManagedPortraitAsset.objects.get(origin='upload')
        ManagedPortraitPin.objects.create(generation_id=done.id, asset=asset, pinned_at=1)             # its generation finished, nobody released it
        ManagedPortraitPin.objects.create(generation_id=uuid.uuid4(), asset=asset, pinned_at=1)         # its generation was deleted
        ManagedPortraitPin.objects.create(generation_id=upload.id, asset=upload, pinned_at=1)           # an upload's own pin
        running = self.enqueue([self.upload(landscape(3))])
        ManagedPortraitPin.objects.create(generation_id=running, asset=asset, pinned_at=1)
        out = io.StringIO()
        with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
            with self.assertRaisesRegex(CommandError, r'1 portrait pin\(s\) are held by queued/running generations'):
                call_command('managed_portraits_rollback', '--confirm', '--delete-remote', stdout=out)
            self.assertIn('released 2 pin(s) of finished generations and 1 Gallery upload pin(s)', out.getvalue())
            self.assertEqual([str(pin) for pin in ManagedPortraitPin.objects.values_list('generation_id', flat=True)], [running], 'a queued generation keeps its pin')
            Generation.objects.filter(pk=running).update(status='failed')
            with self.assertRaisesRegex(CommandError, 'may still exist at BytePlus'):       # past the pin check; stop before the migration
                call_command('managed_portraits_rollback', '--confirm', stdout=io.StringIO())
        self.assertFalse(ManagedPortraitPin.objects.exists())


class DeletedGroupTests(GalleryBase):
    def group(self, name, **extra):
        identifier = self.fake.asset_api('CreateAssetGroup', {'Name': name})[1]['Result']['Id']
        self.fake.groups[identifier].update(extra)
        return identifier

    def asset(self, group, **extra):
        identifier = self.fake.asset_api('CreateAsset', {'GroupId': group, 'URL': 'https://example.invalid/x.png', 'Name': 'n'})[1]['Result']['Id']
        self.fake.assets[identifier].update(extra)
        return identifier

    def test_the_pool_never_adopts_a_group_that_is_deleted(self):
        gone = self.group(managed_pool.POOL_GROUP_NAME, Status='Deleted', CreateTime='2000-01-01T00:00:00Z')
        live = self.group(managed_pool.POOL_GROUP_NAME, Status='Active')
        self.assertEqual(managed_pool.ensure_group(managed_pool.default_client()), live)
        ManagedPortraitPool.objects.update(byteplus_group_id=None)
        del self.fake.groups[live]
        created = managed_pool.ensure_group(managed_pool.default_client())
        self.assertNotIn(created, (gone, live), 'with only a deleted group left a new one is created')

    def run_cutover(self, *args):
        import io
        from django.core.management import call_command
        out = io.StringIO()
        call_command('portraits_cutover', *args, stdout=out)
        return out.getvalue()

    def test_cutover_ignores_deleted_groups_and_never_deletes_an_asset_of_unknown_group(self):
        pool = self.group(managed_pool.POOL_GROUP_NAME, Status='Active')
        pool_asset = self.asset(pool)
        dead_pool = self.group(managed_pool.POOL_GROUP_NAME, Status='Deleted')
        old = self.group('character-1', Status='Active')
        old_asset = self.asset(old)
        no_group = self.asset(old, GroupId=None)                        # a listing row without a GroupId
        stranger = self.asset(old, GroupId='group-not-listed')
        blank = self.asset(old, GroupId='')
        dry = self.run_cutover()
        self.assertIn('1 group(s), 1 asset(s)', dry)
        self.assertIn('3 asset(s) with a missing or unknown group were NOT touched', dry)
        self.assertNotIn(dead_pool, dry)
        self.run_cutover('--apply', '--expect-assets', '1', '--expect-groups', '1')
        remaining = {key for key, value in self.fake.assets.items() if value['Status'] != 'Deleted'}
        self.assertEqual(remaining, {pool_asset, no_group, stranger, blank}, 'only the asset of a known old group was deleted')
        self.assertIn(pool, self.fake.groups)
        self.assertNotIn(old, self.fake.groups)
        self.assertNotIn(old_asset, remaining)
