"""Board "Create with AI" jobs: allowlist, quotes, idempotent submission, worker execution, admission and paid guard.

Provider calls reach only ``testsupport.fake_providers`` (``HttpTransport._send`` replaced); nothing leaves the machine.
"""
import contextlib
import json
import time
import uuid
from unittest.mock import patch

from django.db import connection
from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.admin_dashboard import tests as session_fixtures
from apps.agents import board as board_formats
from apps.agents.llm import BoardTextTransport, agent_endpoint, board_payload_allowed
from apps.generation.models import Generation
from apps.generation.services import admission, paid_guard, reads
from apps.generation.services.deadline import Cancellation
from apps.generation.services.executor import process_generation
from apps.generation.test_paid_guard_audio_agent import LIMITED, UNLIMITED, LedgerCursor
from apps.integrations.transport import HttpTransport, ProviderError
from apps.library.models import OrganizationIdempotencyKey
from apps.media.storage import MemoryAdapter, StorageService
from apps.projects.models import Project
from deploy import gateway
from testsupport.fake_providers import BOARD_NOTES, FakeProviders
from .models import BoardAiJob, CanvasBoard

MODEL = 'gemini-flash-latest'
ENDPOINT = agent_endpoint(MODEL)
WORKER_ENV = {'GOOGLE_API_KEY': 'fixture-google-key'}
GEMINI_PATH = r'POST generativelanguage\.googleapis\.com/v1beta/models/gemini-flash-latest:generateContent'


def now():
    return int(time.time() * 1000)


def stickies_body(prompt='five ideas for a teaser'):
    return board_formats.build_body(board_formats.submission_input('stickies', MODEL, board_formats.conversation(prompt)))


def text_contract(**changes):
    value = board_formats.submission_input('stickies', MODEL, board_formats.conversation('ideas'))
    contract = {name: None for name in ('id', 'user_id', 'kind', 'model', 'duration', 'resolution', 'generate_audio', 'draft_mode',
                'draft_task_id', 'bitrate_mode', 'video_task_mode', 'aspect_ratio', 'prompt', 'submission_input', 'reference_images',
                'reference_videos', 'reference_audios', 'continuation_frame_url', 'last_frame_url', 'project_id', 'folder_id',
                'track_characters', 'width', 'height')}
    contract.update(id=str(uuid.uuid4()), user_id=str(uuid.uuid4()), kind='text', model=f'Gemini ({MODEL})', prompt='ideas',
                    aspect_ratio='', submission_input=value)
    contract.update(changes)
    return contract


