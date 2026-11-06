"""The run endpoints under /api/agent-conversations/<id>/runs: who may use them, starting a run or messaging the active
one, the event feed, quote answers and cancel. The worker side runs through ``runner.advance`` with Gemini faked below
the transport, as in test_runner; no network is used."""
import uuid
from datetime import timedelta
from threading import Event

from django.db import IntegrityError, transaction
from django.test import Client
from django.utils import timezone

from apps.admin_dashboard.models import AppSetting, UserLimit
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.generation.models import Generation
from apps.mcp.tests.test_results import png_bytes
from apps.media.models import UploadSession
from . import composer, runner, runs, worker
from .loop_llm import ADVANCED_LOOP_MODEL, LOOP_MODEL
from .models import (ACTIVE_RUN_STATUSES, AgentChatAsset, AgentConversation, AgentConversationMessage, AgentGrant, AgentInboxMessage,
                     AgentLlmUsage, AgentRun, AgentRunEvent)
from .test_runner import RunnerCase, call, text


class RunsApiCase(RunnerCase):
    def setUp(self):
        super().setUp()
        User.objects.filter(pk=self.user.id).update(role='admin')         # the tab is admin-only, like the old path
        AppSetting.objects.filter(key='agentsEnabled').delete()
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


class GateTests(RunsApiCase):
    """Every agent-conversation route and the session's ``agentsEnabled`` follow ``limits.agents_enabled``."""
    def setUp(self):
        super().setUp()
        self.member = self.make_user('member@example.invalid', 'Member', 'user')
        AgentGrant.objects.all().delete()

    def switch(self, value, user=None):
        if user is None:
            AppSetting.objects.update_or_create(key='agentsEnabled', defaults={'value': value, 'updated_at': 1})
        else:
            UserLimit.objects.update_or_create(user_id=user.id, key='agentsEnabled', defaults={'value': value, 'updated_at': 1})

    def chat(self, owner):
        return AgentConversation.objects.create(project_id=self.project.id, name=owner.name, agent_kind='image', user_id=owner.id,
                                                created_by=owner.id, created_at=2, updated_at=2)

    def reach(self, user):
        """``(session agentsEnabled, conversations GET status, conversation create status, run POST status)`` for ``user``
        on a conversation of their own."""
        client = self.client_for(user)
        own = self.chat(user)
        me = client.get('/api/auth/me').json()['user']['agentsEnabled']
        listed = client.get('/api/agent-conversations', {'projectId': str(self.project.id), 'agentKind': 'image'})
        created = client.post('/api/agent-conversations', {'op': 'createConversation', 'projectId': str(self.project.id),
                                                          'agentKind': 'image', 'name': 'New'}, content_type='application/json')
        started = client.post(f'/api/agent-conversations/{own.id}/runs', {'content': 'Make a fox'}, content_type='application/json')
        for response in (listed, created, started):
            if response.status_code == 403:
                self.assertEqual(response.json()['code'], 'AGENTS_DISABLED')
        return me, listed.status_code, created.status_code, started.status_code

    def test_with_no_rows_admins_only(self):
        self.assertEqual(self.reach(self.user), (True, 200, 200, 201))
        self.assertEqual(self.reach(self.member), (False, 403, 403, 403))

    def test_a_global_1_opens_the_tab_for_everyone(self):
        self.switch('1')
        self.assertEqual(self.reach(self.member), (True, 200, 200, 201))

    def test_a_global_0_is_off_for_everyone_even_with_a_per_user_1(self):
        self.switch('0')
        self.switch('1', self.user)
        self.switch('1', self.member)
        self.assertEqual(self.reach(self.user), (False, 403, 403, 403))
        self.assertEqual(self.reach(self.member), (False, 403, 403, 403))

    def test_a_per_user_row_decides_over_the_role_and_a_global_1(self):
        self.switch('1', self.member)
        self.switch('0', self.user)
        self.assertEqual(self.reach(self.member), (True, 200, 200, 201))
        self.assertEqual(self.reach(self.user), (False, 403, 403, 403))
        self.switch('1')
        self.assertEqual(self.reach(self.user)[0], False, 'a per-user 0 beats a global 1')

    def test_everyone_admins_included_lists_and_opens_only_their_own_conversations(self):
        self.switch('1', self.member)
        mine, theirs = self.chat(self.member), self.conversation
        member, admin = self.client_for(self.member), self.client_for(self.user)
        query = {'projectId': str(self.project.id), 'agentKind': 'image'}
        self.assertEqual([row['id'] for row in member.get('/api/agent-conversations', query).json()['conversations']], [str(mine.id)])
        self.assertEqual([row['id'] for row in admin.get('/api/agent-conversations', query).json()['conversations']], [str(theirs.id)])
        for client, other in ((member, theirs), (admin, mine)):
            with self.subTest(other=other.name):
                self.assertEqual(client.get(f'/api/agent-conversations/{other.id}').status_code, 404)
                renamed = client.post('/api/agent-conversations', {'op': 'renameConversation', 'id': str(other.id), 'name': 'Mine now'},
                                      content_type='application/json')
                self.assertEqual(renamed.status_code, 404)
                deleted = client.post('/api/agent-conversations', {'op': 'deleteConversation', 'id': str(other.id)},
                                      content_type='application/json')
                self.assertEqual(deleted.status_code, 404)
        self.assertEqual(sorted(AgentConversation.objects.values_list('name', flat=True)), sorted(['Chat', self.member.name]))
        self.assertEqual(member.get(f'/api/agent-conversations/{mine.id}').json()['conversation']['id'], str(mine.id))
        self.assertEqual(admin.get(f'/api/agent-conversations/{theirs.id}').json()['conversation']['id'], str(theirs.id))


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

    def test_with_agents_off_every_run_route_refuses_even_with_a_run_active(self):
        run = self.started()
        AppSetting.objects.update_or_create(key='agentsEnabled', defaults={'value': '0', 'updated_at': 1})
        for response in (self.post(self.base, {'content': 'And a wolf'}), self.get(f'{self.base}/{run.id}/events'),
                         self.post(f'{self.base}/{run.id}/cancel', {'cancelJobs': True})):
            self.assertEqual((response.status_code, response.json()['code']), (403, 'AGENTS_DISABLED'))
        self.assertEqual((AgentInboxMessage.objects.count(), AgentRun.objects.get(pk=run.id).cancel_requested_at), (0, None))
        AgentRun.objects.filter(pk=run.id).update(status='completed')
        refused = self.post(self.base, {'content': 'Another'})
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'AGENTS_DISABLED'))
        self.assertEqual(AgentRun.objects.count(), 1)
        self.assertEqual(AgentConversationMessage.objects.filter(content='Another').count(), 0)

    def test_the_per_user_switch_and_the_active_run_cap_refuse_a_new_run(self):
        UserLimit.objects.create(user_id=self.user.id, key='agentsEnabled', value='0', updated_at=1)
        refused = self.post(self.base, {'content': 'x'})
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'AGENTS_DISABLED'))
        UserLimit.objects.filter(user_id=self.user.id).delete()
        AppSetting.objects.update_or_create(key='agentActiveRuns', defaults={'value': '1', 'updated_at': 1})
        other = AgentConversation.objects.create(project_id=self.conversation.project_id, name='Other', kind='chat', agent_kind='image',
                                                 user_id=self.user.id, created_by=self.user.id, created_at=1, updated_at=1)
        self.started()
        refused = self.post(f'/api/agent-conversations/{other.id}/runs', {'content': 'x'})
        body = refused.json()
        self.assertEqual((refused.status_code, body['code'], body['kind']), (429, 'AGENT_LIMIT', 'active_runs'))
        self.assertEqual(AgentRun.objects.count(), 1)
        self.assertEqual(AgentConversationMessage.objects.filter(conversation_id=other.id).count(), 0)

    def test_only_a_global_agents_switch_of_0_refuses_a_new_run(self):
        for attempt in range(3):
            with self.subTest(attempt=attempt):
                run = self.started()
                AgentRun.objects.filter(pk=run.id).update(status='completed')
        AppSetting.objects.create(key='agentsEnabled', value='0', updated_at=1)
        refused = self.post(self.base, {'content': 'Another'})
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'AGENTS_DISABLED'))
        self.assertEqual(AgentRun.objects.count(), 3)

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


