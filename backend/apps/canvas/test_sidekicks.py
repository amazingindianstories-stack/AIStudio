"""Sidekicks, Flows, Catch up, AI search and AI credits: payload allowlist, parsers, routes, roles, credits and pruning.

Provider calls reach only ``testsupport.fake_providers``; nothing leaves the machine.
"""
import json
import uuid

from django.test import SimpleTestCase, override_settings

from apps.agents import board as board_formats
from apps.agents import sidekick
from apps.agents.llm import board_payload_allowed
from apps.authentication.models import User
from apps.generation.models import Generation
from testsupport.fake_providers import FakeProviders
from . import ai_allowance, flows, sidekicks
from .models import BoardActivity, BoardAiJob, BoardSidekickChat, FlowOutputVersion, Sidekick
from .serialization import node
from .test_ai_jobs import MODEL, BoardFixture, now


def body_of(name, turns):
    return board_formats.build_body(board_formats.submission_input(name, MODEL, turns))


class SidekickFormatTests(SimpleTestCase):
    def test_every_format_has_one_exact_allowed_shape_and_only_the_web_formats_carry_tools(self):
        turns = [{'role': 'user', 'text': 'context'}, {'role': 'model', 'text': 'Understood.'}, {'role': 'user', 'text': 'go'}]
        for name in (name for name in sidekick.FORMATS if not name.endswith('-web')):
            with self.subTest(name):
                body = body_of(name, turns)
                self.assertTrue(board_payload_allowed(body))
                self.assertEqual(board_formats.body_format(body), name)
                self.assertNotIn('tools', body)
                self.assertFalse(board_payload_allowed({**body, 'tools': [{'codeExecution': {}}]}))
                self.assertFalse(board_payload_allowed({**body, 'safetySettings': []}))
        plain = body_of('sidekick', turns)
        self.assertFalse(board_payload_allowed({**plain, 'tools': [{'google_search': {}}]}))

    def test_the_web_formats_send_exactly_the_google_search_tool_and_no_other_format_does(self):
        turns = [{'role': 'user', 'text': 'context'}, {'role': 'model', 'text': 'Understood.'}, {'role': 'user', 'text': 'go'}]
        for name in ('sidekick-web', 'flowstep-web'):
            with self.subTest(name):
                self.assertTrue(board_formats.is_web_format(name))
                body = body_of(name, turns)
                self.assertEqual(body['tools'], [{'google_search': {}}])
                self.assertEqual(board_formats.body_format(body), name)
                self.assertTrue(board_payload_allowed(body))
                self.assertFalse(board_payload_allowed({key: value for key, value in body.items() if key != 'tools'}))
                self.assertFalse(board_payload_allowed({**body, 'tools': [{'google_search': {}}, {'codeExecution': {}}]}))
                self.assertFalse(board_payload_allowed({**body, 'tools': [{'codeExecution': {}}]}))
        self.assertFalse(any(board_formats.is_web_format(name) for name in board_formats.TEXT_FORMATS if not name.endswith('-web')))
        # A plain body never passes as its web twin: the web prompt and the tool differ.
        self.assertEqual(board_formats.body_format(body_of('sidekick', turns)), 'sidekick')

    def test_the_largest_sidekick_context_fits_one_turn_and_an_oversized_body_is_refused_before_queueing(self):
        sidekick_ = {'name': 'n' * sidekicks.MAX_NAME, 'instructions': 'i' * sidekicks.MAX_INSTRUCTIONS,
                     'knowledge': [{'name': f'{index}'.rjust(116, 'k') + '.txt', 'text': 'k' * (sidekicks.KNOWLEDGE_CHARS // sidekicks.MAX_FILES)}
                                   for index in range(sidekicks.MAX_FILES)]}
        nodes = [{'id': f'{index}'.rjust(64, 'n'), 'type': 'sticky', 'x': 0, 'y': index, 'w': 1, 'h': 1, 'text': 't' * 240}
                 for index in range(sidekicks.MAX_SUMMARY_OBJECTS)]
        connectors = [{'from': {'nodeId': 'a' * 64}, 'to': {'nodeId': 'b' * 64}}] * 100
        summary = sidekicks.board_summary({'nodes': nodes, 'connectors': connectors})
        self.assertLessEqual(len(summary), sidekicks.SUMMARY_CHARS + 40)
        sources = '\n\n'.join(['s' * sidekicks.SOURCE_CHARS] * sidekicks.MAX_SOURCES)
        context = sidekicks.context_turn(sidekick_, summary, sources)
        self.assertTrue(board_formats.valid_turns([{'role': 'user', 'text': context}], 'sidekick'))
        wide = [{'role': 'user', 'text': '\u0915' * 100_000}, {'role': 'model', 'text': 'Understood.'}, {'role': 'user', 'text': 'go'}]
        with self.assertRaisesRegex(ValueError, 'too large'):
            board_formats.submission_input('sidekick', MODEL, wide)

    def test_turn_limits_are_per_format(self):
        long_turns = [{'role': 'user', 'text': 'c'}, {'role': 'model', 'text': 'Understood.'}] * 4 + [{'role': 'user', 'text': 'go'}]
        self.assertTrue(board_formats.valid_turns(long_turns, 'sidekick'))
        self.assertFalse(board_formats.valid_turns(long_turns, 'flowstep'))
        self.assertFalse(board_formats.valid_turns(long_turns, 'stickies'))

    def test_parsers_keep_only_what_the_board_can_apply(self):
        result = sidekick.parse_sidekick({'reply': 'ok', 'actions': [
            {'op': 'add', 'type': 'sticky', 'text': 'hi', 'color': 'mauve'}, {'op': 'delete'}, {'op': 'explode', 'id': 'a'},
            {'op': 'connect', 'from': 'a', 'to': 'b'}]})
        self.assertEqual([action['op'] for action in result['actions']], ['add', 'connect'])
        self.assertNotIn('color', result['actions'][0])
        colored = sidekick.parse_sidekick({'reply': 'ok', 'actions': [
            {'op': 'update', 'id': 'a', 'color': 'black'}, {'op': 'add', 'type': 'sticky', 'text': 'x', 'fill': '#FF00AA'},
            {'op': 'add', 'type': 'sticky', 'text': 'y', 'fill': 'pink-ish'}]})['actions']
        self.assertEqual([(action.get('color'), action.get('fill')) for action in colored], [('black', None), (None, '#ff00aa'), (None, None)])
        asking = sidekick.parse_sidekick({'reply': 'Which scene?', 'options': ['One', 'Two'], 'actions': [{'op': 'add', 'type': 'sticky', 'text': 'x'}]})
        self.assertEqual((asking['options'], asking['actions']), (['One', 'Two'], []))
        with self.assertRaises(board_formats.UnusableResult):
            sidekick.parse_sidekick({'actions': []})
        with self.assertRaises(board_formats.UnusableResult):
            sidekick.parse_flow_step({'text': '  '})
        self.assertEqual(sidekick.parse_search({'terms': ['a', 7], 'updatedWithinDays': 'x', 'createdByMe': 'yes'})['updatedWithinDays'], 0)

    def test_attribution_and_flow_settings_survive_normalisation(self):
        raw = {'id': 'n1', 'type': 'sticky', 'x': 0, 'y': 0, 'w': 10, 'h': 10, 'text': 'a', 'aiCreated': True, 'aiEditedAt': 5,
               'flow': {'block': 'instruction', 'task': 'do it', 'webSearch': True, 'inputHash': 'abc', 'junk': 1}}
        result = node(raw)
        self.assertEqual((result['aiCreated'], result['aiEditedAt']), (True, 5))
        self.assertEqual(result['flow'], {'block': 'instruction', 'task': 'do it', 'webSearch': True, 'inputHash': 'abc'})
        bad = node({**raw, 'aiCreated': 'yes', 'aiEditedAt': 'x', 'flow': {'block': 'weird'}})
        self.assertNotIn('aiCreated', bad)
        self.assertNotIn('flow', bad)


class AssistantFixture(BoardFixture):
    def setUp(self):
        super().setUp()
        self.root = f'/api/canvas-boards/{self.board.id}/assistant/'

    def api(self, method, path, body=None, key=None):
        headers = {'HTTP_IDEMPOTENCY_KEY': key} if key else {}
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            if method == 'get':
                return self.client.get(path, body or {})
            return getattr(self.client, method)(path, json.dumps(body or {}), content_type='application/json', **headers)

    def board_api(self, method, action, body=None, key=None):
        return self.api(method, self.root + action, body, key)

    def personal(self, method, action, body=None):
        return self.api(method, '/api/canvas-ai/' + action, body)

    def new_chat(self, sidekick_id='ux-researcher'):
        return self.board_api('post', 'sidekick-chats', {'sidekick': sidekick_id}).json()['chat']

    def finish(self, job):
        with FakeProviders():
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')


class SidekickCatalogueTests(AssistantFixture):
    def test_premade_sidekicks_and_skills_are_listed(self):
        data = self.personal('get', 'sidekicks').json()
        self.assertGreaterEqual(len(data['premade']), 4)
        self.assertTrue(all(item['instructions'] and item['starters'] for item in data['premade']))
        self.assertIn('summarize', [skill['name'] for skill in data['skills']])
        self.assertEqual(data['limits']['types'], ['.txt', '.md', '.csv'])

    def test_a_custom_sidekick_is_validated_and_private_to_its_owner(self):
        files = [{'name': 'notes.md', 'text': 'The hero is called Mara.'}]
        created = self.personal('post', 'sidekicks', {'name': 'Mara Expert', 'instructions': 'Answer as Mara.', 'starters': ['Hi'], 'knowledge': files})
        self.assertEqual(created.status_code, 201, created.content)
        item = created.json()['sidekick']
        self.assertEqual((item['name'], item['mine'], 'shared' in item, 'webSearch' in item), ('Mara Expert', True, False, False))
        self.assertEqual(item['knowledge'], [{'name': 'notes.md', 'chars': len(files[0]['text'])}])
        for bad, message in (({'name': ' '}, 'name'), ({'name': 'x', 'knowledge': [{'name': 'a.pdf', 'text': 'x'}]}, 'type'),
                             ({'name': 'x', 'knowledge': [{'name': 'a.txt', 'text': 'x' * (sidekicks.KNOWLEDGE_CHARS + 1)}]}, 'tokens'),
                             ({'name': 'x', 'knowledge': [{'name': f'{n}.txt', 'text': 'x'} for n in range(sidekicks.MAX_FILES + 1)]}, 'count'),
                             ({'name': 'x', 'starters': ['a'] * 7}, 'starters'), ({'name': 'x', 'processing': 'turbo'}, 'processing')):
            with self.subTest(message):
                self.assertEqual(self.personal('post', 'sidekicks', bad).status_code, 400)
        updated = self.personal('patch', f"sidekicks/{item['id']}", {'shared': True, 'name': 'Mara Pro'}).json()['sidekick']
        self.assertEqual((updated['name'], 'shared' in updated), ('Mara Pro', False))
        # Another person neither sees nor changes it, even if they ask for it by id.
        other = User(id=uuid.uuid4(), name='Other', role='user')
        row = Sidekick.objects.get(pk=item['id'])
        with self.assertRaises(sidekicks.JobError):
            sidekicks.custom_row(other, str(row.id))
        with self.assertRaises(sidekicks.JobError):
            sidekicks.custom_row(other, str(row.id), owned=True)
        self.assertEqual(sidekicks.catalogue(other)['custom'], [])
        self.assertEqual(self.personal('delete', f"sidekicks/{item['id']}").status_code, 200)
        self.assertEqual(Sidekick.objects.count(), 0)


class WebSearchPricingTests(AssistantFixture):
    """Sidekick and Flow web search: the grounding fee is in the quote, the stored cost (credits and spend window) and is
    refunded when the answer reports that no search ran."""

    def test_the_fee_is_the_published_price_per_grounded_request(self):
        from apps.admin_dashboard.default_pricing import DEFAULT_PRICING
        row = next(row for row in DEFAULT_PRICING if row['model'] == 'Board AI web search')
        self.assertEqual((row['unit'], row['unitCostCents']), ('per_1000_requests', 1400))
        self.assertIn('ai.google.dev/gemini-api/docs/pricing', row['notes'])

    def token_cents(self, generation_id):
        from apps.generation.services import text_submission
        value = Generation.objects.get(pk=generation_id).submission_input
        return text_submission.text_cost(value, [{'model': 'Board AI text', 'unit': 'per_million_tokens', 'unitCostCents': 250}], grounded=False)

    def test_a_web_turn_is_quoted_with_the_grounding_fee_before_it_runs(self):
        chat = self.new_chat()
        path = f"sidekick-chats/{chat['id']}/quote"
        plain = self.board_api('post', path, {'message': 'Who won?'}).json()['quote']
        web = self.board_api('post', path, {'message': 'Who won?', 'webSearch': True}).json()['quote']
        self.assertNotIn('groundingCents', plain)
        self.assertEqual((web['format'], web['webSearch']), ('sidekick-web', True))
        self.assertEqual(web['costCents'] - plain['costCents'], web['groundingCents'])
        self.assertGreaterEqual(web['groundingCents'], 1)
        self.assertEqual(self.board_api('post', path, {'message': 'x', 'webSearch': 'yes'}).status_code, 400)
        self.assertEqual(Generation.objects.count(), 0)

    def test_a_web_turn_is_stored_at_the_quoted_cost_and_counts_in_the_monthly_credits(self):
        chat = self.new_chat()
        base = f"sidekick-chats/{chat['id']}"
        quote = self.board_api('post', base + '/quote', {'message': 'Who won?', 'webSearch': True}).json()['quote']
        job = self.board_api('post', base + '/turns', {'message': 'Who won?', 'webSearch': True}, key='web-key-0001').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual((row.submission_input['format'], row.cost_cents), ('sidekick-web', quote['costCents']))
        self.assertEqual(BoardAiJob.objects.get().format, 'sidekick-web')
        self.assertEqual(self.personal('get', 'credits').json()['credits']['usedCents'], quote['costCents'])
        prices = self.personal('get', 'credits').json()['credits']['prices']
        self.assertGreater(prices['sidekick-web']['basic'], prices['sidekick']['basic'])
        # The same message without web search is a different request under the same key.
        self.assertEqual(self.board_api('post', base + '/turns', {'message': 'Who won?'}, key='web-key-0001').status_code, 409)

    def test_a_web_turn_over_the_remaining_credits_is_refused_though_the_plain_turn_fits(self):
        from django.db import connection
        chat = self.new_chat()
        base = f"sidekick-chats/{chat['id']}"
        plain = self.board_api('post', base + '/quote', {'message': 'x'}).json()['quote']['costCents']
        with connection.cursor() as cursor:
            cursor.execute("INSERT INTO settings VALUES ('boardAiMonthlyCapCents', %s, 0)", [str(plain)])
        refused = self.board_api('post', base + '/turns', {'message': 'x', 'webSearch': True}, key='web-key-0002')
        self.assertEqual((refused.status_code, refused.json()['code']), (402, 'AI_CREDITS_EXHAUSTED'))
        self.assertEqual(Generation.objects.count(), 0)
        self.assertEqual(self.board_api('post', base + '/turns', {'message': 'x'}, key='web-key-0003').status_code, 201)

    def test_a_web_turn_counts_its_fee_in_the_gemini_spend_window(self):
        from unittest.mock import patch
        from apps.generation.services import admission
        chat = self.new_chat()
        base = f"sidekick-chats/{chat['id']}"
        plain = self.board_api('post', base + '/turns', {'message': 'a'}, key='web-key-0004').json()['job']
        web = self.board_api('post', base + '/turns', {'message': 'a', 'webSearch': True}, key='web-key-0005').json()['job']
        plain_cost, web_cost = (Generation.objects.get(pk=item['generationId']).cost_cents for item in (plain, web))
        self.assertGreater(web_cost, plain_cost)
        Generation.objects.filter(pk=web['generationId']).update(status='cancelled')
        Generation.objects.create(id=uuid.uuid4(), kind='text', status='succeeded', prompt='x', model=f'Gemini ({MODEL})', aspect_ratio='',
                                  user_id=self.actor_id, cost_cents=5, created_at=now(), updated_at=now())
        # The window holds 5 already: room for the plain turn (admission prices a job at cost times the best-of multiplier),
        # not for the web turn that costs the fee more.
        with patch.dict('os.environ', {'GEMINI_SPEND_LIMIT_CENTS': str(5 + plain_cost * admission.best_of_multiplier())}):
            self.assertNotIn('heldForBudget', admission.queue_position(plain['generationId']))
            Generation.objects.filter(pk=web['generationId']).update(status='queued')
            self.assertTrue(admission.queue_position(web['generationId'])['heldForBudget'])

    def test_the_fee_is_kept_when_the_answer_reports_a_search_and_refunded_when_it_does_not(self):
        chat = self.new_chat()
        base = f"sidekick-chats/{chat['id']}/turns"
        grounded = self.board_api('post', base, {'message': 'one', 'webSearch': True}, key='web-key-0006').json()['job']
        quoted = Generation.objects.get(pk=grounded['generationId']).cost_cents
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(grounded['generationId'])['kind'], 'succeeded')
        self.assertEqual(fake.board_payloads[0]['tools'], [{'google_search': {}}])
        self.assertEqual(Generation.objects.get(pk=grounded['generationId']).cost_cents, quoted)
        silent = self.board_api('post', base, {'message': 'two', 'webSearch': True}, key='web-key-0007').json()['job']
        quoted = Generation.objects.get(pk=silent['generationId']).cost_cents
        with FakeProviders() as fake:
            fake.web_search_ran = False
            self.assertEqual(self.run_worker(silent['generationId'])['kind'], 'succeeded')
        row = Generation.objects.get(pk=silent['generationId'])
        self.assertEqual(row.cost_cents, self.token_cents(silent['generationId']))
        self.assertLess(row.cost_cents, quoted)
        self.assertEqual(self.personal('get', 'credits').json()['credits']['usedCents'], Generation.objects.get(pk=grounded['generationId']).cost_cents + row.cost_cents)

    def test_a_plain_turn_never_pays_or_sends_the_fee(self):
        chat = self.new_chat()
        job = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'one', 'webSearch': False}, key='web-key-0008').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual((row.submission_input['format'], row.cost_cents), ('sidekick', self.token_cents(job['generationId'])))

    def test_flow_steps_with_web_search_are_quoted_priced_and_run_with_grounding(self):
        step = {'task': 'Find the release date.', 'inputs': [{'text': 'a film'}]}
        plain = self.board_api('post', 'flows/steps/quote', step).json()['quote']
        web = self.board_api('post', 'flows/steps/quote', {**step, 'webSearch': True}).json()['quote']
        self.assertEqual((web['format'], web['webSearch'], web['costCents'] - plain['costCents']), ('flowstep-web', True, web['groundingCents']))
        run = self.board_api('post', 'flows/quote', {'steps': [step, {**step, 'webSearch': True}]}).json()['quote']
        self.assertEqual((run['costCents'], 'groundingCents' in run['steps'][0], run['steps'][1]['groundingCents']),
                         (plain['costCents'] + web['costCents'], False, web['groundingCents']))
        self.assertEqual(self.board_api('post', 'flows/steps/quote', {**step, 'webSearch': 1}).status_code, 400)
        job = self.board_api('post', 'flows/steps', {**step, 'webSearch': True}, key='web-key-0009').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual((row.submission_input['format'], row.cost_cents), ('flowstep-web', web['costCents']))
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')
        self.assertEqual(fake.board_payloads[0]['tools'], [{'google_search': {}}])
        self.assertEqual(self.board_api('get', f"work/{job['id']}").json()['job']['result'], {'text': 'Mock flow output'})

    def test_a_flow_step_keeps_its_web_search_setting(self):
        raw = {'id': 'n1', 'type': 'sticky', 'x': 0, 'y': 0, 'w': 10, 'h': 10, 'text': 'a', 'flow': {'block': 'instruction', 'task': 't', 'webSearch': True}}
        self.assertEqual(node(raw)['flow'], {'block': 'instruction', 'task': 't', 'webSearch': True})
        self.assertNotIn('webSearch', node({**raw, 'flow': {**raw['flow'], 'webSearch': 'yes'}})['flow'])


