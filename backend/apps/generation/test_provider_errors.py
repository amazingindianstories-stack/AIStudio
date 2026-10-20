"""Exact provider error capture, the user message that quotes it, and the same through the real worker.

Every adapter records the provider's own answer (code, message, param, request id, task id, bounded redacted raw
body); the user sees the plain sentence followed by that exact detail. The real error shapes come from
testsupport.fake_providers, which the end-to-end cases also serve through the fake provider network.
"""
import json
import os
import uuid
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.admin_dashboard import tests as session_fixtures
from apps.media.storage import MemoryAdapter, StorageService
from testsupport.fake_providers import (FakeProviders, PROVIDER_ERRORS, REQUEST_ID, asset_error, byteplus_error, google_error,
                                        kling_error, magnific_error)
from . import failure_copy, provider_errors
from .models import Generation
from .providers import gemini, kling, magnific, omni, seedance, seedream
from apps.integrations.transport import HttpResult, ProviderError
from .serialization import generation_item
from .services import executor, poller
from .services.deadline import Cancellation

NOW = 1792400000000
AUDIO_MESSAGE = 'The request failed because the input audio may contain sensitive information.'


class Transport:
    def __init__(self, *results):
        self.results, self.calls = list(results), []

    def request(self, method, url, **options):
        self.calls.append((method, url))
        return self.results.pop(0)


def answer(status, body, headers=None):
    return HttpResult(status, json.dumps(body).encode(), headers or {'content-type': 'application/json'})


def row(kind='video', model='Seedance 2.5', responses=None, blocked=None):
    return SimpleNamespace(kind=kind, model=model, moderation_blocked=blocked, provider_responses=responses)


