"""The run endpoints under /api/agent-conversations/<id>/runs: who may use them, starting a run or messaging the active
one, the event feed, quote answers and cancel. The worker side runs through ``runner.advance`` with Gemini faked below
the transport, as in test_runner; no network is used."""
import uuid

from django.db import IntegrityError, transaction
from django.test import Client

from apps.admin_dashboard.models import AppSetting
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.generation.models import Generation
from . import runs
from .loop_llm import ADVANCED_LOOP_MODEL, LOOP_MODEL
from .models import AgentConversation, AgentConversationMessage, AgentGrant, AgentInboxMessage, AgentRun, AgentRunEvent
from .test_runner import RunnerCase, call, text


class RunsApiCase(RunnerCase):
    def setUp(self):
        super().setUp()
        User.objects.filter(pk=self.user.id).update(role='admin')         # the tab is admin-only, like the old path
        self.user.refresh_from_db()
        self.base = f'/api/agent-conversations/{self.conversation.id}/runs'

    def client_for(self, user):
        client = Client(raise_request_exception=False, HTTP_SEC_FETCH_SITE='same-origin')
        if user is not None:
            client.cookies['veevee_session'] = sign_session(user)
        return client

    def post(self, path, body=None, user='owner'):
        client = self.client_for(self.user if user == 'owner' else user)
        return client.post(path, body or {}, content_type='application/json')

    def get(self, path, user='owner'):
        return self.client_for(self.user if user == 'owner' else user).get(path)

    def started(self, message='Make a red fox'):
        response = self.post(self.base, {'content': message})
        self.assertEqual(response.status_code, 201, response.content)
        return AgentRun.objects.get(pk=response.json()['run']['id'])


class AccessTests(RunsApiCase):
    def test_only_the_admin_who_owns_the_conversation_reaches_its_runs(self):
        run = self.started()
        other = AgentConversation.objects.create(project_id=self.project.id, name='Other', agent_kind='image', user_id=self.admin.id,
                                                 created_by=self.admin.id, created_at=1, updated_at=1)
        artist = self.make_user('plain@example.invalid', 'Plain', 'user')
        paths = [(self.base, 'GET'), (self.base, 'POST'), (f'{self.base}/{run.id}/events', 'GET'),
                 (f'{self.base}/{run.id}/approve', 'POST'), (f'{self.base}/{run.id}/decline', 'POST'),
                 (f'{self.base}/{run.id}/cancel', 'POST')]
        for path, method in paths:
            send = self.get if method == 'GET' else lambda target, user: self.post(target, {'content': 'x', 'stepIndex': 1}, user)
            with self.subTest(path=path, method=method):
                self.assertEqual(send(path, None).status_code, 403)                     # no session
                self.assertEqual(send(path, artist).status_code, 403)                   # not an admin
                missing = send(path, self.admin)                                         # another admin's view: not found
                self.assertEqual((missing.status_code, missing.json()['error']), (404, 'Conversation not found.'))
        # A run is only found under its own conversation, and malformed ids are simply not found.
        foreign = f'/api/agent-conversations/{other.id}/runs/{run.id}/events'
        self.assertEqual(self.get(foreign, self.admin).json(), {'error': 'Run not found.'})
        self.assertEqual(self.get(f'{self.base}/{uuid.uuid4()}/events').status_code, 404)
        self.assertEqual(self.get(f'{self.base}/not-a-run/events').status_code, 404)
        self.assertEqual(self.get('/api/agent-conversations/not-a-chat/runs').status_code, 404)
        run = AgentRun.objects.get(pk=run.id)
        self.assertEqual((run.status, run.cancel_requested_at, AgentInboxMessage.objects.count()), ('queued', None, 0))

    def test_a_conversation_without_user_id_is_owned_by_its_creator(self):
        AgentConversation.objects.filter(pk=self.conversation.id).update(user_id=None)
        self.started()
        self.assertEqual(self.post(self.base, {'content': 'x'}, self.admin).status_code, 404)