class BoardPayloadAllowlistTests(SimpleTestCase):
    """Board prompts go through the agents payload allowlist: one format's exact prompt, schema and config, text turns."""

    def test_only_the_exact_board_shape_is_allowed(self):
        body = stickies_body()
        self.assertTrue(board_payload_allowed(body))
        refine = board_formats.build_body(board_formats.submission_input('stickies', MODEL, board_formats.conversation(
            'shorter', ('five ideas', {'notes': [{'text': 'a', 'color': 'yellow'}]}))))
        self.assertTrue(board_payload_allowed(refine))

        def changed(edit):
            value = json.loads(json.dumps(body))
            edit(value)
            return value
        variants = {
            'tools': changed(lambda b: b.update(tools=[{'googleSearch': {}}])),
            'other system prompt': changed(lambda b: b['systemInstruction']['parts'][0].update(text='You are a pirate.')),
            'more candidates': changed(lambda b: b['generationConfig'].update(candidateCount=4)),
            'bigger output': changed(lambda b: b['generationConfig'].update(maxOutputTokens=65536)),
            'other schema': changed(lambda b: b['generationConfig'].update(responseSchema={'type': 'STRING'})),
            'no generation config': changed(lambda b: b.pop('generationConfig')),
            'image part': changed(lambda b: b['contents'][0]['parts'].append({'inlineData': {'mimeType': 'image/png', 'data': 'AA=='}})),
            'file part': changed(lambda b: b['contents'][0].update(parts=[{'fileData': {'fileUri': 'x'}}])),
            'model first': changed(lambda b: b['contents'][0].update(role='model')),
            'even turns': changed(lambda b: b['contents'].append({'role': 'model', 'parts': [{'text': 'x'}]})),
            'too many turns': changed(lambda b: b['contents'].extend([{'role': 'model', 'parts': [{'text': 'x'}]},
                                                                      {'role': 'user', 'parts': [{'text': 'y'}]}] * 2)),
            'oversized turn': changed(lambda b: b['contents'][0]['parts'][0].update(text='x' * (board_formats.MAX_TURN_CHARS + 1))),
            'empty turn': changed(lambda b: b['contents'][0]['parts'][0].update(text='  ')),
            'extra top-level key': changed(lambda b: b.update(safetySettings=[])),
        }
        for name, value in variants.items():
            with self.subTest(name):
                self.assertFalse(board_payload_allowed(value))
        self.assertFalse(board_payload_allowed(None))
        self.assertFalse(board_payload_allowed({}))

    def test_the_board_transport_refuses_anything_else_before_the_network(self):
        sent = []
        with patch.object(HttpTransport, '_send', lambda self, method, url, **kwargs: sent.append(url)):
            transport = BoardTextTransport(MODEL)
            for method, url, body in (('POST', ENDPOINT, {**stickies_body(), 'tools': []}),
                                      ('POST', agent_endpoint('gemini-2.5-pro'), stickies_body()),
                                      ('GET', ENDPOINT, None)):
                with self.subTest(url=url, method=method), self.assertRaises(ProviderError) as raised:
                    transport.request(method, url, body=body)
                self.assertEqual((raised.exception.code, raised.exception.may_have_submitted), ('agent_scope', False))
            transport.request('POST', ENDPOINT, body=stickies_body())
        self.assertEqual(sent, [ENDPOINT])
        # The admin chat's exempt transport does not accept a board body: each caller has its own allowlist.
        from apps.agents.llm import agent_payload_allowed
        self.assertFalse(agent_payload_allowed(stickies_body()))

    def test_the_paid_guard_pins_a_text_job_to_its_model_endpoint_and_exact_request(self):
        contract = text_contract()
        self.assertEqual(paid_guard.quote_for(contract, UNLIMITED),
                         {'maximum_cents': 0, 'pricing_status': 'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE',
                          'allowed_paid_endpoints': [ENDPOINT], 'provider_payload_allowed_values': {}})
        for change, message in (({'model': 'Gemini (gemini-2.5-pro)'}, 'outside its Gemini model'),
                                ({'submission_input': {'version': 1, 'operation': 'audio-transcription'}}, 'New board text job only'),
                                ({'submission_input': None}, 'New board text job only'),
                                ({'user_id': None}, 'New authenticated initial jobs only')):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                paid_guard.quote_for(text_contract(**change), UNLIMITED)
        with self.assertRaisesRegex(ValueError, 'No verified maximum charge quote'):
            paid_guard.quote_for(contract, LIMITED)
        self.assertTrue(paid_guard.text_payload_matches(board_formats.build_body(contract['submission_input']), contract))
        self.assertFalse(paid_guard.text_payload_matches(stickies_body('another prompt'), contract))
        self.assertFalse(paid_guard.text_payload_matches({**board_formats.build_body(contract['submission_input']), 'tools': []}, contract))

    def test_results_are_validated_before_the_board_sees_them(self):
        parsed = board_formats.parse_output('stickies', json.dumps({'notes': [
            {'text': '  first  ', 'color': 'blue'}, {'text': '', 'color': 'blue'}, {'text': 'x' * 400, 'color': 'magenta'}, 'junk']}))
        self.assertEqual(parsed, {'notes': [{'text': 'first', 'color': 'blue'}, {'text': 'x' * board_formats.MAX_STICKY_CHARS, 'color': 'yellow'}]})
        many = board_formats.parse_output('stickies', json.dumps({'notes': [{'text': str(n), 'color': 'green'} for n in range(40)]}))
        self.assertEqual(len(many['notes']), board_formats.MAX_STICKIES)
        for text in ('not json', '[]', '{"notes": []}', '{"notes": [{"text": " "}]}', '{"ideas": ["a"]}'):
            with self.subTest(text=text), self.assertRaises(board_formats.UnusableResult):
                board_formats.parse_output('stickies', text)

    def test_the_gateway_opens_board_submissions_only_with_the_paid_initial_routes(self):
        path = f'/api/canvas-boards/{uuid.uuid4()}/ai-jobs'
        self.assertFalse(gateway.allowed('POST', path))
        self.assertTrue(gateway.allowed('POST', path, paid_initial_routes=True))
        self.assertEqual(gateway.upstream_wait('POST', path), 120)
        for method, route in (('POST', path + '/quote'), ('GET', path), ('PATCH', path + '/' + str(uuid.uuid4()))):
            with self.subTest(method=method, route=route):
                self.assertTrue(gateway.allowed(method, route))


