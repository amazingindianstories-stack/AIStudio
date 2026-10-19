"""Paid guard for audio transcription, and the admin agent's exempt transport.

Audio: the API registers each intent in the paid ledger inside the transaction that creates it, the worker claims
RESERVED->ATTEMPTING only after its own never-replay claim committed, and the single Gemini POST moves
ATTEMPTING->SUBMITTING with this job's exact payload. The ledger below applies the production functions' rules
(reserve once for a new queued row of the actor; one-step transitions on the same input fingerprint).
"""
import base64
import contextlib
import hashlib
import json
import time
import uuid
from unittest.mock import patch

from django.db import connection
from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.agents.llm import AgentTransport, GeminiAgentClient, agent_payload_allowed
from apps.agents.orchestrator import run_turn, tools_for_kind
from apps.agents.prompts import DESIGN_PROMPT, system_prompt
from apps.generation.models import Generation
from apps.generation.providers.transport import HttpResult, HttpTransport, ProviderError
from apps.generation.services import audio_submission
from apps.generation.services.audio_submission import AUDIO_READY, audio_capacity_available, process_audio
from apps.generation.services.deadline import Cancellation
from apps.media.audio import TRANSCRIPTION_PROMPT, GeminiTranscriber
from apps.media.audio_inputs import MAX_AUDIO_BYTES, capture_audio_input
from apps.media.storage import MemoryAdapter, StorageService
from . import paid_guard

UNLIMITED = {'approved_scope': paid_guard.UNLIMITED_SCOPE, 'unlimited_new_jobs': True}
LIMITED = {'approved_scope': paid_guard.LIMITED_SCOPE, 'maximum_total_cents': paid_guard.CAP,
           'reviewed_maximum_quotes': paid_guard.operator_quotes('a' * 64), 'operator_budget_uncertainty_accepted': True}
ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent'
AUDIO = b'RIFF\x24\x00\x00\x00WAVEfmt fixture-audio-bytes'
SOURCE = 'data:audio/wav;base64,' + base64.b64encode(AUDIO).decode()
TRANSCRIPT = '[00:00.000 - 00:00.200] Ambience: quiet room tone.'


def gemini_reply(text=TRANSCRIPT):
    return HttpResult(200, json.dumps({'candidates': [{'content': {'parts': [{'text': text}]}, 'finishReason': 'STOP'}]}).encode())


def exact_body():
    return {'contents': [{'role': 'user', 'parts': [{'inlineData': {'mimeType': 'audio/wav', 'data': base64.b64encode(AUDIO).decode()}},
                                                    {'text': TRANSCRIPTION_PROMPT}]}], 'generationConfig': {'temperature': 0.1}}


def audio_contract(**changes):
    value = {'version': 2, 'operation': 'audio-transcription', 'source': '/api/media/references/x', 'model': 'gemini-2.5-flash',
             'originalName': 'clip.wav', 'mimeType': 'audio/wav', 'byteLength': len(AUDIO), 'sha256': hashlib.sha256(AUDIO).hexdigest()}
    inputs = changes.pop('submission_input', {})
    value = None if inputs is None else {**value, **inputs}
    contract = {name: None for name in ('id', 'user_id', 'kind', 'model', 'duration', 'resolution', 'generate_audio', 'draft_mode',
                'draft_task_id', 'bitrate_mode', 'video_task_mode', 'aspect_ratio', 'prompt', 'submission_input', 'reference_images',
                'reference_videos', 'reference_audios', 'continuation_frame_url', 'last_frame_url', 'project_id', 'folder_id',
                'track_characters', 'width', 'height')}
    contract.update(id=str(uuid.uuid4()), user_id=str(uuid.uuid4()), kind='audio', model='Gemini (gemini-2.5-flash)', prompt='',
                    aspect_ratio='audio', submission_input=value)
    contract.update(changes)
    return contract


