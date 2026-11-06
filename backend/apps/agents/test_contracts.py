import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from django.db import connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.authentication.models import User
from .images import parse_message_body
from .models import AgentConversation, AgentConversationMessage
from . import services


class MessageBodyTests(SimpleTestCase):
    def test_message_validation_utf16_and_image_count(self):
        self.assertEqual(parse_message_body({}), {'error': 'content is required.'})
        self.assertIn('too long', parse_message_body({'content': '😀' * 4001})['error'])
        self.assertEqual(parse_message_body({'content': ' x ', 'images': [1, 'data:image/png;base64,YQ==']}), {'content': 'x', 'images': ['data:image/png;base64,YQ==']})
        self.assertIn('at most', parse_message_body({'content': 'x', 'images': ['x'] * 11})['error'])
        self.assertIn('array', parse_message_body({'content': 'x', 'images': None})['error'])


@override_settings(ROOT_URLCONF='apps.agents.urls')
class AgentHTTPTests(TransactionTestCase):
    cookie = SettingsTests.cookie

    def setUp(self):
        SettingsTests.setUp(self)
        self.actor = User.objects.get(pk='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        self.actor.role = 'admin'
        self.actor.save(update_fields=['role'])
        self.project = str(uuid.uuid4())

    def post(self, path, body):
        return self.client.post(path, body, content_type='application/json')

    def conversation(self, kind='image'):
        return services.create_conversation(self.project, kind, 'Thread', self.actor.id)

    def test_all_five_methods_need_the_agents_tab(self):
        identifier, message_id = str(uuid.uuid4()), str(uuid.uuid4())
        paths = [('get', '/api/agent-conversations'), ('post', '/api/agent-conversations'),
            ('get', f'/api/agent-conversations/{identifier}'), ('post', f'/api/agent-conversations/{identifier}/runs'),
            ('patch', f'/api/agent-conversations/{identifier}/messages/{message_id}')]
        for method, path in paths:
            self.assertEqual(getattr(self.client, method)(path, {}, content_type='application/json').status_code, 403)
        self.cookie()
        self.actor.role = 'member'; self.actor.save(update_fields=['role'])
        for method, path in paths:
            self.assertEqual(getattr(self.client, method)(path, {}, content_type='application/json').status_code, 403)

    def test_create_project_kind_lists_rename_delete_and_detail(self):
        self.cookie()
        base = '/api/agent-conversations'
        self.assertEqual(self.client.get(base).json(), {'error': 'projectId required.'})
        self.assertEqual(self.client.get(base, {'projectId': self.project, 'agentKind': 'depth'}).json(),
                         {'error': "agentKind must be 'image' or 'video' when sent."})
        for body in ({'op': 'createConversation'}, {'op': 'createConversation', 'projectId': self.project},
                     {'op': 'createConversation', 'projectId': self.project, 'agentKind': 'image', 'name': ' '},
                     {'op': 'createConversation', 'projectId': self.project, 'agentKind': 'upscale', 'name': 'Named'}):
            self.assertEqual(self.post(base, body).status_code, 400)
        created = self.post(base, {'op': 'createConversation', 'projectId': self.project, 'agentKind': 'image', 'name': '  Named  '}).json()['conversation']
        self.assertEqual((created['name'], created['createdBy'], created['agentKind']), ('Named', str(self.actor.id), 'image'))
        video = self.conversation('video')
        listing = self.client.get(base, {'projectId': self.project, 'agentKind': 'image'}).json()
        self.assertEqual([row['id'] for row in listing['conversations']], [created['id']])
        self.assertEqual(self.post(base, {'op': 'renameConversation', 'id': created['id'], 'name': '', 'agentKind': 'image'}).json()['conversations'][0]['name'], '')
        services.append_message(created['id'], 'user', 'Persisted')
        self.assertEqual(self.client.get(base + '/' + created['id']).json()['messages'][0]['content'], 'Persisted')
        self.assertEqual(self.post(base, {'op': 'deleteConversation', 'id': created['id'], 'agentKind': 'image'}).json(), {'conversations': []})
        self.assertFalse(AgentConversationMessage.objects.exists())
        self.assertTrue(AgentConversation.objects.filter(pk=video['id']).exists())

    def test_one_chat_list_holds_every_kind_and_new_chats_have_none(self):
        """The Agents tab's one chat makes images, videos and upscales: without agentKind the list is every chat in the
        project, a new chat has no kind, and rename and delete answer with that whole list."""
        self.cookie()
        base = '/api/agent-conversations'
        image, video = self.conversation('image'), self.conversation('video')
        created = self.post(base, {'op': 'createConversation', 'projectId': self.project, 'name': 'Shared'}).json()
        self.assertEqual(created['conversation']['agentKind'], None)
        self.assertEqual(AgentConversation.objects.get(pk=created['conversation']['id']).agent_kind, None)
        everything = {image['id'], video['id'], created['conversation']['id']}
        self.assertEqual({row['id'] for row in created['conversations']}, everything)
        self.assertEqual({row['id'] for row in self.client.get(base, {'projectId': self.project}).json()['conversations']}, everything)
        renamed = self.post(base, {'op': 'renameConversation', 'id': video['id'], 'name': 'Clips'}).json()['conversations']
        self.assertEqual({row['id']: row['name'] for row in renamed}[video['id']], 'Clips')
        self.assertEqual({row['id'] for row in self.post(base, {'op': 'deleteConversation', 'id': image['id']}).json()['conversations']},
                         everything - {image['id']})

    def test_attach_requires_same_conversation_and_existing_trace(self):
        self.cookie()
        one, two = self.conversation(), self.conversation()
        message = services.append_message(one['id'], 'assistant', 'Generating', {'tool': 'generate_image', 'result': {'prompt': 'P'}})
        path = f'/api/agent-conversations/{one["id"]}/messages/{message["id"]}'
        self.assertEqual(self.client.patch(path, {}, content_type='application/json').status_code, 400)
        wrong_path = f'/api/agent-conversations/{two["id"]}/messages/{message["id"]}'
        self.assertEqual(self.client.patch(wrong_path, {'generatedItemId': 'g'}, content_type='application/json').status_code, 404)
        result = self.client.patch(path, {'generatedItemId': '  generation-fixture  '}, content_type='application/json')
        self.assertEqual(result.json()['message']['toolTrace'], {'tool': 'generate_image', 'result': {'prompt': 'P'}, 'generatedItemId': 'generation-fixture'})
        no_trace = services.append_message(one['id'], 'user', 'No trace')
        self.assertIsNone(services.attach_generated_item(one['id'], no_trace['id'], 'id'))

    def test_concurrent_delete_append_never_creates_orphan_message(self):
        thread = self.conversation()
        barrier = Barrier(2)
        def call(delete):
            try:
                barrier.wait(10)
                if delete:
                    services.delete_conversation(thread['id'])
                else:
                    try:
                        services.append_message(thread['id'], 'user', 'Racing')
                    except ValueError:
                        pass
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(call, [True, False]))
        self.assertFalse(AgentConversation.objects.filter(pk=thread['id']).exists())
        self.assertFalse(AgentConversationMessage.objects.filter(conversation_id=thread['id']).exists())