class BoardFixture(TransactionTestCase):
    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        session_fixtures.SettingsTests.cookie(self)
        self.actor_id = uuid.UUID(session_fixtures.UID)
        self.project = Project.objects.create(id=uuid.uuid4(), name='Board project', created_at=1, updated_at=1)
        self.board = CanvasBoard.objects.create(id=uuid.uuid4(), project_id=self.project.id, name='Ideas', data={'version': 1},
                                                created_at=1, updated_at=1)
        self.storage = StorageService(MemoryAdapter())
        self.base = f'/api/canvas-boards/{self.board.id}/ai-jobs'

    def submit(self, body, key='board-key-0001'):
        headers = {'HTTP_IDEMPOTENCY_KEY': key} if key else {}
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            return self.client.post(self.base, body, content_type='application/json', **headers)

    def quote(self, body):
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            return self.client.post(self.base + '/quote', body, content_type='application/json')

    def jobs(self, *ids):
        return self.client.get(self.base, {'ids': ','.join(ids)} if ids else {}).json()['jobs']

    def run_worker(self, generation_id):
        return process_generation(generation_id, owner='board-test:' + uuid.uuid4().hex, signal=Cancellation(), env=WORKER_ENV,
                                  heartbeat=False)

    def expected_cost(self, prompt):
        value = board_formats.submission_input('stickies', MODEL, board_formats.conversation(prompt))
        return -(-250 * board_formats.estimated_tokens(value) // 1000000)


class BoardAiJobTests(BoardFixture):
    def test_a_quote_prices_the_job_and_stores_nothing(self):
        response = self.quote({'format': 'stickies', 'prompt': 'ideas for a teaser'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['quote'], {'format': 'stickies', 'model': f'Gemini ({MODEL})',
                                                    'costCents': self.expected_cost('ideas for a teaser')})
        self.assertGreaterEqual(response.json()['quote']['costCents'], 1)
        image = self.quote({'format': 'image', 'prompt': 'a lantern', 'model': 'Nano Banana 2.1'}).json()['quote']
        self.assertEqual((image['format'], image['model']), ('image', 'Nano Banana 2.1'))
        self.assertGreater(image['costCents'], 0)
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (0, 0))
        for body, status in (({'format': 'doc', 'prompt': 'x'}, 400), ({'format': 'stickies', 'prompt': ' '}, 400),
                             ({'format': 'image', 'prompt': 'x', 'model': 'Retired Model'}, 400)):
            with self.subTest(body=body):
                self.assertEqual(self.quote(body).status_code, status)

    def test_a_submission_queues_one_text_job_and_a_replayed_key_returns_it(self):
        first = self.submit({'format': 'stickies', 'prompt': 'five ideas for a teaser'})
        self.assertEqual(first.status_code, 201, first.content)
        job = first.json()['job']
        self.assertEqual((job['format'], job['status'], job['prompt']), ('stickies', 'queued', 'five ideas for a teaser'))
        again = self.submit({'format': 'stickies', 'prompt': 'five ideas for a teaser'})
        self.assertEqual((again.status_code, again.json()['job']['id']), (201, job['id']))
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (1, 1))
        row = Generation.objects.get()
        self.assertEqual((str(row.id), row.kind, row.status, row.model, row.created_via, row.user_id, row.project_id),
                         (job['generationId'], 'text', 'queued', f'Gemini ({MODEL})', 'board', self.actor_id, None))
        self.assertEqual(row.cost_cents, self.expected_cost('five ideas for a teaser'))
        self.assertEqual(row.submission_input, board_formats.submission_input('stickies', MODEL, [{'role': 'user', 'text': 'five ideas for a teaser'}]))
        self.assertIsNone(row.permanent_name)
        # The same key with other values is a conflict, not a second job; a submission without a key is refused.
        changed = self.submit({'format': 'stickies', 'prompt': 'six ideas'})
        self.assertEqual((changed.status_code, changed.json()['code']), (409, 'IDEMPOTENCY_PAYLOAD_MISMATCH'))
        self.assertEqual(self.submit({'format': 'stickies', 'prompt': 'x'}, key=None).json()['code'], 'IDEMPOTENCY_KEY_REQUIRED')
        self.assertEqual(Generation.objects.count(), 1)
        # A text job is not library media: no scope lists or counts it.
        self.assertEqual(reads.count_library({})['allAssets'], 0)
        self.assertEqual(self.client.get('/api/history').json().get('items', []), [])

    def test_the_worker_runs_the_job_once_against_the_provider_and_the_board_reads_the_notes(self):
        job = self.submit({'format': 'stickies', 'prompt': 'five ideas for a teaser'}).json()['job']
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')
            # A second worker pass finds nothing to run: the job is never submitted twice.
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'unclaimed')
        self.assertEqual(fake.board_payloads, [stickies_body('five ideas for a teaser')])
        self.assertEqual([call for call in fake.calls if 'generateContent' in call[1]],
                         [('POST', 'generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent')])
        (read,) = self.jobs(job['id'])
        self.assertEqual((read['status'], read['result']), ('succeeded', {'notes': BOARD_NOTES}))
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual((row.output, row.url, row.permanent_name), ({'notes': BOARD_NOTES}, None, None))
        self.assertEqual(reads.count_library({})['allAssets'], 0)

    def test_an_unusable_or_refused_answer_fails_the_job_without_a_retry(self):
        from apps.generation.failure_copy import BUSY, TEXT_UNUSABLE
        cases = ((200, {'candidates': [{'content': {'parts': [{'text': 'Here are some ideas!'}]}, 'finishReason': 'STOP'}]}, TEXT_UNUSABLE),
                 (429, {'error': {'code': 429, 'message': 'quota'}}, BUSY))
        for index, (status, payload, message) in enumerate(cases):
            with self.subTest(status=status):
                job = self.submit({'format': 'stickies', 'prompt': f'ideas {index}'}, key=f'board-key-fail-{index}').json()['job']
                with FakeProviders() as fake:
                    fake.faults = [{'match': GEMINI_PATH, 'status': status, 'payload': payload, 'count': 5}]
                    self.assertEqual(self.run_worker(job['generationId'])['kind'], 'failed')
                self.assertEqual(len([call for call in fake.calls if 'generateContent' in call[1]]), 1)
                (read,) = self.jobs(job['id'])
                self.assertEqual(read['status'], 'failed')
                self.assertTrue(read['error'].startswith(message), read['error'])
                self.assertNotIn('result', read)
        throttled = Generation.objects.get(pk=self.jobs(job['id'])[0]['generationId'])
        self.assertTrue(any(isinstance(entry, dict) and entry.get('unbilled') for entry in throttled.provider_responses))

    def test_a_refinement_sends_the_previous_result_and_only_a_finished_result_can_be_refined(self):
        job = self.submit({'format': 'stickies', 'prompt': 'five ideas for a teaser'}).json()['job']
        early = self.submit({'format': 'stickies', 'prompt': 'shorter', 'parentJobId': job['id']}, key='board-key-early')
        self.assertEqual((early.status_code, early.json()['code']), (409, 'PARENT_NOT_READY'))
        with FakeProviders():
            self.run_worker(job['generationId'])
        refined = self.submit({'format': 'stickies', 'prompt': 'make them shorter', 'parentJobId': job['id']}, key='board-key-refine').json()['job']
        self.assertEqual(refined['parentJobId'], job['id'])
        turns = Generation.objects.get(pk=refined['generationId']).submission_input['turns']
        self.assertEqual(turns, [{'role': 'user', 'text': 'five ideas for a teaser'},
                                 {'role': 'model', 'text': json.dumps({'notes': BOARD_NOTES}, ensure_ascii=False, separators=(',', ':'))},
                                 {'role': 'user', 'text': 'make them shorter'}])
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(refined['generationId'])['kind'], 'succeeded')
        self.assertEqual(fake.board_payloads[0]['contents'][1]['role'], 'model')
        # A refinement of another format, or of a job on another board, is not found.
        other = CanvasBoard.objects.create(id=uuid.uuid4(), project_id=self.project.id, name='Other', data={}, created_at=1, updated_at=1)
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            response = self.client.post(f'/api/canvas-boards/{other.id}/ai-jobs', {'format': 'stickies', 'prompt': 'x', 'parentJobId': job['id']},
                                        content_type='application/json', HTTP_IDEMPOTENCY_KEY='board-key-other')
        self.assertEqual(response.status_code, 404)
        self.assertEqual(self.submit({'format': 'image', 'prompt': 'x', 'parentJobId': job['id']}, key='board-key-format').status_code, 404)

    def test_the_image_format_queues_an_image_generation_in_the_boards_project_and_refines_from_it(self):
        response = self.submit({'format': 'image', 'prompt': 'a lantern on a pier', 'model': 'Nano Banana 2.1', 'aspectRatio': '16:9'})
        self.assertEqual(response.status_code, 201, response.content)
        job = response.json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual((row.kind, row.model, row.aspect_ratio, row.project_id, row.created_via, row.prompt),
                         ('image', 'Nano Banana 2.1', '16:9', self.project.id, 'board', 'a lantern on a pier'))
        self.assertEqual(reads.count_library({})['allAssets'], 1)      # a board image is ordinary library media
        url = self.storage.upload_buffer(b'png-bytes', f'generations/{row.id}/master.png', 'png')
        Generation.objects.filter(pk=row.id).update(status='succeeded', url=url, completed_at=now(), updated_at=now())
        (read,) = self.jobs(job['id'])
        self.assertEqual(read['result'], {'url': url, 'aspectRatio': '16:9'})
        refined = self.submit({'format': 'image', 'prompt': 'make it night', 'parentJobId': job['id']}, key='board-key-image-refine')
        self.assertEqual(refined.status_code, 201, refined.content)
        edit = Generation.objects.get(pk=refined.json()['job']['generationId'])
        self.assertEqual((edit.kind, edit.prompt, len(edit.reference_images or [])), ('image', 'make it night', 1))

    def test_placing_a_result_is_recorded_once(self):
        job = self.submit({'format': 'stickies', 'prompt': 'ideas'}).json()['job']
        path = f"{self.base}/{job['id']}"
        early = self.client.patch(path, {'placedNodeIds': ['n1']}, content_type='application/json')
        self.assertEqual((early.status_code, early.json()['code']), (409, 'NOT_READY'))
        with FakeProviders():
            self.run_worker(job['generationId'])
        self.assertEqual([item['id'] for item in self.jobs()], [job['id']])     # unplaced results come back after a reload
        placed = self.client.patch(path, {'placedNodeIds': ['n1', 'n2']}, content_type='application/json')
        self.assertEqual((placed.status_code, placed.json()['job']['placedNodeIds']), (200, ['n1', 'n2']))
        again = self.client.patch(path, {'placedNodeIds': ['n3']}, content_type='application/json')
        self.assertEqual((again.status_code, again.json()['code']), (409, 'ALREADY_PLACED'))
        self.assertEqual(self.jobs(), [])
        self.assertEqual(self.client.patch(path, {'placedNodeIds': 'n1'}, content_type='application/json').status_code, 400)
        self.assertEqual(self.client.patch(f'{self.base}/{uuid.uuid4()}', {'placedNodeIds': []}, content_type='application/json').status_code, 404)
        # Deleting the board deletes its jobs; the generation stays.
        self.board.delete()
        self.assertEqual((BoardAiJob.objects.count(), Generation.objects.count()), (0, 1))

    def test_signed_out_and_unknown_board_requests_are_refused(self):
        self.assertEqual(self.client.post(f'/api/canvas-boards/{uuid.uuid4()}/ai-jobs', {}, content_type='application/json',
                                          HTTP_IDEMPOTENCY_KEY='board-key-404').status_code, 404)
        self.assertEqual(self.client.post('/api/canvas-boards/not-a-board/ai-jobs/quote', {}, content_type='application/json').status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.submit({'format': 'stickies', 'prompt': 'x'}).status_code, 401)
        self.assertEqual(self.client.get(self.base).status_code, 401)


