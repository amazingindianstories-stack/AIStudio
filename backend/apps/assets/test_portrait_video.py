"""Gallery video portraits: the documented video limits, registration as a BytePlus Video asset, delete and consumer guards."""
import json
from unittest.mock import patch

from django.test import SimpleTestCase

from apps.generation.references import resolve_submission_references
from apps.media.uploads import UploadError

from . import managed_pool, video_limits
from .models import ManagedPortraitAsset, ReferenceFaceScan
from .test_portrait_gallery import GalleryBase, landscape, session_fixtures

GOOD = {'containers': ['mov', 'mp4', 'm4a'], 'width': 1080, 'height': 1920, 'seconds': 8.0, 'fps': 30.0}
MP4 = b'\x00\x00\x00\x18ftypmp42' + b'0' * 64


def probe(**changes):
    return patch.object(video_limits, 'probe_stored', return_value={**GOOD, **changes})


class VideoLimitsTests(SimpleTestCase):
    def test_a_clip_inside_every_documented_limit_passes(self):
        self.assertIsNone(video_limits.problem(GOOD, 10 * 1024 * 1024))

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
        self.assertEqual(video_limits.problem(GOOD, 201 * 1024 * 1024)[0], 'PORTRAIT_TOO_LARGE')
        self.assertEqual(video_limits.problem(None)[0], 'PORTRAIT_VIDEO_UNREADABLE')

    def test_boundaries_are_inclusive(self):
        self.assertIsNone(video_limits.problem({**GOOD, 'seconds': 2, 'fps': 24, 'width': 640, 'height': 640}))
        self.assertIsNone(video_limits.problem({**GOOD, 'seconds': 30, 'fps': 60}))
        self.assertIsNone(video_limits.problem(GOOD, 200 * 1024 * 1024))

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

    def test_a_video_upload_is_queued_as_a_video_portrait_with_a_poster(self):
        with probe():
            result = self.add_video()
        self.assertTrue(result['ok'], result)
        item = result['portrait']
        self.assertEqual(item['kind'], 'video')
        self.assertIsNone(item['imageUrl'])
        self.assertTrue(item['videoUrl'].startswith('/api/media/uploads/portrait/'))
        self.assertEqual(item['posterUrl'], '/api/media/thumbs/poster/' + item['videoUrl'][len('/api/media/'):] + '.webp')
        self.assertEqual(ManagedPortraitAsset.objects.get().media_kind, 'video')
        self.assertFalse(ReferenceFaceScan.objects.exists(), 'a video is never scanned as an image')
        self.assertEqual(self.fake.calls, [])

    def test_the_poster_is_requested_for_the_extensionless_upload_key(self):
        with probe(), patch('apps.assets.managed_views.bounded_poster') as make:
            self.add_video()
        self.assertEqual(make.call_count, 1)
        self.assertTrue(make.call_args.kwargs['video'])
        self.assertTrue(make.call_args.args[1].startswith('uploads/portrait/'))

    def test_images_still_report_the_image_kind(self):
        item = self.add(landscape(1))['results'][0]['portrait']
        self.assertEqual((item['kind'], item['videoUrl'], item['posterUrl']), ('image', None, None))

    def test_a_clip_that_breaks_a_limit_is_refused_with_its_message_and_nothing_is_queued(self):
        for change, code in (({'seconds': 45.0}, 'PORTRAIT_VIDEO_DURATION'), ({'fps': 120.0}, 'PORTRAIT_VIDEO_FPS'),
                             ({'width': 100, 'height': 100}, 'PORTRAIT_VIDEO_SIZE'), ({'containers': ['webm']}, 'PORTRAIT_VIDEO_FORMAT')):
            with probe(**change):
                result = self.add_video()
            self.assertEqual((result['ok'], result['error']), (False, code))
            self.assertTrue(result['message'])
        with patch.object(video_limits, 'probe_stored', return_value=None):
            self.assertEqual(self.add_video()['error'], 'PORTRAIT_VIDEO_UNREADABLE')
        with probe():
            self.assertEqual(self.add_video(size=201 * 1024 * 1024)['error'], 'PORTRAIT_TOO_LARGE')
        self.assertFalse(ManagedPortraitAsset.objects.exists())

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
        with probe():
            ref = self.upload(MP4, mime='video/mp4', purpose='portrait')
        image = self.upload(b'\x89PNG' + b'0' * 32, mime='image/png', purpose='portrait')
        videos = resolve_submission_references({'referenceVideos': [ref]}, session_fixtures.UID)
        self.assertTrue(videos['referenceVideos'][0].startswith('/api/media/uploads/portrait/'))
        for field in ('referenceImages', 'firstFrame', 'lastFrame', 'continuationFrame', 'image'):
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
