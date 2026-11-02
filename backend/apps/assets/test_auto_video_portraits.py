"""Automatic video portraits: a reference video with a face is registered as a BytePlus Video asset and sent as asset://,
like a face image, and appears in the Portrait Gallery while its asset is live."""
import hashlib
import shutil
import subprocess
import tempfile
from pathlib import Path
from unittest.mock import patch

from apps.admin_dashboard.models import AppSetting
from apps.generation.models import Generation
from apps.generation.services import executor, portrait_prepare
from apps.media import posters

from . import managed_pool
from .models import ManagedPortraitAsset, ReferenceFaceScan
from .test_portrait_gallery import FACE, GalleryBase


def make_clip(directory, name, *, face=True, seconds=3, fps=30, width=720, height=960):
    """A real MP4: the public-domain face photo (or a plain colour) held for ``seconds`` seconds."""
    path = Path(directory) / name
    size = f'scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2,format=yuv420p'
    if face:
        photo = Path(directory) / (name + '.jpg')
        photo.write_bytes(FACE)
        source = ['-loop', '1', '-i', str(photo)]
    else:
        source = ['-f', 'lavfi', '-i', f'color=c=0x2060a0:s={width}x{height}']
    subprocess.run([shutil.which('ffmpeg') or 'ffmpeg', '-nostdin', '-loglevel', 'error', *source, '-t', str(seconds), '-r', str(fps),
                    '-vf', size, '-c:v', 'libx264', '-y', str(path)], check=True)
    return path.read_bytes()


