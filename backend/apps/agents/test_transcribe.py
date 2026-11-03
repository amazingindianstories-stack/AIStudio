"""POST /api/agent-conversations/<id>/transcribe: an admin's own conversation only, raw audio under the voice caps, one
exact transcription call with a 'transcribe' usage row, and nothing stored or logged."""
import base64
import json
import logging
import os
import uuid
from unittest.mock import patch

from django.test import TestCase

from apps.admin_dashboard.models import AppSetting
from apps.authentication.session import sign_session
from apps.common.leases import now_ms
from apps.canvas.test_roles import make_user
from apps.integrations.transport import HttpResult, ProviderError
from apps.media.models import UploadSession
from . import media, services
from .loop_llm import TRANSCRIBE_PROMPT, transcribe_body
from .models import AgentLlmUsage
from .test_media import provider

FLASH = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'
HEADERS = {'Content-Type': 'application/json', 'x-goog-api-key': 'fixture-key'}
USAGE = {'promptTokenCount': 1_000, 'candidatesTokenCount': 200, 'thoughtsTokenCount': 100, 'totalTokenCount': 1_300,
         'promptTokensDetails': [{'modality': 'AUDIO', 'tokenCount': 1_000}]}
WORDS = 'नमस्ते, इस shot को थोड़ा brighter बनाओ'
NOTE = b'\x1aE\xdf\xa3' + b'\x42' * 20_000


def answer(text, status=200):
    parts = [{'text': 'Listening.', 'thought': True}] + ([{'text': text}] if text else [])
    body = {'candidates': [{'content': {'role': 'model', 'parts': parts}, 'finishReason': 'STOP'}], 'usageMetadata': USAGE}
    return HttpResult(status, json.dumps(body).encode())