@patch('apps.generation.provider_errors.now_ms', return_value=NOW)
class CaptureTests(SimpleTestCase):
    """Each adapter's record of the provider's real error shape."""

    def raised(self, call):
        with self.assertRaises(ProviderError) as caught:
            call()
        return caught.exception

    def test_seedance_create_rejection_keeps_code_param_and_request_id(self, _):
        status, body = PROVIDER_ERRORS['seedance']
        error = self.raised(lambda: seedance.create_video_task({'prompt': 'x', 'modelDisplay': 'Seedance 2.5'},
            env={'ARK_API_KEY': 'fixture'}, transport=Transport(answer(status, body))))
        self.assertEqual(error.provider_response, {
            'provider': 'seedance', 'phase': 'create', 'source': 'provider', 'httpStatus': 400,
            'code': 'InputAudioSensitiveContentDetected', 'message': AUDIO_MESSAGE + ' Request id: ' + REQUEST_ID,
            'param': 'content[10]', 'requestId': REQUEST_ID, 'rawBody': json.dumps(body), 'receivedAt': NOW})
        self.assertEqual((error.code, error.may_have_submitted, error.upstream_code), ('moderation', False, 'InputAudioSensitiveContentDetected'))

    def test_seedance_header_request_id_wins_and_finalization_keeps_it_too(self, _):
        body = {'error': {'code': 'InvalidParameter', 'message': 'bad draft'}}
        error = self.raised(lambda: seedance.create_final_video_task({'modelDisplay': 'Seedance 2.5', 'draftTaskId': 'cgt-1'},
            env={'ARK_API_KEY': 'fixture'}, transport=Transport(answer(400, body, {'X-Request-Id': 'hdr-1'}))))
        self.assertEqual((error.provider_response['phase'], error.provider_response['requestId'], error.provider_response['code']),
                         ('finalize', 'hdr-1', 'InvalidParameter'))

    def test_seedance_async_task_failure(self, _):
        payload = {'id': 'cgt-9', 'status': 'failed', 'error': {'code': 'OutputVideoSensitiveContentDetected',
                                                               'message': 'The output video may contain sensitive information.'}}
        result = seedance.normalize_video_task_payload(payload)
        self.assertEqual(result['providerError'], {
            'provider': 'seedance', 'phase': 'task', 'source': 'provider', 'code': 'OutputVideoSensitiveContentDetected',
            'message': 'The output video may contain sensitive information.', 'taskId': 'cgt-9', 'rawBody': json.dumps(payload),
            'receivedAt': NOW})
        # A callback wraps the task in "data"; the record is the same.
        self.assertEqual(seedance.normalize_video_task_payload({'data': payload})['providerError'], result['providerError'])

    def test_seedance_status_poll_error_names_the_task(self, _):
        error = self.raised(lambda: seedance.get_video_task('cgt-3', env={'ARK_API_KEY': 'fixture'},
            transport=Transport(answer(500, {'error': {'code': 'InternalServiceError', 'message': 'busy'}}))))
        self.assertEqual({key: error.provider_response[key] for key in ('phase', 'httpStatus', 'code', 'taskId')},
                         {'phase': 'status', 'httpStatus': 500, 'code': 'InternalServiceError', 'taskId': 'cgt-3'})

    def test_seedream_rejection_and_local_failures(self, _):
        status, body = PROVIDER_ERRORS['seedream']
        call = lambda transport, **extra: seedream._generate_image({'prompt': 'x', 'references': []}, transport=transport,
                                                                    env={'ARK_API_KEY': 'fixture'}, **extra)
        error = self.raised(lambda: call(Transport(answer(status, body))))
        self.assertEqual({key: error.provider_response.get(key) for key in ('provider', 'phase', 'httpStatus', 'code', 'requestId')},
                         {'provider': 'seedream', 'phase': 'create', 'httpStatus': 400, 'code': 'OutputImageSensitiveContentDetected',
                          'requestId': REQUEST_ID})
        broken = Mock(request=Mock(side_effect=ConnectionError('reset by peer')))
        error = self.raised(lambda: call(broken))
        self.assertEqual({key: error.provider_response[key] for key in ('source', 'code', 'message')},
                         {'source': 'veevee', 'code': 'ambiguous_submission', 'message': 'reset by peer'})
        fetched = Transport(answer(200, {'data': [{'url': 'https://fixture.invalid/out.png?X-Tos-Signature=secret'}]}))
        error = self.raised(lambda: call(fetched, fetcher=Mock(side_effect=IOError('403 for https://fixture.invalid/out.png?sig=secret'))))
        self.assertEqual({key: error.provider_response[key] for key in ('phase', 'code', 'message')},
                         {'phase': 'download', 'code': 'output_download_failed', 'message': '403 for [url]'})

    def test_gemini_image_http_error_and_billed_200_without_an_image(self, _):
        status, body = PROVIDER_ERRORS['gemini']
        payload = {'assembled': {'instruction': 'x', 'groups': []}, 'aspectRatio': '1:1'}
        error = self.raised(lambda: gemini.generate_image(payload, env={'GOOGLE_API_KEY': 'fixture'}, transport=Transport(answer(status, body))))
        self.assertEqual({key: error.provider_response.get(key) for key in ('provider', 'httpStatus', 'code', 'message', 'unbilled')},
                         {'provider': 'gemini', 'httpStatus': 400, 'code': 'API_KEY_INVALID',
                          'message': 'API key not valid. Please pass a valid API key.', 'unbilled': None})
        blocked = {'promptFeedback': {'blockReason': 'PROHIBITED_CONTENT'}, 'candidates': [], 'responseId': 'resp-77'}
        error = self.raised(lambda: gemini.generate_image(payload, env={'GOOGLE_API_KEY': 'fixture'}, transport=Transport(answer(200, blocked))))
        self.assertEqual({key: error.provider_response.get(key) for key in ('httpStatus', 'code', 'requestId', 'rawBody')},
                         {'httpStatus': 200, 'code': 'PROHIBITED_CONTENT', 'requestId': 'resp-77',
                          'rawBody': json.dumps({'promptFeedback': {'blockReason': 'PROHIBITED_CONTENT'}})})
        throttled = self.raised(lambda: gemini.generate_image(payload, env={'GOOGLE_API_KEY': 'fixture'},
                                                              transport=Transport(answer(429, google_error(429)))))
        self.assertEqual((throttled.provider_response['code'], throttled.provider_response['unbilled']), ('RESOURCE_EXHAUSTED', True))

    def test_omni_create_rejection(self, _):
        status, body = PROVIDER_ERRORS['omni']
        error = self.raised(lambda: omni.create_video_task({'modelDisplay': 'Gemini Omni Flash 1.1', 'duration': 4, 'aspectRatio': '16:9',
            'resolution': '720p', 'assembled': {'instruction': 'x', 'groups': []}}, env={'GOOGLE_API_KEY': 'fixture'},
            transport=Transport(answer(status, body))))
        self.assertEqual({key: error.provider_response.get(key) for key in ('provider', 'phase', 'httpStatus', 'code')},
                         {'provider': 'omni', 'phase': 'create', 'httpStatus': 429, 'code': 'RESOURCE_EXHAUSTED'})

    def test_kling_create_rejection_and_task_failure_is_terminal(self, _):
        status, body = PROVIDER_ERRORS['kling']
        options = {'env': {'KLING_API': 'fixture'}}
        error = self.raised(lambda: kling.submit_image({'model': 'Kling Image 3.0', 'prompt': 'x'}, transport=Transport(answer(status, body)), **options))
        self.assertEqual({key: error.provider_response.get(key) for key in ('provider', 'phase', 'httpStatus', 'code', 'message', 'requestId')},
                         {'provider': 'kling', 'phase': 'create', 'httpStatus': 429, 'code': '1102',
                          'message': 'Account balance not enough', 'requestId': 'req-sim'})
        failed = answer(200, {'code': 0, 'request_id': 'req-poll', 'data': {'task_id': 'k-1', 'task_status': 'failed',
                                                                            'task_status_msg': 'Image violates the content policy'}})
        error = self.raised(lambda: kling.resolve_image('k-1', transport=Transport(failed), **options))
        self.assertTrue(error.terminal)
        self.assertEqual({key: error.provider_response.get(key) for key in ('phase', 'message', 'taskId', 'requestId')},
                         {'phase': 'task', 'message': 'Kling generation failed: Image violates the content policy', 'taskId': 'k-1',
                          'requestId': 'req-poll'})

    def test_magnific_create_rejection_and_failed_task(self, _):
        status, body = PROVIDER_ERRORS['magnific']
        error = self.raised(lambda: magnific.submit_upscale({'model': 'Magnific Creative', 'image': 'data:image/png;base64,AAAA', 'apiKey': 'k'},
                                                             transport=Transport(answer(status, body)), env={}))
        self.assertEqual({key: error.provider_response.get(key) for key in ('provider', 'httpStatus', 'code', 'message', 'param')},
                         {'provider': 'magnific', 'httpStatus': 400, 'code': None,
                          'message': 'Invalid request (image: Image exceeds the maximum size)', 'param': 'image'})
        failed = answer(200, {'data': {'task_id': 'mag-1', 'status': 'FAILED', 'error': 'Source image could not be decoded'}})
        result = magnific.get_upscale_status('mag-1', api_key='k', transport=Transport(failed), env={})
        self.assertEqual({key: result['providerError'].get(key) for key in ('phase', 'message', 'taskId')},
                         {'phase': 'task', 'message': 'Source image could not be decoded', 'taskId': 'mag-1'})

    def test_byteplus_asset_api_keeps_the_original_code_and_request_id(self, _):
        from apps.integrations.byteplus import BytePlusAssetError, BytePlusClient
        client = BytePlusClient({'ak': 'ak', 'sk': 'sk', 'region': 'ap-southeast-1', 'host': 'ark.ap-southeast-1.byteplusapi.com',
                                 'base_url': 'https://ark.ap-southeast-1.byteplusapi.com', 'is_mock': False},
                                transport=Transport(answer(400, asset_error('CreateAsset', 'InputImageSensitiveContentDetected.PrivacyInformation', 'real person'))))
        with self.assertRaises(BytePlusAssetError) as caught:
            client.create_asset('group', 'https://fixture.invalid/x.png')
        self.assertEqual(caught.exception.code, 'moderation_rejected', 'callers still branch on the compliance code')
        self.assertEqual({key: caught.exception.provider_error.get(key) for key in ('provider', 'phase', 'httpStatus', 'code', 'message', 'requestId')},
                         {'provider': 'byteplus-assets', 'phase': 'CreateAsset', 'httpStatus': 400,
                          'code': 'InputImageSensitiveContentDetected.PrivacyInformation', 'message': 'real person',
                          'requestId': 'req-asset-fixture'})


