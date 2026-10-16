from testsupport.frozen_oracle import run as oracle_run
import base64
import io
import json
from pathlib import Path
import subprocess

from django.test import SimpleTestCase
from PIL import Image

from .providers import gemini, kling, magnific, omni
from .providers.transport import HttpResult, ProviderError


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
        payload={'assembled':{'groups':[],'instruction':'fixture'},'aspectRatio':'16:9','duration':4}
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
        maps = {'geminiParts': ('assembled', gemini.build_parts), 'omniParts': ('assembled', omni.build_input),
                'klingInput': ('assembled', lambda value: kling.build_input(value, 'Kling Image 3.0')),
                'magnific': ('magnific', lambda value: magnific.build_payload(value['variant'], value)),
                'magnificParams': ('magnificParams', lambda value: magnific.params_for_model(value['model'], value['params'])),
                'kling': ('kling', kling.build_payload), 'omni': ('omni', lambda value: omni.build_payload(*value, env={}))}
        for key, (input_key, function) in maps.items():
            for index, entry in enumerate(request[input_key]):
                with self.subTest(key=key, index=index):
                    self.assertEqual(expected[key][index], capture(lambda: function(entry)))
        self.assertEqual(expected['retryDelay'], [gemini.retry_delay_ms(v) for v in request['retryDelay']])
        self.assertEqual(expected['ratios'], [kling.nearest_aspect_ratio(*v) for v in request['ratios']])
        self.assertEqual(expected['omniStatuses'], [omni.map_status(v) for v in request['omniStatuses']])
        self.assertEqual(expected['omniErrors'], [omni.terminal_status_http_error(*v) for v in request['omniErrors']])

    def test_gemini_transient_budget_no_image_and_auth_headers(self):
        class Signal:
            waits = []
            def check(self):
                pass
            def wait(self, value):
                self.waits.append(value)
        response = {'candidates': [{'content': {'parts': [{'inlineData': {'data': 'master', 'mimeType': 'image/png'}}]}}]}
        transport = ScriptedTransport(result({'error': {}}, 429), result(response))
        signal = Signal()
        value = gemini.generate_image({'assembled': {'groups': [], 'instruction': 'literal'}, 'seed': 42},
            env={'GOOGLE_API_KEY': 'fixture'}, transport=transport, signal=signal, random_value=lambda: .5)
        self.assertEqual(value, {'base64': 'master', 'mimeType': 'image/png'})
        self.assertEqual(signal.waits, [4000])
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
        task_id = omni.create_video_task({'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '16:9', 'duration': 4}, **options)
        self.assertEqual(omni.get_video_status(task_id, **options), {'status': 'succeeded', 'videoBase64': 'original', 'mimeType': 'video/mp4'})
        self.assertTrue(transport.calls[-1][0][1].endswith('/task%2Fid'))
        for uri in ('https://evil.invalid/video', 'http://googleapis.com/video', 'https://user@googleapis.com/video', 'https://googleapis.com:444/video'):
            download = ScriptedTransport()
            with self.assertRaises(ValueError):
                omni.extract_video({'output_video': {'uri': uri}}, {'x-goog-api-key': 'fixture'}, transport=download)
            self.assertFalse(download.calls)
        download = ScriptedTransport(HttpResult(200, b'original-master', {'content-type': 'video/mp4'}))
        self.assertEqual(base64.b64decode(omni.extract_video({'output_video': {'uri': 'https://storage.googleapis.com/fixture'}}, transport=download)['base64']), b'original-master')
        self.assertEqual(omni.get_video_status('gone', transport=ScriptedTransport(result({'error': {'message': 'gone'}}, 404)), env={'GOOGLE_API_KEY': 'fixture'})['status'], 'failed')
        with self.assertRaises(ProviderError):
            omni.get_video_status('task', transport=ScriptedTransport(result({}, 401)), env={'GOOGLE_API_KEY': 'fixture'})

    def test_magnific_task_protocol_and_output_list(self):
        transport = ScriptedTransport(result({'data': {'task_id': 'task'}}), result({'data': {'status': 'COMPLETED', 'generated': ['one', 'two']}}))
        options = {'transport': transport, 'env': {'MAGNIFIC_API_KEY': 'fixture'}}
        value = magnific.submit_upscale({'model': 'Magnific Precision V2', 'image': 'base64'}, **options)
        self.assertEqual(value['variant'], 'precision-v2')
        self.assertEqual(magnific.get_upscale_status('task', model='Magnific Precision V2', **options)['generatedUrls'], ['one', 'two'])
        with self.assertRaisesRegex(ProviderError, 'invalid.*image: too small'):
            magnific.submit_upscale({'image': 'x'}, transport=ScriptedTransport(result({'message': 'invalid', 'invalid_params': [{'field': 'image', 'reason': 'too small'}]}, 400)), env={'MAGNIFIC_API_KEY': 'fixture'})