class StartAndMessageTests(RunsApiCase):
    def test_the_first_message_starts_a_run_and_later_ones_go_to_its_inbox(self):
        AgentGrant.objects.all().delete()
        response = self.post(self.base, {'content': '  Make a red fox  '})
        self.assertEqual(response.status_code, 201)
        body = response.json()
        run = AgentRun.objects.get(pk=body['run']['id'])
        grant = AgentGrant.objects.get(user_id=self.user.id, revoked_at__isnull=True)       # issued on first use
        self.assertEqual((body['delivery'], body['run']['status'], body['message']['content']), ('run', 'queued', 'Make a red fox'))
        self.assertEqual((run.user_id, run.grant_id, run.model, run.conversation_id), (self.user.id, grant.id, LOOP_MODEL, self.conversation.id))
        conversation = AgentConversation.objects.get(pk=self.conversation.id)
        self.assertEqual((conversation.status, conversation.last_run_at), ('queued', run.created_at))
        self.assertEqual(list(AgentRunEvent.objects.filter(run_id=run.id).values_list('kind', flat=True)), ['run_queued'])
        self.assertEqual(AgentConversationMessage.objects.get(conversation_id=self.conversation.id).created_at, run.created_at)

        second = self.post(self.base, {'content': 'Make it blue'})
        self.assertEqual((second.status_code, second.json()['delivery'], second.json()['run']['id']), (202, 'inbox', str(run.id)))
        inbox = AgentInboxMessage.objects.get()
        self.assertEqual((inbox.run_id, inbox.user_id, inbox.content, inbox.delivered_at), (run.id, self.user.id, 'Make it blue', None))
        self.assertEqual(AgentRun.objects.filter(conversation_id=self.conversation.id).count(), 1)

        bodies = self.gemini([text('A blue fox it is.')])
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(bodies[0]['contents'][-1]['parts'], [{'text': 'Make a red fox'}, {'text': 'Make it blue'}])
        self.assertEqual(AgentInboxMessage.objects.get().delivered_step, 0)
        listed = self.get(self.base).json()['runs']
        self.assertEqual([(item['id'], item['status']) for item in listed], [(str(run.id), 'completed')])
        # With the run finished, the next message starts a new run.
        self.assertEqual(self.post(self.base, {'content': 'Now a wolf'}).json()['delivery'], 'run')

    def test_validation_and_the_model_choice(self):
        for body in ({}, {'content': '   '}, {'content': 'x' * 8001}, {'content': 'x', 'model': 'gemini-ultra'}):
            with self.subTest(body=body):
                self.assertEqual(self.post(self.base, body).status_code, 400)
        self.assertEqual(AgentRun.objects.count(), 0)
        response = self.post(self.base, {'content': 'x', 'model': ADVANCED_LOOP_MODEL})
        self.assertEqual(response.json()['run']['model'], ADVANCED_LOOP_MODEL)

    def test_the_chats_model_setting_is_the_default(self):
        AgentConversation.objects.filter(pk=self.conversation.id).update(settings={'model': ADVANCED_LOOP_MODEL})
        self.assertEqual(self.started().model, ADVANCED_LOOP_MODEL)

    def test_with_agents_off_no_run_starts_but_an_active_run_still_gets_messages(self):
        run = self.started()
        AppSetting.objects.create(key='agentsEnabled', value='false', updated_at=1)
        self.assertEqual(self.post(self.base, {'content': 'And a wolf'}).status_code, 202)
        AgentRun.objects.filter(pk=run.id).update(status='completed')
        refused = self.post(self.base, {'content': 'Another'})
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'AGENTS_DISABLED'))
        self.assertEqual(AgentRun.objects.count(), 1)
        self.assertEqual(AgentConversationMessage.objects.filter(content='Another').count(), 0)

    def test_an_inactive_account_cannot_start_a_run(self):
        AgentGrant.objects.all().delete()
        User.objects.filter(pk=self.user.id).update(is_active=False)
        # The session itself is refused for an inactive account; the grant check backs it up.
        self.assertIn(self.post(self.base, {'content': 'x'}).status_code, (401, 403))
        self.assertEqual(AgentRun.objects.count(), 0)

    def test_one_active_run_per_conversation_is_a_database_constraint(self):
        run = self.started()
        with self.assertRaises(IntegrityError), transaction.atomic():
            AgentRun.objects.create(conversation_id=self.conversation.id, user_id=self.user.id, grant_id=run.grant_id,
                                    model=LOOP_MODEL, status='waiting_jobs', created_at=2, updated_at=2)

    def test_a_message_retries_a_run_paused_by_a_limit_now(self):
        run = self.started()
        AgentRun.objects.filter(pk=run.id).update(status='paused_limit', pause_reason='daily_cap', resume_after=None)
        self.post(self.base, {'content': 'Try again'})
        run = AgentRun.objects.get(pk=run.id)
        self.assertEqual(run.status, 'paused_limit')
        self.assertIsNotNone(run.resume_after)
        self.assertLessEqual(run.resume_after, run.updated_at)


