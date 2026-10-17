"""Portrait Gallery v2: shared gallery API, first come first served slots, janitor recovery, missed-face learning."""
import hashlib
import io
import os
import time
import uuid
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

from django.test import Client, TransactionTestCase, override_settings
from django.utils import timezone
from PIL import Image

from apps.admin_dashboard import tests as session_fixtures
from apps.admin_dashboard.models import AppSetting
from apps.authentication.models import User
from apps.generation.models import Generation
from apps.generation.services import executor, portrait_prepare
from apps.media.models import UploadSession
from apps.media.storage import MemoryAdapter, StorageService
from testsupport.fake_providers import FakeProviders

from . import managed_pool
from .models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool, ManagedPortraitWait, ReferenceFaceScan

FACE = (Path(__file__).resolve().parents[2] / 'testsupport' / 'data' / 'face_public_domain.jpg').read_bytes()
ENV = {'ARK_API_KEY': 'fake-ark', 'GOOGLE_API_KEY': 'fake-google', 'MOCK_GENERATION': '0', 'MOCK_ASSET_PROVIDER': '0',
       'BYTEPLUS_ACCESS_KEY_ID': 'fake-ak', 'BYTEPLUS_SECRET_ACCESS_KEY': 'fake-sk', 'BYTEPLUS_ARK_REGION': 'ap-southeast-1'}
OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'


def landscape(seed=0):
    out = io.BytesIO()
    Image.new('RGB', (640, 400), (40 + seed, 120, 180)).save(out, format='PNG')
    return out.getvalue()


def face_variant(n):
    with Image.open(io.BytesIO(FACE)) as image:
        image = image.convert('RGB')
        image.putpixel((0, 0), (n % 256, 0, 0))
        out = io.BytesIO()
        image.save(out, format='PNG')
        return out.getvalue()


def pause():
    time.sleep(0.004)       # waiting_since / created_at are milliseconds; keep the queue order unambiguous


