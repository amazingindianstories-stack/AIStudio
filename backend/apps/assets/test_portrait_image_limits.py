"""Image bounds (300-6000 px, ratio 0.4-2.5, 30 MB): Gallery uploads, Seedance enqueue, the worker and the pool's safety net."""
import base64
import io
from unittest.mock import patch

from PIL import Image

from apps.generation.models import Generation
from apps.generation.services import enqueue, video_execution

from . import managed_pool
from .test_portrait_gallery import GalleryBase, landscape


def png(width, height, color=(40, 120, 180)):
    out = io.BytesIO()
    Image.new('RGB', (width, height), color).save(out, format='PNG')
    return out.getvalue()


def data_url(data):
    return 'data:image/png;base64,' + base64.b64encode(data).decode()


class GalleryUploadLimits(GalleryBase):
    def test_sides_and_ratio_are_refused_per_item_and_a_good_image_still_registers(self):
        result = self.add(png(240, 180), png(7000, 700), png(1000, 300), landscape())['results']
        self.assertEqual([item.get('error') for item in result], ['PORTRAIT_IMAGE_SIZE', 'PORTRAIT_IMAGE_SIZE', 'PORTRAIT_IMAGE_RATIO', None])
        self.assertEqual(result[0]['message'], 'This image is 240 x 180 px. Portraits need at least 300 px and at most 6000 px on each side.')
        self.assertIn('7000 x 700 px', result[1]['message'])
        self.assertEqual(result[2]['message'], 'This image is 1000 x 300 px. Portraits need a width to height ratio between 0.4 and 2.5, so not too wide or too tall.')
        self.assertTrue(result[3]['ok'])

    def test_the_bounds_are_inclusive(self):
        result = self.add(png(300, 300), png(6000, 2400), png(300, 750), png(299, 300))['results']
        self.assertEqual([item['ok'] for item in result], [True, True, True, False])


class SeedanceReferenceLimits(GalleryBase):
    def post(self, refs, **extra):
        payload = {'prompt': 'a slow pan across a candle-lit hall @img1', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True,
                   'duration': 5, 'referenceImages': refs, **extra}
        return self.client.post('/api/generate/video', payload, content_type='application/json')

    def test_a_small_or_extreme_reference_is_refused_and_nothing_is_queued(self):
        for image, size in ((png(200, 900), '200 x 900'), (png(1000, 300), '1000 x 300'), (png(299, 400), '299 x 400')):
            response = self.post([data_url(landscape()), data_url(image)], prompt='@img2 and @img1')
            self.assertEqual(response.status_code, 400, response.content)
            body = response.json()
            self.assertEqual(body['code'], 'REFERENCE_IMAGE_SIZE')
            self.assertEqual(body['referenceIndex'], 2)
            self.assertTrue(body['error'].startswith(f'@img2 is {size} px. Seedance needs at least 300 px'), body['error'])
            self.assertTrue(body['error'].endswith('nothing was queued.'))
        self.assertFalse(Generation.objects.exists())

    def test_frames_are_checked_and_named(self):
        response = self.post([], firstFrame=data_url(png(100, 100)))
        self.assertEqual((response.status_code, response.json()['code']), (400, 'REFERENCE_IMAGE_SIZE'))
        self.assertTrue(response.json()['error'].startswith('The first frame is 100 x 100 px.'))

    def test_a_large_reference_is_not_an_error_and_is_downscaled_for_the_provider(self):
        big = png(7000, 3000)
        self.assertEqual(self.post([data_url(big)]).status_code, 200)
        from apps.generation.prompting.image_prep import prep_reference
        prepared = prep_reference('image/png', base64.b64encode(big).decode())
        with Image.open(io.BytesIO(base64.b64decode(prepared['data']))) as image:
            self.assertEqual(max(image.size), 2048)
        self.assertLess(len(base64.b64decode(prepared['data'])), 30 * 1024 * 1024)

    def test_other_models_and_the_time_budget_are_left_alone(self):
        small = data_url(png(100, 100))
        item = {'model': 'Gemini Omni Flash', 'prompt': '@img1'}
        enqueue.verify_reference_image_sizes(item, {'referenceImages': [small]})
        ticks = iter(range(0, 1000, 20))
        enqueue.verify_reference_image_sizes({'model': 'Seedance 2.5', 'prompt': '@img1'}, {'referenceImages': [small]},
                                             budget_seconds=8, clock=lambda: next(ticks))      # out of budget at the first image

    def test_the_worker_refuses_what_enqueue_could_not_check_before_any_paid_call(self):
        with patch.object(enqueue, 'verify_reference_image_sizes', lambda *args, **kwargs: None):
            response = self.post([data_url(png(200, 900))])
        self.assertEqual(response.status_code, 200, response.content)
        row = self.run_worker(response.json()['id'])
        self.assertEqual(row.status, 'failed')
        self.assertTrue(row.error.startswith('@img1 is 200 x 900 px.'), row.error)
        self.assertTrue(row.error.endswith('nothing was sent to the provider, so this was not charged.'))
        self.assertFalse([call for call in self.fake.calls if 'video' in call[1] or 'contents/generations' in call[1]])
        from apps.generation.serialization import generation_item
        self.assertEqual(generation_item(row)['error'], row.error)

    def test_worker_check_names_catalog_and_frame_references(self):
        item = type('Row', (), {'continuation_frame_url': 'f', 'last_frame_url': None})()
        sizes = {'a': (800, 600), 'f': (500, 100)}
        with self.assertRaisesRegex(video_execution.ReferenceImageRejected, r'^The first frame is 500 x 100 px\.'):
            video_execution.verify_reference_image_sizes(item, [{'tag': '@hero', 'imageUrl': 'a'}], measure=sizes.get)
        video_execution.verify_reference_image_sizes(type('Row', (), {'continuation_frame_url': None, 'last_frame_url': None})(),
                                                     [{'tag': '@hero', 'imageUrl': 'a'}], measure=sizes.get)


class PoolSafetyNet(GalleryBase):
    def test_bounded_copy_still_pads_ratio_shrinks_big_and_leaves_good_images_alone(self):
        self.assertIsNone(managed_pool.bounded_copy(png(640, 400)))
        for width, height in ((2000, 300), (300, 2000), (9000, 3000), (200, 200)):
            with self.subTest(size=(width, height)):
                derived = managed_pool.bounded_copy(png(width, height))
                with Image.open(io.BytesIO(derived)) as image:
                    self.assertGreaterEqual(min(image.size), managed_pool.MIN_SIDE)
                    self.assertLessEqual(max(image.size), managed_pool.MAX_SIDE)
                    self.assertTrue(managed_pool.MIN_RATIO <= image.width / image.height <= managed_pool.MAX_RATIO)