class RedactionTests(SimpleTestCase):
    def test_credentials_signed_urls_and_inline_media_never_survive(self):
        secret = 'private-fixture-token'
        body = json.dumps({'error': {'code': 'X', 'message': f'see https://bucket.invalid/o?X-Goog-Signature={secret} key={secret}',
                                     'echo': 'Authorization: Bearer ' + secret, 'data': 'data:image/png;base64,' + 'A' * 300,
                                     'blob': 'Q' * 200, 'hdr': 'x-goog-api-key: ' + secret}})
        record = provider_errors.capture('gemini', status=400, body=body)
        text = json.dumps(record)
        self.assertNotIn(secret, text)
        self.assertNotIn('A' * 120, text)
        self.assertNotIn('Q' * 120, text)
        self.assertNotIn('bucket.invalid', text)
        self.assertEqual(record['message'], 'see [url] key=[redacted]')

    def test_raw_body_is_bounded(self):
        record = provider_errors.capture('seedance', status=500, body='overloaded ' * 1000)
        self.assertEqual(len(record['rawBody'].encode()), provider_errors.RAW_LIMIT)

    def test_a_redacted_message_is_never_shown_to_the_user(self):
        self.assertIsNone(provider_errors.public_message_text('token=abc failed'))
        self.assertEqual(provider_errors.public_message_text('Image too small \u2014 use 300px. Request id: abc123def'), 'Image too small - use 300px.')