@override_settings(VEEVEE_MANAGED_PORTRAITS=True)
class GalleryBase(TransactionTestCase):
    setUp_session = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def setUp(self):
        self.setUp_session()
        self.cookie()
        User.objects.create(id=OTHER, email='other@example.invalid', name='Other Person', role='user', password_hash='x', password_salt='x',
                            created_at=1, is_active=True, auth_version=0)
        self.storage = StorageService(MemoryAdapter())
        self.fake = FakeProviders(asset_activation_polls=1)
        stack = [override_settings(VEEVEE_MEDIA_STORAGE=self.storage), patch.dict(os.environ, ENV), self.fake]
        for item in stack:
            item.__enter__()
            self.addCleanup(item.__exit__, None, None, None)

    def upload(self, data, mime='image/png', purpose='image-reference', actor=session_fixtures.UID, size=None):
        key = f'uploads/{purpose}/{uuid.uuid4()}'
        self.storage.primary.put(key, data, mime, 'private, no-store')
        row = UploadSession.objects.create(actor_id=actor, key=key, purpose=purpose, content_type=mime, byte_size=size or len(data),
            sha256=hashlib.sha256(data).hexdigest(), state='ready', finalized_at=timezone.now(), expires_at=timezone.now() + timedelta(hours=1))
        return {'referenceId': str(row.id)}

    def add(self, *images, names=None):
        """POST /api/portraits with one finalized portrait upload per image; returns the parsed response."""
        uploads = [{**self.upload(data, purpose='portrait'), 'name': (names or {}).get(index, f'Portrait {index}')} for index, data in enumerate(images)]
        response = self.client.post('/api/portraits', {'uploads': uploads}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def enqueue(self, refs):
        payload = {'prompt': 'a slow pan across a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True,
                   'duration': 5, 'referenceImages': refs}
        response = self.client.post('/api/generate/video', payload, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['id']

    def run_worker(self, identifier, passes=14):
        for _ in range(passes):
            Generation.objects.filter(pk=identifier).update(next_poll_at=0)
            executor.process_generation(identifier, heartbeat=False)
            row = Generation.objects.get(pk=identifier)
            if row.status in ('succeeded', 'failed'):
                return row
        return Generation.objects.get(pk=identifier)

    def settle_uploads(self, ticks=8):
        for _ in range(ticks):
            managed_pool.process_uploads()

    def submitted_refs(self, index=-1):
        return [part['image_url']['url'] for part in self.fake.seedance_payloads[index]['content'] if part.get('type') == 'image_url']

    def listing(self, query=''):
        response = self.client.get('/api/portraits' + query)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()


class GalleryApiTests(GalleryBase):
    def test_old_routes_answer_410_on_every_method_in_managed_mode(self):
        for path in ('/api/assets/portraits', '/api/assets/portraits/upload', f'/api/assets/portraits/{uuid.uuid4()}/assets'):
            for method in ('get', 'post', 'patch', 'delete', 'put', 'head', 'options'):
                response = getattr(self.client, method)(path)
                self.assertEqual(response.status_code, 410, (method, path))
                if method not in ('head', 'options'):
                    self.assertEqual(response.json()['error'], 'PORTRAITS_ARE_AUTOMATIC')
        self.assertEqual(self.client.get('/api/portraits/managed').status_code, 404, 'the old managed list is gone')

    def test_flag_off_keeps_old_routes_and_disables_the_gallery(self):
        with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
            self.assertEqual(self.client.get('/api/portraits').json(), {'enabled': False, 'portraits': [], 'next': None})
            for response in (self.client.post('/api/portraits', {'uploads': []}, content_type='application/json'),
                             self.client.post('/api/portraits/delete', {'ids': []}, content_type='application/json'),
                             self.client.patch(f'/api/portraits/{uuid.uuid4()}', {'name': 'x'}, content_type='application/json')):
                self.assertEqual((response.status_code, response.json()['error']), (404, 'PORTRAITS_DISABLED'))
            self.assertNotEqual(self.client.get('/api/assets/portraits').status_code, 410)

    def test_every_route_needs_a_session(self):
        anonymous = Client()
        for response in (anonymous.get('/api/portraits'), anonymous.post('/api/portraits', {}, content_type='application/json'),
                         anonymous.post('/api/portraits/delete', {}, content_type='application/json'),
                         anonymous.patch(f'/api/portraits/{uuid.uuid4()}', {}, content_type='application/json')):
            self.assertEqual(response.status_code, 401)

    def test_batch_is_validated_ordered_and_makes_no_provider_call(self):
        for count in (0, 51):
            response = self.client.post('/api/portraits', {'uploads': [{'referenceId': str(uuid.uuid4())}] * count}, content_type='application/json')
            self.assertEqual((response.status_code, response.json()['error']), (400, 'PORTRAIT_BATCH_LIMIT'), count)
        result = self.add(*[landscape(n) for n in range(5)], names={0: 'First'})
        self.assertTrue(all(item['ok'] and not item['existing'] for item in result['results']))
        first = result['results'][0]['portrait']
        self.assertEqual((first['name'], first['origin'], first['state'], first['inUse']), ('First', 'upload', 'preparing', False),
                         'with room in the pool a queued upload is simply next in line, not waiting for space')
        self.assertTrue(first['imageUrl'].startswith('/api/media/uploads/portrait/'))
        self.assertTrue(first['message'] and 'BytePlus' not in str(first))
        created = [item['portrait']['createdAt'] for item in result['results']]
        self.assertEqual(created, sorted(set(created)), 'created_at strictly increases in request order')
        self.assertEqual(list(ManagedPortraitAsset.objects.order_by('created_at').values_list('name', flat=True))[0], 'First')
        self.assertEqual(self.fake.calls, [], 'nothing calls BytePlus inside the request')
        self.assertEqual(ReferenceFaceScan.objects.filter(forced='upload', has_face=True).count(), 5)

    def test_items_that_cannot_be_registered_get_their_own_error(self):
        good = self.upload(landscape(1), purpose='portrait')
        bad = [{'referenceId': self.upload(landscape(2), purpose='portrait', actor=OTHER)['referenceId']},       # someone else's upload
               {'referenceId': self.upload(landscape(3))['referenceId']},                                         # wrong purpose
               {'referenceId': self.upload(landscape(4), purpose='portrait', size=31 * 1024 * 1024)['referenceId']},
               {'referenceId': str(uuid.uuid4())}, {'referenceId': 'not-a-uuid'}, {'name': 'no id'}]
        response = self.client.post('/api/portraits', {'uploads': [*bad, {**good, 'name': 'x' * 121}, {**good, 'name': 'Fine'}]}, content_type='application/json')
        results = response.json()['results']
        self.assertEqual([item['error'] for item in results[:-1]], ['UPLOAD_NOT_FOUND', 'UPLOAD_PURPOSE_MISMATCH', 'PORTRAIT_TOO_LARGE',
                                                                     'UPLOAD_NOT_FOUND', 'UPLOAD_NOT_FOUND', 'BAD_REQUEST', 'INVALID_NAME'])
        self.assertTrue(results[-1]['ok'])
        self.assertTrue(all(item['message'] for item in results[:-1]))
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)

    def test_listing_pages_by_keyset_newest_first_and_filters_by_name(self):
        self.add(*[landscape(n) for n in range(5)], names={0: 'Anna', 1: 'Bo', 2: 'Cy', 3: 'Di', 4: 'Ed'})
        seen, cursor = [], ''
        for _ in range(4):
            page = self.listing(f'?limit=2{cursor}')
            seen += [item['name'] for item in page['portraits']]
            if not page['next']:
                break
            cursor = '&cursor=' + page['next']
        self.assertEqual(seen, ['Ed', 'Di', 'Cy', 'Bo', 'Anna'])
        self.assertIsNone(page['next'])
        self.assertEqual([item['name'] for item in self.listing('?q=an')['portraits']], ['Anna'])
        self.assertEqual(self.client.get('/api/portraits?cursor=garbage').status_code, 400)

    def test_failed_upload_is_listed_unusable_but_failed_automatic_faces_are_not(self):
        self.add(landscape(1))
        original = self.fake.asset_api

        def refuse(action, body):
            if action == 'CreateAsset':
                return 400, {'ResponseMetadata': {'Error': {'Code': 'InvalidParameter', 'Message': 'bad image'}}}
            return original(action, body)
        with patch.object(self.fake, 'asset_api', refuse):
            self.settle_uploads(3)
        item = self.listing()['portraits'][0]
        self.assertEqual((item['state'], item['message']), ('unusable', "This image can't be used as a portrait."))
        ManagedPortraitAsset.objects.create(id=uuid.uuid4(), content_sha256='f' * 64, source_key='uploads/image-reference/x', status='FAILED',
            receipt={}, created_at=1, updated_at=1, last_used_at=1, origin='reference')
        self.assertEqual(len(self.listing()['portraits']), 1)

    def test_scheduler_registers_uploads_to_ready_and_a_quota_error_keeps_the_place(self):
        self.add(landscape(1))
        self.fake.asset_capacity = 0
        managed_pool.process_uploads()
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, asset.error_code), ('QUEUED', 'QuotaSharedPoolExceeded'), 'a quota error requeues an upload, it does not fail it')
        self.assertEqual(self.listing()['portraits'][0]['state'], 'waiting')
        self.fake.asset_capacity = None
        ManagedPortraitPool.objects.update(last_quota_error_at=managed_pool.now_ms() - managed_pool.QUOTA_BACKOFF_MS - 1)     # the backoff has passed
        self.settle_uploads()
        asset.refresh_from_db()
        self.assertEqual(asset.status, 'ACTIVE')
        self.assertFalse(ManagedPortraitPin.objects.exists(), 'the temporary pin goes once the upload is ACTIVE')
        self.assertEqual(self.listing()['portraits'][0]['state'], 'ready')
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_one_scheduler_pass_registers_several_uploads_oldest_first(self):
        self.add(*[landscape(n) for n in range(7)])
        report = managed_pool.process_uploads()
        self.assertEqual(report['registered'], managed_pool.UPLOADS_PER_PASS)
        order = list(ManagedPortraitAsset.objects.order_by('created_at').values_list('status', flat=True))
        self.assertNotIn('QUEUED', order[:5], 'the five oldest uploads were registered in this pass')
        self.assertEqual(order[5:], ['QUEUED', 'QUEUED'], 'the newest uploads wait for the next pass')
        ticks = iter([0, 100])
        self.assertEqual(managed_pool.process_uploads(clock=lambda: next(ticks))['registered'], 1, 'the time budget ends a pass early')

    def test_a_write_limit_pauses_registration_instead_of_refusing_the_image(self):
        # Production 2026-10-17: QuotaWriteQPMExceeded (HTTP 400) was taken for a refusal and faces went inline.
        self.add(landscape(1))
        self.fake.asset_throttle = 1
        managed_pool.process_uploads()
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, asset.error_code), ('QUEUED', 'throttled'), 'the upload keeps its place')
        self.assertGreater(managed_pool.pause_remaining(managed_pool.now_ms()), 50000, 'new registrations pause for a minute')
        calls = len(self.fake.calls)
        managed_pool.process_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'QUEUED')
        self.assertFalse([c for c in self.fake.calls[calls:] if 'CreateAsset' in str(c)], 'no CreateAsset during the pause')
        job = self.enqueue([self.upload(face_variant(7))])
        executor.process_generation(job, heartbeat=False)
        row = Generation.objects.get(pk=job)
        self.assertEqual((row.status, row.provider_status), ('queued', portrait_prepare.WAITING_STATUS))
        self.assertIn('slow down', row.progress_message)
        AppSetting.objects.filter(key=managed_pool.PAUSE_KEY).update(value='0')
        self.settle_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get(origin='upload').status, 'ACTIVE')
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        self.assertTrue(any(ref.startswith('asset://') for ref in self.submitted_refs()))
        self.assertFalse(ReferenceFaceScan.objects.filter(forced=managed_pool.REFUSED).exists(), 'a write limit never marks a face as inline')

    def test_a_write_limit_during_a_face_job_does_not_send_the_face_inline(self):
        for status, code in ((400, 'QuotaWriteQPMExceeded'), (429, 'TooManyRequests')):
            with self.subTest(code=code):
                AppSetting.objects.filter(key=managed_pool.PAUSE_KEY).delete()
                self.fake.asset_throttle, self.fake.asset_throttle_error = 1, (status, code, 'slow down')
                job = self.enqueue([self.upload(face_variant(8 if status == 400 else 9))])
                executor.process_generation(job, heartbeat=False)
                self.assertEqual(Generation.objects.get(pk=job).status, 'queued')
                self.assertFalse(ReferenceFaceScan.objects.filter(forced=managed_pool.REFUSED).exists())
                AppSetting.objects.filter(key=managed_pool.PAUSE_KEY).update(value='0')
                self.assertEqual(self.run_worker(job).status, 'succeeded')

    def test_full_pool_shows_waiting_for_space(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        holder = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(holder, heartbeat=False)
        self.add(landscape(1))
        item = self.listing()['portraits'][0]
        self.assertEqual((item['state'], item['message']), ('waiting', 'Waiting for space - other generations are using it.'))

    def test_same_image_returns_the_existing_asset_and_shows_it_again(self):
        first = self.add(landscape(1), names={0: 'Mine'})['results'][0]['portrait']
        again = self.add(landscape(1), names={0: 'Other name'})['results'][0]
        self.assertEqual((again['existing'], again['portrait']['id'], again['portrait']['name']), (True, first['id'], 'Mine'))
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)
        ManagedPortraitPin.objects.create(generation_id=uuid.uuid4(), asset_id=first['id'], pinned_at=1)      # a running job holds it
        self.client.post('/api/portraits/delete', {'ids': [first['id']]}, content_type='application/json')
        self.assertEqual(self.listing()['portraits'], [])
        back = self.add(landscape(1))['results'][0]
        self.assertEqual((back['existing'], back['portrait']['id']), (True, first['id']), 'still held, so it is shown again instead of duplicated')
        self.assertEqual(len(self.listing()['portraits']), 1)
        ManagedPortraitPin.objects.all().delete()
        self.client.post('/api/portraits/delete', {'ids': [first['id']]}, content_type='application/json')
        fresh = self.add(landscape(1))['results'][0]
        self.assertEqual(fresh['existing'], False, 'a queued upload nobody holds is simply gone, so adding it again makes a new one')

    def test_rename_and_shared_delete(self):
        self.add(landscape(1), landscape(2))
        self.settle_uploads()
        a, b = [item['id'] for item in self.listing()['portraits']]
        ManagedPortraitAsset.objects.filter(pk=a).update(created_by_id=OTHER)       # another artist's portrait: anyone may rename and delete it
        renamed = self.client.patch(f'/api/portraits/{a}', {'name': '  Hero  '}, content_type='application/json')
        self.assertEqual(renamed.json()['portrait']['name'], 'Hero')
        self.assertEqual(self.listing()['portraits'][0]['createdBy']['name'], 'Other Person')
        for bad in ({'name': ''}, {'name': 'x' * 121}, {}):
            self.assertEqual(self.client.patch(f'/api/portraits/{a}', bad, content_type='application/json').status_code, 400)
        self.assertEqual(self.client.patch(f'/api/portraits/{uuid.uuid4()}', {'name': 'x'}, content_type='application/json').status_code, 404)
        gone = str(uuid.uuid4())
        result = self.client.post('/api/portraits/delete', {'ids': [a, gone, 'not-a-uuid', a]}, content_type='application/json').json()['results']
        self.assertEqual([(item['ok'], item.get('error')) for item in result], [(True, None), (False, 'NOT_FOUND'), (False, 'NOT_FOUND'), (True, None)])
        self.assertEqual([item['id'] for item in self.listing()['portraits']], [b], 'it disappears at once')
        self.assertEqual(ManagedPortraitAsset.objects.get(pk=a).status, 'DELETING')
        self.assertEqual(self.fake.live_asset_count(), 2, 'the remote delete is the scheduler job, not part of the request')
        managed_pool.process_uploads()
        self.assertEqual((ManagedPortraitAsset.objects.get(pk=a).status, self.fake.live_asset_count()), ('DELETED', 1))
        for count in (0, 201):
            self.assertEqual(self.client.post('/api/portraits/delete', {'ids': [b] * count}, content_type='application/json').status_code, 400)

    def test_deleting_a_pinned_portrait_hides_it_until_its_job_finishes(self):
        busy = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(busy, heartbeat=False)
        executor.process_generation(busy, heartbeat=False)
        item = self.listing()['portraits'][0]
        self.assertEqual((item['origin'], item['state'], item['inUse'], item['name'].startswith('Face from Fixture')), ('reference', 'ready', True, True))
        deleted = self.client.post('/api/portraits/delete', {'ids': [item['id']]}, content_type='application/json').json()['results']
        self.assertEqual(deleted, [{'id': item['id'], 'ok': True}])
        self.assertEqual(self.listing()['portraits'], [])
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, asset.hidden_at is not None), ('ACTIVE', True))
        managed_pool.janitor()
        self.assertEqual(self.fake.live_asset_count(), 1, 'the running job still needs it')
        self.assertEqual(self.run_worker(busy).status, 'succeeded')
        managed_pool.janitor()
        self.assertEqual((ManagedPortraitAsset.objects.get().status, self.fake.live_asset_count()), ('DELETED', 0))

    def test_another_artists_gallery_image_can_be_read_but_a_private_upload_cannot(self):
        from apps.media import grants
        shared = self.upload(landscape(1), purpose='portrait', actor=OTHER)
        key = UploadSession.objects.get(pk=shared['referenceId']).key
        with self.assertRaises(ValueError):
            grants.authorize_owned_upload_read(key, session_fixtures.UID)
        ManagedPortraitAsset.objects.create(id=uuid.uuid4(), content_sha256='a' * 64, source_key=key, status='ACTIVE', receipt={},
            created_at=1, updated_at=1, last_used_at=1, origin='upload')
        self.assertEqual(grants.authorize_owned_upload_read(key, session_fixtures.UID).key, key)
        ManagedPortraitAsset.objects.update(hidden_at=5)
        with self.assertRaises(ValueError):
            grants.authorize_owned_upload_read(key, session_fixtures.UID)

    def test_retired_old_portrait_does_not_block_a_video_in_managed_mode(self):
        from .models import PortraitAsset, PortraitGroup
        reference = self.upload(landscape(9))
        key = UploadSession.objects.get(pk=reference['referenceId']).key
        group = PortraitGroup.objects.create(id=uuid.uuid4(), name='Old', created_at=1, updated_at=1)
        PortraitAsset.objects.create(id=uuid.uuid4(), group=group, image_url='/api/media/' + key, status='Retired', created_at=1, updated_at=1)
        self.enqueue([reference])      # raises (non-200) if the retired portrait is still checked at enqueue
        with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
            payload = {'prompt': 'a hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True, 'duration': 5, 'referenceImages': [reference]}
            self.assertEqual(self.client.post('/api/generate/video', payload, content_type='application/json').status_code, 400)

    def test_old_portrait_lifecycle_patches_stay_off_in_managed_mode(self):
        from django.apps import apps as registry
        config = registry.get_app_config('production_runtime')
        for managed, installed in ((True, 0), (False, 1)):
            with override_settings(VEEVEE_RUNTIME_COMPONENT='api', VEEVEE_PORTRAIT_LIFECYCLE=True, VEEVEE_MANAGED_PORTRAITS=managed,
                                   VEEVEE_PAID_GUARD=None, VEEVEE_EXPORT_ADMISSION=False), \
                    patch('apps.production_runtime.namespacing.install_readonly_pricing'), \
                    patch('apps.production_runtime.apps.install_portrait_lifecycle') as install:
                config.ready()
            self.assertEqual(install.call_count, installed, managed)


class FirstComeFirstServedTests(GalleryBase):
    def test_two_waiting_generations_and_an_upload_get_slots_in_the_order_they_started_waiting(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        holder = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(holder, heartbeat=False)                 # registers and pins the only slot
        pause()
        first = self.enqueue([self.upload(face_variant(2))])
        executor.process_generation(first, heartbeat=False)                  # waits: the pool is full
        pause()
        self.add(face_variant(3))                                            # a Gallery upload queues behind it
        pause()
        last = self.enqueue([self.upload(face_variant(4))])
        executor.process_generation(last, heartbeat=False)                   # and a younger generation behind that
        self.assertEqual(ManagedPortraitWait.objects.filter(reason='portrait_pool_full').count(), 2)
        self.assertEqual(self.run_worker(holder).status, 'succeeded')        # its asset is now free to evict
        managed_pool.process_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get(origin='upload').status, 'QUEUED', 'the upload does not jump the older waiter')
        executor.process_generation(last, heartbeat=False)
        self.assertEqual(Generation.objects.get(pk=last).provider_status, portrait_prepare.WAITING_STATUS)
        self.assertEqual(ManagedPortraitAsset.objects.exclude(status__in=('DELETED', 'QUEUED')).count(), 1, 'only the holder asset exists; nobody got a slot early')
        self.assertEqual(self.run_worker(first).status, 'succeeded')         # the oldest waiter goes first
        executor.process_generation(last, heartbeat=False)
        self.assertEqual(Generation.objects.get(pk=last).provider_status, portrait_prepare.WAITING_STATUS, 'the upload is ahead of the younger generation')
        self.settle_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get(origin='upload').status, 'ACTIVE')
        self.assertEqual(self.run_worker(last).status, 'succeeded')
        names = [asset['Name'] for asset in self.fake.assets.values()]
        expected = ['veevee-' + hashlib.sha256(face_variant(n)).hexdigest()[:40] for n in (1, 2, 3, 4)]
        self.assertEqual(names, expected, 'slots were handed out in waiting order')

    def test_a_generation_that_is_no_longer_queued_does_not_hold_the_queue(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        holder = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(holder, heartbeat=False)
        gone = self.enqueue([self.upload(face_variant(2))])
        executor.process_generation(gone, heartbeat=False)
        self.assertTrue(ManagedPortraitWait.objects.filter(generation_id=gone).exists())
        pause()
        self.add(face_variant(3))
        self.assertEqual(self.run_worker(holder).status, 'succeeded')
        managed_pool.process_uploads()
        upload = ManagedPortraitAsset.objects.get(origin='upload')
        self.assertEqual(upload.status, 'QUEUED', 'blocked behind the older waiting generation')
        self.assertEqual(len(managed_pool._claimants()), 2)
        Generation.objects.filter(pk=gone).update(status='failed')           # cancelled or failed while it waited
        self.assertEqual([claimant[1] for claimant in managed_pool._claimants()], [str(upload.id)], 'a stale wait row no longer counts as a claimant')
        managed_pool.janitor()
        self.assertFalse(ManagedPortraitWait.objects.filter(generation_id=gone).exists())
        self.settle_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get(origin='upload').status, 'ACTIVE')

    def test_a_generation_shares_an_upload_of_the_same_image_instead_of_registering_it_twice(self):
        self.add(face_variant(1))
        job = self.enqueue([self.upload(face_variant(1))])
        executor.process_generation(job, heartbeat=False)
        self.assertEqual(Generation.objects.get(pk=job).provider_status, portrait_prepare.WAITING_STATUS)
        self.assertEqual(ManagedPortraitPin.objects.filter(generation_id=job).count(), 1, 'pinned to the queued upload')
        self.settle_uploads()
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)
        self.assertEqual(len(self.fake.assets), 1)