class NamingTests(RunsApiCase):
    """A chat the Agents tab created ('New chat') takes its first message as its name, so the chat list never shows two
    rows that read alike; a chat the artist named, and later messages, leave the name alone."""
    def rename(self, name):
        AgentConversation.objects.filter(pk=self.conversation.id).update(name=name)

    def test_a_new_chat_is_named_after_its_first_message(self):
        self.rename('New chat')
        response = self.post(self.base, {'content': '  A warm close-up\nof a potter  '})
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()['conversation']['name'], 'A warm close-up of a potter')
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).name, 'A warm close-up of a potter')
        self.post(self.base, {'content': 'Make it blue'})
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).name, 'A warm close-up of a potter')

    def test_a_long_first_message_is_cut_at_a_word(self):
        self.rename('New chat')
        self.post(self.base, {'content': 'Make a slow push-in video of the potter\'s wheel turning, golden hour, shallow focus, grain'})
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).name,
                         "Make a slow push-in video of the potter's wheel turning…")

    def test_a_named_chat_and_a_chat_with_earlier_messages_keep_their_names(self):
        self.rename('Spring hero')
        self.assertEqual(self.post(self.base, {'content': 'A fox'}).json()['conversation']['name'], 'Spring hero')
        self.rename('New chat')
        AgentRun.objects.update(status='completed')
        self.post(self.base, {'content': 'Another fox'})
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).name, 'New chat')


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


