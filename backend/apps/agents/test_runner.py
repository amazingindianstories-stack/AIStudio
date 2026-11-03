"""The run engine (apps.agents.runner): the journal, replay after a crash, the inbox, approvals, waits, cancel, bounds.

Gemini is faked below the transport (``HttpTransport._send``), so every step still passes ``AgentLoopTransport``'s
allowlist and writes its usage row; tools run in-process through ``server.dispatch`` as the run's agent grant, and paid
tools only queue rows, as in the MCP tests. No network is used.
"""
import json
import os
import threading
from types import SimpleNamespace
from threading import Event
from unittest.mock import Mock, patch

from django.db import connection

from apps.admin_dashboard.models import AppSetting, Pricing, UserLimit
from apps.generation.models import Generation
from apps.integrations.transport import HttpResult, HttpTransport
from apps.library.models import Folder
from apps.mcp import server
from apps.mcp_auth import policy
from apps.mcp.tests.support import McpCase
from apps.mcp.tests.test_paid_tools import mid_minute
from apps.mcp.tests.test_results import StorageMixin
from apps.projects.models import Project
from apps.workers import scheduler
from . import design, events, grants, limits, runner, runs, worker
from .models import (AgentChatAsset, AgentConversation, AgentConversationMessage, AgentGrant, AgentInboxMessage, AgentLlmUsage,
                     AgentRun, AgentRunEvent, AgentRunStep)

USAGE = {'promptTokenCount': 1000, 'candidatesTokenCount': 100, 'totalTokenCount': 1100}
HELD = SimpleNamespace(held=True)


def call(name, args=None, identifier=None):
    function = {'name': name, 'args': args or {}}
    if identifier:
        function['id'] = identifier
    return {'functionCall': function, 'thoughtSignature': 'c2ln'}


def text(value):
    return {'text': value}


def reply(*parts):
    return HttpResult(200, json.dumps({'candidates': [{'content': {'role': 'model', 'parts': list(parts)}, 'finishReason': 'STOP'}],
                                       'usageMetadata': USAGE}).encode())