class BoardAiAdmissionTests(BoardFixture):
    """A board text job is admitted like a Gemini image: per-user concurrency and the Gemini spend window apply."""

    def row(self, **fields):
        stamp = now()
        values = dict(id=uuid.uuid4(), kind='image', status='running', prompt='x', model='Nano Banana Pro', aspect_ratio='1:1',
                      user_id=self.actor_id, cost_cents=1, created_at=stamp - 1000, updated_at=stamp - 1000)
        values.update(fields)
        return Generation.objects.create(**values)

    def test_the_per_user_concurrency_limit_holds_a_board_job(self):
        with connection.cursor() as cursor:
            cursor.execute("INSERT INTO settings VALUES ('maxConcurrentJobs','1',0)")
        self.row()
        job = self.submit({'format': 'stickies', 'prompt': 'ideas'}).json()['job']
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'not_admitted')
        self.assertEqual(fake.board_payloads, [])
        self.assertTrue(admission.queue_position(job['generationId'])['heldForConcurrency'])
        # A running board job counts against the same limit as images and videos.
        Generation.objects.filter(kind='image').update(status='succeeded')
        Generation.objects.filter(pk=job['generationId']).update(status='running')
        image = self.row(status='queued', created_at=now())
        self.assertTrue(admission.queue_position(image.id)['heldForConcurrency'])

    def test_the_gemini_spend_window_holds_a_board_job_and_counts_its_cost(self):
        self.row(status='succeeded', cost_cents=9, updated_at=now())
        job = self.submit({'format': 'stickies', 'prompt': 'ideas'}).json()['job']
        with patch.dict('os.environ', {'GEMINI_SPEND_LIMIT_CENTS': '10'}), FakeProviders() as fake:
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'not_admitted')
            (read,) = self.jobs(job['id'])
        self.assertEqual(fake.board_payloads, [])
        self.assertEqual((read['status'], read['heldReason']), ('queued', admission.HELD_MESSAGE))
        # The other way round: a board job's spend holds the next Gemini image.
        Generation.objects.all().delete()
        self.row(kind='text', model=f'Gemini ({MODEL})', status='succeeded', cost_cents=9, updated_at=now())
        image = self.row(status='queued', created_at=now())
        with patch.dict('os.environ', {'GEMINI_SPEND_LIMIT_CENTS': '10'}):
            self.assertTrue(admission.queue_position(image.id)['heldForBudget'])
            self.assertIsNone(admission.admit_job(image.id))