class AudioQuoteTests(SimpleTestCase):
    def test_a_transcription_is_pinned_to_the_configured_models_generate_content_endpoint(self):
        self.assertEqual(paid_guard.quote_for(audio_contract(), UNLIMITED),
                         {'maximum_cents': 0, 'pricing_status': 'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE',
                          'allowed_paid_endpoints': [ENDPOINT], 'provider_payload_allowed_values': {}})
        with override_settings(AUDIO_TRANSCRIPTION_MODEL='gemini-3-flash'):
            quote = paid_guard.quote_for(audio_contract(model='Gemini (gemini-3-flash)', submission_input={'model': 'gemini-3-flash'}), UNLIMITED)
            self.assertEqual(quote['allowed_paid_endpoints'], ['https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent'])
            # A row made for another model than the configured one is refused.
            with self.assertRaisesRegex(ValueError, 'outside the configured model'):
                paid_guard.quote_for(audio_contract(), UNLIMITED)

    def test_anything_but_a_new_authenticated_snapshot_of_a_supported_audio_file_is_refused(self):
        refusals = [({'user_id': None}, 'New authenticated initial jobs only'), ({'draft_task_id': 'x'}, 'New authenticated initial jobs only'),
                    ({'submission_input': None}, 'New audio transcription only'),
                    ({'submission_input': {'version': 1}}, 'New audio transcription only'),
                    ({'submission_input': {'version': True}}, 'New audio transcription only'),
                    ({'submission_input': {'operation': 'image-edit'}}, 'New audio transcription only'),
                    ({'model': 'Gemini (gemini-2.5-pro)'}, 'outside the configured model'),
                    ({'submission_input': {'model': 'gemini-2.5-pro'}}, 'outside the configured model'),
                    ({'submission_input': {'mimeType': 'video/mp4'}}, 'outside the transcription contract'),
                    ({'submission_input': {'byteLength': MAX_AUDIO_BYTES + 1}}, 'outside the transcription contract'),
                    ({'submission_input': {'byteLength': '12'}}, 'outside the transcription contract'),
                    ({'submission_input': {'sha256': 'not-a-digest'}}, 'outside the transcription contract')]
        for change, message in refusals:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                paid_guard.quote_for(audio_contract(**change), UNLIMITED)
        with override_settings(AUDIO_TRANSCRIPTION_MODEL='gemini-2.5-flash/../../files'), self.assertRaisesRegex(ValueError, 'outside the configured model'):
            paid_guard.quote_for(audio_contract(model='Gemini (gemini-2.5-flash/../../files)', submission_input={'model': 'gemini-2.5-flash/../../files'}), UNLIMITED)
        # The limited (priced) scope has no reviewed transcription quote.
        with self.assertRaisesRegex(ValueError, 'No verified maximum charge quote'):
            paid_guard.quote_for(audio_contract(), LIMITED)

    def test_only_the_exact_transcription_payload_for_this_snapshot_matches(self):
        contract = audio_contract()
        self.assertTrue(paid_guard.audio_payload_matches(exact_body(), contract))

        def changed(edit):
            body = exact_body()
            edit(body)
            return body
        other = base64.b64encode(AUDIO + b'x').decode()
        variants = {
            'other bytes': changed(lambda b: b['contents'][0]['parts'][0]['inlineData'].update(data=other)),
            'truncated bytes': changed(lambda b: b['contents'][0]['parts'][0]['inlineData'].update(data=base64.b64encode(AUDIO[:-1]).decode())),
            'not base64': changed(lambda b: b['contents'][0]['parts'][0]['inlineData'].update(data='%%%')),
            'other MIME': changed(lambda b: b['contents'][0]['parts'][0]['inlineData'].update(mimeType='audio/mpeg')),
            'other prompt': changed(lambda b: b['contents'][0]['parts'][1].update(text='Describe this audio.')),
            'extra part': changed(lambda b: b['contents'][0]['parts'].append({'text': 'and more'})),
            'second content': changed(lambda b: b['contents'].append(b['contents'][0])),
            'model role': changed(lambda b: b['contents'][0].update(role='model')),
            'tools': changed(lambda b: b.update(tools=[{'googleSearch': {}}])),
            'more candidates': changed(lambda b: b['generationConfig'].update(candidateCount=4)),
            'other temperature': changed(lambda b: b['generationConfig'].update(temperature=1.0)),
            'file reference': changed(lambda b: b['contents'][0]['parts'][0].update(fileData={'fileUri': 'x'})),
            'no generation config': changed(lambda b: b.pop('generationConfig')),
        }
        for name, body in variants.items():
            with self.subTest(name):
                self.assertFalse(paid_guard.audio_payload_matches(body, contract))
        self.assertFalse(paid_guard.audio_payload_matches({}, contract))
        self.assertFalse(paid_guard.audio_payload_matches({'contents': 'x', 'generationConfig': {'temperature': 0.1}}, contract))


