import base64
from copy import deepcopy
import io
import json
import uuid
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from django.db import connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.authentication.models import User
from apps.integrations.transport import HttpResult
from apps.media.storage import MemoryAdapter, StorageService
from .images import images_to_parts, parse_message_body
from .llm import GeminiAgentClient
from .orchestrator import run_turn, dispatch_tool, tools_for_kind
from .models import AgentConversation, AgentConversationMessage
from . import services


class SequenceTransport:
    def __init__(self, responses):
        self.responses, self.calls = responses, []
    def request(self, *args, **kwargs):
        self.calls.append((args, deepcopy(kwargs)))
        response = self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]
        return response if isinstance(response, HttpResult) else HttpResult(200, json.dumps(response).encode())


def result(parts, **extra):
    return {'candidates': [{'content': {'parts': parts}}], **extra}


class OrchestratorTests(SimpleTestCase):
    def llm_client(self, responses):
        transport = SequenceTransport(responses)
        return GeminiAgentClient(transport, env={'GOOGLE_API_KEY': 'fixture-key'}), transport

    def test_plain_reply_history_roles_tools_and_provider_headers(self):
        client, transport = self.llm_client([result([{'text': 'Sure.'}], usageMetadata={'promptTokenCount': 12, 'candidatesTokenCount': 5})])
        output = run_turn([{'role': 'system', 'content': 'ignore'}, {'role': 'user', 'content': 'Earlier'}, {'role': 'assistant', 'content': 'Answer'}], 'Hello', client=client)
        self.assertEqual(output, {'reply': 'Sure.', 'toolTrace': None})
        args, options = transport.calls[0]
        self.assertIn('gemini-flash-latest:generateContent', args[1])
        self.assertEqual(options['headers']['x-goog-api-key'], 'fixture-key')
        self.assertEqual(options['body']['contents'], [{'role': 'user', 'parts': [{'text': 'Earlier'}]}, {'role': 'model', 'parts': [{'text': 'Answer'}]}, {'role': 'user', 'parts': [{'text': 'Hello'}]}])
        self.assertEqual([tool['name'] for tool in options['body']['tools'][0]['functionDeclarations']], ['design_prompt', 'generate_image'])
        self.assertEqual(client.text(system_prompt='S', messages=[{'role': 'user', 'content': 'H'}])['usage'], {'tokensIn': 12, 'tokensOut': 5})

    def test_design_subcall_reference_parts_signature_and_trace_preserved(self):
        function = {'functionCall': {'name': 'design_prompt', 'args': {'idea': 'a detective', 'references': 'match clothing'}}, 'thoughtSignature': 'opaque-fixture-signature'}
        client, transport = self.llm_client([result([function]), result([{'text': '  A moody detective.  '}]), result([{'text': 'Your prompt.'}])])
        image = {'inlineData': {'mimeType': 'image/png', 'data': 'fixture'}}
        output = run_turn([], 'Design a detective', [image], client=client)
        self.assertEqual(output['toolTrace'], {'tool': 'design_prompt', 'args': function['functionCall']['args'], 'result': {'prompt': 'A moody detective.'}})
        self.assertEqual(len(transport.calls), 3)
        subcall = transport.calls[1][1]['body']
        self.assertNotIn('tools', subcall)
        self.assertEqual(subcall['contents'][0]['parts'][1], image)
        self.assertIn('Do NOT use @img', subcall['systemInstruction']['parts'][0]['text'])
        continuation = transport.calls[2][1]['body']['contents']
        self.assertEqual(continuation[1], {'role': 'model', 'parts': [function]})
        self.assertEqual(continuation[-1]['parts'][0]['functionResponse'], {'name': 'design_prompt', 'response': {'prompt': 'A moody detective.'}})

    def test_unknown_tool_failure_returns_result_then_recovers(self):
        client, transport = self.llm_client([result([{'functionCall': {'name': 'unknown', 'args': {}}}]), result([{'text': 'Recovered.'}])])
        self.assertEqual(run_turn([], 'Hi', client=client)['reply'], 'Recovered.')
        self.assertEqual(transport.calls[-1][1]['body']['contents'][-1]['parts'][0]['functionResponse']['response'], {'error': 'Tool failed.'})

    def test_tool_exception_credentials_are_not_forwarded_to_the_model(self):
        client, transport = self.llm_client([result([{'functionCall':{'name':'design_prompt','args':{}}}]),result([{'text':'Recovered.'}])])
        with patch('apps.agents.orchestrator.dispatch_tool',side_effect=ValueError('private-fixture-token')):
            self.assertEqual(run_turn([],'Hi',client=client)['reply'],'Recovered.')
        self.assertNotIn('private-fixture-token',json.dumps(transport.calls))
        self.assertEqual(len(transport.calls),2)

    def test_video_generation_trace_does_not_create_second_billed_job(self):
        client, transport = self.llm_client([result([{'functionCall': {'name': 'generate_video', 'args': {'prompt': '  A moving train  '}}}]), result([{'text': 'Generating.'}])])
        output = run_turn([], 'Generate', kind='video', client=client)
        self.assertEqual(output['toolTrace']['result'], {'prompt': 'A moving train'})
        self.assertEqual([tool['name'] for tool in transport.calls[0][1]['body']['tools'][0]['functionDeclarations']], ['design_prompt', 'generate_video'])
        self.assertIn('generate_video', transport.calls[0][1]['body']['systemInstruction']['parts'][0]['text'])
        self.assertEqual(len(transport.calls), 2)
        with self.assertRaisesMessage(ValueError, 'empty prompt'):
            dispatch_tool('generate_image', {'prompt': ' '}, [], client)

    def test_round_limit_empty_response_failure_and_configuration(self):
        client, transport = self.llm_client([result([{'functionCall': {'name': 'unknown', 'args': {}}}])])
        with self.assertRaisesMessage(ValueError, 'round limit'):
            run_turn([], 'Loop', client=client)
        self.assertEqual(len(transport.calls), 4)
        empty, _ = self.llm_client([{'candidates': [{'finishReason': 'SAFETY'}]}])
        with self.assertRaisesMessage(ValueError, 'SAFETY'):
            run_turn([], 'Blocked', client=empty)
        failed, _ = self.llm_client([HttpResult(429, b'quota')])
        with self.assertRaisesMessage(ValueError, 'Agent LLM error (429): quota'):
            run_turn([], 'Hi', client=failed)
        with self.assertRaisesMessage(ValueError, 'GOOGLE_API_KEY is not set.'):
            GeminiAgentClient(env={}, mock=False).raw(system_prompt='', contents=[])

    def test_message_validation_utf16_image_count_and_mime_security(self):
        self.assertEqual(parse_message_body({}), {'error': 'content is required.'})
        self.assertIn('too long', parse_message_body({'content': '😀' * 4001})['error'])
        self.assertEqual(parse_message_body({'content': ' x ', 'images': [1, 'data:image/png;base64,YQ==']}), {'content': 'x', 'images': ['data:image/png;base64,YQ==']})
        self.assertIn('at most', parse_message_body({'content': 'x', 'images': ['x'] * 11})['error'])
        self.assertIn('array', parse_message_body({'content': 'x', 'images': None})['error'])
        self.assertEqual(images_to_parts(['data:image/jpeg;base64,YQ==']), [{'inlineData': {'mimeType': 'image/jpeg', 'data': 'YQ=='}}])
        for ref in ('data:image/svg+xml;base64,YQ==', 'https://evil.invalid/private.png', '/api/media/settings/private.json'):
            with self.assertRaises(ValueError):
                images_to_parts([ref])

    def test_stored_reference_preview_capped_without_mutating_master(self):
        from PIL import Image
        stream = io.BytesIO()
        Image.new('RGB', (3000, 1500)).save(stream, format='PNG')
        original = stream.getvalue()
        storage = StorageService(MemoryAdapter())
        storage.primary.put('assets/large.png', original, 'image/png', '')
        part = images_to_parts(['/api/media/assets/large.png'], storage)[0]['inlineData']
        self.assertEqual(part['mimeType'], 'image/jpeg')
        with Image.open(io.BytesIO(base64.b64decode(part['data']))) as preview:
            self.assertEqual(preview.size, (2048, 1024))
        self.assertEqual(storage.primary.objects['assets/large.png'][0], original)


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

    def test_all_five_methods_admin_only(self):
        identifier, message_id = str(uuid.uuid4()), str(uuid.uuid4())
        paths = [('get', '/api/agent-conversations'), ('post', '/api/agent-conversations'),
            ('get', f'/api/agent-conversations/{identifier}'), ('post', f'/api/agent-conversations/{identifier}/messages'),
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
        self.assertEqual(self.client.get(base, {'projectId': self.project}).status_code, 400)
        for body in ({'op': 'createConversation'}, {'op': 'createConversation', 'projectId': self.project}, {'op': 'createConversation', 'projectId': self.project, 'agentKind': 'image', 'name': ' '}):
            self.assertEqual(self.post(base, body).status_code, 400)
        created = self.post(base, {'op': 'createConversation', 'projectId': self.project, 'agentKind': 'image', 'name': '  Named  '}).json()['conversation']
        self.assertEqual((created['name'], created['createdBy']), ('Named', str(self.actor.id)))
        video = self.conversation('video')
        listing = self.client.get(base, {'projectId': self.project, 'agentKind': 'image'}).json()
        self.assertEqual([row['id'] for row in listing['conversations']], [created['id']])
        self.assertEqual(self.post(base, {'op': 'renameConversation', 'id': created['id'], 'name': ''}).json()['conversations'][0]['name'], '')
        services.append_message(created['id'], 'user', 'Persisted')
        self.assertEqual(self.client.get(base + '/' + created['id']).json()['messages'][0]['content'], 'Persisted')
        self.assertEqual(self.post(base, {'op': 'deleteConversation', 'id': created['id']}).json(), {'conversations': []})
        self.assertFalse(AgentConversationMessage.objects.exists())
        self.assertTrue(AgentConversation.objects.filter(pk=video['id']).exists())

    def test_user_turn_persists_on_llm_failure_then_reply_with_trace(self):
        self.cookie()
        thread = self.conversation()
        path = f'/api/agent-conversations/{thread["id"]}/messages'
        with patch('apps.agents.views.run_turn', side_effect=ValueError('private-fixture-token')):
            response = self.post(path, {'content': '  First turn  '})
        self.assertEqual((response.status_code, response.json()['error']), (502, 'Orchestrator request failed.'))
        self.assertEqual(response.json()['userMessage']['content'], 'First turn')
        self.assertEqual(AgentConversationMessage.objects.count(), 1)
        trace = {'tool': 'generate_image', 'args': {'prompt': 'red bicycle'}, 'result': {'prompt': 'red bicycle'}}
        with patch('apps.agents.views.run_turn', return_value={'reply': 'Generating', 'toolTrace': trace}) as run:
            response = self.post(path, {'content': 'Generate that', 'images': ['data:image/png;base64,YQ==']})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['assistantMessage']['toolTrace'], trace)
        self.assertEqual(run.call_args.args[0], [{'role': 'user', 'content': 'First turn'}])
        self.assertEqual(run.call_args.args[2][0]['inlineData']['mimeType'], 'image/png')
        self.assertEqual(AgentConversationMessage.objects.count(), 3)

    def test_invalid_images_never_persist_user_turn_or_call_provider(self):
        self.cookie()
        thread = self.conversation()
        path = f'/api/agent-conversations/{thread["id"]}/messages'
        with patch('apps.agents.views.run_turn') as run:
            for body in ({}, {'content': 'x', 'images': None}, {'content': 'x', 'images': ['https://untrusted.invalid/image.png']}):
                self.assertEqual(self.post(path, body).status_code, 400)
            run.assert_not_called()
        self.assertFalse(AgentConversationMessage.objects.exists())

    def test_reference_preparation_error_does_not_disclose_or_persist(self):
        self.cookie()
        thread = self.conversation()
        with patch('apps.agents.views.images_to_parts',side_effect=ValueError('private-fixture-token')), patch('apps.agents.views.run_turn') as run:
            response = self.post(f'/api/agent-conversations/{thread["id"]}/messages',{'content':'fixture'})
        self.assertEqual(response.status_code,400)
        self.assertEqual(response.json(),{'error':'Invalid reference image.'})
        self.assertFalse(AgentConversationMessage.objects.exists())
        run.assert_not_called()

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
