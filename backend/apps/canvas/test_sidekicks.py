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
from . import flows, sidekicks
from .models import BoardActivity, BoardAiJob, BoardSidekickChat, FlowOutputVersion, Sidekick
from .serialization import node
from .test_ai_jobs import MODEL, BoardFixture, now


def body_of(name, turns):
    return board_formats.build_body(board_formats.submission_input(name, MODEL, turns))


class SidekickFormatTests(SimpleTestCase):
    def test_every_format_has_one_exact_allowed_shape_and_web_search_is_only_for_the_web_variants(self):
        turns = [{'role': 'user', 'text': 'context'}, {'role': 'model', 'text': 'Understood.'}, {'role': 'user', 'text': 'go'}]
        for name in sidekick.FORMATS:
            with self.subTest(name):
                body = body_of(name, turns)
                self.assertTrue(board_payload_allowed(body))
                self.assertEqual(board_formats.body_format(body), name)
                self.assertEqual('tools' in body, name.endswith('-web'))
                self.assertFalse(board_payload_allowed({**body, 'tools': [{'codeExecution': {}}]}))
                self.assertFalse(board_payload_allowed({**body, 'safetySettings': []}))
        plain = body_of('sidekick', turns)
        self.assertFalse(board_payload_allowed({**plain, 'tools': sidekick.WEB_TOOLS}))
        self.assertFalse(board_payload_allowed({**body_of('flowstep-web', turns), 'tools': None}))

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
        asking = sidekick.parse_sidekick({'reply': 'Which scene?', 'options': ['One', 'Two'], 'actions': [{'op': 'add', 'type': 'sticky', 'text': 'x'}]})
        self.assertEqual((asking['options'], asking['actions']), (['One', 'Two'], []))
        with self.assertRaises(board_formats.UnusableResult):
            sidekick.parse_sidekick({'actions': []})
        with self.assertRaises(board_formats.UnusableResult):
            sidekick.parse_flow_step({'text': '  '})
        self.assertEqual(sidekick.parse_search({'terms': ['a', 7], 'updatedWithinDays': 'x', 'createdByMe': 'yes'})['updatedWithinDays'], 0)
        self.assertEqual(sidekick.lenient_json('```json\n{"text": "a"}\n```'), '{"text": "a"}')

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

    def test_a_custom_sidekick_is_validated_owned_and_shared(self):
        files = [{'name': 'notes.md', 'text': 'The hero is called Mara.'}]
        created = self.personal('post', 'sidekicks', {'name': 'Mara Expert', 'instructions': 'Answer as Mara.', 'starters': ['Hi'], 'knowledge': files,
                                                      'webSearch': True, 'hideInstructions': True})
        self.assertEqual(created.status_code, 201, created.content)
        item = created.json()['sidekick']
        self.assertEqual((item['name'], item['mine'], item['shared'], item['webSearch']), ('Mara Expert', True, False, True))
        self.assertEqual(item['knowledge'], [{'name': 'notes.md', 'chars': len(files[0]['text'])}])
        for bad, message in (({'name': ' '}, 'name'), ({'name': 'x', 'knowledge': [{'name': 'a.pdf', 'text': 'x'}]}, 'type'),
                             ({'name': 'x', 'knowledge': [{'name': 'a.txt', 'text': 'x' * (sidekicks.KNOWLEDGE_CHARS + 1)}]}, 'tokens'),
                             ({'name': 'x', 'knowledge': [{'name': f'{n}.txt', 'text': 'x'} for n in range(sidekicks.MAX_FILES + 1)]}, 'count'),
                             ({'name': 'x', 'starters': ['a'] * 7}, 'starters'), ({'name': 'x', 'processing': 'turbo'}, 'processing')):
            with self.subTest(message):
                self.assertEqual(self.personal('post', 'sidekicks', bad).status_code, 400)
        updated = self.personal('patch', f"sidekicks/{item['id']}", {'shared': True}).json()['sidekick']
        self.assertEqual((updated['shared'], updated['name']), (True, 'Mara Expert'))
        # Another person sees a shared Sidekick but not its hidden instructions, and cannot change it.
        other = User(id=uuid.uuid4(), name='Other', role='user')
        row = Sidekick.objects.get(pk=item['id'])
        seen = sidekicks.sidekick_json(row, other)
        self.assertNotIn('instructions', seen)
        self.assertFalse(seen['mine'])
        with self.assertRaises(sidekicks.JobError):
            sidekicks.custom_row(other, str(row.id), owned=True)
        Sidekick.objects.filter(pk=row.pk).update(shared=False)
        with self.assertRaises(sidekicks.JobError):
            sidekicks.custom_row(other, str(row.id))
        self.assertEqual(self.personal('delete', f"sidekicks/{item['id']}").status_code, 200)
        self.assertEqual(Sidekick.objects.count(), 0)


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
        # The panel's own job list never shows chat jobs; the chat's history does.
        self.assertEqual(self.jobs(), [])
        self.finish(job)
        detail = self.board_api('get', path).json()
        self.assertEqual([(turn['prompt'], turn['status']) for turn in detail['turns']], [('Cluster these', 'succeeded')])
        self.assertEqual(detail['turns'][0]['result']['reply'], sidekick.MOCK_OUTPUTS['sidekick']['reply'])
        second = self.board_api('post', path + '/turns', {'message': 'And now?'}, key='turn-key-0002').json()['job']
        roles = [turn['role'] for turn in Generation.objects.get(pk=second['generationId']).submission_input['turns']]
        self.assertEqual(roles, ['user', 'model', 'user', 'model', 'user'])

    def test_a_custom_sidekick_with_web_search_queues_the_web_format_and_sources_stay_inside_veevee(self):
        made = self.personal('post', 'sidekicks', {'name': 'Scout', 'instructions': 'Find facts.', 'webSearch': True,
                                                   'knowledge': [{'name': 'a.txt', 'text': 'Fact sheet'}]}).json()['sidekick']
        chat = self.new_chat(made['id'])
        job = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'Research it'}, key='turn-key-0003').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual(row.submission_input['format'], 'sidekick-web')
        self.assertIn('Fact sheet', row.submission_input['turns'][0]['text'])
        with FakeProviders() as fake:
            self.assertEqual(self.run_worker(job['generationId'])['kind'], 'succeeded')
        self.assertEqual(fake.board_payloads[0]['tools'], sidekick.WEB_TOOLS)
        bad = self.board_api('post', f"sidekick-chats/{chat['id']}/quote", {'message': 'x', 'sources': [{'kind': 'url', 'id': 'http://example.com'}]})
        self.assertEqual(bad.status_code, 400)
        missing = self.board_api('post', f"sidekick-chats/{chat['id']}/quote", {'message': 'x', 'sources': [{'kind': 'board', 'id': str(uuid.uuid4())}]})
        self.assertEqual(missing.status_code, 404)

    def test_chats_are_private_listed_renamed_and_deleted(self):
        chat = self.new_chat()
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

    def test_viewers_and_commenters_cannot_chat_or_run_flows_but_may_catch_up_and_search(self):
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
                self.assertEqual(self.board_api('get', 'catch-up').status_code, 200)
                self.assertEqual(self.board_api('post', 'ai-search/quote', {'query': 'my boards'}).status_code, 200)
        self.assertEqual((Generation.objects.count(), BoardAiJob.objects.count()), (0, 0))