class LedgerCursor:
    """The paid-budget functions with the production rules; every other statement reaches the real database."""
    def __init__(self, real, ledger):
        self.real, self.ledger = real, ledger

    def __enter__(self):
        self.real.__enter__()
        return self

    def __exit__(self, *exc):
        return self.real.__exit__(*exc)

    def __getattr__(self, name):
        return getattr(self.real, name)

    def execute(self, sql, params=None):
        if isinstance(sql, str) and 'goal4_preview_paid_budget.reserve' in sql:
            generation, actor, cents, quote, contract = params
            self.real.execute('SELECT user_id::text, status, task_id FROM generations WHERE id=%s', [generation])
            row = self.real.fetchone()
            if cents != 0 or row is None or row != (str(actor), 'queued', None) or str(generation) in self.ledger:
                raise RuntimeError('Only new authenticated queued jobs allowed')
            self.ledger[str(generation)] = {'state': 'RESERVED', 'input': contract}
            return None
        if isinstance(sql, str) and 'goal4_preview_paid_budget.transition' in sql:
            generation, contract, old, new = params
            job = self.ledger.get(str(generation))
            if job is None or job['state'] != old or job['input'] != contract:
                raise RuntimeError('No paid submission retry or stale input')
            job['state'] = new
            return None
        return self.real.execute(sql, params)


@contextlib.contextmanager
def guard(ledger, sent, responses=None):
    """The production paid guard over a provider that records each request and answers from `responses`."""
    from apps.generation.services import enqueue, executor, upscale_submission
    originals = (enqueue.persist, executor.execute_admitted, HttpTransport.request, upscale_submission.submit_claimed_upscale,
                 audio_submission.persist_audio_intent, audio_submission.transcribe_claimed)
    flag = getattr(enqueue, '_goal4_paid_guard_installed', False)

    def provider(self, method, url, **kwargs):
        sent.append((method, url, kwargs.get('body')))
        return responses.pop(0) if responses else gemini_reply()

    HttpTransport.request = provider
    enqueue._goal4_paid_guard_installed = False
    real_cursor = connection.cursor
    try:
        with patch.object(connection, 'cursor', lambda *args, **kwargs: LedgerCursor(real_cursor(*args, **kwargs), ledger)):
            paid_guard.install_paid_guard(UNLIMITED)
            yield
    finally:
        (enqueue.persist, executor.execute_admitted, HttpTransport.request, upscale_submission.submit_claimed_upscale,
         audio_submission.persist_audio_intent, audio_submission.transcribe_claimed) = originals
        enqueue._goal4_paid_guard_installed = flag
        paid_guard.STATE.active = None
        paid_guard.STATE.api_error = None


def transcriber():
    from apps.media.audio import get_transcriber
    with override_settings(VEEVEE_AUDIO_TRANSCRIBER=None, GOOGLE_API_KEY='fixture-key'):
        return get_transcriber()


