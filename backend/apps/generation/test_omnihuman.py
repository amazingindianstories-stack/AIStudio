"""Executable OmniHuman protocol, validation and durable lifecycle coverage. No live calls."""
import base64
import io
import json
import wave
import requests
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TransactionTestCase, override_settings
from PIL import Image

from apps.generation import failure_copy, provider_errors
from apps.generation.providers import omnihuman as api
from apps.generation.services import enqueue, poller, video_execution, paid_guard
from apps.generation.services.deadline import Cancellation
from apps.generation.services.omnihuman_inputs import validate, IMAGE_BYTES, AUDIO_BYTES
from apps.generation.services.pricing import compute_cost
from apps.integrations.byteplus import sign_request
from apps.integrations.transport import HttpResult, HttpTransport, ProviderError
from apps.generation.models import Generation

ENV = {'OMNIHUMAN_ACCESS_KEY_ID': 'synthetic-ak', 'OMNIHUMAN_SECRET_ACCESS_KEY': 'synthetic-sk'}


def response(payload, status=200):
    return HttpResult(status, json.dumps(payload).encode())


def image(size=(300, 300), fmt='PNG'):
    out = io.BytesIO()
    Image.new('RGB', size).save(out, format=fmt)
    return out.getvalue()


def audio(seconds=4):
    out = io.BytesIO()
    with wave.open(out, 'wb') as writer:
        writer.setnchannels(1); writer.setsampwidth(2); writer.setframerate(8000)
        writer.writeframes(b'\x00\x00' * int(8000 * seconds))
    return out.getvalue()


