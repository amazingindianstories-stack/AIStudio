"""Automatic portrait pool: API enqueue → real worker → fake BytePlus (generation + asset API)."""
import io
import os
import time
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from PIL import Image

from apps.admin_dashboard import tests as session_fixtures
from apps.admin_dashboard.models import AppSetting
from apps.generation.models import Generation
from apps.generation.services import executor
from apps.media.models import UploadSession
from apps.media.storage import MemoryAdapter, StorageService
from testsupport.fake_providers import FakeProviders

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool

FACE = (Path(__file__).resolve().parents[2] / 'testsupport' / 'data' / 'face_public_domain.jpg').read_bytes()
ENV = {'ARK_API_KEY': 'fake-ark', 'GOOGLE_API_KEY': 'fake-google', 'MOCK_GENERATION': '0', 'MOCK_ASSET_PROVIDER': '0',
       'BYTEPLUS_ACCESS_KEY_ID': 'fake-ak', 'BYTEPLUS_SECRET_ACCESS_KEY': 'fake-sk', 'BYTEPLUS_ARK_REGION': 'ap-southeast-1'}


def landscape(seed=0):
    out = io.BytesIO()
    Image.new('RGB', (640, 400), (40 + seed, 120, 180)).save(out, format='PNG')
    return out.getvalue()


def face_variant(n):
    """Distinct bytes, same face (so each is its own asset)."""
    with Image.open(io.BytesIO(FACE)) as image:
        image = image.convert('RGB')
        image.putpixel((0, 0), (n % 256, 0, 0))
        out = io.BytesIO()
        image.save(out, format='PNG')
        return out.getvalue()