class AudioGuardFlowTests(TransactionTestCase):
    def setUp(self):
        self.store = StorageService(MemoryAdapter())

    def fields(self, **changes):
        identifier, now = uuid.uuid4(), int(time.time() * 1000)
        value = capture_audio_input(self.store, SOURCE, identifier, model='gemini-2.5-flash', name='clip.wav')
        # The same fields the transcription view commits.
        return {'id': identifier, 'kind': 'audio', 'status': 'queued', 'prompt': '', 'model': 'Gemini (gemini-2.5-flash)',
                'aspect_ratio': 'audio', 'reference_audios': [SOURCE], 'project_id': None, 'user_id': uuid.uuid4(), 'cost_cents': 0,
                'cost_basis': 'estimated', 'created_at': now, 'updated_at': now, 'provider_status': AUDIO_READY,
                'submission_input': value, **changes}

    def run_worker(self, row, provider=None):
        return process_audio(row.id, 'audio:' + uuid.uuid4().hex, signal=Cancellation(), provider=provider or transcriber(), storage=self.store)

    def test_the_api_registers_the_intent_in_the_transaction_that_creates_it(self):
        ledger, sent = {}, []
        with guard(ledger, sent):
            row = audio_submission.persist_audio_intent(self.fields())
        self.assertEqual(ledger[str(row.id)]['state'], 'RESERVED')
        self.assertEqual(ledger[str(row.id)]['input'], paid_guard.fingerprint(paid_guard.execution_contract(row)))
        self.assertEqual(sent, [])

    def test_an_intent_the_guard_refuses_is_never_committed(self):
        ledger, sent = {}, []
        for fields, message in ((self.fields(model='Gemini (gemini-2.5-pro)'), 'Audio transcription outside the configured model'),
                                (self.fields(user_id=None), 'New authenticated initial jobs only')):
            with self.subTest(message=message), guard(ledger, sent):
                with self.assertRaises(ValueError):
                    audio_submission.persist_audio_intent(fields)
                self.assertEqual(paid_guard.STATE.api_error, message)
            self.assertFalse(Generation.objects.filter(pk=fields['id']).exists())
        # A ledger refusal (here: a replayed registration) rolls the row back too.
        fields = self.fields()
        ledger[str(fields['id'])] = {'state': 'RESERVED', 'input': 'x'}
        with guard(ledger, sent):
            with self.assertRaises(RuntimeError):
                audio_submission.persist_audio_intent(fields)
            self.assertEqual(paid_guard.STATE.api_error, 'Paid Preview budget unavailable or exhausted; no provider submission occurred.')
        self.assertFalse(Generation.objects.filter(pk=fields['id']).exists())
        self.assertEqual(sent, [])

    def test_the_worker_claims_once_and_sends_exactly_this_jobs_request(self):
        ledger, sent = {}, []
        with guard(ledger, sent):
            row = audio_submission.persist_audio_intent(self.fields())
            outcome = self.run_worker(row)
        self.assertEqual(outcome['kind'], 'completed')
        self.assertEqual(sent, [('POST', ENDPOINT, exact_body())])
        self.assertEqual(ledger[str(row.id)]['state'], 'SUBMITTING')
        row.refresh_from_db()
        self.assertEqual((row.status, row.provider_status, row.prompt), ('succeeded', 'COMPLETED', TRANSCRIPT))

    def test_an_unregistered_intent_is_never_sent_and_frees_the_users_slot(self):
        # e.g. a row created before this release, or by any path that skipped registration
        ledger, sent = {}, []
        row = Generation.objects.create(**self.fields())
        with guard(ledger, sent):
            outcome = self.run_worker(row)
        row.refresh_from_db()
        self.assertEqual((outcome['kind'], row.status, row.provider_status), ('failed', 'failed', 'REJECTED'))
        self.assertEqual(sent, [])
        self.assertTrue(audio_capacity_available(row.user_id))

    def test_a_replayed_intent_is_refused_before_any_request(self):
        ledger, sent = {}, []
        with guard(ledger, sent):
            row = audio_submission.persist_audio_intent(self.fields())
            self.assertEqual(self.run_worker(row)['kind'], 'completed')
            # Force the finished row back into the queue: its ledger entry has already been spent.
            Generation.objects.filter(pk=row.id).update(status='queued', provider_status=AUDIO_READY, prompt='', completed_at=None)
            outcome = self.run_worker(row)
        self.assertEqual(outcome['kind'], 'failed')
        self.assertEqual(len(sent), 1)
        self.assertEqual(ledger[str(row.id)]['state'], 'SUBMITTING')

    def test_a_second_post_inside_one_claim_is_refused_and_the_job_stays_held(self):
        ledger, sent = {}, []

        class Twice:
            def transcribe(self, data, mime, model, *, signal=None):
                inner = transcriber()
                inner.transcribe(data, mime, model, signal=signal)
                return inner.transcribe(data, mime, model, signal=signal)
        with guard(ledger, sent):
            row = audio_submission.persist_audio_intent(self.fields())
            with self.assertRaisesRegex(RuntimeError, 'No paid submission retry'):
                self.run_worker(row, Twice())
        self.assertEqual(len(sent), 1)
        row.refresh_from_db()
        # The first request may have been billed: never replayed, held as uncertain.
        self.assertEqual(row.provider_status, 'SUBMISSION_UNCERTAIN')

    def test_a_request_outside_the_quote_is_refused_and_ends_the_job(self):
        ledger, sent = {}, []

        class Tampered:
            def __init__(self, url=ENDPOINT, edit=None):
                self.url, self.edit = url, edit

            def transcribe(self, data, mime, model, *, signal=None):
                body = exact_body()
                if self.edit:
                    self.edit(body)
                HttpTransport(allowed_hosts=['generativelanguage.googleapis.com']).request('POST', self.url, body=body)
                return TRANSCRIPT
        for name, provider in (('other model', Tampered(url=ENDPOINT.replace('gemini-2.5-flash', 'gemini-2.5-pro'))),
                               ('grounding tool', Tampered(edit=lambda b: b.update(tools=[{'googleSearch': {}}]))),
                               ('other bytes', Tampered(edit=lambda b: b['contents'][0]['parts'][0]['inlineData'].update(data='AAAA')))):
            with self.subTest(name), guard(ledger, sent):
                row = audio_submission.persist_audio_intent(self.fields())
                outcome = self.run_worker(row, provider)
            row.refresh_from_db()
            self.assertEqual((outcome['kind'], row.status), ('failed', 'failed'))
            self.assertEqual(ledger[str(row.id)]['state'], 'ATTEMPTING')
        self.assertEqual(sent, [])

    def test_no_request_leaves_without_a_claim_and_no_transport_can_opt_out(self):
        ledger, sent = {}, []
        with guard(ledger, sent):
            with self.assertRaises(ProviderError) as caught:
                transcriber().transcribe(base64.b64encode(AUDIO).decode(), 'audio/wav', 'gemini-2.5-flash')
            self.assertEqual((caught.exception.code, caught.exception.may_have_submitted), ('preview_paid_scope', False))
            for marker in (False, 'yes', 1):
                class Sneaky(HttpTransport):
                    paid_guard_exempt = marker
                with self.subTest(marker=marker), self.assertRaises(ProviderError):
                    GeminiTranscriber('k', lambda url, payload, headers, signal=None: Sneaky(allowed_hosts=['generativelanguage.googleapis.com'])
                                      .request('POST', url, headers=headers, body=payload)).transcribe('QUJD', 'audio/wav', 'gemini-2.5-flash')
            # The exempt agent transport refuses the transcription endpoint (and any model but the agent's).
            with self.assertRaises(ProviderError) as caught:
                AgentTransport({}).request('POST', ENDPOINT, body=exact_body())
            self.assertEqual((caught.exception.code, caught.exception.may_have_submitted), ('agent_scope', False))
        self.assertEqual(sent, [])