class DeleteWhileRunningTests(RunsApiCase):
    def test_deleting_the_chat_ends_its_active_run_and_its_jobs_still_finish(self):
        self.gemini([call('generate_image', {'prompt': 'red fox'})])
        run = self.started()
        self.assertEqual(self.advance(run), 'waiting')
        deleted = self.post('/api/agent-conversations', {'op': 'deleteConversation', 'id': str(self.conversation.id)})
        self.assertEqual(deleted.status_code, 200)
        self.assertFalse(AgentRun.objects.filter(pk=run.id).exists())
        self.assertFalse(AgentRunEvent.objects.filter(run_id=run.id).exists())
        self.assertEqual(self.advance(run), 'finished')
        self.assertEqual(Generation.objects.get().status, 'queued')
        # Nothing counts toward the active-run cap any more, so the artist can start again in another chat.
        self.assertFalse(AgentRun.objects.filter(status__in=ACTIVE_RUN_STATUSES).exists())

    def test_deleting_the_chat_mid_step_keeps_the_billed_call_and_the_worker_ends_quietly(self):
        def delete_mid_step():
            deleted = self.post('/api/agent-conversations', {'op': 'deleteConversation', 'id': str(self.conversation.id)})
            self.assertEqual(deleted.status_code, 200)
            return [text('Done.')]
        self.gemini(delete_mid_step)
        run = self.started()
        with self.assertNoLogs('veevee.agents', 'ERROR'):
            self.assertEqual(worker.handle_run(run.id, worker.default_process, Event()), 'finished')
        self.assertFalse(AgentRun.objects.filter(pk=run.id).exists())
        self.assertEqual(list(AgentLlmUsage.objects.values_list('user_id', 'grant_id', 'conversation_id', 'run_id')),
                         [(run.user_id, run.grant_id, None, None)])