class RunnerCase(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        clock = patch('apps.mcp_auth.controls.now_ms', return_value=mid_minute())
        clock.start()
        self.addCleanup(clock.stop)
        key = patch.dict(os.environ, {'GOOGLE_API_KEY': 'fixture-key'})
        key.start()
        self.addCleanup(key.stop)
        backoff = patch.object(runner, 'LLM_RETRY_SECONDS', (0, 0))
        backoff.start()
        self.addCleanup(backoff.stop)
        AppSetting.objects.create(key='agentsEnabled', value='1', updated_at=1)
        self.price(6)
        self.project = Project.objects.create(name='Winter', created_at=1, updated_at=1)
        self.folder = Folder.objects.create(project=self.project, name='Hero shots', created_at=1)
        self.other = Folder.objects.create(project=self.project, name='Alternates', created_at=1)
        self.grant = grants.ensure_grant(self.user.id)
        self.conversation = AgentConversation.objects.create(
            project_id=self.project.id, name='Chat', kind='chat', agent_kind='image', user_id=self.user.id,
            created_by=self.user.id, default_project_id=self.project.id, default_folder_id=self.folder.id, created_at=1, updated_at=1)

    def price(self, cents):
        Pricing.objects.bulk_create([Pricing(model='Nano Banana 2.1', unit_cost_cents=cents, unit='per_image', notes='')],
                                    ignore_conflicts=True)
        Pricing.objects.filter(model='Nano Banana 2.1').update(unit_cost_cents=cents)

    def start_run(self, message='Make a red fox', **fields):
        AgentConversationMessage.objects.create(conversation_id=self.conversation.id, role='user', content=message, created_at=10)
        values = {'conversation_id': self.conversation.id, 'user_id': self.user.id, 'grant_id': self.grant.id,
                  'model': 'gemini-3.8-flash', 'created_at': 10, 'updated_at': 10, **fields}
        return AgentRun.objects.create(**values)

    def gemini(self, *replies):
        """Answer each Gemini call with the next reply: parts, an ``HttpResult``, an exception to raise, or a callable
        run first (the artist acting mid-step) that returns one of those. Returns the request bodies."""
        bodies, queue = [], list(replies)

        def send(transport, method, url, **kwargs):
            bodies.append(kwargs['body'])
            answer = queue.pop(0)
            answer = answer() if callable(answer) else answer
            if isinstance(answer, Exception):
                raise answer
            return answer if isinstance(answer, HttpResult) else reply(*answer)
        sender = patch.object(HttpTransport, '_send', send)
        sender.start()
        self.addCleanup(sender.stop)
        return bodies

    def dispatched(self):
        """The arguments of every in-process tool call."""
        sent, real = [], server.dispatch

        async def spy(principal, name, arguments, **options):
            sent.append((name, dict(arguments), options['tags']))
            return await real(principal, name, arguments, **options)
        spying = patch.object(server, 'dispatch', spy)
        spying.start()
        self.addCleanup(spying.stop)
        return sent

    def advance(self, run, stop=None, now=None):
        return runner.advance(run.id, lease=HELD, stop=stop or Event(), **({'now': now} if now else {}))

    def refresh(self, run):
        return AgentRun.objects.get(pk=run.id)

    def steps(self, run):
        return list(AgentRunStep.objects.filter(run_id=run.id).order_by('step_index'))

    def kinds(self, run):
        return list(AgentRunEvent.objects.filter(run_id=run.id).order_by('seq').values_list('kind', flat=True))

    def finish_jobs(self, run, status='completed'):
        Generation.objects.filter(agent_run_id=run.id).update(status=status)


class LoopTests(RunnerCase):
    def test_a_run_journals_each_step_and_ends_with_the_models_reply(self):
        bodies = self.gemini([text('Checking.'), call('list_models', {}, 'c1')], [text('Here are the models.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed')
        run = self.refresh(run)
        self.assertEqual((run.status, run.step_count, run.cost_cents), ('completed', 3, 0))
        self.assertIsNotNone(run.started_at)
        self.assertIsNotNone(run.finished_at)
        steps = self.steps(run)
        self.assertEqual([(step.step_index, step.kind, step.tool_name, step.outcome) for step in steps],
                         [(0, 'llm', None, 'calls'), (1, 'tool', 'list_models', 'ok'), (2, 'llm', None, 'final')])
        self.assertEqual([step.idempotency_key for step in steps], [None, f'{run.id}:1', None])
        self.assertTrue(all(len(step.input_hash) == 64 for step in steps))
        # The first turn is the chat; the second adds the model turn (thought signature kept) and its response.
        self.assertEqual(bodies[0]['contents'], [{'role': 'user', 'parts': [{'text': 'Make a red fox'}]}])
        self.assertEqual(bodies[1]['contents'][1], {'role': 'model', 'parts': [text('Checking.'), call('list_models', {}, 'c1')]})
        response = bodies[1]['contents'][2]['parts'][0]['functionResponse']
        self.assertEqual((response['name'], response['id']), ('list_models', 'c1'))
        self.assertIn('models', response['response'])
        message = AgentConversationMessage.objects.get(conversation_id=self.conversation.id, role='assistant')
        self.assertEqual((message.content, message.tool_trace), ('Here are the models.', {'runId': str(run.id), 'stepIndex': 2}))
        self.assertEqual(self.kinds(run), ['run_started', 'step_started', 'assistant_text', 'step_started', 'tool_called',
                                           'step_started', 'assistant_text', 'completed'])
        self.assertEqual(list(AgentRunEvent.objects.filter(run_id=run.id).order_by('seq').values_list('seq', flat=True)),
                         list(range(1, 9)))
        self.assertEqual(list(AgentLlmUsage.objects.filter(run_id=run.id).order_by('step_index').values_list('step_index', 'purpose')),
                         [(0, 'step'), (2, 'step')])
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).status, 'completed')

    def test_a_call_to_a_tool_the_grant_cannot_use_is_dropped_and_explained(self):
        bodies = self.gemini([call('admin_list_users', {})], [text('Sorry, I cannot do that.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(self.steps(run)[0].result['rejected'], ['admin_list_users'])
        # The refused call is not replayed to the model (the loop allowlist only carries declared tools); a note is.
        self.assertEqual(bodies[1]['contents'], [{'role': 'user', 'parts': [
            {'text': 'Make a red fox'}, {'text': 'Veevee: admin_list_users is not a tool you can call. Use only the declared tools.'}]}])
        self.assertEqual([step.kind for step in self.steps(run)], ['llm', 'llm'])

    def test_missing_credentials_fail_the_run_instead_of_pretending(self):
        run = self.start_run()
        with patch.dict(os.environ, {'GOOGLE_API_KEY': ''}):
            self.assertEqual(self.advance(run), 'failed')
        self.assertEqual(self.refresh(run).error['code'], 'llm_unconfigured')

    def test_transient_model_errors_are_retried_then_fail_the_run(self):
        self.gemini(HttpResult(503, b'{}'), [text('Done.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual([step.result.get('attempts') for step in self.steps(run)], [1])
        self.gemini(HttpResult(503, b'{}'), HttpResult(429, b'{}'), HttpResult(500, b'{}'))
        AgentConversationMessage.objects.all().delete()
        second = self.start_run(created_at=20)
        AgentRun.objects.filter(pk=run.id).delete()
        self.assertEqual(self.advance(second), 'failed')
        self.assertEqual(self.refresh(second).error['code'], 'llm_failed')
        self.gemini(HttpResult(400, b'{}'))
        AgentRun.objects.filter(pk=second.id).delete()
        third = self.start_run(created_at=30)
        self.assertEqual(self.advance(third), 'failed')
        self.assertEqual(self.steps(third)[0].result['attempts'], 1, 'a refused request is not retried')


class PaidToolTests(RunnerCase):
    def test_paid_jobs_never_wait_link_to_the_run_and_land_in_the_chats_folder(self):
        sent = self.dispatched()
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox in snow'})], [text('Your fox is ready.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        run = self.refresh(run)
        self.assertEqual(run.status, 'waiting_jobs')
        name, arguments, tags = sent[0]
        self.assertEqual((name, arguments['wait'], arguments['idempotencyKey'], arguments['folderId']),
                         ('generate_image', False, f'{run.id}:1', str(self.folder.id)))
        self.assertEqual(tags, {'runId': str(run.id), 'stepIndex': 1})
        job = Generation.objects.get()
        self.assertEqual((job.agent_run_id, job.created_via, job.mcp_token_id, job.folder_id, job.status),
                         (run.id, 'agent', self.grant.id, self.folder.id, 'queued'))
        self.assertEqual((run.cost_cents, self.steps(run)[1].cost_cents), (6, 6))
        asset = AgentChatAsset.objects.get()
        self.assertEqual((asset.conversation_id, asset.asset_id, asset.source, asset.kind, asset.run_id),
                         (self.conversation.id, job.id, 'output', 'image', run.id))
        queued = AgentRunEvent.objects.get(run_id=run.id, kind='job_queued').payload
        self.assertEqual(queued, {'generationId': str(job.id), 'kind': 'image', 'tool': 'generate_image', 'stepIndex': 1})
        # Rechecked each tick, without another model call, until the job is terminal.
        self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual((len(bodies), self.kinds(run).count('waiting_jobs')), (1, 1))
        self.finish_jobs(run)
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(bodies[1]['contents'][-1]['parts'][-1],
                         {'text': f'Veevee: these jobs finished since your last turn: image {job.id} completed. '
                                  'get_generation shows each result.'})
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='job_finished').payload,
                         {'generationId': str(job.id), 'kind': 'image', 'status': 'completed', 'stepIndex': 2})

    def test_a_folder_the_model_names_is_respected_and_harness_fields_it_sends_are_dropped(self):
        sent = self.dispatched()
        forged = {'prompt': 'red fox', 'folderId': str(self.other.id), 'wait': True, 'maxWaitSeconds': 45,
                  'idempotencyKey': 'model-chosen-key', 'quoteToken': 'forged', 'confirmedByUser': True}
        self.gemini([call('generate_image', forged)])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        arguments = sent[0][1]
        self.assertEqual((arguments['folderId'], arguments['wait'], arguments['idempotencyKey']), (str(self.other.id), False, f'{run.id}:1'))
        self.assertFalse({'quoteToken', 'confirmedByUser', 'maxWaitSeconds'} & set(arguments))
        self.assertEqual(self.steps(run)[1].result['call']['args'], {'prompt': 'red fox', 'folderId': str(self.other.id)})
        self.assertEqual(Generation.objects.get().folder_id, self.other.id)

    def test_without_a_default_folder_the_chats_project_is_used(self):
        AgentConversation.objects.filter(pk=self.conversation.id).update(default_folder_id=None)
        sent = self.dispatched()
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        self.advance(self.start_run())
        self.assertEqual(sent[0][1]['projectId'], str(self.project.id))
        self.assertNotIn('folderId', sent[0][1])
        self.assertEqual((Generation.objects.get().project_id, Generation.objects.get().folder_id), (self.project.id, None))


    def test_a_search_without_a_location_is_sent_unscoped(self):
        sent = self.dispatched()
        for folder in (self.folder.id, None):
            with self.subTest(default_folder=folder):
                AgentConversation.objects.filter(pk=self.conversation.id).update(default_folder_id=folder)
                self.gemini([call('search_generations', {'text': 'fox'})], [text('Nothing found.')])
                self.assertEqual(self.advance(self.start_run()), 'completed')
                self.assertEqual(sent[-1][:2], ('search_generations', {'text': 'fox'}))


class ReplayTests(RunnerCase):
    def test_an_llm_step_without_an_outcome_is_reissued_after_the_lease_expires(self):
        bodies = self.gemini(RuntimeError('worker died mid-call'), [text('Hello again.')])
        run = self.start_run()
        with self.assertRaises(RuntimeError):
            self.advance(run)
        run = self.refresh(run)
        self.assertEqual((run.status, [(step.kind, step.outcome) for step in self.steps(run)]), ('running', [('llm', None)]))
        # The worker's heartbeat stopped; the scheduler's resume pass re-queues the run for the next worker.
        AgentRun.objects.filter(pk=run.id).update(last_heartbeat_at=1)
        scheduler.resume_agent_runs()
        self.assertEqual(self.refresh(run).status, 'queued')
        self.assertEqual(worker.runnable(), [run.id])
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual([(step.step_index, step.outcome) for step in self.steps(run)], [(0, 'final')])
        self.assertEqual(bodies[0], bodies[1], 'the same step is re-issued with the same contents')
        self.assertEqual(self.kinds(run).count('resumed'), 1)

    def test_a_tool_step_without_an_outcome_is_replayed_by_its_key_and_billed_once(self):
        sent = self.dispatched()
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.start_run()
        real = runner.finish_tool_step
        with patch.object(runner, 'finish_tool_step', side_effect=RuntimeError('worker died after submitting')):
            with self.assertRaises(RuntimeError):
                self.advance(run)
        self.assertEqual(Generation.objects.count(), 1)
        self.assertEqual([(step.kind, step.outcome) for step in self.steps(run)], [('llm', 'calls'), ('tool', None)])
        self.assertEqual(self.refresh(run).cost_cents, 0)
        with patch.object(runner, 'finish_tool_step', side_effect=real):
            self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual([arguments['idempotencyKey'] for _, arguments, _ in sent], [f'{run.id}:1'] * 2)
        job = Generation.objects.get()
        run = self.refresh(run)
        self.assertEqual((job.agent_run_id, run.cost_cents, run.status, run.step_count), (run.id, 6, 'waiting_jobs', 2))
        self.assertEqual(AgentChatAsset.objects.count(), 1)
        self.assertEqual(self.kinds(run).count('job_queued'), 1)

    def test_a_graceful_stop_or_lost_lease_requeues_the_run_at_the_next_boundary(self):
        stop = Event()
        self.gemini(lambda: (stop.set(), [call('list_models', {})])[1], [text('Done.')])
        run = self.start_run()
        self.assertEqual(self.advance(run, stop), 'stopped')
        self.assertEqual((self.refresh(run).status, len(self.steps(run))), ('queued', 1))
        lost = SimpleNamespace(held=False)
        self.assertEqual(runner.advance(run.id, lease=lost, stop=Event()), 'stopped')
        self.assertEqual(self.advance(run), 'completed')


class InboxTests(RunnerCase):
    def test_messages_are_delivered_in_order_at_the_next_boundary_and_hold_the_run_open(self):
        run = self.start_run()

        def artist_writes(*messages):
            def act():
                for content, created_at in messages:
                    AgentInboxMessage.objects.create(conversation_id=self.conversation.id, run_id=run.id, user_id=self.user.id,
                                                     content=content, created_at=created_at)
                return [call('list_models', {}, 'c1')] if len(messages) == 2 else [text('Final answer.')]
            return act
        bodies = self.gemini(artist_writes(('Make it blue', 20), ('Actually green', 15)), artist_writes(('One more thing', 30)),
                             [text('Done with that too.')])
        self.assertEqual(self.advance(run), 'completed')
        rows = list(AgentInboxMessage.objects.order_by('created_at').values_list('content', 'delivered_step'))
        self.assertEqual(rows, [('Actually green', 1), ('Make it blue', 1), ('One more thing', 3)])
        # Delivered before the next model call, after the function response, oldest first; a message that arrives
        # during the final turn keeps the run open for one more.
        self.assertEqual([part.get('text') for part in bodies[1]['contents'][-1]['parts']], [None, 'Actually green', 'Make it blue'])
        self.assertEqual(bodies[2]['contents'][-2:], [{'role': 'model', 'parts': [{'text': 'Final answer.'}]},
                                                      {'role': 'user', 'parts': [{'text': 'One more thing'}]}])
        self.assertEqual([step.outcome for step in self.steps(run)], ['calls', 'ok', 'final', 'final'])
        self.assertEqual(self.kinds(run).count('message_delivered'), 3)
        chat = list(AgentConversationMessage.objects.filter(conversation_id=self.conversation.id).order_by('created_at', 'role')
                    .values_list('role', 'content'))
        self.assertEqual(chat[0], ('user', 'Make a red fox'))
        self.assertIn(('user', 'One more thing'), chat)
        self.assertEqual(chat[-1], ('assistant', 'Done with that too.'))

    def test_a_message_delivered_before_a_retried_turn_gets_its_own_turn_before_the_run_completes(self):
        run = self.start_run()

        def artist_writes_then_unavailable():
            AgentInboxMessage.objects.create(conversation_id=self.conversation.id, run_id=run.id, user_id=self.user.id,
                                             content='Make it blue instead', created_at=20)
            return HttpResult(503, b'{}')
        bodies = self.gemini(artist_writes_then_unavailable, [text('A red fox.')], [text('A blue fox it is.')])
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(AgentInboxMessage.objects.get().delivered_step, 1)
        self.assertEqual(bodies[1]['contents'], [{'role': 'user', 'parts': [{'text': 'Make a red fox'}]}],
                         'the retried turn is the same turn, so it does not see the message')
        self.assertEqual(bodies[2]['contents'][-2:], [{'role': 'model', 'parts': [{'text': 'A red fox.'}]},
                                                      {'role': 'user', 'parts': [{'text': 'Make it blue instead'}]}])
        self.assertEqual([(step.kind, step.outcome) for step in self.steps(run)], [('llm', 'final'), ('llm', 'final')])
        self.assertEqual(list(AgentConversationMessage.objects.filter(conversation_id=self.conversation.id, role='assistant')
                              .order_by('tool_trace__stepIndex').values_list('content', flat=True)), ['A red fox.', 'A blue fox it is.'])

    def test_a_message_wakes_a_run_that_is_waiting_for_jobs(self):
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'})], [text('Making a blue one next.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        AgentInboxMessage.objects.create(conversation_id=self.conversation.id, run_id=run.id, user_id=self.user.id,
                                         content='Make it blue', created_at=20)
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(Generation.objects.get().status, 'queued', 'the job keeps running and still lands in the library')
        self.assertEqual(bodies[1]['contents'][-1]['parts'][-1], {'text': 'Make it blue'})
        self.assertEqual(AgentInboxMessage.objects.get().delivered_step, 2)

class ApprovalTests(RunnerCase):
    def setUp(self):
        super().setUp()
        AgentGrant.objects.filter(pk=self.grant.id).update(auto_approve_cents=0)

    def approve_and_replay(self, cents):
        self.price(cents)
        sent = self.dispatched()
        self.gemini([call('generate_image', {'prompt': 'red fox', 'quoteToken': 'forged', 'confirmedByUser': True})])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual(self.refresh(run).status, 'waiting_approval')
        self.assertEqual(Generation.objects.count(), 0)
        self.assertFalse({'quoteToken', 'confirmedByUser'} & set(sent[0][1]))
        event = AgentRunEvent.objects.get(run_id=run.id, kind='quote_required').payload
        self.assertEqual((event['stepIndex'], event['tool'], event['prompt'], event['quote']['costCents']), (1, 'generate_image', 'red fox', cents))
        self.assertEqual(event['arguments'], {'prompt': 'red fox', 'folderId': str(self.folder.id)})
        self.assertNotIn('token', event['quote'])
        self.assertEqual(worker.runnable(), [], 'a run waiting for approval is not advanced')
        self.assertEqual(self.advance(run), 'waiting')
        self.assertIsNone(runner.approve_quote(run.id, self.user.id, step_index=0))
        self.assertIsNotNone(runner.approve_quote(run.id, self.user.id, step_index=1))
        self.assertEqual(self.refresh(run).status, 'queued')
        self.assertEqual(self.advance(run), 'waiting')
        token = self.steps(run)[1].result['quote']['token']
        replay = sent[1][1]
        self.assertEqual((replay['quoteToken'], replay['idempotencyKey']), (token, f'{run.id}:1'))
        run = self.refresh(run)
        self.assertEqual((run.status, run.step_count, run.cost_cents, Generation.objects.get().cost_cents), ('waiting_jobs', 2, cents, cents))
        self.assertEqual(self.kinds(run).count('quote_approved'), 1)
        return replay

    def test_an_approved_quote_replays_the_same_step_with_its_token(self):
        self.assertNotIn('confirmedByUser', self.approve_and_replay(10))

    def test_at_a_dollar_or_more_the_replay_carries_the_users_confirmation(self):
        self.assertIs(self.approve_and_replay(100)['confirmedByUser'], True)

    def test_an_approved_quote_at_the_step_limit_is_still_held_to_the_daily_caps(self):
        self.price(10)
        sent = self.dispatched()
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual(self.refresh(run).step_count, 2)
        AgentLlmUsage.objects.create(user_id=self.user.id, grant_id=self.grant.id, model='m', purpose='step', prompt_tokens=1, cached_tokens=0,
                                     output_tokens=1, thoughts_tokens=0, tool_prompt_tokens=0, total_tokens=2, cost_microcents=10_000_000,
                                     created_at=limits.now_ms())
        for key, value in (('agentMaxStepsPerRun', 2), ('agentGlobalDailyCapCents', 15)):
            AppSetting.objects.update_or_create(key=key, defaults={'value': str(value), 'updated_at': 1})
        runner.approve_quote(run.id, self.user.id)
        self.assertEqual(self.advance(run), 'paused', 'the replay adds no step, but its price is checked against every cap')
        run = self.refresh(run)
        self.assertEqual((run.pause_reason, run.error['costCents'], len(sent), Generation.objects.count()),
                         ('global_daily_cap', 10, 1, 0))
        self.assertIsNotNone(run.resume_after, 'the window frees the spend that is in the way')
        AppSetting.objects.filter(key='agentGlobalDailyCapCents').update(value='20000')
        AgentRun.objects.filter(pk=run.id).update(resume_after=20)
        self.assertEqual(self.advance(run), 'waiting', 'once the cap is raised the same step is replayed, still past the step limit')
        run = self.refresh(run)
        self.assertEqual((run.status, run.step_count, len(sent), Generation.objects.get().cost_cents), ('waiting_jobs', 2, 2, 10))

    def test_an_approved_quote_priced_past_a_daily_cap_on_its_own_is_refused_to_the_model(self):
        self.price(10)
        sent = self.dispatched()
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'})], [text('That is more than today allows.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        AppSetting.objects.update_or_create(key='agentGlobalDailyCapCents', defaults={'value': '5', 'updated_at': 1})
        runner.approve_quote(run.id, self.user.id)
        self.assertEqual(self.advance(run), 'completed', 'the approval cannot fit a 10 cent call under a 5 cent cap')
        step = self.steps(run)[1]
        self.assertEqual((step.outcome, step.result['response']['code'], len(sent), Generation.objects.count(), len(bodies)),
                         ('BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 1, 0, 2))
        self.assertNotIn('paused', self.kinds(run))


class CancelTests(RunnerCase):
    def waiting_run(self, **fields):
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.start_run(**fields)
        self.assertEqual(self.advance(run), 'waiting')
        return run

    def test_stop_ends_the_run_and_keeps_its_jobs(self):
        run = self.waiting_run()
        AgentRun.objects.filter(pk=run.id).update(cancel_requested_at=99)
        self.assertIn(run.id, worker.runnable())
        cancel = Mock()
        with patch.object(runner.cancellation, 'cancel_generation', cancel):
            self.assertEqual(self.advance(run), 'cancelled')
        cancel.assert_not_called()
        self.assertEqual((self.refresh(run).status, Generation.objects.get().status), ('cancelled', 'queued'))
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='cancelled').payload, {'cancelJobs': False, 'jobs': []})

    def test_stop_and_cancel_jobs_cancels_each_active_linked_job(self):
        self.gemini([call('generate_image', {'prompt': 'red fox'}), call('generate_image', {'prompt': 'grey fox'})])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        done, job = Generation.objects.filter(agent_run_id=run.id).order_by('created_at', 'id')
        Generation.objects.filter(pk=done.id).update(status='completed')
        AgentRun.objects.filter(pk=run.id).update(cancel_requested_at=99, cancel_jobs=True)
        cancel = Mock(return_value=(SimpleNamespace(status='cancelled'), None))
        with patch.object(runner.cancellation, 'cancel_generation', cancel):
            self.assertEqual(self.advance(run), 'cancelled')
        self.assertEqual(len(cancel.call_args_list), 1)
        (identifier, actor), options = cancel.call_args
        self.assertEqual((identifier, actor.id, options), (job.id, self.user.id, {'defer': True}))
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='cancelled').payload['jobs'],
                         [{'generationId': str(job.id), 'status': 'cancelled', 'message': None}])

    def assert_message_kept(self, run, end):
        run = self.refresh(run)
        inbox = AgentInboxMessage.objects.get(run_id=run.id)
        self.assertIsNotNone(inbox.delivered_at)
        self.assertEqual(inbox.delivered_step, run.step_count)
        message = AgentConversationMessage.objects.get(conversation_id=self.conversation.id, content='Also make it blue')
        self.assertEqual((message.role, message.tool_trace), ('user', {'runId': str(run.id), 'deliveredStep': run.step_count}))
        kinds = self.kinds(run)
        self.assertEqual(kinds[-2:], ['message_delivered', end])
        self.assertEqual(list(AgentRun.objects.filter(conversation_id=self.conversation.id).values_list('id', flat=True)), [run.id],
                         'no new run starts for the message')

    def artist_writes_mid_step(self, run, then):
        def act():
            AgentInboxMessage.objects.create(conversation_id=self.conversation.id, run_id=run.id, user_id=self.user.id,
                                             content='Also make it blue', created_at=20)
            then()
            return [call('list_models', {})]
        return act

    def test_a_message_posted_mid_step_is_kept_in_the_chat_when_the_run_is_cancelled(self):
        run = self.start_run()
        self.gemini(self.artist_writes_mid_step(run, lambda: runs.request_cancel(run.id, cancel_jobs=False, now=21)))
        self.assertEqual(self.advance(run), 'cancelled')
        self.assertEqual([step.kind for step in self.steps(run)], ['llm'])
        self.assert_message_kept(run, 'cancelled')

    def test_a_message_posted_mid_step_is_kept_in_the_chat_when_the_grant_ends(self):
        run = self.start_run()
        self.gemini(self.artist_writes_mid_step(run, lambda: grants.revoke_grant(self.user.id)))
        self.assertEqual(self.advance(run), 'failed')
        self.assertEqual(self.refresh(run).error['code'], 'grant_invalid')
        self.assert_message_kept(run, 'failed')

    def test_a_job_with_no_provider_task_is_cancelled_by_the_shared_service(self):
        run = self.waiting_run()
        AgentRun.objects.filter(pk=run.id).update(cancel_requested_at=99, cancel_jobs=True)
        self.assertEqual(self.advance(run), 'cancelled')
        payload = AgentRunEvent.objects.get(run_id=run.id, kind='cancelled').payload
        self.assertEqual(len(payload['jobs']), 1)
        self.assertEqual(payload['jobs'][0]['generationId'], str(Generation.objects.get().id))


COST_BOUND = 1000


class BoundaryTests(RunnerCase):
    def setting(self, key, value):
        AppSetting.objects.update_or_create(key=key, defaults={'value': str(value), 'updated_at': 1})

    def assert_paused_at(self, run, reason, resume_after=None):
        run = self.refresh(run)
        self.assertEqual((run.status, run.pause_reason, run.resume_after), ('paused_limit', reason, resume_after))
        if reason != 'time_limit':
            self.assertEqual((run.error['code'], run.error['kind'], run.error['hits']), ('limit_paused', reason, [reason]))
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='paused').payload, {'reason': reason, 'resumeAfter': resume_after})
        if resume_after is None:
            self.assertNotIn(run.id, worker.runnable(), 'it waits for the artist instead of retrying into the bound')
        return run

    def usage(self, cents, created_at):
        AgentLlmUsage.objects.create(user_id=self.user.id, grant_id=self.grant.id, model='m', purpose='step', prompt_tokens=1,
                                     cached_tokens=0, output_tokens=1, thoughts_tokens=0, tool_prompt_tokens=0, total_tokens=2,
                                     cost_microcents=cents * 1_000_000, created_at=created_at)

    def test_the_agents_switch_off_pauses_and_the_run_resumes_once_it_is_back_on(self):
        clock = limits.now_ms()
        bodies = self.gemini([text('Done.')])
        run = self.start_run()
        self.setting('agentsEnabled', 0)
        self.assertEqual(self.advance(run, now=lambda: clock), 'paused')
        run = self.assert_paused_at(run, 'disabled', clock + limits.SWITCH_RETRY_MS)
        self.assertEqual(self.steps(run), [])
        self.assertNotIn(run.id, worker.runnable(now=clock + limits.SWITCH_RETRY_MS - 1))
        clock += limits.SWITCH_RETRY_MS
        self.assertEqual(worker.runnable(now=clock), [run.id], 'the switch is re-checked every minute')
        self.assertEqual(self.advance(run, now=lambda: clock), 'paused', 'still off: waking is not a second refusal')
        run = self.refresh(run)
        self.assertEqual((run.status, run.resume_after, run.error['hits']), ('paused_limit', clock + limits.SWITCH_RETRY_MS, ['disabled']))
        self.assertEqual(self.kinds(run), ['paused'])
        self.setting('agentsEnabled', 1)
        clock += limits.SWITCH_RETRY_MS
        self.assertEqual(worker.runnable(now=clock), [run.id])
        self.assertEqual(self.advance(run, now=lambda: clock), 'completed', 'back on: the next re-check resumes the run')
        self.assertEqual((len(bodies), self.kinds(run)[:2]), (1, ['paused', 'run_started']))

    def test_a_message_to_a_run_paused_at_a_daily_cap_pauses_it_again_and_lands_in_the_chat(self):
        bodies = self.gemini()
        self.usage(2, limits.now_ms())
        UserLimit.objects.create(user_id=self.user.id, key='mcpDailyCapCents', value='1', updated_at=1)
        run = self.start_run()
        self.assertEqual(self.advance(run), 'paused')
        self.assertEqual(self.refresh(run).pause_reason, 'daily_cap')
        runs.deliver(self.refresh(run), self.user, 'ok, wait', now=20)
        self.assertEqual(self.advance(run), 'paused', 'a message is not a second refusal')
        run = self.refresh(run)
        self.assertEqual((run.status, run.pause_reason, run.error['code'], run.error['hits']),
                         ('paused_limit', 'daily_cap', 'limit_paused', ['daily_cap']))
        self.assertGreater(run.resume_after, limits.now_ms(), 'the message wake refreshed resume_after')
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).status, 'paused_limit')
        self.assertEqual(AgentConversationMessage.objects.get(conversation_id=self.conversation.id, content='ok, wait').role, 'user')
        self.assertEqual(self.kinds(run), ['paused', 'message_queued', 'message_delivered'])
        self.assertEqual(bodies, [])

    def test_a_timed_wake_at_a_still_spent_global_cap_pauses_the_run_again(self):
        bodies = self.gemini()
        clock = limits.now_ms()
        self.usage(2, clock)
        self.setting('agentGlobalDailyCapCents', 1)
        run = self.start_run()
        self.assertEqual(self.advance(run, now=lambda: clock), 'paused')
        self.assertEqual(self.refresh(run).resume_after, clock + policy.DAY_MS)
        self.usage(2, clock + 1000)
        wake = clock + policy.DAY_MS + 1
        self.assertEqual(worker.runnable(now=wake), [run.id])
        self.assertEqual(self.advance(run, now=lambda: wake), 'paused', 'spend after the pause keeps the cap spent')
        run = self.refresh(run)
        self.assertEqual((run.status, run.pause_reason, run.resume_after, run.error['hits']),
                         ('paused_limit', 'global_daily_cap', clock + 1000 + policy.DAY_MS, ['global_daily_cap']))
        self.assertEqual((self.kinds(run), bodies), (['paused'], []))

    def test_a_run_that_resumed_and_hits_the_same_daily_cap_again_fails(self):
        bodies = self.gemini()
        run = self.start_run()
        limits.apply_limit_hit(run, limits.LimitHit(limits.DAILY_CAP, 'Spent.', None), now=5)
        AgentRun.objects.filter(pk=run.id).update(status='running')
        self.usage(2, limits.now_ms())
        UserLimit.objects.create(user_id=self.user.id, key='mcpDailyCapCents', value='1', updated_at=1)
        self.assertEqual(self.advance(run), 'failed', 'a refusal after the run resumed is the second one')
        self.assertEqual((self.refresh(run).error['code'], bodies), ('limit', []))
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).status, 'failed')
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='failed').payload['code'], 'limit')

    def test_the_switch_follows_the_per_user_override_and_the_global_kill(self):
        clock = limits.now_ms()
        self.gemini([text('Done.')], [text('Done.')], [text('Done.')])
        self.assertEqual(self.advance(self.start_run()), 'completed')
        UserLimit.objects.create(user_id=self.user.id, key='agentsEnabled', value='0', updated_at=1)
        run = self.start_run()
        self.assertEqual(self.advance(run, now=lambda: clock), 'paused')
        self.assert_paused_at(run, 'disabled', clock + limits.SWITCH_RETRY_MS)
        AgentRun.objects.filter(pk=run.id).update(status='cancelled')
        UserLimit.objects.filter(user_id=self.user.id).update(value='1')
        self.setting('agentsEnabled', 0)
        run = self.start_run()
        self.assertEqual(self.advance(run), 'paused', 'the global 0 is a kill switch even over a per-user 1')

    def test_a_limit_hit_pauses_the_run_with_its_reason_and_resume_after(self):
        hit = limits.LimitHit(limits.GLOBAL_DAILY_CAP, 'Spent.', 123_456, 'global')
        run = self.start_run()
        with patch.object(limits, 'check_step', return_value=hit) as check:
            self.assertEqual(self.advance(run), 'paused')
        self.assertEqual(check.call_args.kwargs['cost_cents'], 0)
        run = self.assert_paused_at(run, 'global_daily_cap', 123_456)
        self.assertEqual(run.step_count, 0)

    def test_the_step_limit_is_an_admin_value_read_at_the_next_step(self):
        bodies = self.gemini([text('Done.')])
        run = self.start_run(step_count=5)
        self.setting('agentMaxStepsPerRun', 5)
        self.assertEqual(self.advance(run), 'paused')
        self.assert_paused_at(run, 'steps')
        self.assertEqual((self.steps(run), bodies), ([], []))
        self.assertEqual(runs.deliver(self.refresh(run), self.user, 'Keep going', now=20)['run']['resumeAfter'], 20)
        self.setting('agentMaxStepsPerRun', 50)
        self.assertEqual(self.advance(run), 'completed', 'the raised limit applies at once')
        self.assertEqual(len(bodies), 1)

    def test_a_message_to_a_limit_paused_run_lands_in_the_chat_history(self):
        run = self.start_run(step_count=5)
        self.setting('agentMaxStepsPerRun', 5)
        self.assertEqual(self.advance(run), 'paused')
        runs.deliver(self.refresh(run), self.user, 'Keep going', now=20)
        self.assertEqual(self.advance(run), 'failed', 'still at the limit: a second refusal ends the run')
        inbox = AgentInboxMessage.objects.get(run_id=run.id)
        self.assertIsNotNone(inbox.delivered_at)
        message = AgentConversationMessage.objects.get(conversation_id=self.conversation.id, content='Keep going')
        self.assertEqual(message.role, 'user')
        self.assertEqual(self.kinds(run), ['paused', 'message_queued', 'message_delivered', 'failed'])

    def test_a_paid_call_past_the_cost_bound_is_refused_with_cost_limit_and_never_sent(self):
        sent = self.dispatched()
        answer = 'That would go past what this run may spend. Shall I try a smaller size?'
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'}, 'c1')], [text(answer)])
        run = self.start_run(cost_cents=COST_BOUND - 5)
        self.assertEqual(self.advance(run), 'completed')
        run = self.refresh(run)
        self.assertEqual((sent, Generation.objects.count(), run.cost_cents, run.error), ([], 0, COST_BOUND - 5, None))
        steps = self.steps(run)
        self.assertEqual([(step.kind, step.tool_name, step.outcome, step.cost_cents) for step in steps],
                         [('llm', None, 'calls', 0), ('tool', 'generate_image', 'COST_LIMIT', 0), ('llm', None, 'final', 0)])
        self.assertEqual(steps[1].result['response'], {
            'code': 'COST_LIMIT',
            'message': 'Nothing was charged: this call would take the run past its spending bound. Suggest a cheaper option or ask the artist.'})
        self.assertEqual(bodies[1]['contents'][-1], {'role': 'user', 'parts': [{'functionResponse': {
            'name': 'generate_image', 'response': steps[1].result['response'], 'id': 'c1'}}]})
        message = AgentConversationMessage.objects.get(conversation_id=self.conversation.id, role='assistant')
        self.assertEqual(message.content, answer)
        self.assertNotIn('paused', self.kinds(run))

    def test_a_paid_call_past_a_daily_cap_on_its_own_is_refused_with_budget_exceeded_and_never_sent(self):
        sent = self.dispatched()
        answer = 'That costs more than your daily limit. Shall I try something cheaper?'
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'}, 'c1')], [text(answer)])
        UserLimit.objects.create(user_id=self.user.id, key='mcpDailyCapCents', value='5', updated_at=1)
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed', 'no wait would ever fit a 6 cent call under a 5 cent cap')
        run = self.refresh(run)
        self.assertEqual((sent, Generation.objects.count(), run.cost_cents, run.error, run.pause_reason), ([], 0, 0, None, None))
        steps = self.steps(run)
        self.assertEqual([(step.kind, step.tool_name, step.outcome, step.cost_cents) for step in steps],
                         [('llm', None, 'calls', 0), ('tool', 'generate_image', 'BUDGET_EXCEEDED', 0), ('llm', None, 'final', 0)])
        self.assertEqual(steps[1].result['response'], {
            'code': 'BUDGET_EXCEEDED',
            'message': 'Nothing was charged: this call alone costs more than a daily spending limit allows. '
                       'Suggest a cheaper option or ask the artist.'})
        self.assertEqual(bodies[1]['contents'][-1], {'role': 'user', 'parts': [{'functionResponse': {
            'name': 'generate_image', 'response': steps[1].result['response'], 'id': 'c1'}}]})
        self.assertEqual(AgentConversationMessage.objects.get(conversation_id=self.conversation.id, role='assistant').content, answer)
        self.assertNotIn('paused', self.kinds(run))

    def test_a_paid_call_past_a_daily_cap_on_its_own_after_the_model_was_told_fails_the_run(self):
        sent = self.dispatched()
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'})], [call('generate_image', {'prompt': 'tiny fox'})])
        self.setting('agentGlobalDailyCapCents', 5)
        run = self.start_run()
        self.assertEqual(self.advance(run), 'failed')
        run = self.refresh(run)
        error = {'code': 'limit', 'kind': 'global_daily_cap',
                 'message': 'The run stopped: the model asked again for a paid call past a daily spending limit.'}
        self.assertEqual((run.status, run.error, run.cost_cents), ('failed', error, 0))
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='failed').payload, error)
        self.assertEqual((sent, Generation.objects.count(), len(bodies)), ([], 0, 2))
        self.assertEqual([(step.kind, step.outcome) for step in self.steps(run)],
                         [('llm', 'calls'), ('tool', 'BUDGET_EXCEEDED'), ('llm', 'calls')])
        self.assertNotIn('paused', self.kinds(run))

    def test_the_run_cost_limit_is_an_admin_value_read_at_the_next_step(self):
        sent = self.dispatched()
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.start_run(cost_cents=COST_BOUND - 5)
        self.setting('agentMaxRunCostCents', COST_BOUND + 10)
        self.assertEqual(self.advance(run), 'waiting', 'raised first: the same call now fits and is submitted')
        self.assertEqual((len(sent), Generation.objects.count()), (1, 1))

    def test_a_paid_call_past_the_cost_bound_after_the_model_was_told_fails_the_run(self):
        sent = self.dispatched()
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'}), call('generate_image', {'prompt': 'grey fox'})],
                             [call('generate_image', {'prompt': 'tiny fox'})])
        run = self.start_run(cost_cents=COST_BOUND - 5)
        self.assertEqual(self.advance(run), 'failed')
        run = self.refresh(run)
        error = {'code': 'limit', 'kind': 'cost',
                 'message': 'The run stopped: the model asked again for a paid call past its spending bound.'}
        self.assertEqual((run.status, run.error, run.cost_cents), ('failed', error, COST_BOUND - 5))
        self.assertEqual(AgentRunEvent.objects.get(run_id=run.id, kind='failed').payload, error)
        self.assertEqual((sent, Generation.objects.count(), len(bodies)), ([], 0, 2))
        self.assertEqual([(step.kind, step.outcome) for step in self.steps(run)],
                         [('llm', 'calls'), ('tool', 'COST_LIMIT'), ('tool', 'COST_LIMIT'), ('llm', 'calls')],
                         'both calls of the turn are refused; the next turn asks again and the run ends')

    def test_model_token_spend_counts_toward_the_run_cost_limit(self):
        bodies = self.gemini()
        run = self.start_run()
        AgentLlmUsage.objects.create(user_id=self.user.id, grant_id=self.grant.id, run_id=run.id, model='m', purpose='step', prompt_tokens=1,
                                     cached_tokens=0, output_tokens=1, thoughts_tokens=0, tool_prompt_tokens=0, total_tokens=2,
                                     cost_microcents=(COST_BOUND + 1) * 1_000_000, created_at=1)
        self.assertEqual(self.advance(run), 'paused')
        self.assert_paused_at(run, 'run_cost')
        self.assertEqual((self.steps(run), bodies), ([], []))

    def test_the_global_daily_cap_pauses_with_a_resume_time(self):
        bodies = self.gemini()
        run = self.start_run()
        AgentLlmUsage.objects.create(user_id=self.user.id, grant_id=self.grant.id, model='m', purpose='step', prompt_tokens=1, cached_tokens=0,
                                     output_tokens=1, thoughts_tokens=0, tool_prompt_tokens=0, total_tokens=2, cost_microcents=2_000_000,
                                     created_at=limits.now_ms())
        self.setting('agentGlobalDailyCapCents', 1)
        self.assertEqual(self.advance(run), 'paused')
        run = self.refresh(run)
        self.assertEqual((run.pause_reason, bodies), ('global_daily_cap', []))
        self.assertGreater(run.resume_after, limits.now_ms())

    def test_waiting_for_jobs_or_approval_is_not_counted_toward_the_time_bound(self):
        clock = [1_000_000]
        AgentGrant.objects.filter(pk=self.grant.id).update(auto_approve_cents=0)
        self.gemini([call('generate_image', {'prompt': 'red fox'})], [call('generate_image', {'prompt': 'grey fox'})], [text('Done.')])
        run = self.start_run()
        self.assertEqual(self.advance(run, now=lambda: clock[0]), 'waiting')
        self.assertEqual(self.refresh(run).status, 'waiting_approval')
        clock[0] += runner.MAX_ACTIVE_MS + 1
        runner.approve_quote(run.id, self.user.id, now=clock[0])
        self.assertEqual(self.advance(run, now=lambda: clock[0]), 'waiting')
        self.assertEqual(self.refresh(run).status, 'waiting_jobs')
        clock[0] += runner.MAX_ACTIVE_MS + 1
        self.finish_jobs(run)
        self.assertEqual(self.advance(run, now=lambda: clock[0]), 'waiting')
        self.assertEqual(self.refresh(run).status, 'waiting_approval')
        clock[0] += runner.MAX_ACTIVE_MS + 1
        runner.decline_quote(run.id, 'declined', now=clock[0])
        self.assertEqual(self.advance(run, now=lambda: clock[0]), 'completed')
        self.assertLess(runner.active_ms(self.refresh(run)), runner.MAX_ACTIVE_MS)

    def test_time_spent_in_steps_reaches_the_time_bound_and_pauses_the_run(self):
        clock = [1_000_000]

        def slow():
            clock[0] += runner.MAX_ACTIVE_MS
            return [call('list_models', {})]
        self.gemini(slow)
        run = self.start_run()
        self.assertEqual(self.advance(run, now=lambda: clock[0]), 'paused')
        self.assert_paused_at(run, 'time_limit')
        self.assertEqual([step.kind for step in self.steps(run)], ['llm'])

    def test_a_revoked_grant_fails_the_run_with_a_clear_error(self):
        run = self.start_run()
        grants.revoke_grant(self.user.id)
        self.assertEqual(self.advance(run), 'failed')
        run = self.refresh(run)
        self.assertEqual((run.status, run.error['code']), ('failed', 'grant_invalid'))
        self.assertIn('Agent access for this chat has ended', AgentRunEvent.objects.get(run_id=run.id, kind='failed').payload['message'])