class AiCreditTests(AssistantFixture):
    def test_the_monthly_cap_blocks_submission_and_the_credits_report_use_and_prices(self):
        credits = self.personal('get', 'credits').json()['credits']
        self.assertEqual((credits['capCents'], credits['usedCents']), (5000, 0))
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
            self.assertEqual((old.status_code, old.json()['code']), (402, 'AI_CREDITS_EXHAUSTED'))
            # A replay of the accepted key still returns the first job.
            self.assertEqual(self.board_api('post', path, {'message': 'one'}, key='credit-key-0001').json()['job']['id'], job['id'])
        self.assertEqual(Generation.objects.count(), 1)
        self.assertEqual(self.personal('post', 'credits/request', {'message': 'please'}).status_code, 200)

    def test_failed_jobs_do_not_use_credits_and_last_months_jobs_do_not_count(self):
        chat = self.new_chat()
        job = self.board_api('post', f"sidekick-chats/{chat['id']}/turns", {'message': 'one'}, key='credit-key-0004').json()['job']
        Generation.objects.filter(pk=job['generationId']).update(status='failed')
        self.assertEqual(sidekicks.credits_used(self.actor_id), 0)
        Generation.objects.filter(pk=job['generationId']).update(status='succeeded')
        self.assertGreater(sidekicks.credits_used(self.actor_id), 0)
        self.assertEqual(sidekicks.credits_used(self.actor_id, now=now() + 62 * 24 * 60 * 60 * 1000), 0)

    def test_usage_analytics_are_for_administrators_and_can_hide_people(self):
        self.board_api('post', f"sidekick-chats/{self.new_chat()['id']}/turns", {'message': 'one'}, key='usage-key-0001')
        self.assertEqual(self.personal('get', 'usage').status_code, 403)
        User.objects.filter(pk=self.actor_id).update(role='admin')
        data = self.personal('post', 'usage', {'period': 'week'}).json()['usage']
        self.assertEqual((data['period'], data['formats'][0]['format'], data['formats'][0]['jobs']), ('week', 'Sidekick', 1))
        self.assertEqual(data['users'][0]['name'], 'Fixture')
        self.assertGreater(data['totalCents'], 0)
        hidden = self.personal('post', 'usage', {'hideUsers': True}).json()['usage']
        self.assertIsNone(hidden['users'])


class FlowTests(AssistantFixture):
    def test_steps_are_quoted_alone_and_as_a_run_then_submitted_and_run_with_the_web_variant_on_request(self):
        step = {'task': 'Summarize the notes.', 'inputs': [{'text': 'note one'}, {'text': 'note two'}]}
        single = self.board_api('post', 'flows/steps/quote', step).json()['quote']
        run = self.board_api('post', 'flows/quote', {'steps': [step, {**step, 'webSearch': True}]}).json()['quote']
        self.assertEqual(run['costCents'], sum(item['costCents'] for item in run['steps']))
        self.assertEqual(run['steps'][0]['costCents'], single['costCents'])
        self.assertEqual(Generation.objects.count(), 0)
        job = self.board_api('post', 'flows/steps', {**step, 'webSearch': True}, key='flow-key-0001').json()['job']
        row = Generation.objects.get(pk=job['generationId'])
        self.assertEqual(row.submission_input['format'], 'flowstep-web')
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
        turns = Generation.objects.get(pk=job.json()['job']['generationId']).submission_input['turns']
        self.assertIn('Added a title', turns[0]['text'])
        self.assertNotIn('Mine', turns[0]['text'])
        self.finish(job.json()['job'])
        done = self.board_api('get', f"work/{job.json()['job']['id']}").json()['job']
        self.assertEqual(done['result']['summary'], sidekick.MOCK_OUTPUTS['catchup']['summary'])
        later = self.board_api('post', 'visit').json()['previousVisitAt']
        self.assertIsNotNone(later)
        week = self.board_api('get', 'catch-up', {'period': '1w'}).json()['catchUp']
        self.assertEqual((week['period'], week['changes']), ('1w', 1))


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