class SidekickChatTests(AssistantFixture):
    def test_a_turn_is_quoted_then_submitted_once_and_carries_the_sidekick_and_board_in_the_first_turn(self):
        self.board.data = {'version': 1, 'nodes': [{'id': 'n1', 'type': 'sticky', 'x': 1, 'y': 2, 'w': 100, 'h': 80, 'text': 'Opening scene'}]}
        self.board.save()
        chat = self.new_chat()
        path = f"sidekick-chats/{chat['id']}"
        quote = self.board_api('post', path + '/quote', {'message': 'Cluster these', 'selection': ['n1']})
        self.assertEqual(quote.status_code, 200, quote.content)
        self.assertGreaterEqual(quote.json()['quote']['costCents'], 1)
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (0, 0))
        first = self.board_api('post', path + '/turns', {'message': 'Cluster these', 'selection': ['n1']}, key='turn-key-0001')
        self.assertEqual(first.status_code, 201, first.content)
        job = first.json()['job']
        again = self.board_api('post', path + '/turns', {'message': 'Cluster these', 'selection': ['n1']}, key='turn-key-0001')
        self.assertEqual(again.json()['job']['id'], job['id'])
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (1, 1))
        turns = Generation.objects.get().submission_input['turns']
        self.assertEqual([turn['role'] for turn in turns], ['user', 'model', 'user'])
        self.assertIn('UX Researcher', turns[0]['text'])
        self.assertIn('*n1|sticky|1,2,100,80|Opening scene', turns[0]['text'])
        self.assertEqual(turns[2]['text'], 'Cluster these')
        conflict = self.board_api('post', path + '/turns', {'message': 'Something else'}, key='turn-key-0001')
        self.assertEqual(conflict.status_code, 409)
        # A retry after the board changed (an autosave between a lost response and the retry) is still the same request.
        self.board.data = {'version': 1, 'nodes': [{'id': 'n2', 'type': 'sticky', 'x': 0, 'y': 0, 'w': 10, 'h': 10, 'text': 'New'}]}
        self.board.save()
        retry = self.board_api('post', path + '/turns', {'message': 'Cluster these', 'selection': ['n1']}, key='turn-key-0001')
        self.assertEqual((retry.status_code, retry.json()['job']['id']), (201, job['id']))
        # The panel's own job list never shows chat jobs; the chat's history does.
        self.assertEqual(self.jobs(), [])
        self.finish(job)
        detail = self.board_api('get', path).json()
        self.assertEqual([(turn['prompt'], turn['status']) for turn in detail['turns']], [('Cluster these', 'succeeded')])
        self.assertEqual(detail['turns'][0]['result']['reply'], sidekick.MOCK_OUTPUTS['sidekick']['reply'])
        second = self.board_api('post', path + '/turns', {'message': 'And now?'}, key='turn-key-0002').json()['job']
        roles = [turn['role'] for turn in Generation.objects.get(pk=second['generationId']).submission_input['turns']]
        self.assertEqual(roles, ['user', 'model', 'user', 'model', 'user'])

    def test_a_custom_sidekick_queues_the_plain_format_with_its_knowledge_and_sources_stay_inside_veevee(self):
        made = self.personal('post', 'sidekicks', {'name': 'Scout', 'instructions': 'Find facts.',
                                                   'knowledge': [{'name': 'a.txt', 'text': 'Fact sheet'}]}).json()['sidekick']
        chat = self.new_chat(made['id'])
        job = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'Research it'}, key='turn-key-0003').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual(row.submission_input['format'], 'sidekick')
        self.assertIn('Fact sheet', row.submission_input['turns'][0]['text'])
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')
        self.assertNotIn('tools', fake.board_payloads[0])
        bad = self.board_api('post', f"sidekick-chats/{chat['id']}/quote", {'message': 'x', 'sources': [{'kind': 'url', 'id': 'http://example.com'}]})
        self.assertEqual(bad.status_code, 400)
        missing = self.board_api('post', f"sidekick-chats/{chat['id']}/quote", {'message': 'x', 'sources': [{'kind': 'board', 'id': str(uuid.uuid4())}]})
        self.assertEqual(missing.status_code, 404)
        # A retry of an accepted turn gets that job even after the Sidekick was deleted; a new message is refused.
        self.personal('delete', f"sidekicks/{made['id']}")
        retry = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'Research it'}, key='turn-key-0003')
        self.assertEqual((retry.status_code, retry.json()['job']['id']), (201, job['id']))
        fresh = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'Research it'}, key='turn-key-0004')
        self.assertEqual(fresh.json()['code'], 'SIDEKICK_DELETED')
        self.assertEqual(BoardAiJob.objects.count(), 1)

    def test_a_new_chat_is_quoted_without_creating_it(self):
        quote = self.board_api('post', 'sidekick-chats/quote', {'sidekick': 'ux-researcher', 'message': 'Cluster these'})
        self.assertEqual(quote.status_code, 200, quote.content)
        self.assertGreaterEqual(quote.json()['quote']['costCents'], 1)
        self.assertEqual((BoardSidekickChat.objects.count(), Generation.objects.count()), (0, 0))
        self.assertEqual(self.board_api('post', 'sidekick-chats/quote', {'message': 'x'}).status_code, 400)
        self.assertEqual(self.board_api('post', 'sidekick-chats/quote', {'sidekick': 'nope', 'message': 'x'}).status_code, 404)
        wide = self.personal('post', 'sidekicks', {'name': 'Wide', 'knowledge': [{'name': 'a.txt', 'text': '\u0915' * 150_000}]}).json()['sidekick']
        refused = self.board_api('post', 'sidekick-chats/quote', {'sidekick': wide['id'], 'message': 'x'})
        self.assertEqual(refused.status_code, 400)
        self.assertIn('too large', refused.json()['error'])

    def test_chats_are_private_listed_renamed_and_deleted(self):
        chat = self.new_chat()
        # A chat with nothing sent yet has no history, so it is not listed until something is sent.
        self.assertEqual(self.board_api('get', 'sidekick-chats').json()['chats'], [])
        self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'hi'}, key='chat-list-0001')
        self.assertEqual([item['id'] for item in self.board_api('get', 'sidekick-chats').json()['chats']], [chat['id']])
        BoardSidekickChat.objects.filter(pk=chat['id']).update(user_id=uuid.uuid4())
        self.assertEqual(self.board_api('get', 'sidekick-chats').json()['chats'], [])
        self.assertEqual(self.board_api('get', f"sidekick-chats/{chat['id']}").status_code, 404)
        BoardSidekickChat.objects.filter(pk=chat['id']).update(user_id=self.actor_id)
        renamed = self.board_api('patch', f"sidekick-chats/{chat['id']}", {'title': 'Scene work'}).json()['chat']
        self.assertEqual(renamed['title'], 'Scene work')
        self.assertEqual(self.board_api('delete', f"sidekick-chats/{chat['id']}").status_code, 200)
        self.assertEqual(BoardSidekickChat.objects.count(), 0)
        self.assertEqual(self.board_api('post', 'sidekick-chats', {'sidekick': 'nope'}).status_code, 404)

    def test_viewers_and_commenters_cannot_chat_run_flows_or_catch_up_but_may_search(self):
        chat = self.new_chat()
        for role in ('view', 'comment'):
            self.board.team_role = role
            self.board.save()
            with self.subTest(role):
                for method, action, body in (('post', 'sidekick-chats', {'sidekick': 'ux-researcher'}),
                                             ('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'hi'}),
                                             ('post', 'flows/steps', {'task': 'x'}), ('post', 'flow-versions', {'nodeId': 'a', 'text': 'b'})):
                    self.assertEqual(self.board_api(method, action, body, key='viewer-key-0001').status_code, 403, action)
                self.assertEqual(self.board_api('post', 'visit').status_code, 200)
                for method, action, body in (('get', 'catch-up', None), ('post', 'catch-up/quote', {}), ('post', 'catch-up/jobs', {})):
                    self.assertEqual(self.board_api(method, action, body, key='viewer-key-0002').status_code, 403, action)
                self.assertEqual(self.board_api('post', 'ai-search/quote', {'query': 'my boards'}).status_code, 200)
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (0, 0))