class AutoVideoBase(GalleryBase):
    def setUp(self):
        super().setUp()
        self.directory = tempfile.mkdtemp(prefix='veevee-clips-')
        self.addCleanup(shutil.rmtree, self.directory, True)
        self.files = {}
        stack = patch.object(posters, '_source', side_effect=self.source)
        stack.start()
        self.addCleanup(stack.stop)

    def source(self, storage, key):
        """ffmpeg and ffprobe read the clip from a local file (the in-memory test storage has no URL to give them)."""
        path = self.files.get(key)
        return (str(path), 'file') if path else (None, None)

    def reference_clip(self, data, purpose='video-reference'):
        """Upload ``data`` as a finalized video reference; returns the referenceId payload."""
        ref = self.upload(data, mime='video/mp4', purpose=purpose)
        from apps.media.models import UploadSession
        key = UploadSession.objects.get(pk=ref['referenceId']).key
        path = Path(self.directory) / key.replace('/', '_')
        path.write_bytes(data)
        self.files[key] = path
        return ref

    def enqueue_video(self, clip):
        payload = {'prompt': 'the person from @vid1 walks into a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True,
                   'duration': 5, 'referenceVideos': [clip]}
        response = self.client.post('/api/generate/video', payload, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()['id']

    def sent_videos(self, index=-1):
        return [part['video_url']['url'] for part in self.fake.seedance_payloads[index]['content'] if part.get('type') == 'video_url']


class AutoVideoPortraitTests(AutoVideoBase):
    def test_a_face_image_reference_is_a_gallery_portrait_and_goes_as_its_asset(self):
        job = self.enqueue([self.upload(FACE, 'image/jpeg')])
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(self.submitted_refs(), ['asset://' + asset.byteplus_asset_id])
        self.assertEqual([(card['kind'], card['state']) for card in self.listing()['portraits']], [('image', 'ready')])

    def test_a_reference_video_with_a_face_goes_as_its_asset_and_is_a_gallery_portrait(self):
        clip = self.reference_clip(make_clip(self.directory, 'face.mp4'))
        job = self.enqueue_video(clip)
        row = self.run_worker(job)
        self.assertEqual(row.status, 'succeeded', row.error)
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(self.sent_videos(), ['asset://' + asset.byteplus_asset_id])
        self.assertEqual([item['AssetType'] for item in self.fake.assets.values()], ['Video'])
        cards = self.listing()['portraits']
        self.assertEqual([(card['kind'], card['state'], card['origin']) for card in cards], [('video', 'ready', 'reference')])

    def test_the_automatic_video_portrait_looks_like_an_automatic_image_portrait_in_the_gallery(self):
        self.run_worker(self.enqueue_video(self.reference_clip(make_clip(self.directory, 'face.mp4'))))
        card = self.listing()['portraits'][0]
        self.assertEqual((card['kind'], card['origin'], card['state'], card['message']), ('video', 'reference', 'ready', None))
        self.assertTrue(card['videoUrl'].startswith('/api/media/uploads/video-reference/'))
        self.assertTrue(card['posterUrl'].startswith('/api/media/thumbs/poster/uploads/video-reference/'))
        self.assertTrue(self.storage.exists(card['posterUrl'].removeprefix('/api/media/')), 'the card has its picture')
        self.assertTrue(card['name'].startswith('Face from '))

    def test_a_clip_with_no_face_goes_as_a_url_and_is_not_in_the_gallery(self):
        row = self.run_worker(self.enqueue_video(self.reference_clip(make_clip(self.directory, 'plain.mp4', face=False))))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertFalse(self.sent_videos()[0].startswith('asset://'))
        self.assertEqual((ManagedPortraitAsset.objects.count(), self.fake.assets, self.listing()['portraits']), (0, {}, []))

    def test_a_clip_outside_the_video_limits_goes_as_a_url_without_a_failed_job_or_a_registration(self):
        too_short = make_clip(self.directory, 'short.mp4', seconds=1)
        row = self.run_worker(self.enqueue_video(self.reference_clip(too_short)))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertFalse(self.sent_videos()[0].startswith('asset://'))
        self.assertEqual((ManagedPortraitAsset.objects.count(), self.fake.assets, self.listing()['portraits']), (0, {}, []))
        self.assertEqual(len(self.fake.seedance_payloads), 1, 'one submission, nothing extra')

    def test_identical_clips_share_one_asset_even_when_added_to_the_gallery_first(self):
        data = make_clip(self.directory, 'face.mp4')
        first = self.run_worker(self.enqueue_video(self.reference_clip(data)))
        second = self.run_worker(self.enqueue_video(self.reference_clip(data)))
        self.assertEqual((first.status, second.status), ('succeeded', 'succeeded'))
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(self.sent_videos(0), self.sent_videos(1))
        self.assertEqual(self.sent_videos(1), ['asset://' + asset.byteplus_asset_id])
        self.assertEqual(len(self.fake.assets), 1)
        # The same bytes added by hand to the Gallery are that asset too.
        again = self.reference_clip(data, purpose='portrait')
        result = self.client.post('/api/portraits', {'uploads': [{**again, 'name': 'Mine'}]}, content_type='application/json').json()['results'][0]
        self.assertEqual((result['existing'], result['portrait']['id']), (True, str(asset.id)))

    def test_a_gallery_clip_added_by_hand_is_used_for_the_same_clip_as_a_prompt_reference(self):
        data = make_clip(self.directory, 'face.mp4')
        hand = self.reference_clip(data, purpose='portrait')
        self.client.post('/api/portraits', {'uploads': [{**hand, 'name': 'Mine'}]}, content_type='application/json')
        self.settle_uploads()
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual(asset.origin, 'upload')
        row = self.run_worker(self.enqueue_video(self.reference_clip(data)))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertEqual(self.sent_videos(), ['asset://' + asset.byteplus_asset_id])
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)

    def test_the_face_scan_is_cached_by_content(self):
        from . import face_detect
        data = make_clip(self.directory, 'plain.mp4', face=False)
        with patch.object(face_detect, 'scan', wraps=face_detect.scan) as scan:
            self.run_worker(self.enqueue_video(self.reference_clip(data)))
            frames = scan.call_count
            self.run_worker(self.enqueue_video(self.reference_clip(data)))        # another upload of the same bytes
            self.assertEqual((frames, scan.call_count), (5, 5), 'five sampled frames the first time, none the second')
        sha = ReferenceFaceScan.objects.get().content_sha256
        self.assertEqual(sha, hashlib.sha256(data).hexdigest())

    def test_a_detector_or_frame_failure_fails_closed_to_a_face(self):
        from . import face_detect, video_faces
        data = make_clip(self.directory, 'plain.mp4', face=False)
        with patch.object(face_detect, 'scan', return_value={'has_face': True, 'faces': 0, 'error': 'RuntimeError'}):
            self.assertEqual(self.run_worker(self.enqueue_video(self.reference_clip(data))).status, 'succeeded')
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)
        self.assertEqual(ReferenceFaceScan.objects.get().error, 'RuntimeError', 'an error is not a final answer')
        ManagedPortraitAsset.objects.all().delete()
        ReferenceFaceScan.objects.all().delete()
        with patch.object(video_faces, '_frame', side_effect=ValueError('no frame')):
            self.assertEqual(self.run_worker(self.enqueue_video(self.reference_clip(data))).status, 'succeeded')
        self.assertEqual(ManagedPortraitAsset.objects.count(), 1)

    def test_a_clip_the_asset_service_refuses_goes_as_a_url_and_is_not_asked_again(self):
        data = make_clip(self.directory, 'face.mp4')
        original, creates = self.fake.asset_api, []

        def refuse(action, body):
            if action == 'CreateAsset':
                creates.append(body)
                return 400, {'ResponseMetadata': {'Error': {'Code': 'InvalidParameter', 'Message': 'bad video'}}}
            return original(action, body)
        with patch.object(self.fake, 'asset_api', refuse):
            row = self.run_worker(self.enqueue_video(self.reference_clip(data)))
            self.assertEqual(row.status, 'succeeded', row.error)
            self.assertFalse(self.sent_videos()[0].startswith('asset://'))
            self.assertEqual(ReferenceFaceScan.objects.get().forced, managed_pool.REFUSED)
            self.assertEqual((self.listing()['portraits'], len(creates)), ([], 1))
            self.assertEqual(self.run_worker(self.enqueue_video(self.reference_clip(data))).status, 'succeeded')
            self.assertEqual(len(creates), 1, 'not asked again')

    def test_a_full_pool_makes_the_job_wait_for_portrait_space_without_a_charge(self):
        AppSetting.objects.create(key='portraitPoolCapacity', value='1', updated_at=0)
        holder = self.enqueue([self.upload(FACE, 'image/jpeg')])
        executor.process_generation(holder, heartbeat=False)
        self.assertEqual(self.fake.live_asset_count(), 1)
        job = self.enqueue_video(self.reference_clip(make_clip(self.directory, 'face.mp4')))
        executor.process_generation(job, heartbeat=False)
        row = Generation.objects.get(pk=job)
        self.assertEqual((row.status, row.provider_status), ('queued', portrait_prepare.WAITING_STATUS))
        self.assertEqual(self.fake.seedance_payloads, [], 'nothing was submitted, so nothing was charged')

    def test_a_busy_frame_extractor_makes_the_job_look_again_shortly_instead_of_guessing(self):
        data = make_clip(self.directory, 'face.mp4')
        job = self.enqueue_video(self.reference_clip(data))
        posters._GATE.acquire()
        try:
            with patch.object(posters, 'DEADLINE_SECONDS', 0):
                executor.process_generation(job, heartbeat=False)
        finally:
            posters._GATE.release()
        row = Generation.objects.get(pk=job)
        self.assertEqual((row.status, ManagedPortraitAsset.objects.count(), self.fake.seedance_payloads), ('queued', 0, []))
        self.assertEqual(self.run_worker(job).status, 'succeeded')
        self.assertEqual(self.sent_videos(), ['asset://' + ManagedPortraitAsset.objects.get().byteplus_asset_id])

    def test_a_clip_over_the_asset_size_limit_goes_as_a_url_without_a_scan_or_a_registration(self):
        from apps.media.models import UploadSession
        from . import video_limits
        clip = self.reference_clip(make_clip(self.directory, 'face.mp4'))
        UploadSession.objects.filter(pk=clip['referenceId']).update(byte_size=video_limits.MAX_BYTES + 1)
        row = self.run_worker(self.enqueue_video(clip))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertFalse(self.sent_videos()[0].startswith('asset://'))
        self.assertEqual((ManagedPortraitAsset.objects.count(), ReferenceFaceScan.objects.count(), self.fake.assets), (0, 0, {}))

    def test_a_clip_the_asset_service_fails_while_processing_goes_as_a_url_and_is_not_asked_again(self):
        data = make_clip(self.directory, 'face.mp4')
        original, creates = self.fake.asset_api, []

        def fail(action, body):
            if action == 'CreateAsset':
                creates.append(body)
            if action == 'GetAsset' and body.get('Id') in self.fake.assets:
                self.fake.assets[body['Id']]['Status'] = 'Failed'
            return original(action, body)
        with patch.object(self.fake, 'asset_api', fail):
            row = self.run_worker(self.enqueue_video(self.reference_clip(data)))
            self.assertEqual(row.status, 'succeeded', row.error)
            self.assertFalse(self.sent_videos()[0].startswith('asset://'))
            self.assertEqual(ReferenceFaceScan.objects.get().forced, managed_pool.REFUSED)
            self.assertEqual(ManagedPortraitAsset.objects.get().status, 'DELETED', 'the failed clip frees its slot at once')
            self.assertEqual([item['Status'] for item in self.fake.assets.values()], ['Deleted'])
            self.assertEqual(self.run_worker(self.enqueue_video(self.reference_clip(data))).status, 'succeeded')
            self.assertFalse(self.sent_videos()[0].startswith('asset://'))
            self.assertEqual(len(creates), 1, 'not asked again')

    def test_a_card_picture_that_could_not_be_made_is_made_on_the_next_use_of_the_clip(self):
        data = make_clip(self.directory, 'face.mp4')
        with patch.object(posters, 'bounded_poster', return_value=None):
            self.assertEqual(self.run_worker(self.enqueue_video(self.reference_clip(data))).status, 'succeeded')
        poster = self.listing()['portraits'][0]['posterUrl'].removeprefix('/api/media/')
        self.assertFalse(self.storage.exists(poster))
        self.assertEqual(self.run_worker(self.enqueue_video(self.reference_clip(data))).status, 'succeeded')
        self.assertTrue(self.storage.exists(poster), 'the card has its picture')

    def test_a_clip_already_refused_by_another_poller_still_goes_as_a_url(self):
        data = make_clip(self.directory, 'face.mp4')
        original = self.fake.asset_api

        def fail(action, body):
            if action == 'GetAsset' and body.get('Id') in self.fake.assets:
                self.fake.assets[body['Id']]['Status'] = 'Failed'
                ReferenceFaceScan.objects.update(has_face=False, forced=managed_pool.REFUSED)      # the janitor or another job saw it first
            return original(action, body)
        with patch.object(self.fake, 'asset_api', fail):
            row = self.run_worker(self.enqueue_video(self.reference_clip(data)))
        self.assertEqual(row.status, 'succeeded', row.error)
        self.assertFalse(self.sent_videos()[0].startswith('asset://'))
