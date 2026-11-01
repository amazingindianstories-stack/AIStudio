"""Gallery video portraits: the documented video limits, registration as a BytePlus Video asset, delete and consumer guards."""
import contextlib
import functools
import json
import threading
from unittest.mock import patch

from django.db.models import F
from django.test import SimpleTestCase

from apps.generation.references import resolve_submission_references
from apps.admin_dashboard.models import AppSetting
from apps.media import posters
from apps.media.uploads import UploadError

from . import managed_pool, video_limits
from .models import ManagedPortraitAsset, ManagedPortraitPool, ManagedPortraitWait, ReferenceFaceScan
from .test_portrait_gallery import GalleryBase, landscape, session_fixtures

GOOD = {'containers': ['mov', 'mp4', 'm4a'], 'width': 1080, 'height': 1920, 'seconds': 8.0, 'fps': 30.0}
MP4 = b'\x00\x00\x00\x18ftypmp42' + b'0' * 64


@contextlib.contextmanager
def probe(**changes):
    """The scheduler's check of a clip: ffprobe reads GOOD with ``changes`` and ffmpeg makes its poster."""
    with patch.object(video_limits, 'probe_stored', return_value={**GOOD, **changes}) as probed, \
            patch.object(posters, 'bounded_poster', return_value=('poster', b'webp')):
        yield probed


class VideoLimitsTests(SimpleTestCase):
    def test_a_clip_inside_every_documented_limit_passes(self):
        self.assertIsNone(video_limits.problem(GOOD))

    def test_each_rule_has_a_short_message_without_an_em_dash(self):
        cases = {
            'PORTRAIT_VIDEO_DURATION': [{'seconds': 1.2}, {'seconds': 31}],
            'PORTRAIT_VIDEO_SIZE': [{'width': 200, 'height': 400}, {'width': 7000, 'height': 4000}, {'width': 640, 'height': 400, 'fps': 30}],
            'PORTRAIT_VIDEO_RATIO': [{'width': 3000, 'height': 1000}, {'width': 600, 'height': 3000}],
            'PORTRAIT_VIDEO_FPS': [{'fps': 12}, {'fps': 120}],
            'PORTRAIT_VIDEO_FORMAT': [{'containers': ['matroska', 'webm']}],
        }
        for code, variants in cases.items():
            for change in variants:
                found = video_limits.problem({**GOOD, **change})
                self.assertEqual(found[0], code, change)
                self.assertTrue(found[1] and '—' not in found[1])
        self.assertEqual(video_limits.problem(None)[0], 'PORTRAIT_VIDEO_UNREADABLE')

    def test_a_small_frame_names_the_rule_it_breaks(self):
        self.assertEqual(video_limits.problem({**GOOD, 'width': 200, 'height': 400})[1],
                         'Too small (200 x 400 px). Use at least 300 px on each side.')
        self.assertEqual(video_limits.problem({**GOOD, 'width': 480, 'height': 640})[1],
                         'Too small (480 x 640 px). Use at least 640 x 640 px.')

    def test_boundaries_are_inclusive(self):
        self.assertIsNone(video_limits.problem({**GOOD, 'seconds': 2, 'fps': 24, 'width': 640, 'height': 640}))
        self.assertIsNone(video_limits.problem({**GOOD, 'seconds': 30, 'fps': 60}))

    def test_parse_reads_ffprobe_json_and_swaps_sides_for_rotation(self):
        raw = json.dumps({'format': {'format_name': 'mov,mp4,m4a,3gp,3g2,mj2', 'duration': '8.5'},
                          'streams': [{'codec_type': 'audio'}, {'codec_type': 'video', 'width': 1920, 'height': 1080, 'avg_frame_rate': '30000/1001',
                                                                 'side_data_list': [{'rotation': -90}]}]})
        facts = video_limits.parse(raw)
        self.assertEqual((facts['width'], facts['height'], facts['seconds']), (1080, 1920, 8.5))
        self.assertAlmostEqual(facts['fps'], 29.97, 2)
        self.assertIn('mp4', facts['containers'])
        self.assertIsNone(video_limits.parse('not json'))
        self.assertIsNone(video_limits.parse(json.dumps({'streams': [{'codec_type': 'audio'}], 'format': {}})))