class PoolGroupTests(GalleryBase):
    def test_existing_group_is_adopted_by_name_and_none_is_created(self):
        theirs = self.fake.asset_api('CreateAssetGroup', {'Name': managed_pool.POOL_GROUP_NAME})[1]['Result']['Id']
        self.fake.asset_api('CreateAssetGroup', {'Name': 'veevee-portraits-old'})
        self.assertEqual(managed_pool.ensure_group(managed_pool.default_client()), theirs)
        self.assertEqual(ManagedPortraitPool.objects.get().byteplus_group_id, theirs)
        self.assertEqual([call for call in self.fake.calls if 'CreateAssetGroup' in call[1]], [], 'no group was created')
        self.assertEqual(len(self.fake.groups), 2)

    def test_duplicate_create_race_keeps_the_oldest_group_and_removes_ours(self):
        original, rival = self.fake.asset_api, {}

        def racing(action, body):
            if action == 'CreateAssetGroup' and not rival:       # another process creates the group at the same moment, a second earlier
                rival['id'] = original(action, body)[1]['Result']['Id']
                self.fake.groups[rival['id']]['CreateTime'] = '2020-01-01T00:00:00Z'
            return original(action, body)
        with patch.object(self.fake, 'asset_api', racing):
            chosen = managed_pool.ensure_group(managed_pool.default_client())
        self.assertEqual(chosen, rival['id'])
        self.assertEqual(list(self.fake.groups), [rival['id']], 'our duplicate was deleted')

    def test_a_tie_on_creation_time_resolves_to_the_same_group_every_time(self):
        ids = [self.fake.asset_api('CreateAssetGroup', {'Name': managed_pool.POOL_GROUP_NAME})[1]['Result']['Id'] for _ in range(3)]
        for group in self.fake.groups.values():
            group['CreateTime'] = '2026-01-01T00:00:00Z'
        self.assertEqual(managed_pool._pool_group(managed_pool.default_client()), min(ids))

    def test_group_listing_is_paginated(self):
        for n in range(55):     # the name filter also matches these, so the exact group is on the second page
            self.fake.asset_api('CreateAssetGroup', {'Name': f'{managed_pool.POOL_GROUP_NAME}-copy-{n}'})
        exact = self.fake.asset_api('CreateAssetGroup', {'Name': managed_pool.POOL_GROUP_NAME})[1]['Result']['Id']
        self.assertEqual(managed_pool._pool_group(managed_pool.default_client()), exact)

    def test_flag_off_and_on_again_reuses_the_group(self):
        self.add(landscape(1))
        self.settle_uploads()
        group = ManagedPortraitPool.objects.get().byteplus_group_id
        ManagedPortraitPool.objects.update(byteplus_group_id=None)          # e.g. the rollback command dropped the tables and they came back
        self.add(landscape(2))
        self.settle_uploads()
        self.assertEqual(ManagedPortraitPool.objects.get().byteplus_group_id, group)
        self.assertEqual(len(self.fake.groups), 1)

    def test_reconcile_looks_past_the_first_page(self):
        self.add(landscape(1))
        self.settle_uploads()
        asset = ManagedPortraitAsset.objects.get()
        group = ManagedPortraitPool.objects.get().byteplus_group_id
        remote_id = asset.byteplus_asset_id
        for n in range(120):        # filler assets that sort before it
            self.fake.assets[f'asset-filler-{n}'] = {'Id': f'asset-filler-{n}', 'GroupId': group, 'Name': f'filler-{n}', 'Status': 'Active'}
        self.fake.assets = {**{k: v for k, v in self.fake.assets.items() if k != remote_id}, remote_id: self.fake.assets[remote_id]}
        ManagedPortraitAsset.objects.filter(pk=asset.pk).update(status='UNCERTAIN', byteplus_asset_id=None)
        self.assertEqual(managed_pool.janitor()['reconciled'], 1)
        asset.refresh_from_db()
        self.assertEqual((asset.status, asset.byteplus_asset_id), ('ACTIVE', remote_id))


