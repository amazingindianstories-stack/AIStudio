"""Goal 2 application parser contract, separate from inert Node parity goldens."""
from types import SimpleNamespace
from unittest.mock import Mock
from uuid import uuid4

from django.test import SimpleTestCase

from apps.generation.prompting.assembler import assemble_prompt
from apps.generation.providers.seedream import resolve_seedream_references
from apps.generation.references import mention_indices, reference_warnings
from apps.generation.services import video_execution
from apps.generation.services.deadline import Cancellation
from apps.generation.services.upscale_validation import inspect_image, validate_output_area, InvalidUpscaleRequest


class Goal2ReferenceContractTests(SimpleTestCase):
    def test_typos_remain_literal_without_wrong_binding(self):
        for token in ('@img0', '@imgg1', '@img99', '@img 1', '@img02', '@img2x', '@img'):
            for uploads in ([], ['first', 'second']):
                with self.subTest(token=token, uploads=uploads):
                    result = resolve_seedream_references('Literal ' + token, [], uploads)
                    self.assertIn('Literal ' + token, result['prompt'])
                    self.assertTrue(result['warnings'])
                    self.assertEqual(result['references'], uploads)

    def test_canonical_tokens_have_whole_boundaries_and_case(self):
        prompt = '@img1 @img10 @IMG2 @img02 @img2x @img1_suffix'
        self.assertEqual(mention_indices(prompt), [1, 2, 10])
        result = resolve_seedream_references(prompt, [], ['one', 'two'])
        self.assertIn('image 1 @img10 image 2 @img02 @img2x @img1_suffix', result['prompt'])
        self.assertEqual(result['references'], ['one', 'two'])

    def test_named_material_collision_keeps_explicit_identity(self):
        asset = {'slug': 'img-character', 'kind': 'character', 'name': 'Actor', 'images': ['named']}
        result = resolve_seedream_references('@img-character @img1', [asset], ['upload'])
        self.assertEqual(result['references'], ['named', 'upload'])
        self.assertEqual(reference_warnings('@img-character', [], [asset]), [])
        with self.assertRaisesRegex(ValueError, 'Missing reference @missing'):
            resolve_seedream_references('@missing', [], [])

    def test_provider_image_limit_still_enforced_for_fifty_staged(self):
        with self.assertRaisesRegex(ValueError, 'at most 10'):
            resolve_seedream_references('Literal @img', [], ['source'] * 50)
        self.assertEqual(resolve_seedream_references('@img50', [], [str(n) for n in range(50)])['references'], ['49'])

    def test_catalog_upload_overlap_does_not_shift_numeric_identity(self):
        assets = [{'slug': 'hero', 'kind': 'character', 'name': 'Hero', 'images': ['shared']}]
        refs = video_execution.combined_references('@img2', assets, ['shared', 'second'])
        self.assertEqual([(ref['tag'], ref['imageUrl']) for ref in refs], [('@img2', 'second')])
        refs = video_execution.combined_references('@img2 @img1', assets, ['shared', 'shared'])
        self.assertEqual([ref['tag'] for ref in refs], ['@img1', '@img2'])

    def test_video_audio_remap_preserves_malformed_and_other_namespaces(self):
        result = video_execution.remap_media_tags('@vid3 @vid3x @audio2 @audio02 @img10 @slug', ['v1', 'v2', 'v3'], ['a1', 'a2'])
        self.assertEqual(result, '@vid1 @vid3x @audio1 @audio02 @img10 @slug')

    def test_unreadable_actual_reference_fails_before_paid_work(self):
        with self.assertRaisesRegex(ValueError, 'could not be read'):
            assemble_prompt('scene', [], ['missing'], read_image=Mock(side_effect=OSError('private key')), env={})

    def test_magnific_video_bytes_cannot_be_used_as_image(self):
        import base64
        for mime in ('video/quicktime', 'image/png'):
            with self.assertRaises(InvalidUpscaleRequest):
                inspect_image(base64.b64encode(b'\0\0\0\x18ftypqt  video').decode(), mime)

    def test_documented_creative_output_area_rejected_without_quality_change(self):
        validate_output_area('Magnific Creative', {'scaleFactor': '2x'}, {'width': 2500, 'height': 2500})
        with self.assertRaisesRegex(InvalidUpscaleRequest, '25.3 megapixels'):
            validate_output_area('Magnific Creative', {'scaleFactor': '4x'}, {'width': 2500, 'height': 2500})

    def test_each_final_uses_its_own_draft_receipt_without_reassembly(self):
        submitted, receipts = [], []
        deps = video_execution.Dependencies()
        deps.seedance_final = lambda value, **kwargs: submitted.append(value) or 'final-' + value['draftTaskId']
        deps.assets = Mock(side_effect=AssertionError('final must not rebuild source'))
        for draft in ('draft-red', 'draft-green', 'draft-blue'):
            item = SimpleNamespace(id=uuid4(), model='Seedance 2.5', task_id=None, draft_task_id=draft)
            result = video_execution.submit_video(item, signal=Cancellation(), on_task=lambda *value: receipts.append(value), dependencies=deps, env={})
            self.assertEqual(result['task_id'], 'final-' + draft)
        self.assertEqual([value['draftTaskId'] for value in submitted], ['draft-red', 'draft-green', 'draft-blue'])
        self.assertEqual(len({value[0] for value in receipts}), 3)