class VideoGalleryTests(GalleryBase):
    def add_video(self, name='Clip', mime='video/mp4', **kwargs):
        upload = {**self.upload(MP4, mime=mime, purpose='portrait', **kwargs), 'name': name}
        response = self.client.post('/api/portraits', {'uploads': [upload]}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['results'][0]

    def test_a_video_upload_is_queued_as_a_video_portrait_without_a_poster_yet(self):
        with patch.object(video_limits, 'probe_stored', side_effect=AssertionError('the Gallery request never probes')), \
                patch.object(posters, 'bounded_poster', side_effect=AssertionError('the Gallery request never runs ffmpeg')):
            result = self.add_video()
        self.assertTrue(result['ok'], result)
        item = result['portrait']
        self.assertEqual(item['kind'], 'video')
        self.assertIsNone(item['imageUrl'])
        self.assertTrue(item['videoUrl'].startswith('/api/media/uploads/portrait/'))
        self.assertIsNone(item['posterUrl'], 'the card shows its placeholder until the scheduler made the frame')
        self.assertEqual(ManagedPortraitAsset.objects.get().media_kind, 'video')
        self.assertFalse(ReferenceFaceScan.objects.exists(), 'a video is never scanned as an image')
        self.assertEqual(self.fake.calls, [])

    def test_the_scheduler_makes_the_poster_before_the_clip_is_registered_and_the_card_serves_it(self):
        item = self.add_video()['portrait']
        frame = functools.partial(posters.bounded_poster, frame=lambda source, protocols, timeout: landscape(1))
        with patch.object(video_limits, 'probe_stored', return_value=GOOD), patch.object(posters, '_source', return_value=('clip', 'file')), \
                patch.object(posters, 'bounded_poster', frame):
            self.settle_uploads()
        card = self.listing()['portraits'][0]
        self.assertEqual((card['state'], card['posterUrl']), ('ready', '/api/media/thumbs/poster/' + item['videoUrl'][len('/api/media/'):] + '.webp'))
        response = self.client.get(card['posterUrl'] + '?inline=1')
        self.assertEqual((response.status_code, response['Content-Type']), (200, 'image/webp'))

    def test_a_poster_already_being_made_elsewhere_in_the_process_delays_the_clip_and_does_not_condemn_it(self):
        self.add_video()
        frame = functools.partial(posters.bounded_poster, frame=lambda source, protocols, timeout: landscape(1))
        posters._GATE.acquire()
        threading.Timer(0.3, posters._GATE.release).start()
        with patch.object(video_limits, 'probe_stored', return_value=GOOD), patch.object(posters, '_source', return_value=('clip', 'file')), \
                patch.object(posters, 'bounded_poster', frame):
            self.settle_uploads()
        card = self.listing()['portraits'][0]
        self.assertEqual(card['state'], 'ready')
        self.assertTrue(card['posterUrl'])

    def test_a_clip_whose_first_frame_cannot_be_read_is_unusable_and_never_registered(self):
        self.add_video()
        with patch.object(video_limits, 'probe_stored', return_value=GOOD), patch.object(posters, 'bounded_poster', return_value=None):
            self.settle_uploads()
        self.assertEqual(ManagedPortraitAsset.objects.get().error_code, 'PORTRAIT_VIDEO_UNREADABLE')
        card = self.listing()['portraits'][0]
        self.assertEqual((card['state'], card['posterUrl']), ('unusable', None))
        self.assertEqual(card['message'], 'This video could not be read. Use an MP4 or MOV file and upload it again.')
        self.assertEqual(self.fake.calls, [])

    def test_images_still_report_the_image_kind(self):
        item = self.add(landscape(1))['results'][0]['portrait']
        self.assertEqual((item['kind'], item['videoUrl'], item['posterUrl']), ('image', None, None))

    def test_a_clip_over_200_mb_is_refused_before_it_is_queued(self):
        with patch.object(video_limits, 'probe_stored', side_effect=AssertionError('the Gallery request never probes')):
            result = self.add_video(size=201 * 1024 * 1024)
        self.assertEqual((result['ok'], result['error']), (False, 'PORTRAIT_TOO_LARGE'))
        self.assertFalse(ManagedPortraitAsset.objects.exists())

    def test_the_scheduler_marks_a_clip_that_breaks_a_limit_unusable_with_its_message_and_never_registers_it(self):
        cases = (({'seconds': 45.0}, 'PORTRAIT_VIDEO_DURATION'), ({'fps': 120.0}, 'PORTRAIT_VIDEO_FPS'),
                 ({'width': 100, 'height': 100}, 'PORTRAIT_VIDEO_SIZE'), ({'containers': ['webm']}, 'PORTRAIT_VIDEO_FORMAT'), (None, 'PORTRAIT_VIDEO_UNREADABLE'))
        for change, code in cases:
            with patch.object(video_limits, 'probe_stored', side_effect=AssertionError('the Gallery request never probes')):
                result = self.add_video(name=code)
            self.assertTrue(result['ok'], result)
            facts = None if change is None else {**GOOD, **change}
            with patch.object(video_limits, 'probe_stored', return_value=facts):
                self.settle_uploads()
            asset = ManagedPortraitAsset.objects.get(id=result['portrait']['id'])
            self.assertEqual((asset.status, asset.error_code), ('FAILED', code))
            card = next(item for item in self.listing()['portraits'] if item['id'] == str(asset.id))
            self.assertEqual((card['state'], card['message'], card['posterUrl']), ('unusable', video_limits.problem(facts)[1], None))
        self.assertEqual((self.fake.assets, self.fake.calls), ({}, []))

    def test_a_clip_that_breaks_a_limit_never_evicts_a_portrait_to_make_room(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        self.add(landscape(1))
        self.settle_uploads()
        image = ManagedPortraitAsset.objects.get()
        self.assertEqual(image.status, 'ACTIVE')
        self.add_video()
        with probe(seconds=45.0):
            self.settle_uploads()
        image.refresh_from_db()
        self.assertEqual(image.status, 'ACTIVE', 'the ready portrait is not evicted for a clip that is refused')
        self.assertEqual(ManagedPortraitAsset.objects.get(media_kind='video').error_code, 'PORTRAIT_VIDEO_DURATION')
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_a_clip_waiting_for_space_is_checked_once_and_shows_its_poster_while_it_waits(self):
        self.add_video()
        self.fake.asset_capacity = 0
        with probe() as probed:
            for _ in range(3):
                managed_pool.process_uploads()
        self.assertEqual((ManagedPortraitAsset.objects.get().status, probed.call_count), ('QUEUED', 1))
        card = self.listing()['portraits'][0]
        self.assertEqual(card['state'], 'waiting')
        self.assertTrue(card['posterUrl'])

    def test_the_scheduler_registers_a_video_asset_without_reading_the_file_and_it_becomes_ready(self):
        with probe():
            self.add_video()
            with patch.object(self.storage, 'read', side_effect=AssertionError('the master is never read into memory')):
                self.settle_uploads()
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(asset.status, 'ACTIVE')
        self.assertEqual([item['AssetType'] for item in self.fake.assets.values()], ['Video'])
        self.assertTrue(self.fake.assets[asset.byteplus_asset_id]['URL'].startswith('http'), 'the stored master is registered as it is')
        self.assertEqual(self.listing()['portraits'][0]['state'], 'ready')
        self.assertEqual(self.fake.live_asset_count(), 1)

    def test_a_video_portrait_is_deleted_remotely_like_an_image(self):
        with probe():
            self.add_video()
            self.settle_uploads()
        asset = ManagedPortraitAsset.objects.get()
        result = self.client.post('/api/portraits/delete', {'ids': [str(asset.id)]}, content_type='application/json').json()['results']
        self.assertTrue(result[0]['ok'])
        managed_pool.janitor()
        self.settle_uploads(2)
        self.assertEqual((ManagedPortraitAsset.objects.get().status, self.fake.live_asset_count()), ('DELETED', 0))

    def test_a_video_portrait_only_goes_where_a_video_is_accepted(self):
        ref = self.upload(MP4, mime='video/mp4', purpose='portrait')
        image = self.upload(b'\x89PNG' + b'0' * 32, mime='image/png', purpose='portrait')
        videos = resolve_submission_references({'referenceVideos': [ref]}, session_fixtures.UID)
        self.assertTrue(videos['referenceVideos'][0].startswith('/api/media/uploads/portrait/'))
        for field in ('referenceImages', 'firstFrame', 'lastFrame', 'continuationFrame', 'image', 'video'):
            with self.assertRaises(UploadError, msg=field):
                resolve_submission_references({field: [ref] if field == 'referenceImages' else ref}, session_fixtures.UID)
        with self.assertRaises(UploadError):
            resolve_submission_references({'referenceVideos': [image]}, session_fixtures.UID)

    def enqueue_with_clip(self, ref):
        payload = {'prompt': 'the person from @vid1 walks into a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True,
                   'duration': 5, 'referenceVideos': [ref]}
        response = self.client.post('/api/generate/video', payload, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['id']

    def test_a_generation_sends_a_video_portrait_to_seedance_as_its_asset_and_registers_it_again_after_expiry(self):
        with probe():
            ref = {**self.upload(MP4, mime='video/mp4', purpose='portrait')}
            self.client.post('/api/portraits', {'uploads': [{**ref, 'name': 'Clip'}]}, content_type='application/json')
            self.settle_uploads()
        asset = ManagedPortraitAsset.objects.get()
        job = self.enqueue_with_clip(ref)
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        content = self.fake.seedance_payloads[-1]['content']
        videos = [part for part in content if part.get('type') == 'video_url']
        self.assertEqual([part['video_url']['url'] for part in videos], ['asset://' + asset.byteplus_asset_id])
        # Once the asset expired and was deleted remotely, the next generation registers the same clip again.
        managed_pool._mark_deleting(asset, 'expired', 1)
        managed_pool.janitor()
        self.assertEqual(ManagedPortraitAsset.objects.get().status, 'DELETED')
        again = self.enqueue_with_clip(ref)
        self.assertEqual(self.run_worker(again).status, 'succeeded')
        fresh = ManagedPortraitAsset.objects.exclude(status='DELETED').get()
        self.assertEqual((fresh.media_kind, fresh.origin), ('video', 'reference'))
        self.assertEqual([part['video_url']['url'] for part in self.fake.seedance_payloads[-1]['content'] if part.get('type') == 'video_url'],
                         ['asset://' + fresh.byteplus_asset_id])

    def test_a_clip_registered_again_from_another_upload_of_it_is_still_sent_as_an_asset(self):
        with probe():
            first = self.upload(MP4, mime='video/mp4', purpose='portrait')
            self.client.post('/api/portraits', {'uploads': [{**first, 'name': 'Clip'}]}, content_type='application/json')
            self.settle_uploads()
            old = ManagedPortraitAsset.objects.get()
            managed_pool._mark_deleting(old, 'expired', 1)
            managed_pool.janitor()
            self.add_video()        # the same clip added again: a new upload key and a new row
            self.settle_uploads()
        again = ManagedPortraitAsset.objects.get(status='ACTIVE')
        self.assertNotEqual(again.source_key, old.source_key)
        job = self.enqueue_with_clip(first)
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        self.assertEqual([part['video_url']['url'] for part in self.fake.seedance_payloads[-1]['content'] if part.get('type') == 'video_url'],
                         ['asset://' + again.byteplus_asset_id])

    def test_a_generation_with_a_clip_the_gallery_refused_fails_before_admission_without_a_charge(self):
        ref = self.upload(MP4, mime='video/mp4', purpose='portrait')
        self.client.post('/api/portraits', {'uploads': [{**ref, 'name': 'Clip'}]}, content_type='application/json')
        job = self.enqueue_with_clip(ref)       # attached while its card still said Preparing
        with probe(seconds=45.0):
            self.settle_uploads()
        row = self.run_worker(job)
        self.assertEqual(row.status, 'failed')
        self.assertIn('not charged', row.error)
        self.assertEqual(self.fake.seedance_payloads, [])

    def test_a_quota_error_while_registering_an_expired_clip_again_waits_and_a_later_pass_sends_it(self):
        with probe():
            ref = self.upload(MP4, mime='video/mp4', purpose='portrait')
            self.client.post('/api/portraits', {'uploads': [{**ref, 'name': 'Clip'}]}, content_type='application/json')
            self.settle_uploads()
        managed_pool._mark_deleting(ManagedPortraitAsset.objects.get(), 'expired', 1)
        managed_pool.janitor()
        self.fake.asset_capacity = 0
        job = self.enqueue_with_clip(ref)
        self.assertNotIn(self.run_worker(job, passes=3).status, ('succeeded', 'failed'))
        self.assertEqual(ManagedPortraitAsset.objects.filter(origin='reference', status='FAILED', error_code='QuotaSharedPoolExceeded').count(), 1)
        self.fake.asset_capacity = None
        ManagedPortraitPool.objects.update(last_quota_error_at=managed_pool.now_ms() - managed_pool.QUOTA_BACKOFF_MS - 1)
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        fresh = ManagedPortraitAsset.objects.get(status='ACTIVE')
        self.assertEqual([part['video_url']['url'] for part in self.fake.seedance_payloads[-1]['content'] if part.get('type') == 'video_url'],
                         ['asset://' + fresh.byteplus_asset_id])

    def expired_clip_job(self):
        """A job that references a Gallery clip whose asset expired, so the job registers it again."""
        with probe():
            ref = self.upload(MP4, mime='video/mp4', purpose='portrait')
            self.client.post('/api/portraits', {'uploads': [{**ref, 'name': 'Clip'}]}, content_type='application/json')
            self.settle_uploads()
        managed_pool._mark_deleting(ManagedPortraitAsset.objects.get(), 'expired', 1)
        managed_pool.janitor()
        return self.enqueue_with_clip(ref)

    def rewind(self, job, minutes, processing=False):
        """``minutes`` pass for the job's wait and, with ``processing``, for the asset it is registering."""
        ms = minutes * 60 * 1000
        ManagedPortraitWait.objects.filter(generation_id=job).update(started_at=F('started_at') - ms)
        if processing:
            asset = ManagedPortraitAsset.objects.get(status='PROCESSING')
            asset.receipt = {**asset.receipt, 'registered_at': asset.receipt['registered_at'] - ms}
            asset.save(update_fields=['receipt'])

    def test_a_slot_wait_then_slow_video_processing_each_count_only_against_their_own_limit(self):
        self.fake.asset_capacity, self.fake.asset_activation_polls = 0, 2
        job = self.expired_clip_job()
        self.run_worker(job, passes=2)
        self.rewind(job, 4)                                 # 4 minutes waiting for a slot
        self.fake.asset_capacity = None
        ManagedPortraitPool.objects.update(last_quota_error_at=managed_pool.now_ms() - managed_pool.QUOTA_BACKOFF_MS - 1)
        self.assertEqual(self.run_worker(job, passes=1).status, 'queued')
        self.rewind(job, 12, processing=True)              # then 12 minutes of BytePlus processing the clip
        row = self.run_worker(job)
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertEqual(len(self.fake.seedance_payloads), 1)

    def test_a_clip_still_processing_past_its_limit_fails_saying_so_without_a_charge(self):
        self.fake.asset_activation_polls = 5
        job = self.expired_clip_job()
        self.assertEqual(self.run_worker(job, passes=1).status, 'queued')
        self.rewind(job, 16, processing=True)
        row = self.run_worker(job, passes=1)
        self.assertEqual((row.status, row.error), ('failed', managed_pool.PORTRAIT_STILL_PROCESSING))
        self.assertEqual(self.fake.seedance_payloads, [])