class FeedTests(RunsApiCase):
    def test_events_page_after_a_seq_with_the_run_status(self):
        self.gemini([text('Checking.'), call('list_models', {}, 'c1')], [text('Here are the models.')])
        run = self.started()
        self.assertEqual(self.advance(run), 'completed')
        kinds = list(AgentRunEvent.objects.filter(run_id=run.id).order_by('seq').values_list('kind', flat=True))
        events = f'{self.base}/{run.id}/events'
        whole = self.get(events).json()
        self.assertEqual([event['kind'] for event in whole['events']], kinds)
        self.assertEqual([event['seq'] for event in whole['events']], list(range(1, len(kinds) + 1)))
        self.assertEqual((whole['run']['status'], whole['nextAfter'], whole['more'], whole['pendingMessages']),
                         ('completed', len(kinds), False, []))
        first = self.get(f'{events}?after=0&limit=2').json()
        self.assertEqual(([event['seq'] for event in first['events']], first['nextAfter'], first['more']), ([1, 2], 2, True))
        rest = self.get(f'{events}?after=2').json()
        self.assertEqual([event['seq'] for event in rest['events']], list(range(3, len(kinds) + 1)))
        self.assertEqual(self.get(f'{events}?after={len(kinds)}').json()['events'], [])
        self.assertEqual(self.get(f'{events}?after={len(kinds)}').json()['nextAfter'], len(kinds))
        for query in ('?after=-1', '?after=x', '?limit=0', '?limit=101'):
            with self.subTest(query=query):
                self.assertEqual(self.get(events + query).status_code, 400)

    def test_undelivered_messages_are_listed_until_delivered(self):
        run = self.started()
        self.post(self.base, {'content': 'Make it blue'})
        pending = self.get(f'{self.base}/{run.id}/events').json()['pendingMessages']
        self.assertEqual([(item['content'], item['deliveredStep']) for item in pending], [('Make it blue', None)])