class AiCreditTests(AssistantFixture):
    def test_the_monthly_cap_blocks_submission_and_the_credits_report_use_and_prices(self):
        credits = self.personal('get', 'credits').json()['credits']
        self.assertEqual((credits['capCents'], credits['usedCents']), (10000000, 0))
        self.assertGreater(credits['prices']['sidekick']['advanced'], credits['prices']['sidekick']['basic'])
        chat = self.new_chat()
        path = f"sidekick-chats/{chat['id']}/turns"
        job = self.board_api('post', path, {'message': 'one'}, key='credit-key-0001').json()['job']
        used = self.personal('get', 'credits').json()['credits']['usedCents']
        self.assertEqual(used, job['costCents'])
        self.assertEqual(self.board_api('post', f"sidekick-chats/{chat['id']}/quote", {'message': 'x'}).json()['quote']['credits']['usedCents'], used)
        from django.db import connection
        with connection.cursor() as cursor:
            cursor.execute("INSERT INTO settings VALUES ('boardAiMonthlyCapCents', %s, 0)", [str(used)])
        if True:  # noqa
            refused = self.board_api('post', path, {'message': 'two'}, key='credit-key-0002')
            self.assertEqual((refused.status_code, refused.json()['code']), (402, 'AI_CREDITS_EXHAUSTED'))
            old = self.submit({'format': 'stickies', 'prompt': 'ideas'}, key='credit-key-0003')
            self.assertEqual((old.status_code, old.json()['code']), (429, 'AI_ALLOWANCE_REACHED'))
            # A replay of the accepted key still returns the first job.
            self.assertEqual(self.board_api('post', path, {'message': 'one'}, key='credit-key-0001').json()['job']['id'], job['id'])
        self.assertEqual(Generation.objects.count(), 1)
        self.assertEqual(self.personal('post', 'credits/request', {'message': 'please'}).status_code, 404)

    def test_both_board_ai_switches_block_sidekick_jobs(self):
        from apps.admin_dashboard import workspace
        from apps.admin_dashboard.models import AppSetting
        path = f"sidekick-chats/{self.new_chat()['id']}/turns"
        workspace.save(workspace.FEATURES_KEY, {'board_ai': {'mode': 'none', 'userIds': []}})
        refused = self.board_api('post', path, {'message': 'one'}, key='switch-key-0001')
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'FEATURE_DISABLED'))
        workspace.save(workspace.FEATURES_KEY, {})
        AppSetting.objects.create(key='boardAiEnabled', value='0', updated_at=1)
        refused = self.board_api('post', path, {'message': 'one'}, key='switch-key-0002')
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'AI_DISABLED'))
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (0, 0))

    def test_failed_jobs_do_not_use_credits_and_last_months_jobs_do_not_count(self):
        chat = self.new_chat()
        job = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'one'}, key='credit-key-0004').json()['job']
        Generation.objects.filter(pk=job['generationId']).update(status='failed')
        self.assertEqual(ai_allowance.spent_cents(self.actor_id), 0)
        Generation.objects.filter(pk=job['generationId']).update(status='succeeded')
        self.assertGreater(ai_allowance.spent_cents(self.actor_id), 0)
        self.assertEqual(ai_allowance.spent_cents(self.actor_id, now=now() + 62 * 24 * 60 * 60 * 1000), 0)

    def test_usage_analytics_are_for_administrators_and_can_hide_people(self):
        self.board_api('post', f"sidekick-chats/{self.new_chat()['id']}/turns", {'message': 'one'}, key='usage-key-0001')
        self.assertEqual(self.personal('get', 'usage').status_code, 403)
        User.objects.filter(pk=self.actor_id).update(role='admin')
        data = self.personal('post', 'usage', {'period': 'week'}).json()['usage']
        self.assertEqual((data['period'], data['formats'][0]['format'], data['formats'][0]['jobs']), ('week', 'Sidekick', 1))
        self.assertEqual((data['users'][0]['id'], data['users'][0]['name']), (str(self.actor_id), 'Fixture'))
        self.assertGreater(data['totalCents'], 0)
        hidden = self.personal('post', 'usage', {'hideUsers': True}).json()['usage']
        self.assertIsNone(hidden['users'])