class UserMessageTests(SimpleTestCase):
    """The plain sentence, then the exact detail; never the raw diagnostic."""

    def message(self, record, diagnostic, **values):
        return failure_copy.public_message(row(responses=[record], **values), diagnostic)

    def test_the_production_case_names_the_input_param_code_and_request_id(self):
        status, body = PROVIDER_ERRORS['seedance']
        # Retroactive: the production row kept only the raw body (no requestId header, no parsed fields).
        historical = {'provider': 'seedance', 'httpStatus': status, 'rawBody': json.dumps(body), 'requestId': None, 'receivedAt': 1}
        self.assertEqual(self.message(historical, seedance.NEUTRAL_POLICY_MESSAGE),
                         'Seedance rejected the input audio (content[10]) under its content policy. '
                         f'Provider code: InputAudioSensitiveContentDetected. Request id: {REQUEST_ID}.')

    def test_each_content_policy_code_names_what_it_rejected(self):
        for code, param, expected in (
            ('InputTextSensitiveContentDetected', None, 'Seedance rejected the prompt text under its content policy.'),
            ('InputImageSensitiveContentDetected', 'content[2]', 'Seedance rejected the input image (content[2]) under its content policy.'),
            ('InputVideoSensitiveContentDetected', 'content[5]', 'Seedance rejected the input video (content[5]) under its content policy.'),
            ('OutputVideoSensitiveContentDetected', None, 'Seedance stopped the generated video under its content policy.'),
            ('OutputAudioSensitiveContentDetected', None, 'Seedance stopped the generated audio under its content policy.'),
        ):
            with self.subTest(code=code):
                body = byteplus_error(code, 'Refused.', param=param)
                record = provider_errors.capture('seedance', status=400, body=json.dumps(body))
                self.assertEqual(self.message(record, seedance.NEUTRAL_POLICY_MESSAGE),
                                 f'{expected} Provider code: {code}. Request id: {REQUEST_ID}.')

    def test_face_and_copyright_keep_their_advice(self):
        face = provider_errors.capture('seedance', status=400, body=json.dumps(
            byteplus_error('InputImageSensitiveContentDetected.PrivacyInformation', 'The input image may contain real person.')))
        self.assertEqual(self.message(face, seedance.MODERATION_MESSAGE), failure_copy.FACE_GALLERY +
                         f' Provider code: InputImageSensitiveContentDetected.PrivacyInformation. Request id: {REQUEST_ID}.')
        copyright = provider_errors.capture('seedance', phase='task', code='OutputVideoSensitiveContentDetected',
                                            message='The output video may be related to copyright restrictions.', task_id='cgt-1')
        self.assertEqual(self.message(copyright, 'The output video may be related to copyright restrictions.'),
                         failure_copy.COPYRIGHT + ' Provider code: OutputVideoSensitiveContentDetected. Task id: cgt-1.')

    def test_every_provider_failure_path(self):
        cases = (
            ('image', 'Seedream 5.0 Pro', provider_errors.capture('seedream', status=400, body=json.dumps(byteplus_error('InvalidParameter', 'bad size'))),
             'Seedream rejected the request. Check reference files and content requirements. (400, InvalidParameter)',
             failure_copy.IMAGE_REJECTED + f' Provider code: InvalidParameter. Request id: {REQUEST_ID}.'),
            ('image', 'Nano Banana Pro', provider_errors.capture('gemini', status=400, body=json.dumps(PROVIDER_ERRORS['gemini'][1])),
             'Gemini image error (400): API key not valid.', failure_copy.UNAVAILABLE + ' Provider code: API_KEY_INVALID.'),
            ('image', 'Nano Banana Pro', provider_errors.capture('gemini', status=200, code='PROHIBITED_CONTENT', request_id='resp-1'),
             'Gemini returned no image (PROHIBITED_CONTENT).', failure_copy.POLICY + ' Provider code: PROHIBITED_CONTENT. Request id: resp-1.'),
            ('video', 'Gemini Omni Flash 1.1', provider_errors.capture('omni', status=429, body=json.dumps(google_error(429))),
             'Omni create error (429): {}', failure_copy.BUSY + ' Provider code: RESOURCE_EXHAUSTED.'),
            ('video', 'Gemini Omni Flash 1.1', provider_errors.capture('omni', phase='task', message='Generation stopped.', task_id='v1_x'),
             'Generation stopped.', failure_copy.PROVIDER_ERROR['video'] + ' Provider message: Generation stopped. Task id: v1_x.'),
            ('image', 'Kling Image 3.0', provider_errors.capture('kling', status=429, body=json.dumps(kling_error(1102, 'Account balance not enough'))),
             'Kling /v1/images/generations failed (http 429, code 1102): Account balance not enough',
             failure_copy.BUSY + ' Provider code: 1102. Request id: req-sim.'),
            ('image', 'Kling Image 3.0', provider_errors.capture('kling', phase='task', message='Kling generation failed: blocked', task_id='k-1'),
             'Kling generation failed: blocked', failure_copy.PROVIDER_ERROR['image'] + ' Provider message: Kling generation failed: blocked. Task id: k-1.'),
            ('image', 'Magnific Creative', provider_errors.capture('magnific', status=400, body=json.dumps(PROVIDER_ERRORS['magnific'][1])),
             'Magnific rejected this upscale. Nothing was charged; check the source and settings.',
             'Magnific rejected this upscale. Nothing was charged; check the source and settings. '
             'Provider HTTP status: 400. Provider message: Invalid request (image: Image exceeds the maximum size).'),
            ('video', 'Higgsfield Seedance 2.0', provider_errors.capture('higgsfield', phase='task', code='nsfw', task_id='job-1'),
             'Higgsfield moderation flagged this generation (nsfw).', failure_copy.PROVIDER_ERROR['video'] + ' Provider code: nsfw. Task id: job-1.'),
            ('audio', 'Gemini (gemini-2.5-flash)', provider_errors.capture('gemini', status=400, body=json.dumps(google_error(400))),
             'Gemini transcription failed (400).', failure_copy.AUDIO_REJECTED + ' Provider code: INVALID_ARGUMENT.'),
            ('video', 'Seedance 2.5', provider_errors.local('seedance', 'request_deadline', 'Provider request deadline exceeded.'),
             'Provider request deadline exceeded. It may still have been accepted by the provider; check before retrying.',
             failure_copy.DROPPED + ' Error code: request_deadline.'),
            ('video', 'Seedance 2.5', provider_errors.capture('seedance', status=502, body='<html>Bad gateway</html>'),
             'Seedance create error 502: <html>Bad gateway</html>', failure_copy.PROVIDER_ERROR['video'] + ' Provider HTTP status: 502.'),
        )
        for kind, model, record, diagnostic, expected in cases:
            with self.subTest(model=model, diagnostic=diagnostic[:40]):
                self.assertEqual(self.message(record, diagnostic, kind=kind, model=model), expected)
                self.assertNotIn('\u2014', expected)
                self.assertNotIn('BytePlus', expected)

    def test_a_terminal_task_failure_outranks_an_earlier_candidate_rejection(self):
        earlier = provider_errors.capture('seedance', status=400, body=json.dumps(byteplus_error('InvalidParameter', 'x')))
        task = provider_errors.capture('seedance', phase='task', code='OutputVideoSensitiveContentDetected', task_id='cgt-2')
        message = failure_copy.public_message(row(responses=[earlier, {'uncertainSubmission': True}, task]), 'x')
        self.assertTrue(message.endswith('Provider code: OutputVideoSensitiveContentDetected. Task id: cgt-2.'), message)

    def test_records_without_a_provider_answer_add_nothing(self):
        for responses in (None, [], [{'uncertainSubmission': True}], [{'rawBody': 'private-fixture-token'}]):
            with self.subTest(responses=responses):
                self.assertEqual(failure_copy.public_message(row(responses=responses), 'private-fixture-token'), failure_copy.GENERIC['video'])

    def test_codes_and_ids_outside_their_patterns_are_not_shown(self):
        record = {'provider': 'seedance', 'httpStatus': 400, 'code': 'bad code <script>', 'requestId': 'id with spaces'}
        self.assertEqual(failure_copy.public_message(row(responses=[record]), 'x'), failure_copy.PROVIDER_ERROR['video'] + ' Provider HTTP status: 400.')