class RunAttachmentTests(RunsApiCase):
    """A run message's document uploads and reference images are validated as /messages validates documents, stored by
    id, kind and filename on the message or inbox row, recorded on the chat, and named to the model in a note, so
    read_document and view_media open them. Nothing is read for the model at send time."""

    def upload(self, mime, data, *, name, purpose='document-reference', user=None):
        identifier, owner = uuid.uuid4(), user or self.user
        key = f'uploads/{purpose}/{owner.id}-{identifier}'
        url = self.store(key, data, mime)
        UploadSession.objects.create(id=identifier, actor_id=owner.id, key=key, purpose=purpose, content_type=mime, filename=name,
                                     byte_size=len(data), expires_at=timezone.now() + timedelta(hours=1), state='ready',
                                     finalized_at=timezone.now())
        return str(identifier), url

    def generation(self, user=None):
        identifier = uuid.uuid4()
        url = self.store(f'generations/{identifier}.png', png_bytes(), 'image/png')
        Generation.objects.create(id=identifier, kind='image', status='succeeded', prompt='a fox', model='Nano Banana 2.1',
                                  aspect_ratio='1:1', user_id=(user or self.user).id, url=url, created_at=1, updated_at=1)
        return str(identifier), url

    def note(self, *named):
        listed = '; '.join(f'{kind} {identifier}' + (f' named "{name}"' if name else '') for kind, identifier, name in named)
        return {'text': f'Veevee: the artist attached {listed}. Open documents with read_document and images, video and audio '
                        'with view_media, by id, before you rely on them.'}

    def recorded(self):
        return sorted(AgentChatAsset.objects.values_list('asset_id', 'source', 'kind', 'run_id'))

    def test_a_new_run_and_an_inbox_message_carry_their_files_by_id_to_the_model(self):
        notes, _ = self.upload('text/plain', b'Shot list: fox, snow.', name='notes.txt')
        image, image_url = self.upload('image/png', png_bytes(), name='fox.png', purpose='image-reference')
        made, made_url = self.generation()
        response = self.post(self.base, {'content': 'Use these', 'attachments': [notes, f' {notes} '], 'images': [image_url, made_url, image_url]})
        self.assertEqual(response.status_code, 201, response.content)
        stored = [{'id': notes, 'kind': 'document', 'name': 'notes.txt'}, {'id': image, 'kind': 'image', 'name': 'fox.png'},
                  {'id': made, 'kind': 'image', 'name': ''}]
        self.assertEqual(response.json()['message']['attachments'], stored)
        run = AgentRun.objects.get(pk=response.json()['run']['id'])
        self.assertEqual(AgentConversationMessage.objects.get().tool_trace, {'attachments': stored})
        self.assertEqual(self.recorded(), sorted((uuid.UUID(identifier), 'attachment', kind, run.id)
                                                 for identifier, kind in ((notes, 'document'), (image, 'image'), (made, 'image'))))

        brief, _ = self.upload('text/markdown', b'# Brief', name='brief.md')
        queued = self.post(self.base, {'content': 'And this', 'attachments': [brief]})
        self.assertEqual(queued.status_code, 202, queued.content)
        self.assertEqual(queued.json()['inbox']['attachments'], [{'id': brief, 'kind': 'document', 'name': 'brief.md'}])
        pending = self.get(f'{self.base}/{run.id}/events').json()['pendingMessages']
        self.assertEqual([item['attachments'] for item in pending], [[{'id': brief, 'kind': 'document', 'name': 'brief.md'}]])

        bodies = self.gemini([text('On it.')])
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(len(bodies), 1)                                     # no media sub-call: the model opens files itself
        self.assertEqual(bodies[0]['contents'][-1]['parts'], [
            {'text': 'Use these'}, self.note(('document', notes, 'notes.txt'), ('image', image, 'fox.png'), ('image', made, '')),
            {'text': 'And this'}, self.note(('document', brief, 'brief.md'))])
        thread = self.client_for(self.user).get(f'/api/agent-conversations/{self.conversation.id}').json()['messages']
        self.assertEqual([(item['content'], item.get('attachments')) for item in thread if item['role'] == 'user'],
                         [('Use these', stored), ('And this', [{'id': brief, 'kind': 'document', 'name': 'brief.md'}])])
        # The message the run read from its inbox names the run and the step it was read before; the first one does not.
        users = [item for item in thread if item['role'] == 'user']
        self.assertNotIn('runId', users[0])
        self.assertEqual((users[1]['runId'], users[1]['deliveredStep']), (str(run.id), 0))
        self.assertEqual([item['toolTrace'] for item in users], [None, None])

        # The next run's history names the earlier files again, and a plain message carries no note.
        self.post(self.base, {'content': 'Now a wolf'})
        later = AgentRun.objects.exclude(pk=run.id).get()
        bodies = self.gemini([text('A wolf.')])
        self.assertEqual(self.advance(later), 'completed')
        users = [turn['parts'] for turn in bodies[0]['contents'] if turn['role'] == 'user']
        self.assertEqual(users[0][1], self.note(('document', notes, 'notes.txt'), ('image', image, 'fox.png'), ('image', made, '')))
        self.assertEqual(users[-1], [{'text': 'Now a wolf'}])

    def test_a_teammates_library_image_is_a_reference(self):
        made, made_url = self.generation(user=self.make_user('other@example.invalid', 'Other', 'user'))
        response = self.post(self.base, {'content': 'Match this', 'images': [made_url]})
        self.assertEqual(response.status_code, 201, response.content)
        self.assertEqual(response.json()['message']['attachments'], [{'id': made, 'kind': 'image', 'name': ''}])
        run = AgentRun.objects.get(pk=response.json()['run']['id'])
        self.assertEqual(self.recorded(), [(uuid.UUID(made), 'attachment', 'image', run.id)])
        bodies = self.gemini([text('On it.')])
        self.assertEqual(self.advance(run), 'completed')
        self.assertEqual(bodies[0]['contents'][-1]['parts'], [{'text': 'Match this'}, self.note(('image', made, ''))])

    def test_refused_files_store_nothing(self):
        mine, _ = self.upload('text/plain', b'notes', name='notes.txt')
        other = self.make_user('other@example.invalid', 'Other', 'user')
        theirs, _ = self.upload('text/plain', b'notes', name='theirs.txt', user=other)
        _, teammate_upload_url = self.upload('image/png', png_bytes(), name='theirs.png', purpose='image-reference', user=other)
        image, image_url = self.upload('image/png', png_bytes(), name='fox.png', purpose='image-reference')
        document_url = self.store(f'uploads/document-reference/{uuid.uuid4()}', b'notes', 'text/plain')
        unknown = str(uuid.uuid4())
        cases = [
            ({'attachments': 'nope'}, 400, 'attachments must be a list of at most 10 upload ids.'),
            ({'attachments': [str(uuid.uuid4()) for _ in range(11)]}, 400, 'attachments must be a list of at most 10 upload ids.'),
            ({'attachments': [mine, unknown]}, 404, f'Attachment {unknown} is not in your library. Remove it and attach the file again.'),
            ({'attachments': [theirs]}, 404, f'Attachment {theirs} is not in your library. Remove it and attach the file again.'),
            ({'attachments': [image]}, 400, f'Attachment {image} is image/png; attach images as reference images.'),
            ({'images': 'nope'}, 400, 'images must be an array of data URLs.'),
            ({'images': ['data:image/png;base64,YQ==']}, 400, 'Upload reference images before you send them to the agent.'),
            ({'images': ['https://example.invalid/fox.png']}, 400, 'Use stored reference images.'),
            ({'images': ['/api/media/settings/secret.png']}, 400, 'Use stored reference images.'),
            ({'images': ['/api/media/thumbs/poster/settings/secret.png.webp']}, 400, 'Use stored reference images.'),
            ({'images': [document_url]}, 404, 'A reference image is not in the library. Remove it and attach it again.'),
            ({'images': [image_url, '/api/media/uploads/image-reference/missing.png']}, 404,
             'A reference image is not in the library. Remove it and attach it again.'),
            ({'images': [teammate_upload_url]}, 404, 'A reference image is not in the library. Remove it and attach it again.'),
        ]
        for extra, status, error in cases:
            with self.subTest(extra=extra):
                response = self.post(self.base, {'content': 'Use these', **extra})
                self.assertEqual((response.status_code, response.json()['error']), (status, error))
        self.assertFalse(AgentRun.objects.exists() or AgentConversationMessage.objects.exists() or AgentChatAsset.objects.exists())
        run = self.started()
        refused = self.post(self.base, {'content': 'And this', 'attachments': [unknown]})
        self.assertEqual(refused.status_code, 404)
        self.assertFalse(AgentInboxMessage.objects.exists() or AgentChatAsset.objects.exists())
        self.assertEqual(list(AgentRunEvent.objects.filter(run_id=run.id).values_list('kind', flat=True)), ['run_queued'])