class FlowTests(AssistantFixture):
    def test_steps_are_quoted_alone_and_as_a_run_then_submitted_and_run(self):
        step = {'task': 'Summarize the notes.', 'inputs': [{'text': 'note one'}, {'text': 'note two'}]}
        single = self.board_api('post', 'flows/steps/quote', step).json()['quote']
        run = self.board_api('post', 'flows/quote', {'steps': [step, step]}).json()['quote']
        self.assertEqual(run['costCents'], sum(item['costCents'] for item in run['steps']))
        self.assertEqual(run['steps'][0]['costCents'], single['costCents'])
        self.assertEqual(Generation.objects.count(), 0)
        job = self.board_api('post', 'flows/steps', step, key='flow-key-0001').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual(row.submission_input['format'], 'flowstep')
        self.assertIn('note two', row.submission_input['turns'][0]['text'])
        with FakeProviders():
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')
        done = self.board_api('get', f"work/{job['id']}").json()['job']
        self.assertEqual(done['result'], {'text': 'Mock flow output'})
        for bad in ({'task': ' '}, {'task': 'x', 'inputs': 'no'}, {'task': 'x', 'inputs': [{'text': 'y'}] * 21}, {'task': 'x', 'processing': 'turbo'}):
            self.assertEqual(self.board_api('post', 'flows/steps/quote', bad).status_code, 400)
        self.assertEqual(self.board_api('post', 'flows/quote', {'steps': []}).status_code, 400)

    def test_output_versions_are_kept_for_a_day_deduplicated_capped_and_pruned(self):
        for text in ('first', 'first', 'second'):
            self.assertEqual(self.board_api('post', 'flow-versions', {'nodeId': 'step1', 'text': text}).status_code, 201)
        versions = self.board_api('get', 'flow-versions', {'nodeId': 'step1'}).json()['versions']
        self.assertEqual([item['text'] for item in versions], ['second', 'first'])
        self.assertEqual(versions[0]['by'], 'Fixture')
        FlowOutputVersion.objects.filter(text='first').update(created_at=now() - 25 * 60 * 60 * 1000)
        self.assertEqual([item['text'] for item in self.board_api('get', 'flow-versions', {'nodeId': 'step1'}).json()['versions']], ['second'])
        self.assertEqual(flows.prune_flow_versions()['deleted'], 1)
        self.assertEqual(FlowOutputVersion.objects.count(), 1)
        self.assertEqual(self.board_api('post', 'flow-versions', {'nodeId': '', 'text': 'x'}).status_code, 400)
        for index in range(flows.MAX_VERSIONS_PER_NODE + 5):
            self.board_api('post', 'flow-versions', {'nodeId': 'busy', 'text': f'v{index}'})
        self.assertEqual(FlowOutputVersion.objects.filter(node_id='busy').count(), flows.MAX_VERSIONS_PER_NODE)

    def test_the_scheduler_knows_the_pruning_job(self):
        from apps.workers import scheduler
        self.assertIn('flow_versions', scheduler.default_handlers())


