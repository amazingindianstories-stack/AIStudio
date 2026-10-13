import base64
import io
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from django.test import SimpleTestCase
from PIL import Image

from apps.generation.services.image_execution import Dependencies, execute_image, bounded_best_of
from apps.generation.services.deadline import Cancellation, QueueExecutionDeadlineError
from apps.media.storage import MemoryAdapter, StorageService


def png(color='red', size=(400, 300)):
    buffer = io.BytesIO()
    Image.new('RGB', size, color).save(buffer, format='PNG')
    return buffer.getvalue()


class Signal:
    def __init__(self):
        self.cancelled = False
        self.waits = []
    def check(self):
        if self.cancelled:
            raise QueueExecutionDeadlineError()
    def wait(self, ms):
        self.check()
        self.waits.append(ms)


class ImageExecutionTests(SimpleTestCase):
    def setUp(self):
        self.item = SimpleNamespace(id='fixture', model='Nano Banana Pro', prompt='Original prompt',
            aspect_ratio='1:1', resolution='2K', reference_images=[], seed=10, draft_task_id=None,
            cost_cents=5, cost_basis='estimated', project_id=None, user_id=None, task_id=None)
        self.signal = Signal()
        self.adapter = MemoryAdapter()
        self.storage = StorageService(self.adapter)
        self.deps = Dependencies()
        self.deps.assets, self.deps.pricing = [], []
        self.deps.storage = lambda: self.storage
        self.deps.assemble = Mock(return_value={'instruction': 'Original prompt', 'groups': []})
        self.deps.gemini_generate = Mock(return_value={'mimeType': 'image/png', 'base64': base64.b64encode(png()).decode()})
        self.deps.now = lambda: 1234
        self.deps.random_seed = lambda: 42
        self.env = {}

    def execute(self, **options):
        return execute_image(self.item, signal=self.signal, dependencies=self.deps, env=self.env, **options)

    def stored(self, ext='png'):
        keys = [key for key in self.adapter.objects if key.startswith('generations/fixture/') and key.endswith('.' + ext)]
        return self.storage.read(keys[-1])

    def face(self):
        self.deps.assemble.return_value['judgeFace'] = {'mimeType': 'image/png', 'data': 'face'}

    def test_single_original_bytes_ratio_seed_and_no_item_mutation(self):
        original = vars(self.item).copy()
        result = self.execute()
        self.assertEqual(self.stored(), png())
        self.assertEqual(result['aspect_ratio'], '4:3')
        self.assertEqual(result['cost_cents'], 5)
        self.assertEqual(result['updated_at'], 1234)
        self.assertEqual(vars(self.item), original)
        self.assertIsNone(result['judge_score'])

    def test_generated_seed_and_resolution_alias(self):
        self.item.seed, self.item.resolution = None, '1080p'
        self.assertEqual(self.execute()['seed'], 42)
        self.assertEqual(self.deps.gemini_generate.call_args.args[0]['imageSize'], '2K')

    def test_bounded_bestof_and_defaults(self):
        self.assertEqual([bounded_best_of('20', size) for size in ('1K', '2K', '4K')], [4, 3, 2])
        self.assertEqual(bounded_best_of(None, '1K'), 2)
        self.assertEqual(bounded_best_of('bad', '1K'), 2)
        self.assertEqual(bounded_best_of('1.5', '1K'), 2)
        self.assertEqual(bounded_best_of('-2', '1K'), 1)

    def test_bestof_partial_failure_bills_successes_selects_identity_and_cleans_disk(self):
        self.face()
        self.env['FACE_BEST_OF'] = '4'
        blue = png('blue')
        self.deps.gemini_generate.side_effect = [self.deps.gemini_generate.return_value,
            ValueError('transient'), {'mimeType':'image/png','base64':base64.b64encode(blue).decode()}]
        self.deps.judge_identity = Mock(side_effect=[20, 81])
        directories = []
        def directory(**kwargs):
            temp = tempfile.TemporaryDirectory(**kwargs)
            directories.append(temp.name)
            return temp
        self.deps.temporary_directory = directory
        result = self.execute()
        self.assertEqual(self.stored(), blue)
        self.assertEqual(result['cost_cents'], 10)
        self.assertEqual(result['judge_score'], {'identity':81})
        self.assertEqual([call.args[0]['seed'] for call in self.deps.gemini_generate.call_args_list], [10,11,12])
        self.assertTrue(all(not Path(path).exists() for path in directories))

    def test_composite_identity_floor_and_failopen_tie(self):
        self.face()
        self.env.update(FACE_BEST_OF='3', JUDGE_COMPOSITE='1')
        self.deps.judge_candidate = Mock(side_effect=[{'identity':90,'prominence':10,'sharpness':10},
            {'identity':83,'prominence':80,'sharpness':80}, {'identity':81,'prominence':100,'sharpness':100}])
        self.assertEqual(self.execute()['judge_score']['identity'], 83)
        self.deps.judge_candidate.side_effect = [None, None, None]
        self.assertIsNone(self.execute()['judge_score'])

    def test_all_candidates_fail_no_master_and_original_error(self):
        self.face()
        self.deps.gemini_generate.side_effect = ValueError('all failed')
        with self.assertRaisesMessage(ValueError, 'all failed'):
            self.execute()
        self.assertFalse(any(key.startswith('generations/fixture/') for key in self.adapter.objects))

    def test_cancel_after_provider_prevents_storage_and_cleans_spool(self):
        self.face()
        paths = []
        def directory(**kwargs):
            value = tempfile.TemporaryDirectory(**kwargs)
            paths.append(value.name)
            return value
        self.deps.temporary_directory = directory
        def cancelled(*args, **kwargs):
            self.signal.cancelled = True
            return self.deps.gemini_generate.return_value
        self.deps.gemini_generate.side_effect = cancelled
        with self.assertRaises(QueueExecutionDeadlineError):
            self.execute()
        self.assertFalse(any(key.startswith('generations/fixture/') for key in self.adapter.objects))
        self.assertTrue(all(not Path(path).exists() for path in paths))

    def test_crispen_flag_is_explicit_and_receives_selected_bytes(self):
        self.deps.crispen = Mock(return_value={'mimeType':'image/jpeg', 'data':base64.b64encode(b'original-jpeg-fixture').decode()})
        self.execute()
        self.deps.crispen.assert_not_called()
        self.env['POST_CRISPEN'] = '1'
        self.execute()
        self.assertEqual(self.stored('jpg'), b'original-jpeg-fixture')

    def test_seedream_original_reference_path_dimensions_and_price(self):
        self.item.model = 'Seedream 5.0 Pro'
        self.item.reference_images = ['stored-original']
        self.deps.seedream_resolve = Mock(return_value={'prompt':'image1 original','references':['stored-original']})
        self.deps.seedream_prepare = Mock(return_value={'urls':['signed-original'], 'stable':['original','two','three']})
        self.deps.seedream_generate = Mock(return_value=png(size=(2000,1600)))
        self.assertEqual(self.execute()['cost_cents'], 10)
        self.deps.assemble.assert_not_called()
        self.assertEqual(self.deps.seedream_generate.call_args.args[0]['references'], ['signed-original'])
        self.assertEqual(self.stored(), png(size=(2000,1600)))

    def test_seedream_requires_dimensions(self):
        self.item.model = 'Seedream 5.0 Pro'
        self.deps.seedream_resolve = Mock(return_value={'prompt':'x','references':[]})
        self.deps.seedream_prepare = Mock(return_value={'urls':[], 'stable':[]})
        self.deps.seedream_generate = Mock(return_value=b'corrupt')
        with self.assertRaisesMessage(ValueError, 'dimensions'):
            self.execute()

    def kling(self):
        self.item.model = 'Kling Image 3.0'
        self.deps.kling_build = Mock(return_value={'prompt':'rewritten'})
        self.deps.kling_submit = Mock(return_value='accepted')
        self.deps.kling_resolve = Mock(side_effect=[{'status':'running'}, {'status':'succeeded','url':'https://fixture','unitDeduction':'10'}])
        self.deps.fetcher = Mock(return_value=(png(), 'image/png'))

    def test_kling_receipt_precedes_poll_and_reconciles(self):
        self.kling()
        calls = []
        self.deps.kling_resolve.side_effect = lambda *args, **kwargs: (calls.append('poll') or {'status':'succeeded','url':'https://fixture','unitDeduction':'10'})
        result = self.execute(on_task=lambda task: calls.append(task))
        self.assertEqual(calls, ['accepted', 'poll'])
        self.assertEqual((result['cost_cents'], result['cost_basis']), (4, 'reconciled'))
        self.deps.fetcher.assert_called_once()

    def test_kling_resume_skips_submission_assembly_and_waits(self):
        self.kling()
        self.item.task_id = 'existing'
        callback = Mock()
        self.execute(on_task=callback)
        self.deps.kling_submit.assert_not_called()
        self.deps.assemble.assert_not_called()
        callback.assert_not_called()
        self.assertEqual(self.signal.waits, [3000])
        self.assertEqual(self.deps.kling_resolve.call_args.args[0], 'existing')

    def test_receipt_is_recorded_even_if_cancellation_races_submit(self):
        self.kling()
        def accepted(*args, **kwargs):
            self.signal.cancelled = True
            return 'accepted-before-cancel'
        self.deps.kling_submit.side_effect = accepted
        callback = Mock()
        with self.assertRaises(QueueExecutionDeadlineError):
            self.execute(on_task=callback)
        callback.assert_called_once_with('accepted-before-cancel')
        self.deps.kling_resolve.assert_not_called()

    def test_higgsfield_resume_uses_existing_id_and_native_bytes(self):
        self.item.model, self.item.task_id = 'Higgsfield Soul', 'existing'
        self.deps.higgsfield_submit = Mock()
        self.deps.higgsfield_await = Mock(return_value={'status':'succeeded','url':'https://fixture'})
        self.deps.fetcher = Mock(return_value=png())
        self.execute()
        self.deps.higgsfield_submit.assert_not_called()
        self.deps.assemble.assert_not_called()
        self.deps.higgsfield_await.assert_called_once_with('existing', signal=self.signal)
        self.assertEqual(self.stored(), png())

    def test_explicit_mock_skips_provider(self):
        self.env['MOCK_GENERATION'] = '1'
        self.deps.mock_placeholder = Mock(return_value='/api/media/mock.png')
        self.assertEqual(self.execute()['url'], '/api/media/mock.png')
        self.assertEqual(self.signal.waits, [700])
        self.deps.gemini_generate.assert_not_called()

    def test_higgsfield_upload_reference_count_and_quality(self):
        for model, count, field, value in [('Higgsfield Soul', 1, 'quality', '1.5k'),
                                         ('Higgsfield Nano Banana Pro', 2, 'resolution', '1k')]:
            with self.subTest(model=model):
                self.item.model, self.item.resolution = model, '1K'
                self.item.reference_images = ['data:image/png;base64,' + base64.b64encode(png()).decode()] * 2
                self.deps.higgsfield_upload = Mock(side_effect=['first', 'second'])
                self.deps.higgsfield_submit = Mock(return_value='submitted')
                self.deps.higgsfield_await = Mock(return_value={'status':'succeeded','url':'https://fixture'})
                self.deps.fetcher = Mock(return_value=png())
                callback = Mock()
                self.execute(on_task=callback)
                self.assertEqual(self.deps.higgsfield_upload.call_count, count)
                self.assertEqual(self.deps.higgsfield_submit.call_args.args[0][field], value)
                self.assertEqual(self.deps.higgsfield_submit.call_args.args[0]['mediaIds'], ['first', 'second'][:count])
                callback.assert_called_once_with('submitted')

    def test_kling_single_prepared_reference_and_supported_ratio(self):
        self.kling()
        self.deps.kling_build.return_value['reference'] = {'mimeType':'image/png','data':'original'}
        self.deps.kling_prepare = Mock(return_value={'mimeType':'image/jpeg','data':'prepared'})
        self.deps.fetcher.return_value = png(size=(450,300))
        result = self.execute()
        self.assertEqual(result['aspect_ratio'], '3:2')
        self.assertEqual(self.deps.kling_submit.call_args.args[0]['references'], [{'mimeType':'image/jpeg','data':'prepared'}])

    def test_failed_receipt_does_not_poll_or_store(self):
        self.kling()
        callback = Mock(side_effect=RuntimeError('receipt transaction failed'))
        with self.assertRaisesMessage(RuntimeError, 'receipt transaction failed'):
            self.execute(on_task=callback)
        self.deps.kling_resolve.assert_not_called()
        self.assertFalse(any(key.startswith('generations/fixture/') for key in self.adapter.objects))

    def test_real_assembler_without_references_uses_original_prompt(self):
        from apps.generation.prompting.assembler import assemble_prompt
        self.deps.assemble = assemble_prompt
        self.execute()
        assembled = self.deps.gemini_generate.call_args.args[0]['assembled']
        self.assertIn('Original prompt', assembled['instruction'])
        self.assertEqual(assembled['groups'], [])