ENV = {'ARK_API_KEY': 'fake-ark-key', 'GOOGLE_API_KEY': 'fake-google-key', 'KLING_API': 'fake-kling-key',
       'MOCK_GENERATION': '0', 'MOCK_ASSET_PROVIDER': '0'}


class EndToEndTests(TransactionTestCase):
    """API enqueue -> real worker and adapters -> fake provider network answering with each provider's real error."""
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def run_case(self, kind, payload, configure, *, polls=0):
        from apps.projects.models import Project
        self.cookie()
        project = Project.objects.create(id=uuid.uuid4(), name='Errors', created_at=1, updated_at=1)
        storage = StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders() as fake:
            configure(fake)
            response = self.client.post('/api/generate/' + kind, {**payload, 'projectId': str(project.id)}, content_type='application/json',
                                        HTTP_IDEMPOTENCY_KEY='errors-' + uuid.uuid4().hex)
            self.assertEqual(response.status_code, 200, response.content)
            identifier = response.json()['id']
            executor.process_generation(identifier, heartbeat=False)
            for _ in range(polls):
                Generation.objects.filter(pk=identifier).update(next_poll_at=0)
                executor.process_generation(identifier, heartbeat=False)
            item = self.client.get('/api/generate/video/status', {'id': identifier}).json() if kind == 'video' else None
        current = Generation.objects.get(pk=identifier)
        return current, item or generation_item(current), fake

    def fault(self, match, provider):
        status, body = PROVIDER_ERRORS[provider]
        return lambda fake: fake.faults.append({'match': match, 'status': status, 'payload': body, 'count': 1})

    def test_seedance_create_rejection_reaches_the_user_with_the_exact_detail(self):
        current, item, fake = self.run_case('video', {'prompt': 'a hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'duration': 5},
                                            self.fault(r'^POST ark\.ap-southeast\.bytepluses\.com/api/v3/contents/generations/tasks$', 'seedance'))
        self.assertEqual(current.status, 'failed')
        self.assertEqual(item['error'], 'Seedance rejected the input audio (content[10]) under its content policy. '
                                        f'Provider code: InputAudioSensitiveContentDetected. Request id: {REQUEST_ID}.')
        (record,) = current.provider_responses
        self.assertEqual({key: record[key] for key in ('provider', 'model', 'phase', 'httpStatus', 'code', 'param', 'requestId')},
                         {'provider': 'seedance', 'model': 'Seedance 2.5', 'phase': 'create', 'httpStatus': 400,
                          'code': 'InputAudioSensitiveContentDetected', 'param': 'content[10]', 'requestId': REQUEST_ID})
        self.assertNotIn('providerResponses', item)

    def test_seedance_async_task_failure_is_recorded_from_the_poll(self):
        def configure(fake):
            fake.seedance_task_error = {'code': 'OutputVideoSensitiveContentDetected',
                                        'message': 'The output video may contain sensitive information. Request id: 0217task'}
        current, item, _ = self.run_case('video', {'prompt': 'a hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'duration': 5},
                                         configure, polls=1)
        self.assertEqual(current.status, 'failed')
        self.assertEqual(item['error'], 'Seedance stopped the generated video under its content policy. '
                                        f'Provider code: OutputVideoSensitiveContentDetected. Request id: 0217task. Task id: {current.task_id}.')
        self.assertEqual([(record['phase'], record['taskId']) for record in current.provider_responses], [('task', current.task_id)])

    def test_gemini_image_rejection(self):
        current, item, _ = self.run_case('image', {'prompt': 'a courtyard', 'model': 'Nano Banana Pro', 'aspectRatio': '1:1'},
                                         self.fault(r'^POST generativelanguage\.googleapis\.com/v1beta/models/[^/]+:generateContent$', 'gemini'))
        self.assertEqual(item['error'], failure_copy.UNAVAILABLE + ' Provider code: API_KEY_INVALID.')
        self.assertEqual(current.provider_responses[0]['model'], 'Nano Banana Pro')

    def test_seedream_rejection(self):
        current, item, _ = self.run_case('image', {'prompt': 'a courtyard', 'model': 'Seedream 5.0 Pro', 'aspectRatio': '1:1', 'resolution': '2K'},
                                         self.fault(r'^POST ark\.ap-southeast\.bytepluses\.com/api/v3/images/generations$', 'seedream'))
        self.assertEqual(item['error'], 'Seedream stopped the generated image under its content policy. '
                                        f'Provider code: OutputImageSensitiveContentDetected. Request id: {REQUEST_ID}.')

    def test_kling_task_failure_ends_the_job_instead_of_polling_forever(self):
        def configure(fake):
            fake.kling_task_error = 'Image violates the content policy'
            fake.kling_running_polls = 0
        with patch('apps.generation.services.image_execution.Dependencies.monotonic', side_effect=lambda: 0):
            current, item, fake = self.run_case('image', {'prompt': 'a courtyard', 'model': 'Kling Image 3.0', 'aspectRatio': '1:1'}, configure)
        self.assertEqual(current.status, 'failed', 'a provider-failed task is final, not deferred')
        self.assertEqual(item['error'], failure_copy.POLICY +
                         f' Provider message: Kling generation failed: Image violates the content policy. Request id: req-sim. Task id: {current.task_id}.')
        self.assertNotIn('may still have been accepted', current.error)
        self.assertEqual(sum(1 for call in fake.calls if call[0] == 'POST'), 1, 'exactly one paid submission')

    def test_omni_task_failure(self):
        def configure(fake):
            fake.omni_task_error = {'code': 'SAFETY', 'message': 'The output was blocked by safety filters.'}
            fake.omni_running_polls = 0
        current, item, _ = self.run_case('video', {'prompt': 'a lantern', 'model': 'Gemini Omni Flash 1.1', 'aspectRatio': '16:9',
                                                   'resolution': '360p', 'duration': 4}, configure, polls=1)
        self.assertEqual((current.status, current.moderation_blocked), ('failed', True))
        self.assertEqual(item['error'], failure_copy.POLICY + f' Provider code: SAFETY. Task id: {current.task_id}.')


class PortraitAssetTests(TransactionTestCase):
    def test_a_refused_portrait_keeps_the_exact_byteplus_answer_in_its_receipt_and_the_job(self):
        from apps.assets import managed_pool
        from apps.assets.models import ManagedPortraitAsset
        from apps.integrations.byteplus import BytePlusClient
        fake = FakeProviders()
        storage = StorageService(MemoryAdapter())
        key = 'references/face.png'
        storage.primary.objects[key] = (fake.png, 'image/png', {})
        with fake:
            fake.faults.append({'match': r'^POST ark\.ap-southeast-1\.byteplusapi\.com/$', 'status': 400, 'count': 2,
                                'payload': asset_error('CreateAsset', 'InvalidParameter.ImageInvalid', 'The image cannot be used.')})
            client = BytePlusClient({'ak': 'ak', 'sk': 'sk', 'region': 'ap-southeast-1', 'host': managed_pool.ASSET_HOST,
                                     'base_url': 'https://' + managed_pool.ASSET_HOST, 'is_mock': False})
            client.create_asset_group = Mock(return_value={'Id': 'group-1'})
            client.list_asset_groups = Mock(return_value={'Items': [], 'NextToken': ''})
            with patch.object(managed_pool, 'refuse_as_asset', return_value=False), patch.object(managed_pool, 'bounded_copy', return_value=None):
                outcome = managed_pool.ensure(fake.png, key, uuid.uuid4(), session_fixtures.UID, storage=storage, client=client)
        self.assertEqual(outcome.kind, 'failed')
        asset = ManagedPortraitAsset.objects.get()
        self.assertEqual((asset.status, asset.error_code), ('FAILED', 'InvalidParameter.ImageInvalid'))
        last = asset.receipt['lastError']
        self.assertEqual({key: last[key] for key in ('provider', 'phase', 'httpStatus', 'code', 'message', 'requestId')},
                         {'provider': 'byteplus-assets', 'phase': 'CreateAsset', 'httpStatus': 400, 'code': 'InvalidParameter.ImageInvalid',
                          'message': 'The image cannot be used.', 'requestId': 'req-asset-fixture'})
        self.assertEqual(outcome.detail['code'], 'InvalidParameter.ImageInvalid')
        message = failure_copy.public_message(row(responses=[outcome.detail]), outcome.message)
        self.assertEqual(message, outcome.message + ' Provider code: InvalidParameter.ImageInvalid. Request id: req-asset-fixture.')


class PollerRecordTests(SimpleTestCase):
    def test_records_are_appended_to_what_the_row_already_holds(self):
        item = SimpleNamespace(model='Seedance 2.5', provider_responses=[{'provider': 'seedance', 'code': 'InvalidParameter'}], task_id='t')
        added = poller._with_records(item, provider_errors.capture('seedance', code='X'), None, {'not': 'a record'})
        self.assertEqual([record.get('code') for record in added['provider_responses']], ['InvalidParameter', 'X'])
        self.assertEqual(added['provider_responses'][1]['model'], 'Seedance 2.5')
        self.assertEqual(poller._with_records(item, None), {})


class ExecutorRecordTests(SimpleTestCase):
    def test_a_timeout_gets_a_local_record_and_adapter_records_get_the_model(self):
        item = SimpleNamespace(model='Seedance 2.5', task_id=None)
        (record,) = executor.provider_responses(ProviderError('Provider request deadline exceeded.', code='request_deadline'), item)
        self.assertEqual({key: record[key] for key in ('provider', 'model', 'source', 'code')},
                         {'provider': 'seedance', 'model': 'Seedance 2.5', 'source': 'veevee', 'code': 'request_deadline'})
        self.assertEqual(executor.provider_responses(ValueError('Prompt is required.'), item), [])
        stamped = executor.provider_responses(ProviderError('x', provider_response={'provider': 'seedance', 'code': 'A'}), item)
        self.assertEqual(stamped, [{'provider': 'seedance', 'code': 'A', 'model': 'Seedance 2.5'}])
        unbilled = executor.provider_responses(ProviderError('x', provider_response={'provider': 'gemini', 'httpStatus': 429, 'unbilled': True}), item)
        self.assertTrue(unbilled[0]['unbilled'], 'the spend window still recognizes an unbilled throttle')


    def test_our_own_errors_are_not_provider_records_but_the_job_deadline_is_named(self):
        self.assertEqual(executor.provider_responses(Exception('boom'), SimpleNamespace(model='Seedance 2.5', task_id=None)), [])
        signal = Cancellation(0)
        with self.assertRaises(TimeoutError) as caught:
            signal.check()
        (record,) = executor.provider_responses(caught.exception, SimpleNamespace(model='Nano Banana Pro', task_id=None))
        self.assertEqual((record['provider'], record['code'], record['source']), ('gemini', 'queue_execution_deadline', 'veevee'))