@override_settings(VEEVEE_MANAGED_PORTRAITS=True)
class ManagedPoolTests(TransactionTestCase):
    setUp_session = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def setUp(self):
        self.setUp_session()
        self.cookie()
        self.storage = StorageService(MemoryAdapter())
        self.fake = FakeProviders(asset_activation_polls=1)
        stack = [override_settings(VEEVEE_MEDIA_STORAGE=self.storage), patch.dict(os.environ, ENV), self.fake]
        for item in stack:
            item.__enter__()
            self.addCleanup(item.__exit__, None, None, None)

    def upload(self, data, mime='image/png'):
        key = f'uploads/image-reference/{uuid.uuid4()}'
        self.storage.primary.put(key, data, mime, 'private, no-store')
        row = UploadSession.objects.create(actor_id=session_fixtures.UID, key=key, purpose='image-reference', content_type=mime,
            byte_size=len(data), state='ready', finalized_at=timezone.now(), expires_at=timezone.now() + timedelta(hours=1))
        return {'referenceId': str(row.id)}

    def enqueue(self, refs, **extra):
        payload = {'prompt': 'a slow pan across a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True,
                   'duration': 5, 'referenceImages': refs, **extra}
        response = self.client.post('/api/generate/video', payload, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['id']

    def run_worker(self, identifier, passes=12):
        for _ in range(passes):
            Generation.objects.filter(pk=identifier).update(next_poll_at=0)
            executor.process_generation(identifier, heartbeat=False)
            row = Generation.objects.get(pk=identifier)
            if row.status in ('succeeded', 'failed'):
                return row
        return Generation.objects.get(pk=identifier)

    def submitted_refs(self, index=-1):
        content = self.fake.seedance_payloads[index]['content']
        return [part['image_url']['url'] for part in content if part.get('type') == 'image_url']

    # ------------------------------------------------------------------
    def test_face_becomes_asset_and_plain_image_stays_inline(self):
        row = self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg'), self.upload(landscape())]))
        self.assertEqual(row.status, 'succeeded', row.error)
        refs = self.submitted_refs()
        self.assertTrue(refs[0].startswith('asset://asset-'), refs[0][:40])
        self.assertTrue(refs[1].startswith('data:image/'), refs[1][:40])
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, refs[0]), ('ACTIVE', 'asset://' + asset.byteplus_asset_id))
        self.assertIsNotNone(asset.expires_at)
        self.assertFalse(ManagedPortraitPin.objects.exists(), 'pins are released when the generation finishes')
        self.assertEqual(len(self.fake.seedance_payloads), 1, 'exactly one paid submission')

    def test_same_face_is_shared_between_generations(self):
        first = self.enqueue([self.upload(FACE, 'image/jpeg')])
        second = self.enqueue([self.upload(FACE, 'image/jpeg')])
        executor.process_generation(first, heartbeat=False)
        executor.process_generation(second, heartbeat=False)
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)
        self.assertEqual(ManagedPortraitPin.objects.count(), 2)
        self.assertEqual(self.run_worker(first).status, 'succeeded')
        self.assertEqual(self.run_worker(second).status, 'succeeded')
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_full_pool_evicts_least_recently_used_unpinned_asset(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        old = self.run_worker(self.enqueue([self.upload(face_variant(1))]))
        self.assertEqual(old.status, 'succeeded')
        new = self.run_worker(self.enqueue([self.upload(face_variant(2))]))
        self.assertEqual(new.status, 'succeeded', new.error)
        statuses = sorted(ManagedPortraitAsset.objects.values_list('status', flat=True))
        self.assertEqual(statuses, ['ACTIVE', 'DELETED'])
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_pinned_assets_are_never_evicted_and_jobs_wait_then_proceed(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        holder = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(holder, heartbeat=False)          # registers + pins (job still queued)
        waiting = self.enqueue([self.upload(face_variant(2))])
        executor.process_generation(waiting, heartbeat=False)
        row = Generation.objects.get(pk=waiting)
        self.assertEqual((row.status, row.provider_status), ('queued', 'PORTRAIT_WAITING'))
        self.assertIn('Waiting for portrait space', row.progress_message)
        self.assertEqual(ManagedPortraitAsset.objects.exclude(status='DELETED').count(), 1, 'the pinned asset was not evicted')
        self.assertEqual(self.run_worker(holder).status, 'succeeded')   # finishes → pin released
        row = self.run_worker(waiting)
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertNotEqual(row.provider_status, 'PORTRAIT_WAITING')

    def test_wait_limit_fails_clearly_without_any_paid_submission(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        AppSetting.objects.create(key='portraitQueueWaitMinutes', value='1', updated_at=0)
        holder = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(holder, heartbeat=False)
        waiting = self.enqueue([self.upload(face_variant(2))])
        executor.process_generation(waiting, heartbeat=False)
        from .models import ManagedPortraitWait
        ManagedPortraitWait.objects.filter(generation_id=waiting).update(started_at=int(time.time() * 1000) - 2 * 60 * 1000)
        row = self.run_worker(waiting, passes=1)
        self.assertEqual(row.status, 'failed')
        self.assertIn('not charged', row.error)
        self.assertEqual(self.fake.seedance_payloads, [])
        self.assertFalse(ManagedPortraitPin.objects.filter(generation_id=waiting).exists())

    def test_byteplus_quota_error_records_capacity_evicts_and_recovers(self):
        self.fake.asset_capacity = 1
        first = self.run_worker(self.enqueue([self.upload(face_variant(1))]))
        self.assertEqual(first.status, 'succeeded')
        second = self.run_worker(self.enqueue([self.upload(face_variant(2))]))
        self.assertEqual(second.status, 'succeeded', second.error)
        self.assertEqual(ManagedPortraitPool.objects.get().observed_capacity, 1)
        self.assertEqual(self.fake.live_asset_count(), 1)
        retired = ManagedPortraitAsset.objects.filter(error_code='QuotaSharedPoolExceeded')
        self.assertEqual(list(retired.values_list('status', flat=True)), ['DELETED'], 'the refused attempt leaves the Gallery once the retry is Ready')
        self.assertFalse(ManagedPortraitAsset.objects.filter(status='FAILED').exists())

    def test_uncertain_registration_is_reconciled_not_retried(self):
        identifier = self.enqueue([self.upload(FACE, 'image/jpeg')])
        original = self.fake.asset_api

        def flaky(action, body):
            status, payload = original(action, body)
            if action == 'CreateAsset':
                raise ConnectionError('response lost after BytePlus accepted it')
            return status, payload
        with patch.object(self.fake, 'asset_api', flaky):
            executor.process_generation(identifier, heartbeat=False)
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(asset.status, 'UNCERTAIN')
        creates = [c for c in self.fake.calls if 'Action=CreateAsset' in c[1]]
        Generation.objects.filter(pk=identifier).update(next_poll_at=0)
        executor.process_generation(identifier, heartbeat=False)
        self.assertEqual(len([c for c in self.fake.calls if 'Action=CreateAsset' in c[1]]), len(creates), 'never re-created blindly')
        managed_pool.janitor()
        asset.refresh_from_db()
        self.assertIn(asset.status, ('ACTIVE', 'PROCESSING'))
        self.assertEqual(self.run_worker(identifier).status, 'succeeded')
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_janitor_expires_unused_assets_but_never_pinned_ones(self):
        done = self.run_worker(self.enqueue([self.upload(face_variant(1))]))
        self.assertEqual(done.status, 'succeeded')
        busy = self.enqueue([self.upload(face_variant(2))])
        executor.process_generation(busy, heartbeat=False)
        executor.process_generation(busy, heartbeat=False)
        ManagedPortraitAsset.objects.update(expires_at=1)
        report = managed_pool.janitor()
        self.assertEqual(report['expired'], 1)
        by_status = dict(ManagedPortraitAsset.objects.values_list('status', 'id'))
        self.assertIn('DELETED', by_status)
        self.assertTrue(ManagedPortraitPin.objects.filter(generation_id=busy).exists())
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_manual_upload_is_refused_and_gallery_lists_and_deletes(self):
        response = self.client.post('/api/assets/portraits/upload', {'referenceId': str(uuid.uuid4())}, content_type='application/json')
        self.assertEqual((response.status_code, response.json()['code']), (410, 'PORTRAITS_ARE_AUTOMATIC'))
        busy = self.enqueue([self.upload(FACE, 'image/jpeg')])
        executor.process_generation(busy, heartbeat=False)
        executor.process_generation(busy, heartbeat=False)
        listing = self.client.get('/api/portraits').json()
        self.assertTrue(listing['enabled'])
        asset = listing['portraits'][0]
        self.assertEqual((asset['state'], asset['inUse']), ('ready', True))
        hidden = self.client.post('/api/portraits/delete', {'ids': [asset['id']]}, content_type='application/json')
        self.assertEqual(hidden.json()['results'], [{'id': asset['id'], 'ok': True}], 'a portrait in use leaves the Gallery at once')
        self.assertEqual(self.client.get('/api/portraits').json()['portraits'], [])
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'ACTIVE', 'but stays until its generation finishes')
        self.assertEqual(self.run_worker(busy).status, 'succeeded')
        managed_pool.janitor()
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'DELETED')
        self.assertEqual(self.fake.live_asset_count(), 0)

    def test_draft_final_after_expiry_re_registers_the_face(self):
        draft = self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')]))
        self.assertEqual(draft.status, 'succeeded')
        ManagedPortraitAsset.objects.update(expires_at=1)
        managed_pool.janitor()
        self.assertEqual(self.fake.live_asset_count(), 0)
        response = self.client.post('/api/generate/video/finalize', {'sourceGenerationId': str(draft.id)}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        final = self.run_worker(response.json()['id'])
        self.assertEqual(final.status, 'succeeded', final.error)
        self.assertEqual(self.fake.live_asset_count(), 1, 'the face was registered again for the final')

    def test_admin_settings_endpoint(self):
        from apps.authentication.models import User
        User.objects.filter(pk=session_fixtures.UID).update(role='admin')
        first = self.client.get('/api/admin/portrait-settings')
        self.assertEqual(first.status_code, 200, first.content)
        self.assertEqual(first.json()['settings']['portraitAssetTtlHours'], 4)
        bad = self.client.post('/api/admin/portrait-settings', {'key': 'portraitAssetTtlHours', 'value': 0}, content_type='application/json')
        self.assertEqual(bad.status_code, 400)
        ok = self.client.post('/api/admin/portrait-settings', {'key': 'portraitAssetTtlHours', 'value': 6}, content_type='application/json')
        self.assertEqual(ok.status_code, 200, ok.content)
        self.assertEqual(ok.json()['settings']['portraitAssetTtlHours'], 6)

    def test_asset_removed_outside_veevee_is_detected_and_registered_again(self):
        first = self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')]))
        self.assertEqual(first.status, 'succeeded')
        self.fake.assets.clear()                                   # someone deleted it in the BytePlus console
        ManagedPortraitAsset.objects.update(receipt={'verified_at': 0})
        second = self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')]))
        self.assertEqual(second.status, 'succeeded', second.error)
        self.assertEqual(self.fake.live_asset_count(), 1)
        self.assertEqual(sorted(ManagedPortraitAsset.objects.values_list('status', flat=True)), ['ACTIVE', 'DELETED'])
        live_id = ManagedPortraitAsset.objects.get(status='ACTIVE').byteplus_asset_id
        self.assertIn('asset://' + live_id, self.submitted_refs())

    def test_active_asset_is_reconfirmed_before_each_submission_after_a_minute(self):
        self.assertEqual(self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')])).status, 'succeeded')
        self.fake.assets.clear()        # removed at BytePlus; Veevee last confirmed it moments ago
        ManagedPortraitAsset.objects.update(receipt={'verified_at': managed_pool.now_ms() - managed_pool.VERIFY_INTERVAL_MS - 1})
        row = self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')]))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertEqual(len(self.fake.seedance_payloads), 2, 'no rejected paid submission')
        self.assertLessEqual(managed_pool.VERIFY_INTERVAL_MS, 60 * 1000)

    def test_failed_submission_makes_the_next_use_reconfirm_its_assets(self):
        self.assertEqual(self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')])).status, 'succeeded')
        self.fake.assets.clear()        # vanished inside the trust window: BytePlus refuses this submission
        self.assertEqual(self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')])).status, 'failed')
        self.assertFalse(ManagedPortraitPin.objects.exists())
        row = self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')]))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertEqual(ManagedPortraitAsset.objects.get(status='ACTIVE').byteplus_asset_id, self.submitted_refs()[0][len('asset://'):])

    def test_pool_group_removed_outside_veevee_is_recreated(self):
        self.assertEqual(self.run_worker(self.enqueue([self.upload(face_variant(1))])).status, 'succeeded')
        self.fake.groups.clear()
        self.fake.assets.clear()
        row = self.run_worker(self.enqueue([self.upload(face_variant(2))]))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertEqual(len(self.fake.groups), 1)
        self.assertEqual(ManagedPortraitPool.objects.get().byteplus_group_id, next(iter(self.fake.groups)))

    def test_rollback_command_refuses_unsafe_states_then_removes_pool_and_migration(self):
        from django.core.management import call_command
        from django.core.management.base import CommandError
        from django.db import connection
        self.assertEqual(self.run_worker(self.enqueue([self.upload(FACE, 'image/jpeg')])).status, 'succeeded')
        self.assertEqual(self.fake.live_asset_count(), 1)
        with self.assertRaisesRegex(CommandError, 'turn it off'):
            call_command('managed_portraits_rollback', '--confirm', '--delete-remote')
        with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
            Generation.objects.update(status='queued')          # a real holder: a queued generation keeps its pin
            managed_pool.pin(Generation.objects.first().id, ManagedPortraitAsset.objects.get())
            with self.assertRaisesRegex(CommandError, 'pin'):
                call_command('managed_portraits_rollback', '--confirm', '--delete-remote')
            ManagedPortraitPin.objects.all().delete()
            with self.assertRaisesRegex(CommandError, 'may still exist at BytePlus'):
                call_command('managed_portraits_rollback', '--confirm')
            try:
                call_command('managed_portraits_rollback', '--confirm', '--delete-remote', stdout=io.StringIO())
                self.assertEqual(self.fake.live_asset_count(), 0)
                with connection.cursor() as cursor:
                    cursor.execute("SELECT count(*) FROM pg_tables WHERE tablename LIKE 'managed_portrait%%'")
                    self.assertEqual(cursor.fetchone()[0], 0)
                    cursor.execute("SELECT count(*) FROM django_migrations WHERE app = 'assets' AND name = '0005_managed_portraits'")
                    self.assertEqual(cursor.fetchone()[0], 0)
                self.assertTrue(Generation.objects.exists(), 'generations are untouched')
            finally:
                call_command('migrate', 'assets', verbosity=0)