class JanitorRecoveryTests(GalleryBase):
    def test_rows_stuck_in_deleting_are_deleted_remotely(self):
        self.add(landscape(1))
        self.settle_uploads()
        asset = ManagedPortraitAsset.objects.get()
        managed_pool._mark_deleting(asset, 'evicted', 1)           # claimed long ago by a worker that died
        self.assertEqual(self.fake.live_asset_count(), 1)
        self.assertEqual(managed_pool.janitor()['recovered'], 1)
        self.assertEqual((ManagedPortraitAsset.objects.get().status, self.fake.live_asset_count()), ('DELETED', 0))

    def test_rows_stuck_in_processing_are_polled_to_active(self):
        self.fake.asset_activation_polls = 3
        self.add(landscape(1))
        managed_pool.process_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'PROCESSING')
        self.assertTrue(ManagedPortraitPin.objects.exists(), 'pinned by its own id while it registers')
        for _ in range(3):
            managed_pool.janitor()
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'ACTIVE')
        managed_pool.janitor()
        self.assertFalse(ManagedPortraitPin.objects.exists())

    def test_a_registering_upload_keeps_its_pin_through_the_janitor(self):
        self.add(landscape(1))
        original = self.fake.asset_api
        seen = {}

        def slow(action, body):
            if action == 'CreateAsset':
                seen['status'] = ManagedPortraitAsset.objects.get().status
                seen['pins'] = managed_pool.janitor()['pins_released']       # the janitor runs while the upload registers
                seen['pinned'] = ManagedPortraitPin.objects.count()
            return original(action, body)
        with patch.object(self.fake, 'asset_api', slow):
            managed_pool.process_uploads()
        self.assertEqual(seen, {'status': 'REGISTERING', 'pins': 0, 'pinned': 1})

    def test_a_registration_nobody_finished_becomes_uncertain_and_is_reconciled(self):
        self.add(landscape(1))
        asset = ManagedPortraitAsset.objects.get()
        ManagedPortraitAsset.objects.filter(pk=asset.pk).update(status='REGISTERING', updated_at=1)
        report = managed_pool.janitor()
        self.assertEqual(report['reconciled'], 1)
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'DELETED', 'nothing existed at BytePlus for it')

    def test_deferred_user_delete_and_expiry_both_reach_bytePlus(self):
        self.add(landscape(1), landscape(2))
        self.settle_uploads(12)
        first, second = ManagedPortraitAsset.objects.order_by('created_at')
        self.client.post('/api/portraits/delete', {'ids': [str(first.id)]}, content_type='application/json')
        ManagedPortraitAsset.objects.filter(pk=second.pk).update(expires_at=1)
        report = managed_pool.janitor()
        self.assertEqual(report['expired'], 1)
        self.assertEqual(report['recovered'], 1)
        self.assertEqual(self.fake.live_asset_count(), 0)