class BoardAiPaidGuardTests(BoardFixture):
    @contextlib.contextmanager
    def guard(self, ledger, config=UNLIMITED):
        real_cursor = connection.cursor
        try:
            with override_settings(VEEVEE_PAID_GUARD=config), \
                    patch.object(connection, 'cursor', lambda *args, **kwargs: LedgerCursor(real_cursor(*args, **kwargs), ledger)):
                yield
        finally:
            paid_guard.STATE.active = None
            paid_guard.STATE.api_error = None

    def test_a_held_budget_refuses_the_submission_and_stores_nothing(self):
        with self.guard({}, LIMITED):
            response = self.submit({'format': 'stickies', 'prompt': 'ideas'})
        self.assertEqual((response.status_code, response.json()['code']), (409, 'PREVIEW_PAID_BUDGET_HOLD'))
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count(), OrganizationIdempotencyKey.objects.count()), (0, 0, 0))

    def test_the_job_is_registered_with_its_row_and_claims_one_exact_submission(self):
        ledger = {}
        with self.guard(ledger):
            job = self.submit({'format': 'stickies', 'prompt': 'ideas'}).json()['job']
            self.assertEqual(ledger[job['generationId']]['state'], 'RESERVED')
            with FakeProviders() as fake:
                self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')
            self.assertEqual(ledger[job['generationId']]['state'], 'SUBMITTING')
            self.assertEqual(fake.board_payloads, [stickies_body('ideas')])
            # Forced back into the queue, the spent claim refuses it before any request.
            Generation.objects.filter(pk=job['generationId']).update(status='queued', output=None, completed_at=None)
            with FakeProviders() as fake, self.assertRaises(RuntimeError):
                self.run_worker(job['generationId'])
            self.assertEqual(fake.board_payloads, [])