class ComposerTests(RunsApiCase):
    """A message carries the composer it was sent from (mode, model, settings, location and, to upscale, the source):
    validated, stored on the message or inbox row, shown to the model as a note beside the message, and the chat's
    default location follows it, so new jobs land where the Agents tab says it saves."""
    upload = RunAttachmentTests.upload
    generation = RunAttachmentTests.generation

    def note(self, text):
        return {'text': f"Veevee: the artist sent this from the composer's {text}. "
                        'Use these choices for the work this message asks for, unless the artist says otherwise.'}

    def test_an_image_message_stores_its_composer_notes_it_and_moves_the_chats_location(self):
        sent = {'mode': 'image', 'model': 'Nano Banana 2.1', 'options': {'aspectRatio': '16:9', 'resolution': '2K', 'count': 2},
                'projectId': str(self.project.id), 'folderId': str(self.other.id)}
        response = self.post(self.base, {'content': 'A fox in snow', 'composer': sent})
        self.assertEqual(response.status_code, 201, response.content)
        stored = {'mode': 'image', 'options': {'aspectRatio': '16:9', 'resolution': '2K', 'count': 2}, 'model': 'nano-banana-2-1',
                  'modelName': 'Nano Banana 2.1', 'projectId': str(self.project.id), 'folderId': str(self.other.id)}
        self.assertEqual(response.json()['message']['composer'], stored)
        self.assertEqual(AgentConversationMessage.objects.get().tool_trace, {'composer': stored})
        conversation = AgentConversation.objects.get(pk=self.conversation.id)
        self.assertEqual((conversation.default_project_id, conversation.default_folder_id), (self.project.id, self.other.id))
        bodies = self.gemini([text('On it.')])
        self.assertEqual(self.advance(AgentRun.objects.get()), 'completed')
        self.assertEqual(bodies[0]['contents'][-1]['parts'], [
            {'text': 'A fox in snow'},
            self.note('Image mode: generate_image model nano-banana-2-1 (Nano Banana 2.1), aspectRatio "16:9", resolution "2K"; 2 outputs')])

    def test_the_project_alone_sends_new_jobs_to_its_unsorted_items(self):
        response = self.post(self.base, {'content': 'A fox', 'composer': {'mode': 'image', 'model': 'nano-banana-2-1',
                                                                           'projectId': str(self.project.id)}})
        self.assertEqual(response.status_code, 201, response.content)
        conversation = AgentConversation.objects.get(pk=self.conversation.id)
        self.assertEqual((conversation.default_project_id, conversation.default_folder_id), (self.project.id, None))
        self.assertEqual(runner.with_location(conversation, 'generate_image', {'prompt': 'fox'}),
                         {'prompt': 'fox', 'projectId': str(self.project.id)})

    def test_a_message_without_a_composer_keeps_the_chats_location(self):
        self.started()
        conversation = AgentConversation.objects.get(pk=self.conversation.id)
        self.assertEqual((conversation.default_folder_id, AgentConversationMessage.objects.get().tool_trace), (self.folder.id, None))

    def test_an_inbox_message_carries_its_composer_to_the_model(self):
        run = self.started()
        sent = {'mode': 'video', 'model': 'Seedance 2.5', 'options': {'durationSeconds': 5, 'generateAudio': False, 'draft': True,
                                                                     'bitrateMode': 'high', 'mode': 'generate', 'resolution': None},
                'folderId': str(self.other.id)}
        queued = self.post(self.base, {'content': 'Now a clip', 'composer': sent})
        self.assertEqual(queued.status_code, 202, queued.content)
        stored = {'mode': 'video', 'options': {'durationSeconds': 5, 'generateAudio': False, 'draft': True, 'bitrateMode': 'high',
                                               'mode': 'generate'},
                  'model': 'seedance-25', 'modelName': 'Seedance 2.5', 'folderId': str(self.other.id)}
        self.assertEqual(queued.json()['inbox']['composer'], stored)
        self.assertEqual(self.get(f'{self.base}/{run.id}/events').json()['pendingMessages'][0]['composer'], stored)
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).default_folder_id, self.other.id)
        bodies = self.gemini([text('On it.')])
        self.assertEqual(self.advance(run), 'completed')
        delivered = AgentConversationMessage.objects.get(content='Now a clip')
        self.assertEqual(delivered.tool_trace, {'runId': str(run.id), 'deliveredStep': 0, 'composer': stored})
        self.assertEqual(self.client_for(self.user).get(f'/api/agent-conversations/{self.conversation.id}').json()['messages'][1]['composer'],
                         stored)
        self.assertEqual(bodies[0]['contents'][-1]['parts'][-2:], [
            {'text': 'Now a clip'},
            self.note('Video mode: generate_video model seedance-25 (Seedance 2.5), bitrateMode "high", draft true, '
                      'durationSeconds 5, generateAudio false, mode "generate"')])

    def test_an_upscale_names_its_source_by_library_id(self):
        clip, clip_url = self.upload('video/mp4', b'\x00\x00\x00\x18ftypmp42', name='clip.mp4', purpose='video-reference')
        sent = {'mode': 'upscale', 'model': 'Magnific Video Creative',
                'upscale': {'media': 'video', 'params': {'resolution': '4k', 'fpsBoost': True}, 'source': clip_url}}
        response = self.post(self.base, {'content': 'Sharpen this', 'composer': sent})
        self.assertEqual(response.status_code, 201, response.content)
        stored = {'mode': 'upscale', 'media': 'video', 'params': {'resolution': '4k', 'fpsBoost': True}, 'sourceId': clip,
                  'model': 'magnific-video-creative', 'modelName': 'Magnific Video Creative'}
        self.assertEqual(response.json()['message']['composer'], stored)
        bodies = self.gemini([text('On it.')])
        self.assertEqual(self.advance(AgentRun.objects.get()), 'completed')
        self.assertEqual(bodies[0]['contents'][-1]['parts'][-1], self.note(
            'Upscale mode: upscale_media model magnific-video-creative (Magnific Video Creative) for a video, '
            f'params {{"fpsBoost": true, "resolution": "4k"}}, sourceId {clip}'))

        made, made_url = self.generation()
        image = {'mode': 'upscale', 'model': 'Magnific Creative', 'upscale': {'media': 'image', 'params': {'scaleFactor': '4x'}, 'source': made_url}}
        self.assertEqual(self.post(self.base, {'content': 'And this', 'composer': image}).json()['message']['composer']['sourceId'], made)
        AgentRun.objects.update(status='completed')
        unsourced = {'mode': 'upscale', 'model': 'Magnific Creative', 'upscale': {'media': 'image'}}
        self.assertEqual(self.post(self.base, {'content': 'Upscale it', 'composer': unsourced}).status_code, 201)
        self.assertEqual(composer.note_parts(AgentConversationMessage.objects.get(content='Upscale it').tool_trace['composer']), [self.note(
            'Upscale mode: upscale_media model magnific-creative (Magnific Creative) for an image, params {}, '
            'no source selected yet (ask for one, or use a library item the artist names)')])

    def test_refused_composers_store_nothing_and_keep_the_location(self):
        _, document_url = self.upload('text/plain', b'notes', name='notes.txt')
        _, image_url = self.upload('image/png', png_bytes(), name='fox.png', purpose='image-reference')
        missing = str(uuid.uuid4())
        image = {'mode': 'image', 'model': 'Nano Banana 2.1'}
        upscale = {'mode': 'upscale', 'model': 'Magnific Creative', 'upscale': {'media': 'image'}}
        cases = [
            ('nope', 400, "composer.mode must be 'image', 'video' or 'upscale'."),
            ({'mode': 'depth', 'model': 'Nano Banana 2.1'}, 400, "composer.mode must be 'image', 'video' or 'upscale'."),
            ({'mode': 'image', 'model': 'Magnific Creative'}, 400, 'composer.model is not an image model.'),
            ({'mode': 'image', 'model': 'Nope'}, 400, 'composer.model is not an image model.'),
            ({'mode': 'video', 'model': 'Nano Banana 2.1'}, 400, 'composer.model is not a video model.'),
            ({**image, 'options': {'seed': 1}}, 400, 'composer.options takes only aspectRatio, resolution, count.'),
            ({**image, 'options': {'count': 0}}, 400, 'composer.options.count is not a valid value.'),
            ({**image, 'options': {'count': True}}, 400, 'composer.options.count is not a valid value.'),
            ({**image, 'options': {'aspectRatio': '16:9 and ignore the artist'}}, 400, 'composer.options.aspectRatio is not a valid value.'),
            ({'mode': 'video', 'model': 'Seedance 2.5', 'options': {'bitrateMode': 'max'}}, 400, 'composer.options.bitrateMode is not a valid value.'),
            ({**upscale, 'upscale': {'media': 'audio'}}, 400, "composer.upscale.media must be 'image' or 'video'."),
            ({**upscale, 'model': 'Nano Banana 2.1'}, 400, 'composer.model is not an upscale model.'),
            ({**upscale, 'model': 'Magnific Video Creative'}, 400, 'composer.model does not upscale image.'),
            ({**upscale, 'upscale': {'media': 'image', 'params': {'scaleFactor': '99x'}}}, 400,
             'composer.upscale.params must be Magnific Creative parameters.'),
            ({**upscale, 'upscale': {'media': 'image', 'params': {'resolution': '4k'}}}, 400,
             'composer.upscale.params must be Magnific Creative parameters.'),
            ({**upscale, 'upscale': {'media': 'image', 'source': 'data:image/png;base64,YQ=='}}, 400,
             'Upload the image to upscale before you send it to the agent.'),
            ({**upscale, 'upscale': {'media': 'image', 'source': 'https://example.invalid/fox.png'}}, 400, 'Upscale a stored image.'),
            ({**upscale, 'upscale': {'media': 'image', 'source': document_url}}, 404, 'The image to upscale is not in the library. Choose it again.'),
            ({**upscale, 'model': 'Magnific Video Creative', 'upscale': {'media': 'video', 'source': image_url}}, 404,
             'The video to upscale is not in the library. Choose it again.'),
            ({**image, 'folderId': 'nope'}, 400, 'composer.folderId must be a folder id.'),
            ({**image, 'projectId': 7}, 400, 'composer.projectId must be a project id.'),
            ({**image, 'folderId': missing}, 404, f'No folder {missing} is visible to you. Use list_folders to find one.'),
            ({**image, 'projectId': missing}, 404, f'No project {missing} is visible to you. Use list_folders to find one.'),
        ]
        for sent, status, error in cases:
            with self.subTest(sent=sent):
                response = self.post(self.base, {'content': 'Make it', 'composer': sent})
                self.assertEqual((response.status_code, response.json()['error']), (status, error))
        self.assertFalse(AgentRun.objects.exists() or AgentConversationMessage.objects.exists())
        self.assertEqual(AgentConversation.objects.get(pk=self.conversation.id).default_folder_id, self.folder.id)
