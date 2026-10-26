from testsupport.frozen_oracle import run as oracle_run
import base64
import io
import json
from pathlib import Path
import subprocess
from unittest.mock import patch

from django.test import SimpleTestCase
from PIL import Image

from .providers import gemini, kling, magnific, omni
from apps.integrations.transport import HttpResult, ProviderError


class ScriptedTransport:
    def __init__(self, *results):
        self.results, self.calls = list(results), []

    def request(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


def result(data, status=200):
    return HttpResult(status, json.dumps(data).encode())


class ProviderAdapterTests(SimpleTestCase):
    def test_omni_oauth_uncertainty_never_replays_paid_submission(self):
        from unittest.mock import Mock
        payload={'assembled':{'groups':[],'instruction':'fixture'},'aspectRatio':'16:9','duration':4,'modelDisplay':'Gemini Omni Flash 1.1'}
        transport=Mock()
        auth=Mock(side_effect=RuntimeError('synthetic refresh failure'))
        with self.assertRaises(RuntimeError):
            omni.create_video_task(payload,env={'OMNI_USE_VERTEX':'1'},transport=transport,vertex_auth=auth)
        auth.assert_called_once()
        transport.request.assert_not_called()
        auth=Mock(return_value={'project':'synthetic','token':'mock'})
        transport=Mock(request=Mock(side_effect=TimeoutError('ambiguous paid POST')))
        with self.assertRaises(TimeoutError):
            omni.create_video_task(payload,env={'OMNI_USE_VERTEX':'1'},transport=transport,vertex_auth=auth)
        transport.request.assert_called_once()
        auth.assert_called_once()

    def test_payloads_prompt_parts_errors_and_statuses_match_node(self):
        img = {'mimeType': 'image/png', 'data': 'base64-original'}
        assembled = [{'instruction': prompt, 'groups': []} for prompt in ('scene', '@img1 @img1 @IMG2', '@missing in mist', 'no people')]
        for identity in (True, False):
            for shot in (None, '', 'REFERENCES: @img1\nSCENE: @img1-inspired @other'):
                for count in (0, 1, 2, 13, 14, 15):
                    assembled.append({'instruction': '@img1 walks @img2', 'shotInstruction': shot, 'groups': [
                        {'tag': '@img1', 'header': 'reference header', 'images': [img] * count, 'identity': identity, 'tiles': [img] * 5}]})
        request = {'assembled': assembled, 'magnific': [], 'magnificParams': [], 'kling': [],
                   'ratios': [[0, 10], [2720, 1536], [1168, 864], [1, 3], [1, 1]],
                   'retryDelay': ['bad', '{}', *[json.dumps({'error': {'details': [{'@type': 'type.googleapis.com/google.rpc.RetryInfo', 'retryDelay': x}]}}) for x in ('0.2s', '3s', '999s', 'bad', '2.5s')]],
                   'omni': [[[], ratio, duration] for ratio in ('16:9', '9:16', '1:1') for duration in (4, 6, 8)],
                   'omniStatuses': ['completed', 'in_progress', 'failed', 'cancelled', 'incomplete', 'budget_exceeded', 'requires_action', None, 'novel'],
                   'omniErrors': [[status, body] for status in (400, 401, 403, 404, 408, 409, 410, 422, 425, 429, 500)
                                  for body in ('plain failure', '', '{"error":{"message":"input blocked by safety"}}', '{"message":"missing task"}') ]}
        for variant in ('creative', 'precision-v1', 'precision-v2'):
            request['magnific'].append({'variant': variant, 'image': ' base64 '})
            for value in (None, False, True, 0, -20, -.5, 12.5, 101, '', '2x', '0x10', [], {}, ' 3 '):
                request['magnific'].append({'variant': variant, 'image': ' https://fixture.invalid/ref ', 'params': {
                    key: value for key in ('creativity', 'hdr', 'resemblance', 'fractality', 'sharpen', 'smartGrain', 'ultraDetail', 'scaleFactor', 'filterNsfw')}})
        for model in (*magnific.MODELS, 'unknown'):
            request['magnificParams'].append({'model': model, 'params': {'scaleFactor': '4x', 'prompt': 'literal', 'sharpen': 3, 'filterNsfw': []}})
        for model in ('Kling Image 3.0', 'Kling Image 2.1', 'bad'):
            for refs in ([], [img], [img, img]):
                for resolution in ('1K', '2K', '4K', None):
                    request['kling'].append({'model': model, 'prompt': ' \ufeffliteral ', 'references': refs, 'resolution': resolution})
        request['kling'] += [{'model': 'Kling Image 3.0', 'prompt': p} for p in ('', '😀' * 1251)]
        request['kling'].append({'model': 'Kling Image 3.0', 'prompt': 'scene', 'aspectRatio': 'bad'})
        root = Path(__file__).resolve().parents[3]
        process = oracle_run(['node', '--import', 'tsx', 'scripts/django-migration/provider-pure-oracle.mjs'],
            cwd=root, input=json.dumps(request), capture_output=True, text=True, check=True)
        expected = json.loads(process.stdout)
        def capture(call):
            try:
                return {'value': call()}
            except ValueError as error:
                return {'error': str(error)}
        # The frozen Omni outputs are the retired preview's (gemini-omni-flash-preview, no resolution field); building
        # them by its registry name keeps that historical evidence. Omni Flash 1.1 has its own exact tests below.
        maps = {'geminiParts': ('assembled', gemini.build_parts), 'omniParts': ('assembled', lambda value: omni.build_input(value, 'Gemini Omni Flash')),
                'klingInput': ('assembled', lambda value: kling.build_input(value, 'Kling Image 3.0')),
                'magnific': ('magnific', lambda value: magnific.build_payload(value['variant'], value)),
                'magnificParams': ('magnificParams', lambda value: magnific.params_for_model(value['model'], value['params'])),
                'kling': ('kling', kling.build_payload), 'omni': ('omni', lambda value: omni.build_payload(*value, env={}, model='Gemini Omni Flash'))}
        for key, (input_key, function) in maps.items():
            for index, entry in enumerate(request[input_key]):
                with self.subTest(key=key, index=index):
                    self.assertEqual(expected[key][index], capture(lambda: function(entry)))
        self.assertEqual(expected['retryDelay'], [gemini.retry_delay_ms(v) for v in request['retryDelay']])
        self.assertEqual(expected['ratios'], [kling.nearest_aspect_ratio(*v) for v in request['ratios']])
        # Cancellation now has a distinct public terminal state; the frozen oracle predates it.
        expected['omniStatuses'][request['omniStatuses'].index('cancelled')] = 'cancelled'
        self.assertEqual(expected['omniStatuses'], [omni.map_status(v) for v in request['omniStatuses']])
        self.assertEqual(expected['omniErrors'], [omni.terminal_status_http_error(*v) for v in request['omniErrors']])

    def test_gemini_throttle_fails_at_once_unbilled_and_auth_headers(self):
        response = {'candidates': [{'content': {'parts': [{'inlineData': {'data': 'master', 'mimeType': 'image/png'}}]}}]}
        # A rate limit or overload was not processed: report it immediately (the paid guard allows one POST per job).
        for status in (429, 503):
            transport = ScriptedTransport(result({'error': {}}, status), result(response))
            with self.assertRaises(ProviderError) as caught:
                gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
            self.assertEqual((caught.exception.status, caught.exception.may_have_submitted), (status, False))
            self.assertEqual(len(transport.calls), 1)
        transport = ScriptedTransport(result(response))
        value = gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}, 'seed': 42},
            env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(value, {'base64': 'master', 'mimeType': 'image/png'})
        self.assertNotIn('fixture', transport.calls[0][0][1])
        self.assertEqual(transport.calls[0][1]['body']['generationConfig']['seed'], 42)
        # A 200 without an image is billed: surface it, never re-submit automatically.
        transport = ScriptedTransport(result({}), result({}))
        with self.assertRaisesRegex(ProviderError, 'no candidates'):
            gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(len(transport.calls), 1)
        # An ambiguous server error may have consumed generation; no automatic retry.
        transport = ScriptedTransport(result({'error': {}}, 500), result(response))
        with self.assertRaises(ProviderError):
            gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(len(transport.calls), 1)
        transport = ScriptedTransport(TimeoutError('ambiguous submit'))
        with self.assertRaises(TimeoutError):
            gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(len(transport.calls), 1)

    def test_gemini_model_code_endpoint_and_payload_per_registry_model(self):
        first, second = {'mimeType': 'image/png', 'data': 'first-original'}, {'mimeType': 'image/jpeg', 'data': 'second-original'}
        assembled = {'instruction': 'a brass lantern beside @img1 at dusk', 'groups': [
            {'tag': '@img1', 'header': 'REFERENCE @img1', 'images': [first, second], 'identity': False, 'tiles': []}]}
        response = {'candidates': [{'content': {'parts': [{'text': 'note'}, {'inlineData': {'data': 'master', 'mimeType': 'image/png'}}]}}]}
        sent = {}
        for display in ('Nano Banana Pro', 'nano-banana-pro', 'Nano Banana 2.1', 'nano-banana-2-1', None, 'unknown model'):
            transport = ScriptedTransport(result(response))
            value = gemini.generate_image({'assembled': assembled, 'aspectRatio': '16:9', 'imageSize': '4K', 'modelDisplay': display, 'seed': 7},
                env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
            self.assertEqual(value, {'base64': 'master', 'mimeType': 'image/png'})
            (method, url), options = transport.calls[0]
            self.assertEqual(method, 'POST')
            self.assertEqual(options['headers'], {'Content-Type': 'application/json', 'x-goog-api-key': 'fixture'})
            sent[display] = (url, json.dumps(options['body'], sort_keys=True))
        pro = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent'
        fast = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent'
        self.assertEqual({display: url for display, (url, _) in sent.items()}, {'Nano Banana Pro': pro, 'nano-banana-pro': pro,
            'Nano Banana 2.1': fast, 'nano-banana-2-1': fast, None: pro, 'unknown model': pro})
        # The request body is the same documented generateContent shape for both models.
        self.assertEqual(len({body for _, body in sent.values()}), 1)
        body = json.loads(sent['Nano Banana 2.1'][1])
        self.assertEqual(body['generationConfig'], {'responseModalities': ['TEXT', 'IMAGE'], 'imageConfig': {'aspectRatio': '16:9', 'imageSize': '4K'}, 'seed': 7})
        self.assertEqual(list(body), ['contents', 'generationConfig'])
        parts = body['contents'][0]['parts']
        self.assertEqual(body['contents'][0]['role'], 'user')
        self.assertEqual(parts[:4], [{'text': 'REFERENCE @img1'}, {'inlineData': {'mimeType': 'image/png', 'data': 'first-original'}},
            {'inlineData': {'mimeType': 'image/jpeg', 'data': 'second-original'}}, {'text': 'SCENE: a brass lantern beside @img1 at dusk'}])
        self.assertEqual(len(parts), 5)
        self.assertTrue(parts[4]['text'].startswith('CAST: CAST COUNT 0.'))
        # Defaults when the composer sends no ratio/size: 1:1 at 1K, no seed.
        transport = ScriptedTransport(result(response))
        gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}, 'modelDisplay': 'Nano Banana 2.1'},
            env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(transport.calls[0][1]['body']['generationConfig'], {'responseModalities': ['TEXT', 'IMAGE'], 'imageConfig': {'aspectRatio': '1:1', 'imageSize': '1K'}})

    def test_gemini_reference_limit_names_the_model_and_unconfigured_models_never_submit(self):
        image = {'mimeType': 'image/png', 'data': 'x'}
        many = {'instruction': 'scene', 'groups': [{'tag': '@img1', 'header': 'h', 'images': [image] * 15, 'tiles': []}]}
        for display, name in (('Nano Banana 2.1', 'Nano Banana 2.1'), ('nano-banana-pro', 'Nano Banana Pro')):
            transport = ScriptedTransport()
            with self.assertRaises(ValueError) as raised:
                gemini.generate_image({'assembled': many, 'modelDisplay': display}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
            self.assertTrue(str(raised.exception).startswith(f'Too many reference images: 15. {name} accepts at most 14 images per prompt'))
            self.assertEqual(transport.calls, [])
        # Fourteen references are accepted (the documented maximum for both models).
        transport = ScriptedTransport(result({'candidates': [{'content': {'parts': [{'inlineData': {'data': 'm'}}]}}]}))
        gemini.generate_image({'assembled': {**many, 'groups': [{**many['groups'][0], 'images': [image] * 14}]}, 'modelDisplay': 'Nano Banana 2.1'},
            env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(sum('inlineData' in part for part in transport.calls[0][1]['body']['contents'][0]['parts']), 14)
        # A Gemini registry entry without a model code (hidden Nano Banana 2) and non-Gemini models fail closed.
        for display in ('Nano Banana 2', 'Seedream 5.0 Pro'):
            transport = ScriptedTransport()
            with self.assertRaisesRegex(ValueError, 'has no configured Gemini image model'):
                gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}, 'modelDisplay': display},
                    env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
            self.assertEqual(transport.calls, [])
        # Missing credentials never select mock success.
        with self.assertRaises(Exception) as raised:
            gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}, 'modelDisplay': 'Nano Banana 2.1'},
                env={}, transport=ScriptedTransport())
        self.assertIn('GOOGLE_API_KEY', str(raised.exception))

    def test_kling_task_submit_poll_and_provider_error_protocol(self):
        transport = ScriptedTransport(result({'code': 0, 'data': {'task_id': 'a/b'}}),
            result({'code': 0, 'data': {'task_status': 'submitted'}}),
            result({'code': 0, 'data': {'task_status': 'succeed', 'task_result': {'images': [{'url': 'https://fixture.invalid/master'}]}, 'final_unit_deduction': 3}}))
        options = {'transport': transport, 'env': {'KLING_API': 'fixture'}}
        task_id = kling.submit_image({'model': 'Kling Image 3.0', 'prompt': 'literal'}, **options)
        self.assertEqual(kling.resolve_image(task_id, **options)['status'], 'running')
        self.assertEqual(kling.resolve_image(task_id, **options)['unitDeduction'], 3)
        self.assertTrue(transport.calls[-1][0][1].endswith('/a%2Fb'))
        for value in (result({'code': 1201, 'message': 'bad parameter'}), HttpResult(502, b'proxy error'), result({'code': False})):
            with self.assertRaises(ProviderError):
                kling.submit_image({'model': 'Kling Image 3.0', 'prompt': 'literal'}, transport=ScriptedTransport(value), env={'KLING_API': 'fixture'})

    def test_kling_models_resolve_by_name_or_registry_id(self):
        for model, code in (('Kling Image 3.0', 'kling-v3'), ('kling-image-3', 'kling-v3'), (' kling image 2.1 ', 'kling-v2-1'), ('kling-image-21', 'kling-v2-1')):
            self.assertEqual(kling.build_payload({'model': model, 'prompt': 'literal'})['model_name'], code, model)
        with self.assertRaisesRegex(ValueError, 'not a Kling model'):
            kling.build_payload({'model': 'kling-v3', 'prompt': 'literal'})

    def test_kling_key_is_only_ever_sent_to_a_kling_api_host(self):
        self.assertEqual(kling.create_url({}), 'https://api-singapore.klingai.com/v1/images/generations')
        self.assertEqual(kling.create_url({'KLING_API_HOST': 'https://api.klingai.com/'}), 'https://api.klingai.com/v1/images/generations')
        for host in ('http://api.klingai.com', 'https://evil.example', 'https://api.klingai.com.evil.example', 'https://klingai.com',
                     'https://api.klingai.com:8443', 'https://api.klingai.com/v2', 'https://user@api.klingai.com'):
            transport = ScriptedTransport(result({'code': 0, 'data': {'task_id': 'never'}}))
            with self.subTest(host=host), self.assertRaisesRegex(ProviderError, 'KLING_API_HOST'):
                kling.submit_image({'model': 'Kling Image 3.0', 'prompt': 'literal'}, transport=transport, env={'KLING_API': 'fixture', 'KLING_API_HOST': host})
            self.assertEqual(transport.calls, [])

    def test_kling_reference_bytes_preserved_or_explicitly_converted(self):
        def encoded(size, format):
            buffer = io.BytesIO()
            Image.new('RGB', size, 'red').save(buffer, format=format)
            return base64.b64encode(buffer.getvalue()).decode()
        png = encoded((512, 512), 'PNG')
        self.assertEqual(kling.prep_reference('image/png', png), {'mimeType': 'image/png', 'data': png})
        value = kling.prep_reference('image/webp', encoded((512, 512), 'WEBP'))
        self.assertEqual(value['mimeType'], 'image/jpeg')
        self.assertEqual(Image.open(io.BytesIO(base64.b64decode(value['data']))).size, (512, 512))
        for size in ((299, 400), (900, 300)):
            with self.assertRaises(ValueError):
                kling.prep_reference('image/png', encoded(size, 'PNG'))

    def test_omni_credentials_scoped_downloads_and_terminal_errors(self):
        transport = ScriptedTransport(result({'id': 'task/id'}), result({'status': 'completed', 'steps': [{'content': [{'type': 'video', 'data': 'original', 'mime_type': 'video/mp4'}]}]}))
        options = {'transport': transport, 'env': {'GOOGLE_API_KEY': 'fixture'}}
        task_id = omni.create_video_task({'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '16:9', 'duration': 4,
                                          'modelDisplay': 'Gemini Omni Flash 1.1'}, **options)
        self.assertEqual(omni.get_video_status(task_id, **options), {'status': 'succeeded', 'videoBase64': 'original', 'mimeType': 'video/mp4'})
        self.assertTrue(transport.calls[-1][0][1].endswith('/task%2Fid'))
        for uri in ('https://evil.invalid/video', 'http://googleapis.com/video', 'https://user@googleapis.com/video', 'https://googleapis.com:444/video'):
            for shape in ({'output_video': {'uri': uri}}, {'steps': [{'type': 'model_output', 'content': [{'type': 'video', 'uri': uri}]}]}):
                download = ScriptedTransport()
                with self.assertRaises(ValueError):
                    omni.extract_video(shape, {'x-goog-api-key': 'fixture'}, transport=download)
                self.assertFalse(download.calls)
        download = ScriptedTransport(HttpResult(200, b'original-master', {'content-type': 'video/mp4'}))
        self.assertEqual(base64.b64decode(omni.extract_video({'output_video': {'uri': 'https://storage.googleapis.com/fixture'}}, transport=download)['base64']), b'original-master')
        self.assertEqual(omni.get_video_status('gone', transport=ScriptedTransport(result({'error': {'message': 'gone'}}, 404)), env={'GOOGLE_API_KEY': 'fixture'})['status'], 'failed')
        with self.assertRaises(ProviderError):
            omni.get_video_status('task', transport=ScriptedTransport(result({}, 401)), env={'GOOGLE_API_KEY': 'fixture'})

    def test_omni_flash_1_1_create_payload_endpoint_and_headers_are_exact(self):
        # ai.google.dev/gemini-api/docs/omni and /api/interactions-api VideoResponseFormat (read 2026-10-18).
        first, second, tile = ({'mimeType': 'image/png', 'data': 'first-original'}, {'mimeType': 'image/jpeg', 'data': 'second-original'},
                               {'mimeType': 'image/jpeg', 'data': 'tile'})
        assembled = {'instruction': '@img1 walks through the lantern market', 'groups': [
            {'tag': '@img1', 'header': 'REFERENCE @img1', 'images': [first, second], 'identity': True, 'tiles': [tile]}]}
        parts = [{'type': 'text', 'text': 'REFERENCE @img1'}, {'type': 'image', 'mime_type': 'image/png', 'data': 'first-original'},
                 {'type': 'image', 'mime_type': 'image/jpeg', 'data': 'second-original'}, {'type': 'image', 'mime_type': 'image/jpeg', 'data': 'tile'},
                 {'type': 'text', 'text': 'SCENE: @img1 walks through the lantern market'}]
        cases = [(display, resolution, ratio, duration) for display in ('Gemini Omni Flash 1.1', 'gemini-omni-1-1-flash')
                 for resolution in ('360p', '720p') for ratio in ('16:9', '9:16') for duration in (4, 6, 8, 10)]
        for display, resolution, ratio, duration in cases:
            with self.subTest(display=display, resolution=resolution, ratio=ratio, duration=duration):
                transport = ScriptedTransport(result({'id': 'v1_interaction', 'status': 'in_progress'}))
                task = omni.create_video_task({'assembled': assembled, 'aspectRatio': ratio, 'duration': duration, 'resolution': resolution,
                                               'modelDisplay': display}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
                self.assertEqual(task, 'v1_interaction')
                [((method, url), options)] = transport.calls
                self.assertEqual((method, url), ('POST', 'https://generativelanguage.googleapis.com/v1beta/interactions'))
                self.assertEqual(options['headers'], {'x-goog-api-key': 'fixture', 'Content-Type': 'application/json'})
                body = options['body']
                self.assertEqual(list(body), ['model', 'input', 'background', 'response_format'])
                self.assertEqual({key: body[key] for key in ('model', 'background', 'response_format')}, {
                    'model': 'gemini-omni-1.1-flash', 'background': True,
                    'response_format': {'type': 'video', 'aspect_ratio': ratio, 'duration': f'{duration}s', 'resolution': resolution}})
                self.assertEqual(body['input'][:5], parts)
                self.assertEqual(len(body['input']), 6)
                self.assertTrue(body['input'][5]['text'].startswith('FINAL CHECK: every person referenced above'))
        # The documented default size is sent explicitly when a row has none.
        transport = ScriptedTransport(result({'id': 'v1_default'}))
        omni.create_video_task({'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '16:9', 'duration': 8,
                                'modelDisplay': 'Gemini Omni Flash 1.1'}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
        self.assertEqual(transport.calls[0][1]['body'], {'model': 'gemini-omni-1.1-flash', 'input': [{'type': 'text', 'text': 'literal'}],
            'background': True, 'response_format': {'type': 'video', 'aspect_ratio': '16:9', 'duration': '8s', 'resolution': '720p'}})
        # A resource `name` instead of an `id` is still recorded as the receipt (existing adapter contract).
        transport = ScriptedTransport(result({'name': 'interactions/v1_named'}))
        self.assertEqual(omni.create_video_task({'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '9:16', 'duration': 4,
            'modelDisplay': 'Gemini Omni Flash 1.1'}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport), 'interactions/v1_named')

    def test_omni_flash_1_1_refuses_retired_unoffered_and_unconfigured_requests_before_any_network(self):
        base = {'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '16:9', 'duration': 8, 'resolution': '720p',
                'modelDisplay': 'Gemini Omni Flash 1.1'}
        image = {'mimeType': 'image/png', 'data': 'x'}
        many = {'groups': [{'tag': '@img1', 'header': 'h', 'images': [image] * 15, 'tiles': []}], 'instruction': 'scene'}
        cases = [
            ({'modelDisplay': 'Gemini Omni Flash'}, ValueError, 'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.'),
            ({'modelDisplay': 'gemini-omni-flash'}, ValueError, 'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.'),
            ({'modelDisplay': 'Seedance 2.5'}, ValueError, 'Seedance 2.5 is not a Gemini Omni model.'),
            ({'modelDisplay': None}, ValueError, 'This model is not a Gemini Omni model.'),
            ({'resolution': '1080p'}, ValueError, 'Gemini Omni Flash 1.1 supports 360p/720p only (got 1080p).'),
            ({'resolution': '4k'}, ValueError, 'Gemini Omni Flash 1.1 supports 360p/720p only (got 4k).'),
            ({'duration': 3}, ValueError, 'Gemini Omni Flash 1.1 supports 4/6/8/10s durations (got 3).'),
            ({'duration': 12}, ValueError, 'Gemini Omni Flash 1.1 supports 4/6/8/10s durations (got 12).'),
            ({'duration': '8'}, ValueError, 'Gemini Omni Flash 1.1 supports 4/6/8/10s durations (got 8).'),
            ({'aspectRatio': '1:1'}, ValueError, 'Gemini Omni Flash 1.1 only supports 16:9/9:16 aspect ratios (got "1:1").'),
            ({'assembled': many}, ValueError, 'Too many reference images: 15. Gemini Omni Flash 1.1 accepts at most 14 images per prompt \u2014 remove 1.'),
        ]
        for change, error, message in cases:
            with self.subTest(change=change):
                transport = ScriptedTransport()
                with self.assertRaises(error) as raised:
                    omni.create_video_task({**base, **change}, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
                self.assertEqual(str(raised.exception), message)
                self.assertEqual(transport.calls, [])
        # Missing credentials never select mock success, and nothing is sent.
        transport = ScriptedTransport()
        with self.assertRaises(ProviderError) as raised:
            omni.create_video_task(base, env={}, transport=transport)
        self.assertEqual((str(raised.exception), raised.exception.code), ('GOOGLE_API_KEY is not set.', 'missing_configuration'))
        self.assertEqual(transport.calls, [])

    def test_omni_flash_1_1_create_errors_are_reported_once_and_never_resubmitted(self):
        request = {'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '16:9', 'duration': 4, 'modelDisplay': 'Gemini Omni Flash 1.1'}
        for status, body, message in ((400, {'error': {'code': 400, 'message': 'Request contains an invalid argument.', 'status': 'INVALID_ARGUMENT'}},
                                       'Omni create error (400): '),
                                      (429, {'error': {'code': 429, 'message': 'Resource exhausted.', 'status': 'RESOURCE_EXHAUSTED'}}, 'Omni create error (429): '),
                                      (500, {'error': {'code': 500, 'message': 'Internal error.'}}, 'Omni create error (500): '),
                                      (200, {'status': 'in_progress'}, 'Omni create returned no interaction id.')):
            with self.subTest(status=status):
                transport = ScriptedTransport(result(body, status))
                with self.assertRaises(ProviderError) as raised:
                    omni.create_video_task(request, env={'GOOGLE_API_KEY': 'fixture'}, transport=transport)
                self.assertTrue(str(raised.exception).startswith(message), str(raised.exception))
                if status != 200:
                    self.assertEqual(raised.exception.status, status)
                    self.assertIn(json.dumps(body)[:40], str(raised.exception))
                self.assertEqual(len(transport.calls), 1)

    def test_omni_flash_1_1_status_reads_the_documented_rest_shapes(self):
        env = {'GOOGLE_API_KEY': 'fixture'}
        def status(body, code=200, download=None):
            transport = ScriptedTransport(result(body, code))
            value = omni.get_video_status('v1_task', transport=transport, download_transport=download, env=env)
            [((method, url), options)] = transport.calls
            self.assertEqual((method, url, options['headers']), ('GET', 'https://generativelanguage.googleapis.com/v1beta/interactions/v1_task', {'x-goog-api-key': 'fixture'}))
            return value
        completed = {'id': 'v1_task', 'status': 'completed', 'model': 'gemini-omni-1.1-flash', 'object': 'interaction', 'steps': [
            {'type': 'user_input', 'content': [{'type': 'text', 'text': 'prompt'}]},
            {'type': 'thought', 'content': [{'type': 'thought', 'text': 'planning'}]},
            {'type': 'model_output', 'content': [{'type': 'video', 'mime_type': 'video/mp4', 'data': 'AAAAIGZ0eXBpc29t'}]}]}
        self.assertEqual(status(completed), {'status': 'succeeded', 'videoBase64': 'AAAAIGZ0eXBpc29t', 'mimeType': 'video/mp4'})
        for raw in ('in_progress', 'queued', None):
            self.assertEqual(status({'id': 'v1_task', 'status': raw}), {'status': 'running'})
        clock = patch('apps.generation.provider_errors.now_ms', return_value=7)
        clock.start()
        self.addCleanup(clock.stop)
        # A failed interaction keeps its own record: the provider's message (a plain "failed" is no code), the task id.
        blocked = {'status': 'failed', 'error': {'message': 'The prompt was blocked by safety filters.'}}
        self.assertEqual(status(blocked), {'status': 'failed', 'error': 'The prompt was blocked by safety filters.', 'moderationBlocked': True,
                                           'providerError': {'provider': 'omni', 'phase': 'task', 'source': 'provider',
                                                             'message': 'The prompt was blocked by safety filters.', 'taskId': 'v1_task',
                                                             'rawBody': json.dumps(blocked), 'receivedAt': 7}})
        self.assertEqual(status({'status': 'budget_exceeded'}),
                         {'status': 'failed', 'error': 'Omni generation ended with status "budget_exceeded".', 'moderationBlocked': False,
                          'providerError': {'provider': 'omni', 'phase': 'task', 'source': 'provider', 'code': 'budget_exceeded',
                                            'taskId': 'v1_task', 'rawBody': '{"status": "budget_exceeded"}', 'receivedAt': 7}})
        # URI delivery: the Files API download goes only to a Google host, with the same credential header.
        uri = 'https://generativelanguage.googleapis.com/v1beta/files/abc-123:download?alt=media'
        download = ScriptedTransport(HttpResult(200, b'mp4-master-bytes', {'content-type': 'video/mp4'}))
        value = status({'status': 'completed', 'steps': [{'type': 'model_output', 'content': [{'type': 'video', 'mime_type': 'video/mp4', 'uri': uri}]}]},
                       download=download)
        self.assertEqual((base64.b64decode(value['videoBase64']), value['mimeType']), (b'mp4-master-bytes', 'video/mp4'))
        self.assertEqual(download.calls, [(('GET', uri), {'headers': {'x-goog-api-key': 'fixture'}, 'signal': None})])
        with self.assertRaisesRegex(ProviderError, 'returned no video'):
            omni.get_video_status('v1_task', transport=ScriptedTransport(result({'status': 'completed', 'steps': []})), env=env)
        self.assertEqual(status({'error': {'code': 404, 'message': 'Interaction not found.', 'status': 'NOT_FOUND'}}, 404),
                         {'status': 'failed', 'error': 'Interaction not found.', 'moderationBlocked': False,
                          'providerError': {'provider': 'omni', 'phase': 'status', 'source': 'provider', 'httpStatus': 404,
                                            'code': 'NOT_FOUND', 'message': 'Interaction not found.', 'taskId': 'v1_task',
                                            'rawBody': '{"error": {"code": 404, "message": "Interaction not found.", "status": "NOT_FOUND"}}',
                                            'receivedAt': 7}})

    def test_magnific_task_protocol_and_output_list(self):
        transport = ScriptedTransport(result({'data': {'task_id': 'task'}}), result({'data': {'status': 'COMPLETED', 'generated': ['one', 'two']}}))
        options = {'transport': transport, 'env': {'MAGNIFIC_API_KEY': 'fixture'}}
        value = magnific.submit_upscale({'model': 'Magnific Precision V2', 'image': 'base64'}, **options)
        self.assertEqual(value['variant'], 'precision-v2')
        self.assertEqual(magnific.get_upscale_status('task', model='Magnific Precision V2', **options)['generatedUrls'], ['one', 'two'])
        with self.assertRaisesRegex(ProviderError, 'invalid.*image: too small'):
            magnific.submit_upscale({'image': 'x'}, transport=ScriptedTransport(result({'message': 'invalid', 'invalid_params': [{'field': 'image', 'reason': 'too small'}]}, 400)), env={'MAGNIFIC_API_KEY': 'fixture'})