class BoardAiJobMigrationTests(TransactionTestCase):
    def test_upgrade_adds_the_jobs_table_and_keeps_existing_boards(self):
        from django.db.migrations.executor import MigrationExecutor
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'canvas'] + [('canvas', '0002_board_roles')]
        identifier = uuid.uuid4()
        try:
            executor.migrate(previous)
            with connection.cursor() as cursor:
                cursor.execute("SELECT to_regclass('public.canvas_board_ai_jobs')")
                self.assertIsNone(cursor.fetchone()[0])
            old = executor.loader.project_state(previous).apps.get_model('canvas', 'CanvasBoard')
            old.objects.create(id=identifier, project_id=uuid.uuid4(), name='Kept', data={'version': 1, 'nodes': []}, created_at=1, updated_at=2)
            executor = MigrationExecutor(connection)
            self.assertEqual([(m.app_label, m.name) for m, backward in executor.migration_plan(final)], [('canvas', '0003_boardaijob')])
            executor.migrate(final)
            board = CanvasBoard.objects.get(pk=identifier)
            self.assertEqual((board.name, board.data, board.updated_at), ('Kept', {'version': 1, 'nodes': []}, 2))
            BoardAiJob.objects.create(id=uuid.uuid4(), board=board, user_id=uuid.uuid4(), format='stickies', prompt='x',
                                      generation_id=uuid.uuid4(), created_at=1, updated_at=1)
            with connection.cursor() as cursor:
                cursor.execute("SELECT indexname FROM pg_indexes WHERE tablename = 'canvas_board_ai_jobs' ORDER BY indexname")
                self.assertEqual([row[0] for row in cursor.fetchall()],
                                 ['canvas_ai_jobs_board_user_idx', 'canvas_ai_jobs_parent_idx', 'canvas_board_ai_jobs_generation_id_key',
                                  'canvas_board_ai_jobs_pkey'])
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
        finally:
            MigrationExecutor(connection).migrate(final)
