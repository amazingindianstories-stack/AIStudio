"""The shared submission and read services: availability refusals, typed paid holds, quotes and library reads."""
import json
import uuid
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.authentication.models import User
from apps.library.models import Folder
from apps.library.services import folder_reads
from apps.media.storage import StorageService, MemoryAdapter
from .models import Generation
from .services import enqueue, paid_guard, reads, submission
from .test_enqueue import data_url, picture

LIMITED = {'approved_scope': paid_guard.LIMITED_SCOPE, 'maximum_total_cents': 2000, 'reviewed_maximum_quotes': {}}


class AvailabilityRefusalTests(TransactionTestCase):
    """Only models the composer offers take new jobs, refused with the existing wording before anything is stored."""
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def post(self, path, payload):
        return self.client.post('/api/generate/' + path, payload, content_type='application/json')

    def assertRefused(self, path, payload, message):
        storage = StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            response = self.post(path, payload)
        self.assertEqual((response.status_code, response.json()), (400, {'error': message}))
        self.assertEqual(Generation.objects.count(), 0)
        self.assertEqual(storage.primary.objects, {})

    def test_switched_off_models_are_refused_without_the_paid_guard(self):
        self.cookie()
        image = dict(prompt='lantern at dusk', aspectRatio='1:1', resolution='1K', referenceImages=[data_url()])
        with override_settings(VEEVEE_KLING=False, VEEVEE_GEMINI_OMNI=False, VEEVEE_OMNIHUMAN=False, VEEVEE_MAGNIFIC_UPSCALE=False,
                               VEEVEE_PAID_GUARD=None):
            for model in ('Kling Image 3.0', 'kling-image-21'):
                name = enqueue.model_definition(model)['name']
                with self.subTest(model=model):
                    self.assertRefused('image', {**image, 'model': model}, f'{name} is not enabled. Choose another image model.')
            with self.subTest(model='Gemini Omni Flash 1.1'):
                self.assertRefused('video', dict(prompt='river', model='Gemini Omni Flash 1.1', aspectRatio='16:9', resolution='720p', duration=8),
                                   'Gemini Omni Flash 1.1 is not enabled')
            with self.subTest(model='OmniHuman 2.0'):
                self.assertRefused('video', dict(model='OmniHuman 2.0', referenceImages=['/api/media/a.png'], referenceAudios=['/api/media/a.wav']),
                                   'OmniHuman is not enabled. Choose another video model.')
            with self.subTest(model='Magnific Precision V2'):
                self.assertRefused('upscale', dict(model='Magnific Precision V2', image=data_url(picture(160, 90)),
                    params=dict(scaleFactor='2x', flavor='photo', sharpen=0, smartGrain=0, ultraDetail=0)), 'Magnific upscaling is not enabled')
            with self.subTest(model='Magnific Video Precision'):
                self.assertRefused('upscale', dict(model='Magnific Video Precision', video='/api/media/uploads/video-reference/a.mp4',
                    params=dict(resolution='2k', sharpen=0, smartGrain=0, strength=50, fpsBoost=False, outputFormat='h264')),
                    'Magnific upscaling is not enabled')
        # Switched on, the same request queues.
        with override_settings(VEEVEE_KLING=True, VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            response = self.post('image', {**image, 'model': 'Kling Image 3.0'})
        self.assertEqual(response.status_code, 200, response.content)

    def test_unoffered_and_unknown_models_are_refused(self):
        self.cookie()
        for path, payload, message in [
                ('image', dict(prompt='lantern', model='Nano Banana 2'), 'Nano Banana 2 is not enabled. Choose another image model.'),
                ('image', dict(prompt='lantern', model='higgsfield-soul'), 'Higgsfield Soul is not enabled. Choose another image model.'),
                ('video', dict(prompt='river', model='Seedance 2.0 Mini', resolution='720p'), 'Seedance 2.0 Mini is not enabled. Choose another video model.'),
                ('image', dict(prompt='lantern', model='Imagen 9'), 'Imagen 9 is not enabled. Choose another image model.'),
                ('video', dict(prompt='river', model='Veo 3.1'), 'Veo 3.1 is not enabled. Choose another video model.')]:
            with self.subTest(model=payload['model']):
                self.assertRefused(path, payload, message)

    def test_the_old_unoffered_default_video_model_is_refused(self):
        # A video request that names no model used to fall back to the unoffered Higgsfield Seedance 2.0 and queue it.
        self.cookie()
        message = 'Higgsfield Seedance 2.0 is not enabled. Choose another video model.'
        self.assertRefused('video', dict(prompt='river'), message)
        self.assertRefused('video', dict(prompt='river', model='Higgsfield Seedance 2.0'), message)
        self.assertRefused('video', dict(prompt='river', model='higgsfield-seedance-20'), message)

    def test_retired_models_keep_the_retirement_message(self):
        self.cookie()
        self.assertRefused('video', dict(prompt='river', model='Gemini Omni Flash', aspectRatio='16:9', resolution='720p', duration=8),
                           'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.')

    def test_the_service_names_the_refusal(self):
        actor = User.objects.get(pk=session_fixtures.UID)
        with self.assertRaises(submission.Refused) as refused:
            submission.submit_generation(actor, 'image', {'prompt': 'lantern', 'model': 'Nano Banana 2'})
        self.assertEqual((refused.exception.status, refused.exception.code, refused.exception.body),
                         (400, 'MODEL_UNAVAILABLE', {'error': 'Nano Banana 2 is not enabled. Choose another image model.'}))
        with self.assertRaises(submission.Refused) as refused:
            submission.quote_generation(actor, 'video', {'prompt': 'river'})
        self.assertEqual(refused.exception.code, 'MODEL_UNAVAILABLE')
        with self.assertRaises(submission.Refused) as refused:
            submission.submit_generation(actor, 'image', {'model': 'Nano Banana Pro'})
        self.assertEqual((refused.exception.status, refused.exception.code, refused.exception.body),
                         (400, 'INVALID_REQUEST', {'error': 'Prompt is required.'}))
        self.assertEqual(Generation.objects.count(), 0)


class PaidHoldTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp

    def tearDown(self):
        paid_guard.STATE.api_error = None

    def test_a_paid_guard_refusal_reaches_callers_as_a_typed_hold(self):
        actor = User.objects.get(pk=session_fixtures.UID)
        with override_settings(VEEVEE_PAID_GUARD=LIMITED):
            with self.assertRaises(paid_guard.PaidBudgetHold) as held:
                submission.submit_generation(actor, 'image', {'prompt': 'lantern', 'model': 'Seedream 5.0 Pro'}, idempotency_key='hold-fixture-1')
        self.assertEqual(str(held.exception), 'No verified maximum charge quote for this model')
        self.assertEqual(held.exception.code, 'PREVIEW_PAID_BUDGET_HOLD')
        # The web path still answers it through paid_guard.wrap_wsgi.
        self.assertEqual(paid_guard.STATE.api_error, 'No verified maximum charge quote for this model')
        self.assertEqual(Generation.objects.count(), 0)


class QuoteTests(TransactionTestCase):
    """A quote prices exactly what submission records, and stores nothing."""
    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        self.actor = User.objects.get(pk=session_fixtures.UID)
        self.storage = StorageService(MemoryAdapter())

    def test_generation_quotes_match_the_recorded_estimate(self):
        cases = [('image', dict(prompt='lantern', model='Nano Banana 2.1', resolution='2K', referenceImages=[data_url()])),
                 ('image', dict(prompt='lantern @img1', model='Seedream 5.0 Pro', referenceImages=[data_url(), data_url()])),
                 ('image', dict(prompt='lantern', model='Kling Image 2.1', resolution='1K', referenceImages=[data_url()])),
                 ('video', dict(prompt='river', model='Seedance 2.0', resolution='720p', duration=5, generateAudio=True)),
                 ('video', dict(prompt='river', model='Seedance 2.5', resolution='480p', duration=10, draftMode=True)),
                 ('video', dict(prompt='river', model='Gemini Omni Flash 1.1', aspectRatio='9:16', resolution='360p', duration=6))]
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage, VEEVEE_KLING=True, VEEVEE_GEMINI_OMNI=True):
            for kind, body in cases:
                with self.subTest(model=body['model']):
                    quote = submission.quote_generation(self.actor, kind, json.loads(json.dumps(body)))
                    self.assertEqual((Generation.objects.count(), self.storage.primary.objects), (0, {}))
                    item = submission.submit_generation(self.actor, kind, json.loads(json.dumps(body)))
                    self.assertEqual(quote, {'kind': kind, 'model': body['model'], 'costCents': item['costCents']})
                    Generation.objects.all().delete()
                    self.storage.primary.objects.clear()