class OmniHumanProtocolTests(SimpleTestCase):
    def test_signed_submit_and_query_use_exact_bytes_and_fixed_scope(self):
        transport = Mock(request=Mock(return_value=response({'code': 10000, 'data': {'task_id': 'task-1'}})))
        identifier = api.create_video_task({'imageUrls': ['https://fixture.invalid/i.png'], 'audioUrls': ['https://fixture.invalid/a.wav'],
            'prompt': 'Slow smile'}, env={**ENV, 'ARK_API_KEY': 'must-not-be-used'}, transport=transport)
        self.assertEqual(identifier, 'task-1')
        args, kwargs = transport.request.call_args
        self.assertEqual(args, ('POST', 'https://cv.byteplusapi.com/?Action=CVSync2AsyncSubmitTask&Version=2024-06-06'))
        self.assertEqual(json.loads(kwargs['raw_body']), {'req_key': 'realman_avatar_picture_omni20_cv',
            'image_urls': ['https://fixture.invalid/i.png'], 'audio_url': 'https://fixture.invalid/a.wav', 'prompt': 'Slow smile'})
        self.assertIn('/ap-singapore-1/cv/request,', kwargs['headers']['Authorization'])
        self.assertNotIn('Bearer', kwargs['headers']['Authorization'])
        stamp = datetime.strptime(kwargs['headers']['x-date'], '%Y%m%dT%H%M%SZ').replace(tzinfo=timezone.utc)
        expected = sign_request(body=kwargs['raw_body'], ak=ENV['OMNIHUMAN_ACCESS_KEY_ID'], sk=ENV['OMNIHUMAN_SECRET_ACCESS_KEY'],
            region='ap-singapore-1', service='cv', date=stamp, query={'Action': api.SUBMIT, 'Version': '2024-06-06'},
            headers={'content-type': 'application/json', 'host': 'cv.byteplusapi.com'})
        self.assertEqual(kwargs['headers'], expected['headers'])
        transport.request.return_value = response({'code': 10000, 'data': {'status': 'in_queue'}})
        self.assertEqual(api.get_video_task(identifier, env=ENV, transport=transport)['status'], 'queued')
        self.assertEqual(transport.request.call_args.args, ('POST', api.endpoint(api.QUERY)))
        self.assertEqual(json.loads(transport.request.call_args.kwargs['raw_body']), {'req_key': api.REQ_KEY, 'task_id': 'task-1'})

    def test_every_documented_state_and_missing_or_unknown_state(self):
        for state, expected in [('in_queue', 'queued'), ('generating', 'running'), ('done', 'succeeded'),
            ('not_found', 'failed'), ('expired', 'failed'), ('canceled', 'failed'), ('unexpected', 'failed'), (None, 'failed')]:
            with self.subTest(state=state):
                result = api.normalize_video_task_payload({'code': 10000, 'data': {'status': state, 'video_url': 'https://fixture.invalid/video.mp4'}}, 'task')
                self.assertEqual(result['status'], expected)
                self.assertEqual(result['providerStatus'], state)
                if expected == 'failed':
                    self.assertEqual(result['providerError']['taskId'], 'task')
                    self.assertEqual(result['providerError']['provider'], 'omnihuman')
        result = api.normalize_video_task_payload({'code': 10000, 'data': {'status': 'done'}}, 'task')
        self.assertEqual((result['status'], result['providerError']['code']), ('failed', 'no_video'))
        transport = Mock(request=Mock(return_value=response({'code': 50510, 'data': {'status': 'done', 'video_url': 'https://fixture.invalid/out.mp4'}})))
        result = api.get_video_task('task', env=ENV, transport=transport)
        self.assertEqual((result['status'], result['moderationBlocked']), ('failed', True))
        self.assertNotIn('videoUrl', result)

    def test_all_documented_service_errors_and_failure_copy(self):
        groups = [(api.INVALID, [50200, 50201, 50204, 50215]), (api.IMAGE, [50205, 50206, 50207]),
            (api.UNAVAILABLE, [50400, 50402]), (api.BUSY, [50429, 50430]), (api.INTERNAL, [50500, 50501]),
            (api.POLICY, [50510]), (api.CANCEL_DENIED, [50217])]
        for sentence, codes in groups:
            for code in codes:
                with self.subTest(code=code):
                    payload = {'code': code, 'message': 'private https://secret.invalid/?token=never-persist', 'request_id': 'req-1',
                        'data': {'status': 'done', 'video_url': 'https://ignored.invalid'}}
                    transport = Mock(request=Mock(return_value=response(payload)))
                    with self.assertRaises(ProviderError) as caught:
                        api.create_video_task({'imageUrls': ['i'], 'audioUrls': ['a']}, env=ENV, transport=transport)
                    error = caught.exception
                    self.assertEqual(str(error), sentence)
                    self.assertEqual(error.provider_response['code'], str(code))
                    self.assertEqual(error.provider_response['requestId'], 'req-1')
                    self.assertNotIn('never-persist', json.dumps(error.provider_response))
                    row = SimpleNamespace(kind='video', model='OmniHuman 2.0', moderation_blocked=False, provider_responses=[error.provider_response])
                    self.assertTrue(failure_copy.public_message(row, 'unclassified').startswith(sentence))
                    transport.request.assert_called_once()

    def test_all_gateway_errors_names_and_numeric_codes(self):
        groups = [(api.INVALID, [('MissingParameter', 100002)]),
            (api.UNAVAILABLE, [('MissingAuthenticationToken', 100003), ('MissingRequestInfo', 100004), ('MissingSignature', 100005),
             ('InvalidTimestamp', 100006), ('ServiceNotFound', 100007), ('InvalidActionOrVersion', 100008), ('InvalidAccessKey', 100009),
             ('SignatureDoesNotMatch', 100010), ('LackPolicy', 100012), ('AccessDenied', 100013), ('MethodNotAllowed', 100020),
             ('InvalidAuthorization', 100024), ('InvalidCredential', 100025), ('InvalidSecretToken', 100026)]),
            (api.INTERNAL, [('InternalError', 100014), ('FailToConnect', 100015), ('InternalServiceTimeout', 100016), ('InternalServiceError', 100023)]),
            (api.BUSY, [('FlowLimitExceeded', 100018), ('ServiceUnavailableTemp', 100019)])]
        for sentence, pairs in groups:
            for name, number in pairs:
                for code in (name, number):
                    with self.subTest(code=code):
                        payload = {'ResponseMetadata': {'Error': {'Code': code, 'Message': 'fixture'}, 'RequestId': 'gateway-request'},
                            'code': 10000, 'data': {'status': 'done', 'video_url': 'https://ignored.invalid'}}
                        transport = Mock(request=Mock(return_value=response(payload, 401)))
                        with self.assertRaises(ProviderError) as caught:
                            api.get_video_task('task', env=ENV, transport=transport)
                        self.assertEqual(str(caught.exception), sentence)
                        self.assertEqual(caught.exception.provider_response['code'], str(code))
                        self.assertEqual(caught.exception.provider_response['requestId'], 'gateway-request')

    def test_retryable_poll_errors_back_off_and_terminal_refusals_stop(self):
        for code in [50429, 50430, 50500, 50501, 50400, 50402, 50217]:
            transport = Mock(request=Mock(return_value=response({'code': code}, 429 if code < 50500 else 500)))
            with self.subTest(code=code), self.assertRaises(ProviderError):
                api.get_video_task('task', env=ENV, transport=transport)
            transport.request.assert_called_once()
        for code in [50200, 50201, 50204, 50205, 50206, 50207, 50215, 50510]:
            transport = Mock(request=Mock(return_value=response({'code': code})))
            with self.subTest(code=code):
                result = api.get_video_task('task', env=ENV, transport=transport)
                self.assertEqual((result['status'], result['providerError']['code']), ('failed', str(code)))

    def test_ambiguous_submission_never_retries_and_missing_inputs_never_send(self):
        for result in [HttpResult(200, b'not-json'), response({'code': 10000, 'data': {}})]:
            transport = Mock(request=Mock(return_value=result))
            with self.assertRaises(ProviderError) as caught:
                api.create_video_task({'imageUrls': ['i'], 'audioUrls': ['a']}, env=ENV, transport=transport)
            self.assertTrue(caught.exception.may_have_submitted)
            transport.request.assert_called_once()
        transport = Mock()
        with self.assertRaises(ProviderError):
            api.create_video_task({'imageUrls': ['i']}, env=ENV, transport=transport)
        transport.request.assert_not_called()

    def test_submit_uncertainty_is_visible_and_explicit_rejections_are_safe(self):
        from .services.executor import submission_uncertain
        transport = Mock(request=Mock(side_effect=requests.ConnectionError('lost connection')))
        with self.assertRaises(ProviderError) as caught:
            api.create_video_task({'imageUrls': ['i'], 'audioUrls': ['a']}, env=ENV, transport=transport)
        self.assertTrue(submission_uncertain(caught.exception))
        for code, uncertain in [(50429, False), (50430, False), (50510, False), (50500, True)]:
            error = api.failure({'code': code}, phase='create', http_status=200)
            self.assertEqual(submission_uncertain(error), uncertain)
        error = api.failure({'code': 50500}, phase='create', http_status=200)
        row = SimpleNamespace(kind='video', model='OmniHuman 2.0', moderation_blocked=False,
            provider_responses=[error.provider_response, {'uncertainSubmission': True}])
        self.assertTrue(failure_copy.public_message(row, str(error)).startswith(api.UNCERTAIN))
        with self.assertRaises(ProviderError) as caught:
            api.call(api.SUBMIT, {}, env={}, transport=Mock())
        self.assertFalse(submission_uncertain(caught.exception))

    def test_strict_original_media_validation_and_300_second_audio(self):
        files = {'image': image(), 'audio': audio(300)}
        def read(ref, **kwargs):
            return {'bytes': files[ref]}
        self.assertEqual(validate(['image'], ['audio'], read=read), 300)
        for seconds in [3.99, 300.01, None]:
            with self.subTest(seconds=seconds), self.assertRaisesMessage(ValueError, api.AUDIO):
                validate(['image'], ['audio'], read=read, measure=lambda _: seconds)
        for data in [b'not-an-image', image((299, 300)), image((300, 751)), image((6001, 3000)), b'x' * IMAGE_BYTES]:
            with self.subTest(size=len(data)), self.assertRaisesMessage(ValueError, api.IMAGE):
                validate(['image'], ['audio'], read=lambda ref, **kw: {'bytes': data if ref == 'image' else files['audio']})
        for data in [b'invalid', b'OggS'+audio(), b'x' * AUDIO_BYTES]:
            with self.subTest(size=len(data)), self.assertRaisesMessage(ValueError, api.AUDIO):
                validate(['image'], ['audio'], read=lambda ref, **kw: {'bytes': files['image'] if ref == 'image' else data})
        for images, audios in [([], ['audio']), (['image'], []), (['image'] * 2, ['audio']), (['image'], ['audio'] * 2)]:
            with self.assertRaisesMessage(ValueError, api.INVALID):
                validate(images, audios, read=read)

    def test_registry_contract_and_pricing_does_not_invent_a_rate(self):
        from apps.generation.availability import availability
        with override_settings(VEEVEE_OMNIHUMAN=False):
            self.assertNotIn('omnihuman-2', availability()['models'])
        with override_settings(VEEVEE_OMNIHUMAN=True):
            self.assertIn('omnihuman-2', availability()['models'])
        with override_settings(VEEVEE_OMNIHUMAN=True), patch.object(enqueue, 'prompt_limit', return_value=30000):
            item = enqueue.video_input({'model': 'OmniHuman 2.0', 'prompt': 'Smile', 'duration': 300, 'referenceAudios': ['audio']})
        self.assertEqual((item['duration'], item['resolution'], item['aspectRatio']), (300, 'Auto', 'Auto'))
        with self.assertRaisesMessage(ValueError, 'pricing is not configured'):
            compute_cost(item, [])
        self.assertEqual(compute_cost(item, [{'model': 'OmniHuman 2.0', 'unit': 'per_second', 'unitCostCents': 12}]), 3600)