class QuoteTests(RunsApiCase):
    def setUp(self):
        super().setUp()
        AgentGrant.objects.filter(pk=self.grant.id).update(auto_approve_cents=0)

    def waiting(self, *later):
        sent = self.dispatched()
        bodies = self.gemini([call('generate_image', {'prompt': 'red fox'})], *later)
        run = self.started()
        self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual(AgentRun.objects.get(pk=run.id).status, 'waiting_approval')
        return run, sent, bodies

    def test_approve_through_the_api_replays_the_step_with_its_quote(self):
        run, sent, _ = self.waiting()
        approve = f'{self.base}/{run.id}/approve'
        self.assertEqual(self.post(approve, {}).status_code, 400)
        self.assertEqual(self.post(approve, {'stepIndex': 0}).json()['code'], 'NO_PENDING_QUOTE')
        response = self.post(approve, {'stepIndex': 1})
        self.assertEqual((response.status_code, response.json()['run']['status']), (200, 'queued'))
        self.assertEqual(self.post(approve, {'stepIndex': 1}).status_code, 409, 'an approval is stored once')
        self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual(sent[-1][1]['idempotencyKey'], f'{run.id}:1')
        self.assertIn('quoteToken', sent[-1][1])
        self.assertEqual((AgentRun.objects.get(pk=run.id).status, Generation.objects.count()), ('waiting_jobs', 1))

    def test_decline_tells_the_model_and_pays_nothing(self):
        run, sent, bodies = self.waiting([text('Understood, nothing was made.')])
        response = self.post(f'{self.base}/{run.id}/decline', {'stepIndex': 1})
        self.assertEqual((response.status_code, response.json()['run']['status']), (200, 'queued'))
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual((len(sent), Generation.objects.count()), (1, 0))
        answer = bodies[1]['contents'][-1]['parts'][0]['functionResponse']
        self.assertEqual((answer['name'], answer['response']['code']), ('generate_image', 'QUOTE_DECLINED'))
        self.assertIn('quote_declined', AgentRunEvent.objects.filter(run_id=run.id).values_list('kind', flat=True))
        self.assertEqual(self.post(f'{self.base}/{run.id}/approve', {'stepIndex': 1}).status_code, 409)

    def test_a_new_message_declines_the_waiting_quote_and_reaches_the_model(self):
        run, sent, bodies = self.waiting([text('Making a wolf instead.')])
        self.assertEqual(self.post(self.base, {'content': 'Actually, a wolf'}).json()['run']['status'], 'queued')
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(Generation.objects.count(), 0)
        last = bodies[1]['contents'][-1]['parts']
        self.assertEqual(last[0]['functionResponse']['response']['code'], 'QUOTE_DECLINED')
        self.assertEqual(last[-1], {'text': 'Actually, a wolf'})
        self.assertEqual(AgentInboxMessage.objects.get().delivered_step, 2)


class CancelApiTests(RunsApiCase):
    def test_stop_and_cancel_jobs_through_the_api(self):
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.started()
        self.assertEqual(self.advance(run), 'waiting')
        cancel = f'{self.base}/{run.id}/cancel'
        self.assertEqual(self.post(cancel, {'cancelJobs': 'yes'}).status_code, 400)
        response = self.post(cancel, {'cancelJobs': True})
        self.assertEqual(response.status_code, 202)
        self.assertEqual((response.json()['run']['cancelJobs'], response.json()['run']['status']), (True, 'waiting_jobs'))
        self.post(cancel, {})                                                     # a plain stop never downgrades cancelJobs
        run = AgentRun.objects.get(pk=run.id)
        self.assertTrue(run.cancel_jobs)
        kinds = list(AgentRunEvent.objects.filter(run_id=run.id).values_list('kind', flat=True))
        self.assertEqual(kinds.count('cancel_requested'), 1)
        self.assertEqual(self.advance(run), 'cancelled')
        jobs = AgentRunEvent.objects.get(run_id=run.id, kind='cancelled').payload['jobs']
        self.assertEqual([job['generationId'] for job in jobs], [str(Generation.objects.get().id)])
        finished = self.post(cancel, {})
        self.assertEqual((finished.status_code, finished.json()['code']), (409, 'RUN_FINISHED'))

    def test_a_plain_stop_keeps_the_jobs(self):
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.started()
        self.assertEqual(self.advance(run), 'waiting')
        self.assertEqual(self.post(f'{self.base}/{run.id}/cancel', {}).status_code, 202)
        self.assertEqual(self.advance(run), 'cancelled')
        self.assertEqual(Generation.objects.get().status, 'queued')
        self.assertEqual(runs.request_cancel(run.id, cancel_jobs=True), None)