class CatchUpTests(AssistantFixture):
    def change(self, text, at, actor=None):
        BoardActivity.objects.create(board_id=self.board.id, actor_id=actor or uuid.uuid4(), action='edit', node_id=f'n{text}',
                                     node_type='sticky', snippet=text, created_at=at, ordinal=0)

    def test_catch_up_summarises_changes_by_other_people_since_the_last_visit(self):
        self.assertEqual(self.board_api('post', 'visit').json(), {'previousVisitAt': None})
        self.assertEqual(self.board_api('get', 'catch-up').json()['catchUp']['changes'], 0)
        self.assertEqual(self.board_api('post', 'ai-search/quote', {'query': 'x'}).status_code, 200)
        self.assertEqual(self.board_api('post', 'catch-up/jobs', {}, key='catch-key-0001').json()['code'], 'NOTHING_CHANGED')
        self.change('Added a title', now() + 1000)
        self.change('Mine', now() + 2000, actor=self.actor_id)
        self.assertEqual(self.board_api('get', 'catch-up').json()['catchUp']['changes'], 1)
        job = self.board_api('post', 'catch-up/jobs', {}, key='catch-key-0002')
        self.assertEqual(job.status_code, 201, job.content)
        self.change('Another edit', now() + 3000)
        retry = self.board_api('post', 'catch-up/jobs', {}, key='catch-key-0002')
        self.assertEqual(retry.json()['job']['id'], job.json()['job']['id'])
        turns = Generation.objects.get(pk=job.json()['job']['generationId']).submission_input['turns']
        self.assertIn('Added a title', turns[0]['text'])
        self.assertNotIn('Mine', turns[0]['text'])
        self.finish(job.json()['job'])
        done = self.board_api('get', f"work/{job.json()['job']['id']}").json()['job']
        self.assertEqual(done['result']['summary'], sidekick.MOCK_OUTPUTS['catchup']['summary'])
        later = self.board_api('post', 'visit').json()['previousVisitAt']
        self.assertIsNotNone(later)
        week = self.board_api('get', 'catch-up', {'period': '1w'}).json()['catchUp']
        self.assertEqual((week['period'], week['changes']), ('1w', 2))