class MissedFaceTests(GalleryBase):
    def refuse_inline(self, data, mode):
        self.fake.reject_image_sha256 = {hashlib.sha256(data).hexdigest()}
        self.fake.reject_mode = mode

    def test_create_time_rejection_teaches_the_detector_and_retry_uses_a_portrait(self):
        image = landscape(7)                       # the detector sees no face in it; Seedance does
        self.refuse_inline(image, 'create')
        first = self.run_worker(self.enqueue([self.upload(image)]))
        self.assertEqual((first.status, first.error, first.moderation_blocked), ('failed', portrait_prepare.REJECTED_MESSAGE, True))
        self.assertEqual(self.fake.seedance_payloads, [], 'rejected at creation: nothing accepted, nothing billed')
        scan = ReferenceFaceScan.objects.get(pk=hashlib.sha256(image).hexdigest())
        self.assertEqual((scan.has_face, scan.forced), (True, 'provider_rejection'))
        retry = self.run_worker(self.enqueue([self.upload(image)]))
        self.assertEqual(retry.status, 'succeeded', retry.error)
        self.assertTrue(self.submitted_refs()[0].startswith('asset://asset-'))
        self.assertEqual(len(self.fake.seedance_payloads), 1, 'exactly one paid submission across both tries')

    def test_async_rejection_teaches_the_detector_and_retry_uses_a_portrait(self):
        image = landscape(8)
        self.refuse_inline(image, 'async')
        first = self.run_worker(self.enqueue([self.upload(image), self.upload(landscape(9))]))
        self.assertEqual((first.status, first.error), ('failed', portrait_prepare.REJECTED_MESSAGE))
        self.assertEqual(len(self.fake.seedance_payloads), 1, 'the task was accepted before it failed')
        self.assertTrue(ReferenceFaceScan.objects.filter(pk=hashlib.sha256(image).hexdigest(), forced='provider_rejection').exists())
        self.fake.reject_mode = 'create'
        retry = self.run_worker(self.enqueue([self.upload(image), self.upload(landscape(9))]))
        self.assertEqual(retry.status, 'succeeded', retry.error)
        refs = self.submitted_refs()
        self.assertTrue(refs[0].startswith('asset://') and refs[1].startswith('asset://'), 'every inline image of the rejected job became a portrait')

    def test_a_non_face_rejection_is_not_learned(self):
        self.assertFalse(portrait_prepare.privacy_rejection('The request failed because the input text may contain sensitive information.'))
        self.assertFalse(portrait_prepare.privacy_rejection('', {'error': {'code': 'InputTextSensitiveContentDetected', 'message': 'x'}}))
        self.assertFalse(portrait_prepare.privacy_rejection('Seedance error (500 ): boom'))
        self.assertTrue(portrait_prepare.privacy_rejection('The request failed because the input image may contain real person.'))
        self.assertTrue(portrait_prepare.privacy_rejection('x', {'data': {'error': {'code': 'InputImageSensitiveContentDetected.PrivacyInformation'}}}))

    def test_nothing_is_learned_when_the_flag_is_off(self):
        job = Generation.objects.create(id=uuid.uuid4(), kind='video', status='failed', prompt='x', model='Seedance 2.5', aspect_ratio='16:9',
                                        created_at=1, updated_at=1, reference_images=[], user_id=session_fixtures.UID)
        with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
            self.assertEqual(portrait_prepare.learn_from_rejection(job), 0)
        self.assertFalse(ReferenceFaceScan.objects.exists())

    def test_a_forced_scan_wins_over_the_detector_whatever_its_version(self):
        image = landscape(6)
        sha = hashlib.sha256(image).hexdigest()
        ReferenceFaceScan.objects.create(content_sha256=sha, has_face=False, faces=0, detector_version='old-version', scanned_at=1)
        self.assertEqual(managed_pool.scan_reference(image, scanner=lambda data: {'has_face': False, 'faces': 0, 'error': None}), (sha, False))
        managed_pool.force_face(sha, 'upload')
        self.assertEqual(managed_pool.scan_reference(image, scanner=lambda data: self.fail('a forced scan is not re-run')), (sha, True))
        ReferenceFaceScan.objects.filter(pk=sha).update(detector_version='older')
        self.assertTrue(managed_pool.scan_reference(image)[1])


class UpgradeTests(TransactionTestCase):
    def test_upgrade_from_0005_keeps_rows_and_fills_the_new_columns(self):
        from django.db import connection
        from django.db.migrations.executor import MigrationExecutor
        self.addCleanup(lambda: MigrationExecutor(connection).migrate(MigrationExecutor(connection).loader.graph.leaf_nodes()))
        old = [('assets', '0005_managed_portraits')]
        MigrationExecutor(connection).migrate(old)
        rows = MigrationExecutor(connection).loader.project_state(old).apps
        rows.get_model('assets', 'ManagedPortraitAsset').objects.create(id=uuid.uuid4(), content_sha256='a' * 64, source_key='k', status='ACTIVE',
                                                                       created_at=1, updated_at=1, last_used_at=1)
        rows.get_model('assets', 'ReferenceFaceScan').objects.create(content_sha256='b' * 64, has_face=True, faces=1, detector_version='v', scanned_at=1)
        MigrationExecutor(connection).migrate([('assets', '0006_portrait_gallery')])
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, asset.origin, asset.name, asset.hidden_at), ('ACTIVE', 'reference', None, None))
        self.assertIsNone(ReferenceFaceScan.objects.get().forced)