AGENT_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent'


def agent_body(kind='image', **changes):
    body = {'systemInstruction': {'parts': [{'text': system_prompt(kind)}]},
            'contents': [{'role': 'user', 'parts': [{'text': 'A quiet courtyard at dawn'}, {'inlineData': {'mimeType': 'image/png', 'data': 'iVBORw0KGgo='}}]}],
            'tools': [{'functionDeclarations': tools_for_kind(kind)}]}
    body.update(changes)
    return body


class AgentTransportTests(TransactionTestCase):
    def test_a_chat_turn_with_a_tool_call_passes_the_paid_guard_on_the_agent_endpoint_only(self):
        ledger, sent = {}, []
        call = {'functionCall': {'name': 'design_prompt', 'args': {'idea': 'courtyard at dawn'}}, 'thoughtSignature': 'c2ln'}
        replies = [HttpResult(200, json.dumps({'candidates': [{'content': {'parts': parts}}]}).encode())
                   for parts in ([call], [{'text': 'A misty stone courtyard at dawn.'}], [{'text': 'Here is your prompt.'}])]
        with guard(ledger, sent, replies):
            client = GeminiAgentClient(env={'GOOGLE_API_KEY': 'fixture-key'})
            self.assertIsInstance(client.transport, AgentTransport)
            result = run_turn([{'role': 'assistant', 'content': 'Hi'}], 'A courtyard', [], 'video', client)
        self.assertEqual(result['reply'], 'Here is your prompt.')
        self.assertEqual([url for _, url, _ in sent], [AGENT_ENDPOINT] * 3)
        self.assertEqual(sent[1][2]['systemInstruction'], {'parts': [{'text': DESIGN_PROMPT}]})
        self.assertNotIn('tools', sent[1][2])
        self.assertEqual(sent[2][2]['contents'][-2], {'role': 'model', 'parts': [call]})
        self.assertEqual(ledger, {})

    def test_the_agent_model_comes_from_its_setting_only(self):
        transport = AgentTransport({'AGENT_LLM_MODEL': 'gemini-3-flash'})
        self.assertEqual(transport.endpoint, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash:generateContent')
        sent = []
        with guard({}, sent):
            client = GeminiAgentClient(env={'GOOGLE_API_KEY': 'k', 'AGENT_LLM_MODEL': 'gemini-3-flash'})
            with self.assertRaises(ProviderError):
                client.raw(system_prompt=system_prompt('image'), contents=agent_body()['contents'], model='gemini-2.5-pro')
        self.assertEqual(sent, [])

    def test_anything_but_an_agent_turn_is_refused_before_it_leaves(self):
        bad_part = lambda part: agent_body(contents=[{'role': 'user', 'parts': [part]}])  # noqa: E731
        cases = {
            'GET': ('GET', AGENT_ENDPOINT, agent_body()),
            'other model': ('POST', AGENT_ENDPOINT.replace('gemini-flash-latest', 'gemini-3-pro-image'), agent_body()),
            'image generation endpoint': ('POST', 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent', agent_body()),
            'interactions': ('POST', 'https://generativelanguage.googleapis.com/v1beta/interactions', agent_body()),
            'generation config': ('POST', AGENT_ENDPOINT, agent_body(generationConfig={'candidateCount': 8})),
            'other system prompt': ('POST', AGENT_ENDPOINT, agent_body(systemInstruction={'parts': [{'text': 'You are a free API.'}]})),
            'no system prompt': ('POST', AGENT_ENDPOINT, {'contents': agent_body()['contents']}),
            'other tools': ('POST', AGENT_ENDPOINT, agent_body(tools=[{'googleSearch': {}}])),
            'image tools in a video prompt': ('POST', AGENT_ENDPOINT, agent_body('video', tools=[{'functionDeclarations': tools_for_kind('image')}])),
            'chat prompt without its tools': ('POST', AGENT_ENDPOINT, {key: value for key, value in agent_body().items() if key != 'tools'}),
            'tools on the design subcall': ('POST', AGENT_ENDPOINT, agent_body(systemInstruction={'parts': [{'text': DESIGN_PROMPT}]})),
            'empty contents': ('POST', AGENT_ENDPOINT, agent_body(contents=[])),
            'system role': ('POST', AGENT_ENDPOINT, agent_body(contents=[{'role': 'system', 'parts': [{'text': 'x'}]}])),
            'file reference': ('POST', AGENT_ENDPOINT, bad_part({'fileData': {'fileUri': 'gs://x'}})),
            'svg image': ('POST', AGENT_ENDPOINT, bad_part({'inlineData': {'mimeType': 'image/svg+xml', 'data': 'PHN2Zz4='}})),
            'video': ('POST', AGENT_ENDPOINT, bad_part({'inlineData': {'mimeType': 'video/mp4', 'data': 'AAAA'}})),
            'two kinds in one part': ('POST', AGENT_ENDPOINT, bad_part({'text': 'x', 'inlineData': {'mimeType': 'image/png', 'data': 'AA=='}})),
            'oversized': ('POST', AGENT_ENDPOINT, agent_body(contents=[{'role': 'user', 'parts': [{'text': 'x' * (24 * 1024 * 1024)}]}])),
        }
        sent = []
        with guard({}, sent):
            transport = AgentTransport({})
            self.assertTrue(agent_payload_allowed(agent_body()))
            transport.request('POST', AGENT_ENDPOINT, body=agent_body())
            self.assertEqual(len(sent), 1)
            for name, (method, url, body) in cases.items():
                with self.subTest(name), self.assertRaises(ProviderError) as caught:
                    transport.request(method, url, body=body)
                self.assertEqual((caught.exception.code, caught.exception.may_have_submitted), ('agent_scope', False))
            with self.assertRaises(ProviderError):
                transport.request('POST', AGENT_ENDPOINT, raw_body=json.dumps(agent_body()).encode())
        self.assertEqual(len(sent), 1)

    def test_the_exemption_is_the_agents_own_and_plain_transports_stay_guarded(self):
        self.assertIs(AgentTransport.paid_guard_exempt, True)
        sent = []
        with guard({}, sent):
            with self.assertRaises(ProviderError) as caught:
                HttpTransport(allowed_hosts=['generativelanguage.googleapis.com']).request('POST', AGENT_ENDPOINT, body=agent_body())
            self.assertEqual(caught.exception.code, 'preview_paid_scope')
        self.assertEqual(sent, [])


class AgentMockModeTests(SimpleTestCase):
    def test_mock_mode_never_builds_a_request(self):
        client = GeminiAgentClient(env={'MOCK_GENERATION': '1'})
        self.assertTrue(client.mock)
        self.assertEqual(client.raw(system_prompt='x', contents=[])['parts'][0]['text'], 'I can help you develop a prompt for your scene.')