class AiSearchTests(AssistantFixture):
    def test_search_turns_a_request_into_filters_and_applies_them_to_boards_the_user_can_open(self):
        from .models import CanvasBoard
        CanvasBoard.objects.create(id=uuid.uuid4(), project_id=self.project.id, name='Teaser cut', data={'version': 1}, created_at=1,
                                   updated_at=now(), created_by=self.actor_id)
        job = self.board_api('post', 'ai-search/jobs', {'query': 'boards I updated this week'}, key='search-key-0001').json()['job']
        self.assertEqual(self.board_api('get', f"ai-search/{job['id']}").status_code, 409)
        self.finish(job)
        found = self.board_api('get', f"ai-search/{job['id']}").json()
        self.assertEqual(found['filters']['updatedWithinDays'], 7)
        self.assertEqual([item['name'] for item in found['boards']], ['Teaser cut'])
        self.assertEqual(self.board_api('post', 'ai-search/quote', {'query': ' '}).status_code, 400)
        stale = self.board_api('get', f"ai-search/{job['id']}")
        self.assertEqual(stale.status_code, 200)

    def test_search_terms_match_board_names_even_when_the_project_name_contains_them(self):
        from .models import CanvasBoard
        CanvasBoard.objects.create(id=uuid.uuid4(), project_id=self.project.id, name='Storyboard v2', data={'version': 1}, created_at=1,
                                   updated_at=now() + 1000, created_by=self.actor_id)
        job = self.board_api('post', 'ai-search/jobs', {'query': 'storyboards'}, key='search-key-0002').json()['job']
        self.finish(job)
        generation = Generation.objects.get(pk=job['generationId'])
        for terms, names in ((['board'], ['Storyboard v2']), (['storyboard', 'project'], ['Storyboard v2']),
                             (['board project'], []), ([], ['Storyboard v2', 'Ideas'])):
            generation.output = {'terms': terms, 'updatedWithinDays': 0, 'createdByMe': False, 'explanation': 'x'}
            generation.save()
            found = self.board_api('get', f"ai-search/{job['id']}").json()['boards']
            self.assertEqual([item['name'] for item in found], names, terms)