class ReadTests(TransactionTestCase):
    def setUp(self):
        self.ids = []
        for index in range(5):
            row = Generation.objects.create(id=uuid.uuid4(), kind='image' if index % 2 else 'video', status='succeeded',
                prompt=f'lantern {index}', model='Nano Banana Pro', aspect_ratio='1:1', created_at=1000 + index, updated_at=1000 + index)
            self.ids.append(str(row.id))

    def test_single_and_batch_reads_return_the_history_item(self):
        page = reads.query_history({'limit': 5})
        listed = {item['id']: item for item in page['items']}
        self.assertEqual(reads.get_generation(self.ids[2]), listed[self.ids[2]])
        self.assertEqual(reads.get_generation(self.ids[2].upper()), listed[self.ids[2]])
        self.assertIsNone(reads.get_generation(str(uuid.uuid4())))
        self.assertIsNone(reads.get_generation('not-a-uuid'))
        unknown = str(uuid.uuid4())
        batch = reads.get_generations([self.ids[4], 'not-a-uuid', self.ids[0], unknown, self.ids[4], self.ids[0].upper()])
        self.assertEqual([item['id'] for item in batch['items']], [self.ids[4], self.ids[0]])
        self.assertEqual(batch['items'][0], listed[self.ids[4]])
        self.assertEqual(batch['missing'], ['not-a-uuid', unknown])
        with self.assertRaises(ValueError):
            reads.get_generations([str(uuid.uuid4()) for _ in range(reads.MAX_BATCH + 1)])

    def test_search_pages_with_the_keyset_cursor_from_plain_values(self):
        first = reads.query_history({'limit': 2, 'q': 'lantern'})
        self.assertEqual([item['id'] for item in first['items']], [self.ids[4], self.ids[3]])
        second = reads.query_history({'limit': 2, 'q': 'lantern', 'cursor': first['nextCursor']})
        self.assertEqual([item['id'] for item in second['items']], [self.ids[2], self.ids[1]])
        images = reads.query_history({'kind': 'image', 'sort': ['oldest']})
        self.assertEqual([item['id'] for item in images['items']], [self.ids[1], self.ids[3]])
        self.assertEqual(reads.count_library({'kind': 'video'})['allAssets'], 3)

    def test_folder_reads(self):
        root = Folder.objects.create(id=uuid.uuid4(), name='Scenes', name_normalized='scenes', created_at=1, updated_at=1)
        child = Folder.objects.create(id=uuid.uuid4(), name='Night', name_normalized='night', parent=root, created_at=2, updated_at=2)
        self.assertEqual([folder['id'] for folder in folder_reads.children()['folders']], [str(root.id)])
        self.assertEqual([folder['id'] for folder in folder_reads.children(str(root.id))['folders']], [str(child.id)])
        self.assertEqual([crumb['name'] for crumb in folder_reads.ancestry(str(child.id))['breadcrumbs']], ['Scenes', 'Night'])
        self.assertEqual(folder_reads.tree()['globalFolders'][0]['children'][0]['id'], str(child.id))


class RefusedTests(SimpleTestCase):
    def test_codes(self):
        self.assertEqual(submission.Refused(500).code, 'INTERNAL_ERROR')
        self.assertEqual(submission.Refused(409, {'error': 'x', 'code': 'IDEMPOTENCY_PAYLOAD_MISMATCH'}).code, 'IDEMPOTENCY_PAYLOAD_MISMATCH')
        self.assertEqual(submission.Refused(429, {'error': 'MEDIA_READ_CAPACITY_BUSY'}, headers={'Retry-After': '1'}).code, 'CAPACITY_BUSY')
        self.assertEqual(submission.invalid(enqueue.ModelUnavailable('gone')).code, 'MODEL_UNAVAILABLE')