class EventTests(RunnerCase):
    def test_concurrent_writers_get_strictly_increasing_gapless_seqs(self):
        run = self.start_run()
        failures = []

        def write(worker_index):
            try:
                for index in range(5):
                    events.emit(run.id, 'note', {'writer': worker_index, 'index': index})
            except Exception as error:   # pragma: no cover - reported below
                failures.append(error)
            finally:
                connection.close()       # each thread's own connection, or the test database cannot be dropped
        threads = [threading.Thread(target=write, args=(index,)) for index in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(failures, [])
        self.assertEqual(sorted(AgentRunEvent.objects.filter(run_id=run.id).values_list('seq', flat=True)), list(range(1, 21)))
        self.assertEqual([row.seq for row in events.page(run.id, after=15)], [16, 17, 18, 19, 20])
        self.assertEqual(len(events.page(run.id, after=0, limit=3)), 3)


class DesignPromptTests(RunnerCase):
    """The harness's own design_prompt: a prompt-design sub-call through the loop transport, never the dispatcher."""

    def brief(self, bodies, index):
        self.assertEqual(set(bodies[index]), {'systemInstruction', 'contents', 'generationConfig'})
        self.assertEqual(bodies[index]['systemInstruction'], {'parts': [{'text': design.DESIGN_SYSTEM_PROMPT}]})
        return bodies[index]['contents'][0]['parts'][0]['text']

    def test_text_to_image_designs_the_prompt_then_generates_with_it(self):
        sent = self.dispatched()
        idea = {'idea': 'a red fox in fresh snow at dawn', 'kind': 'image', 'mode': 'text', 'wait': True}
        bodies = self.gemini([call('design_prompt', idea, 'd1')], [text('"A red fox steps through fresh snow, low golden dawn light."')],
                             lambda: [call('generate_image', {'prompt': bodies[2]['contents'][-1]['parts'][0]['functionResponse']
                                                              ['response']['prompt']})])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'waiting')
        self.assertTrue(declared(bodies[0], 'design_prompt'))
        brief = self.brief(bodies, 1)
        self.assertEqual(brief, 'Idea: a red fox in fresh snow at dawn\nMake: an image\nMode: Text to image: no references.\n'
                                'Model: Nano Banana 2.1 (nano-banana-2-1) makes images.')
        response = bodies[2]['contents'][-1]['parts'][0]['functionResponse']
        self.assertEqual(response, {'name': 'design_prompt', 'id': 'd1',
                                    'response': {'prompt': 'A red fox steps through fresh snow, low golden dawn light.'}})
        # The model's wait is a harness field and is dropped; the sub-call never reaches the dispatcher.
        steps = self.steps(run)
        self.assertEqual([(step.kind, step.tool_name, step.outcome, step.cost_cents) for step in steps],
                         [('llm', None, 'calls', 0), ('tool', 'design_prompt', 'ok', 0), ('llm', None, 'calls', 0),
                          ('tool', 'generate_image', 'running', 6)])
        self.assertEqual(steps[1].result['call']['args'], {'idea': idea['idea'], 'kind': 'image', 'mode': 'text'})
        self.assertEqual([name for name, _, _ in sent], ['generate_image'])
        self.assertEqual(Generation.objects.get().prompt, 'A red fox steps through fresh snow, low golden dawn light.')
        self.assertEqual(list(AgentLlmUsage.objects.filter(run_id=run.id).order_by('step_index').values_list('step_index', 'purpose')),
                         [(0, 'step'), (1, 'design_prompt'), (2, 'step')])
        called = AgentRunEvent.objects.filter(run_id=run.id, kind='tool_called').order_by('seq').first().payload
        self.assertEqual(called, {'stepIndex': 1, 'tool': 'design_prompt', 'outcome': 'ok',
                                  'summary': 'A red fox steps through fresh snow, low golden dawn light.'})

    def test_reference_and_edit_modes_brief_the_model_with_ordered_citations_and_its_limits(self):
        notes = ['the fox character, keep its face', 'the snowy pine forest', 'the warm dawn palette']
        bodies = self.gemini([call('design_prompt', {'idea': 'the fox in the forest', 'kind': 'image', 'mode': 'references',
                                                     'references': notes}),
                              call('design_prompt', {'idea': 'make it night', 'kind': 'image', 'mode': 'edit',
                                                     'references': ['the finished fox image']}),
                              call('design_prompt', {'idea': 'the fox runs', 'kind': 'video', 'mode': 'edit', 'model': 'seedance-25',
                                                     'references': ['the fox still']})],
                             [text('@img1 walks through @img2 under the colours of @img3.')], [text('The same fox at night.')],
                             [text('Starting on the still, the fox breaks into a run.')], [text('Three prompts ready.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(self.brief(bodies, 1).split('\n'), [
            'Idea: the fox in the forest', 'Make: an image', 'Mode: References: 3 ordered reference images.',
            'Model: Nano Banana 2.1 (nano-banana-2-1) makes images. It takes up to 14 reference images, cited @img1..@img14.',
            'References, in order:', '@img1: the fox character, keep its face', '@img2: the snowy pine forest',
            '@img3: the warm dawn palette'])
        self.assertEqual(self.brief(bodies, 2).split('\n')[2:], [
            'Mode: Edit: one reference image.', 'Model: Nano Banana 2.1 (nano-banana-2-1) makes images.',
            'References, in order:', 'Reference: the finished fox image'])
        self.assertEqual(self.brief(bodies, 3).split('\n')[1:4], [
            'Make: a video', 'Mode: Edit: one reference image (the first frame).',
            'Model: Seedance 2.5 (seedance-25) makes videos. Describe camera movement, subject action and pacing over the clip.'])
        responses = [part['functionResponse']['response'] for part in bodies[4]['contents'][-1]['parts']]
        self.assertEqual(responses, [{'prompt': '@img1 walks through @img2 under the colours of @img3.'},
                                     {'prompt': 'The same fox at night.'}, {'prompt': 'Starting on the still, the fox breaks into a run.'}])

    def test_a_brief_that_does_not_fit_its_mode_or_model_is_answered_without_a_sub_call(self):
        cases = [({'idea': 'fox', 'kind': 'image', 'mode': 'text', 'references': ['a fox']}, 'takes no references'),
                 ({'idea': 'fox', 'kind': 'image', 'mode': 'edit', 'references': ['a', 'b']}, 'exactly one reference'),
                 ({'idea': 'fox', 'kind': 'image', 'mode': 'references'}, 'a note for each reference'),
                 ({'idea': 'fox', 'kind': 'image', 'mode': 'references', 'references': ['ref'] * 15}, 'at most 14 reference images'),
                 ({'idea': 'fox', 'kind': 'image', 'mode': 'text', 'model': 'seedance-25'}, 'not a image model you can use'),
                 ({'idea': ' ', 'kind': 'image', 'mode': 'text'}, 'Send the idea'),
                 ({'idea': 'fox', 'kind': 'audio', 'mode': 'text'}, 'image or video'),
                 ({'idea': 'fox', 'kind': 'image', 'mode': 'text', 'style': 'noir'}, 'does not take style')]
        bodies = self.gemini([call('design_prompt', args) for args, _ in cases], [text('I will fix those.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(len(bodies), 2)
        responses = [part['functionResponse']['response'] for part in bodies[1]['contents'][-1]['parts']]
        for (_, expected), response in zip(cases, responses):
            with self.subTest(expected):
                self.assertEqual(response['code'], 'INVALID_INPUT')
                self.assertIn(expected, response['message'])
        self.assertEqual({step.outcome for step in self.steps(run) if step.kind == 'tool'}, {'INVALID_INPUT'})
        self.assertFalse(AgentLlmUsage.objects.filter(purpose='design_prompt').exists())

    def test_a_design_sub_call_is_retried_and_an_unanswered_one_is_reissued_after_a_crash(self):
        bodies = self.gemini([call('design_prompt', {'idea': 'fox', 'kind': 'image', 'mode': 'text'})],
                             HttpResult(503, b'{}'), RuntimeError('worker died mid-call'), [text('A fox.')], [text('Done.')])
        run = self.start_run()
        with self.assertRaises(RuntimeError):
            self.advance(run)
        step = self.steps(run)[1]
        self.assertEqual((step.tool_name, step.outcome, step.result['attempts']), ('design_prompt', None, 1))
        AgentRun.objects.filter(pk=run.id).update(last_heartbeat_at=1)
        scheduler.resume_agent_runs()
        self.assertEqual(self.refresh(run).status, 'queued')
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(self.steps(run)[1].outcome, 'ok')
        self.assertEqual(bodies[1], bodies[2])
        self.assertEqual(bodies[2], bodies[3])
        self.assertEqual(bodies[4]['contents'][-1]['parts'][0]['functionResponse']['response'], {'prompt': 'A fox.'})
        self.assertEqual(AgentLlmUsage.objects.filter(run_id=run.id, purpose='design_prompt').count(), 1)

    def test_a_sub_call_that_never_answers_tells_the_model_to_write_the_prompt_itself(self):
        bodies = self.gemini([call('design_prompt', {'idea': 'fox', 'kind': 'image', 'mode': 'text'})],
                             *[HttpResult(503, b'{}')] * runner.LLM_ATTEMPTS, [text('I will write it myself.')])
        run = self.start_run()
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(self.steps(run)[1].outcome, 'DESIGN_FAILED')
        self.assertEqual(bodies[-1]['contents'][-1]['parts'][0]['functionResponse']['response']['code'], 'DESIGN_FAILED')


def declared(body, name):
    return any(item['name'] == name for item in body['tools'][0]['functionDeclarations'])