class TranscribeTests(TestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.admin, self.other = make_user('voice-admin', 'admin'), make_user('voice-other', 'admin')
        self.conversation = services.create_conversation(uuid.uuid4(), 'image', 'Foxes', self.admin.id)['id']
        self.login(self.admin)
        key = patch.dict(os.environ, GOOGLE_API_KEY='fixture-key')
        key.start()
        self.addCleanup(key.stop)
        for target in ('apps.media.storage.get_storage', 'apps.agents.media.get_storage'):
            storage = patch(target, side_effect=AssertionError('a voice note reached storage'))
            storage.start()
            self.addCleanup(storage.stop)

    def login(self, user):
        self.client.cookies.clear()
        if user:
            self.client.cookies['veevee_session'] = sign_session(user)

    def post(self, data=NOTE, mime='audio/webm;codecs=opus', duration='3200', conversation=None, responses=()):
        query = '' if duration is None else f'?durationMs={duration}'
        sent = []
        with provider(list(responses), sent):
            response = self.client.post(f'/api/agent-conversations/{conversation or self.conversation}/transcribe{query}', data=data,
                                        content_type=mime, CONTENT_TYPE=mime)    # also on an empty body
        return response, sent

    def test_the_owner_gets_the_verbatim_transcript_from_one_exact_call_and_a_usage_row(self):
        logger = logging.getLogger('apps.agents')
        with self.assertLogs(level='DEBUG') as logs:
            logger.warning('test marker')
            response, sent = self.post(responses=[answer(WORDS)])
        self.assertEqual((response.status_code, response.json()), (200, {'transcript': WORDS}))
        body = transcribe_body('audio/webm', base64.b64encode(NOTE).decode())
        self.assertEqual(sent, [('POST', FLASH, HEADERS, body, None)])
        self.assertEqual(body['systemInstruction']['parts'][0]['text'], TRANSCRIBE_PROMPT)
        for words in ('English, Hindi or a mix of Hindi and English', 'Hindi in Devanagari, English in Latin letters', 'Do not translate'):
            self.assertIn(words, TRANSCRIBE_PROMPT)
        self.assertNotIn('tools', body)
        row = AgentLlmUsage.objects.get()
        self.assertEqual((row.user_id, row.conversation_id, row.grant_id, row.run_id, row.step_index, row.purpose, row.model, row.prompt_tokens,
                          row.output_tokens, row.thoughts_tokens, row.cost_microcents),
                         (self.admin.id, uuid.UUID(self.conversation), None, None, None, 'transcribe', 'gemini-3.8-flash', 1_000, 200, 100, 187_500))
        # The audio is never stored, and neither it nor the words reach the logs.
        self.assertFalse(UploadSession.objects.exists())
        logged = '\n'.join(logs.output)
        self.assertNotIn('नमस्ते', logged)
        self.assertNotIn(base64.b64encode(NOTE[:300]).decode()[:40], logged)

    def test_a_spent_daily_budget_refuses_the_voice_note_before_any_call(self):
        AppSetting.objects.create(key='agentGlobalDailyCapCents', value='1', updated_at=1)
        AgentLlmUsage.objects.create(user_id=self.admin.id, model='m', purpose='step', prompt_tokens=1, cached_tokens=0, output_tokens=1,
                                     thoughts_tokens=0, tool_prompt_tokens=0, total_tokens=2, cost_microcents=2_000_000, created_at=now_ms())
        response, sent = self.post(responses=[answer(WORDS)])
        self.assertEqual((response.status_code, sent), (429, []))
        self.assertIn('daily limit', response.json()['error'])
        self.assertEqual(AgentLlmUsage.objects.count(), 1)

    def test_safari_and_alias_mime_types_are_sent_as_their_canonical_type(self):
        for sent_as, canonical in (('audio/mp4', 'audio/mp4'), ('audio/x-wav', 'audio/wav'), ('audio/ogg; codecs=opus', 'audio/ogg')):
            with self.subTest(sent_as=sent_as):
                response, sent = self.post(mime=sent_as, responses=[answer('hello')])
                self.assertEqual(response.json(), {'transcript': 'hello'})
                self.assertEqual(sent[0][3]['contents'][0]['parts'][0]['inlineData']['mimeType'], canonical)

    def test_no_speech_is_an_empty_transcript(self):
        response, _ = self.post(responses=[answer('')])
        self.assertEqual((response.status_code, response.json()), (200, {'transcript': ''}))

    def test_admins_only_and_only_their_own_conversation(self):
        other = services.create_conversation(uuid.uuid4(), 'image', 'Theirs', self.other.id)['id']
        cases = (
            (None, self.conversation, 403), (make_user('voice-artist'), self.conversation, 403),
            (self.admin, other, 404), (self.admin, str(uuid.uuid4()), 404), (self.admin, 'not-a-conversation', 404),
        )
        for user, conversation, status in cases:
            with self.subTest(user=user and user.name, conversation=conversation):
                self.login(user)
                response, sent = self.post(conversation=conversation)
                self.assertEqual((response.status_code, sent), (status, []))
                self.assertEqual(self.client.get(f'/api/agent-conversations/{conversation}/transcribe').status_code, status)
        self.assertFalse(AgentLlmUsage.objects.exists())

    def test_the_caps_are_readable_and_enforced_before_any_call(self):
        self.assertEqual(self.client.get(f'/api/agent-conversations/{self.conversation}/transcribe').json(),
                         {'maxSeconds': 120, 'maxBytes': 4 * 1024 * 1024})
        with patch.dict(media.DEFAULTS, agentVoiceMaxSeconds=10, agentVoiceMaxBytes=30_000):
            self.assertEqual(self.client.get(f'/api/agent-conversations/{self.conversation}/transcribe').json(),
                             {'maxSeconds': 10, 'maxBytes': 30_000})
            cases = {
                'too many bytes': (dict(data=b'\x1a' * 30_001), 413),
                'too long': (dict(duration='10001'), 413),
                'infinite': (dict(duration='inf'), 413),
                'no duration': (dict(duration=None), 400),
                'zero duration': (dict(duration='0'), 400),
                'negative duration': (dict(duration='-5'), 400),
                'not a number': (dict(duration='nan'), 400),
                'empty': (dict(data=b''), 400),
                'video': (dict(mime='video/mp4'), 415),
                'an image': (dict(mime='image/png'), 415),
                'no type': (dict(mime=''), 415),
            }
            for name, (options, status) in cases.items():
                with self.subTest(name):
                    response, sent = self.post(**options)
                    self.assertEqual((response.status_code, sent), (status, []), response.content)
            response, _ = self.post(duration='10000', responses=[answer('ok')])
            self.assertEqual(response.json(), {'transcript': 'ok'})
        # More bytes than any voice codec writes in the claimed time: the duration was understated.
        response, sent = self.post(data=b'\x1a' * (media.VOICE_SLACK + media.VOICE_BYTE_RATE + 1), duration='1000')
        self.assertEqual((response.status_code, response.json()['error'], sent),
                         (400, 'The voice note is longer than its reported duration.', []))
        self.assertEqual(AgentLlmUsage.objects.count(), 1)                 # the one note within the caps

    def test_a_missing_key_is_an_explicit_error_never_a_mock_transcript(self):
        with patch.dict(os.environ, GOOGLE_API_KEY=''):
            response, sent = self.post()
        self.assertEqual((response.status_code, response.json(), sent),
                         (503, {'error': 'Voice input is not configured: GOOGLE_API_KEY is not set. Ask a Veevee admin.'}, []))

    def test_a_provider_failure_is_a_retryable_error_without_a_usage_row(self):
        failures = [HttpResult(500, b'{}'), HttpResult(429, b'{}')]
        for failure in failures:
            with self.subTest(status=failure.status):
                response, sent = self.post(responses=[failure])
                self.assertEqual((response.status_code, response.json(), len(sent)),
                                 (502, {'error': 'Veevee could not transcribe the voice note. Try again.'}, 1))

        def refuse(*args, **kwargs):
            raise ProviderError('timed out', code='timeout', may_have_submitted=True)
        with patch('apps.integrations.transport.HttpTransport._send', refuse):
            response = self.client.post(f'/api/agent-conversations/{self.conversation}/transcribe?durationMs=3200', data=NOTE,
                                        content_type='audio/webm')
        self.assertEqual(response.status_code, 502)
        self.assertFalse(AgentLlmUsage.objects.exists())