class OmniHumanLifecycleTests(TransactionTestCase):
    def job(self, **values):
        return Generation.objects.create(**{'kind': 'video', 'status': 'running', 'model': 'OmniHuman 2.0',
            'prompt': 'Smile', 'aspect_ratio': 'Auto', 'resolution': 'Auto', 'duration': 300,
            'task_id': 'accepted-task', 'submitted_at': 1000, 'created_at': 1000, 'updated_at': 1000, **values})

    def deps(self, **values):
        return poller.Dependencies(now=lambda: 20000, mock=lambda: False, publish=lambda _: None, **values)

    def test_long_task_polls_yield_capacity_and_preserve_receipt_then_save_master(self):
        row = self.job()
        get_status = Mock(return_value={'status': 'queued', 'providerStatus': 'in_queue'})
        save = Mock(return_value={'url': '/api/media/generations/master.mp4', 'aspectRatio': '3:4'})
        deps = self.deps(get_omnihuman=get_status, save_omnihuman_video=save)
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'pending')
        row.refresh_from_db()
        self.assertEqual((row.status, row.task_id, row.provider_status, row.next_poll_at), ('running', 'accepted-task', 'in_queue', 25000))
        # Six hours of healthy pending work remains alive, without holding a submit execution thread.
        deps.now = lambda: 6 * 60 * 60 * 1000
        get_status.return_value = {'status': 'running', 'providerStatus': 'generating'}
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'pending')
        row.refresh_from_db()
        self.assertEqual(row.task_id, 'accepted-task')
        get_status.return_value = {'status': 'succeeded', 'providerStatus': 'done', 'videoUrl': 'https://fixture.invalid/master.mp4'}
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'succeeded')
        row.refresh_from_db()
        self.assertEqual((row.duration, row.url, row.aspect_ratio), (300, '/api/media/generations/master.mp4', '3:4'))
        save.assert_called_once()
        self.assertEqual(save.call_args.args[1], 'mp4')
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'succeeded')
        save.assert_called_once()

    def test_12_hour_pending_task_expires_without_resubmission(self):
        row = self.job()
        get_status = Mock()
        deps = self.deps(get_omnihuman=get_status)
        deps.now = lambda: 1000 + 12 * 60 * 60 * 1000
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'failed')
        row.refresh_from_db()
        self.assertEqual(row.error, api.EXPIRED)
        self.assertEqual(row.task_id, 'accepted-task')
        get_status.assert_not_called()

    def test_provider_failures_keep_exact_code_without_portrait_gallery_advice(self):
        for code in (50205, 50510):
            with self.subTest(code=code):
                row = self.job()
                transport = Mock(request=Mock(return_value=response({'code': code, 'message': 'provider detail', 'request_id': 'request-1'})))
                deps = self.deps(get_omnihuman=lambda task_id, **kw: api.get_video_task(task_id, env=ENV, transport=transport))
                self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'failed')
                row.refresh_from_db()
                self.assertEqual(row.provider_responses[0]['code'], str(code))
                self.assertEqual(row.moderation_blocked, code == 50510)
                self.assertNotIn('Portrait Gallery', failure_copy.public_message(row, row.error))

    def test_credential_or_clock_refusal_while_polling_keeps_the_accepted_task(self):
        for code in ('SignatureDoesNotMatch', 'InvalidTimestamp', 'AccessDenied', 'InvalidAccessKey', 100013, 50400):
            with self.subTest(code=code):
                row = self.job()
                payload = {'ResponseMetadata': {'Error': {'Code': code, 'Message': 'fixture'}, 'RequestId': 'gateway-request'}} \
                    if isinstance(code, str) or code > 100000 else {'code': code}
                transport = Mock(request=Mock(return_value=response(payload, 403)))
                deps = self.deps(get_omnihuman=lambda task_id, **kw: api.get_video_task(task_id, env=ENV, transport=transport))
                self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'poll_error')
                row.refresh_from_db()
                self.assertEqual((row.status, row.task_id, row.error, row.poll_error_count), ('running', 'accepted-task', None, 1))
                transport.request.return_value = response({'code': 10000, 'data': {'status': 'generating'}})
                self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'pending')
                row.refresh_from_db()
                self.assertEqual((row.status, row.task_id, row.poll_error_count), ('running', 'accepted-task', 0))
                self.assertEqual(transport.request.call_count, 2)

    def test_download_retry_stays_within_output_url_lifetime_and_never_resubmits(self):
        row = self.job()
        deps = self.deps(get_omnihuman=lambda *a, **kw: {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mp4'},
            save_omnihuman_video=Mock(side_effect=IOError('transient storage failure')))
        for _ in range(20):
            result = poller.advance(row, dependencies=deps)
            row.refresh_from_db()
            self.assertEqual(row.task_id, 'accepted-task')
            if result['kind'] == 'failed':
                break
            self.assertEqual(row.provider_status, poller.DOWNLOAD_PENDING)
            now = row.next_poll_at
            deps.now = lambda: now
        self.assertEqual(row.status, 'failed')
        self.assertLess(poller.waited_ms(poller.download_retry_ms, row.poll_error_count), 60 * 60 * 1000)

    def test_submit_validates_originals_and_records_receipt_before_return(self):
        from apps.media.storage import MemoryAdapter, StorageService
        storage = StorageService(MemoryAdapter())
        storage.primary.put('assets/hero.png', image(), 'image/png', 'private')
        storage.primary.put('assets/voice.wav', audio(300), 'audio/wav', 'private')
        row = self.job(task_id=None, reference_images=['/api/media/assets/hero.png'], reference_audios=['/api/media/assets/voice.wav'])
        deps = video_execution.Dependencies()
        deps.assets = lambda _: []
        deps.sign = lambda ref: 'https://fixture.invalid/' + ref.rsplit('/', 1)[-1]
        deps.inline = Mock(side_effect=AssertionError('Vision must never register or transform a portrait'))
        receipts = []
        def submit(input, *, signal):
            self.assertEqual(input['imageUrls'], ['https://fixture.invalid/hero.png'])
            self.assertEqual(input['audioUrls'], ['https://fixture.invalid/voice.wav'])
            self.assertEqual(input['prompt'], 'Smile')
            return 'new-task'
        deps.omnihuman_submit = submit
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            result = video_execution.submit_video(row, signal=Cancellation(), on_task=lambda *args: receipts.append(args),
                dependencies=deps, env={'MOCK_GENERATION': '0'})
        self.assertEqual(receipts, [('new-task', 0, 1)])
        self.assertEqual(result['task_id'], 'new-task')
        self.assertFalse(deps.inline.called)
        row.task_id = result['task_id']
        deps.omnihuman_submit = Mock(side_effect=AssertionError('must not submit twice'))
        video_execution.submit_video(row, signal=Cancellation(), on_task=lambda *args: None, dependencies=deps, env={})
        deps.omnihuman_submit.assert_not_called()

    @override_settings(VEEVEE_PAID_GUARD={'enabled': True})
    def test_paid_guard_allows_only_exact_read_only_query_without_a_claim(self):
        body = {'req_key': api.REQ_KEY, 'task_id': 'task-1'}
        with patch.object(paid_guard, 'enabled', return_value=True):
            paid_guard.check_request(HttpTransport(allowed_hosts={api.HOST}), 'POST', api.endpoint(api.QUERY), body)
            for url, invalid in [(api.endpoint(api.SUBMIT), body), (api.endpoint(api.QUERY), {**body, 'image_urls': ['x']}),
                (api.endpoint(api.QUERY), {**body, 'req_key': 'another-model'})]:
                with self.subTest(url=url), self.assertRaises(ProviderError):
                    paid_guard.check_request(HttpTransport(allowed_hosts={api.HOST}), 'POST', url, invalid)


from apps.admin_dashboard.tests import SettingsTests


@override_settings(ROOT_URLCONF='apps.generation.enqueue_urls', VEEVEE_OMNIHUMAN=True)
class OmniHumanApiTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def test_authenticated_video_enqueue_with_five_minute_audio_and_upfront_refusals(self):
        from apps.media.storage import MemoryAdapter, StorageService
        from apps.admin_dashboard.models import Pricing
        storage = StorageService(MemoryAdapter())
        storage.primary.put('assets/image.png', image(), 'image/png', 'private')
        storage.primary.put('assets/voice.wav', audio(300), 'audio/wav', 'private')
        Pricing.objects.update_or_create(model='OmniHuman 2.0', defaults={'unit_cost_cents': 12, 'unit': 'per_second'})
        payload = {'model': 'OmniHuman 2.0', 'prompt': '', 'referenceImages': ['/api/media/assets/image.png'],
            'referenceAudios': ['/api/media/assets/voice.wav']}
        self.cookie()
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            result = self.client.post('/api/generate/video', payload, content_type='application/json')
            self.assertEqual(result.status_code, 200, result.content)
            row = Generation.objects.get(id=result.json()['id'])
            self.assertEqual((row.status, row.duration, row.cost_cents), ('queued', 300, 3600))
            self.assertEqual((row.reference_images, row.reference_audios), (payload['referenceImages'], payload['referenceAudios']))
            for changed, phrase in [({'referenceAudios': []}, 'one valid image'), ({'referenceImages': []}, 'one valid image'),
                ({'firstFrame': '/api/media/assets/image.png'}, 'frames'), ({'videoTaskMode': 'edit'}, 'Edit'),
                ({'referenceAudios': payload['referenceAudios'] * 2}, 'at most 1'),
                ({'referenceVideos': ['video']}, 'video references')]:
                with self.subTest(changed=changed):
                    result = self.client.post('/api/generate/video', {**payload, **changed}, content_type='application/json')
                    self.assertEqual(result.status_code, 400, result.content)
                    self.assertIn(phrase, result.json()['error'])
            self.assertEqual(Generation.objects.count(), 1)
            from apps.generation.services.executor import process_generation
            deps = video_execution.Dependencies()
            deps.omnihuman_submit = Mock(return_value='api-accepted-task')
            def submit(item, **kwargs):
                return video_execution.submit_video(item, dependencies=deps, **kwargs)
            process_generation(row.id, owner='omnihuman-test', video_submit=submit, heartbeat=False,
                env={'MOCK_GENERATION': '0'})
            row.refresh_from_db()
            self.assertEqual((row.status, row.task_id), ('running', 'api-accepted-task'))
            deps.omnihuman_submit.assert_called_once()
            status_deps = poller.Dependencies(mock=lambda: False, publish=lambda _: None,
                get_omnihuman=lambda *a, **kw: {'status': 'succeeded', 'providerStatus': 'done', 'videoUrl': 'https://fixture.invalid/master.mp4'},
                save_omnihuman_video=lambda *a: {'url': '/api/media/generations/api-master.mp4', 'aspectRatio': '1:1'})
            self.assertEqual(poller.advance(row, dependencies=status_deps)['kind'], 'succeeded')
            row.refresh_from_db()
            self.assertEqual((row.duration, row.url), (300, '/api/media/generations/api-master.mp4'))


class OmniHumanMasterTests(SimpleTestCase):
    def test_extensionless_result_preserves_all_300_seconds_and_original_bytes(self):
        import contextlib
        import subprocess
        import tempfile
        from pathlib import Path
        from apps.integrations.remote import SafeMediaFetcher
        from apps.media.storage import MemoryAdapter, StorageService
        with tempfile.TemporaryDirectory() as directory:
            # Tiny synthetic video: exercise five-minute duration without allocating a production-size master.
            source = Path(directory) / 'original.mp4'
            subprocess.run(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:r=1',
                '-t', '300', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source)], check=True, timeout=30)
            original = source.read_bytes()
            class Fetcher(SafeMediaFetcher):
                @contextlib.contextmanager
                def open_file(self, url, **kwargs):
                    self_test.assertEqual(url, 'https://fixture.invalid/result')
                    self_test.assertEqual(self.max_bytes, 4 * 1024 * 1024 * 1024)
                    self_test.assertEqual(self.total_timeout, 600)
                    with source.open('rb') as stream:
                        yield stream, 'application/octet-stream'
            self_test = self
            fetcher = Fetcher(['fixture.invalid'])
            storage = StorageService(MemoryAdapter())
            with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.object(poller, 'get_media_fetcher', return_value=fetcher):
                result = poller.Dependencies().save_omnihuman_video('https://fixture.invalid/result', 'mp4', 'long-master', {})
                self.assertEqual(storage.read('generations/long-master.mp4'), original)
            self.assertEqual(result['url'], '/api/media/generations/long-master.mp4')
            self.assertEqual((result['width'], result['height']), (32, 32))
            length = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                '-of', 'default=nokey=1:noprint_wrappers=1', str(source)], capture_output=True, text=True, check=True)
            self.assertEqual(float(length.stdout.strip()), 300)
            self.assertEqual(fetcher.max_bytes, 512 * 1024 * 1024, 'the shared fetcher cap must not be mutated')

    def test_mov_container_is_never_renamed_mp4(self):
        import struct
        mov = struct.pack('>I4s', 20, b'ftyp') + b'qt  ' + b'\x00\x00\x00\x00qt  '
        self.assertEqual(api.video_container(io.BytesIO(mov)), 'mov')
        with self.assertRaises(ValueError):
            api.video_container(io.BytesIO(b'not video'))
