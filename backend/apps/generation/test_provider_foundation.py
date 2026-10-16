from testsupport.frozen_oracle import run as oracle_run
import json
from pathlib import Path
import subprocess
import threading
import time
from unittest.mock import patch

from django.test import SimpleTestCase
from .model_registry import MODEL_REGISTRY, provider_model_id
from .providers.seedream import seedream_payload, resolve_seedream_references, generate_image
from .providers.transport import HttpResult, HttpTransport, ProviderError
from .services.deadline import settle_queue_execution, Cancellation, QueueExecutionDeadlineError


class PureProviderParityTests(SimpleTestCase):
    def test_registry_seedream_payloads_and_reference_resolution_match_node(self):
        # Magnific video upscalers (2026-10-14) postdate the frozen Node registry;
        # compare the frozen entries and assert the additions explicitly.
        added = [item for item in MODEL_REGISTRY if item.get('capabilities', {}).get('upscaleMedia') == 'video']
        self.assertEqual([(item['name'], item['provider'], item['kind'], item['pricingKey']) for item in added], [
            (name, 'magnific', 'upscale', name) for name in ('Magnific Video Creative', 'Magnific Video Creative Turbo', 'Magnific Video Precision', 'Magnific Video Topaz')])
        frozen = [item for item in MODEL_REGISTRY if item not in added]
        request = {'modelIds': [item['id'] for item in frozen] + [item['name'] for item in frozen] + ['unknown'],
                   'seedream': [], 'references': []}
        for resolution in ('1K', '1.5K', '2K', '4K', None):
            for ratio in ('1:1', '16:9', '21:9', 'invalid'):
                request['seedream'].append({'prompt': 'देवी @img1', 'resolution': resolution, 'aspectRatio': ratio, 'references': ['https://fixture.invalid/a.png']})
        request['seedream'] += [{'prompt': ''}, {'prompt': 'valid', 'references': ['a'] * 11}, {'prompt': '  literal  '}]
        assets = [{'slug': 'sati', 'kind': 'character', 'name': 'Sati', 'description': 'सती', 'images': ['one', 'two']}]
        for prompt in ('scene', '@img2 with @img1', '@sati @img2', '@Sati @sati', '@missing', '@img0', '@img4', '@image 2', '@vid1 @audio1 @img01', '@img2extra'):
            request['references'].append({'prompt': prompt, 'assets': assets, 'uploads': ['upload1', 'upload2']})
        request['references'] += [{'prompt': 'a', 'uploads': [None]}, {'prompt': 'a', 'uploads': ['x'] * 11}]
        root = Path(__file__).resolve().parents[3]
        result = oracle_run(['node', '--import', 'tsx', 'scripts/django-migration/provider-pure-oracle.mjs'],
            cwd=root, input=json.dumps(request), capture_output=True, text=True, check=True)
        expected = json.loads(result.stdout)
        # referenceAudioSeconds (2026-10-14) postdates the frozen Node registry:
        # BytePlus reference-audio length limits, checked at enqueue.
        audio_limits = {item['name']: item['capabilities'].get('referenceAudioSeconds') for item in MODEL_REGISTRY}
        self.assertEqual({name: limits for name, limits in audio_limits.items() if limits}, {
            'Seedance 2.0': {'clipMin': 2, 'clipMax': 15, 'totalMax': 15},
            'Seedance 2.0 Mini': {'clipMin': 2, 'clipMax': 15, 'totalMax': 15},
            'Seedance 2.5': {'clipMin': 2, 'clipMax': 30, 'totalMax': 30}})
        frozen = [{**item, 'capabilities': {key: value for key, value in item['capabilities'].items() if key != 'referenceAudioSeconds'}}
                  for item in frozen]
        self.assertEqual(expected['models'], frozen)
        self.assertEqual(expected['modelIds'], [provider_model_id(value, {}) for value in request['modelIds']])
        def capture(call):
            try:
                return {'value': call()}
            except ValueError as error:
                return {'error': str(error)}
        self.assertEqual(expected['seedream'], [capture(lambda entry=entry: seedream_payload(entry, {})) for entry in request['seedream']])
        # Goal 2 deliberately supersedes the old typo rejection/normalization
        # contract. Frozen oracle bytes stay inert, unchanged provenance.
        changed = {'@img0', '@img4', '@image 2', '@vid1 @audio1 @img01', '@img2extra'}
        for entry, historical in zip(request['references'], expected['references']):
            actual = capture(lambda: resolve_seedream_references(entry['prompt'], entry.get('assets'), entry.get('uploads')))
            if entry['prompt'] not in changed:
                self.assertEqual(actual, historical)
                continue
            resolved = actual['value']
            self.assertEqual(resolved['references'], entry['uploads'])
            self.assertTrue(resolved['prompt'].endswith(entry['prompt']))
            self.assertEqual(resolved['warnings'][0]['code'], 'REFERENCE_TOKEN_LITERAL')
            self.assertNotEqual(actual, historical)

    def test_seedream_single_submit_and_ambiguous_timeout_never_retries(self):
        class Transport:
            calls = 0
            def request(self, *args, **kwargs):
                self.calls += 1
                raise TimeoutError('private URL query secret')
        transport = Transport()
        with self.assertRaisesRegex(ProviderError, 'not resubmitted') as failure:
            generate_image({'prompt': 'fixture'}, env={'ARK_API_KEY': 'synthetic'}, transport=transport)
        self.assertEqual(transport.calls, 1)
        self.assertNotIn('private', str(failure.exception))

    def test_seedream_exact_payload_and_result_bytes(self):
        captured = []
        class Transport:
            def request(self, method, url, **kwargs):
                captured.append((method, url, kwargs))
                return HttpResult(200, b'{"data":[{"url":"https://fixture.invalid/image.png"}]}')
        data = b'\x89PNG\r\n\x1a\noriginal-master'
        result = generate_image({'prompt': 'fixture', 'references': ['signed-ref']},
            env={'ARK_API_KEY': 'synthetic'}, transport=Transport(), fetcher=lambda _url: (data, 'image/png'))
        self.assertEqual(result, data)
        self.assertEqual(len(captured), 1)
        self.assertEqual(captured[0][2]['body']['output_format'], 'png')
        self.assertEqual(captured[0][2]['body']['image'], ['signed-ref'])

    def test_seedream_error_classification_and_no_download_on_error(self):
        for status, code, phrase in [(429, 'rate', 'rate limit'), (403, 'denied', 'authentication'),
                                      (400, 'ModelNotOpen', 'Enable Seedream')]:
            class Transport:
                def request(self, *args, **kwargs):
                    return HttpResult(status, json.dumps({'error': {'code': code}}).encode())
            with self.assertRaisesRegex(ProviderError, phrase):
                generate_image({'prompt': 'fixture'}, env={'ARK_API_KEY': 'synthetic'}, transport=Transport(),
                               fetcher=lambda url: self.fail('Error response must not download'))

    def test_transport_rejects_unapproved_or_credentialed_url_before_io(self):
        transport = HttpTransport(allowed_hosts=['provider.example'])
        for url in ('http://provider.example', 'https://private.example', 'https://user:secret@provider.example'):
            with self.assertRaises(ProviderError):
                transport.request('POST', url)

    def test_deadline_calls_failure_once_and_ignores_late_result(self):
        events = []
        finished = threading.Event()
        def work(signal):
            time.sleep(.06)
            finished.set()
            return 'late success'
        result = settle_queue_execution(work=work, timeout_ms=5,
            on_success=lambda value: events.append(('success', value)),
            on_failure=lambda error: events.append(('failure', error.code)))
        self.assertIsNone(result)
        self.assertTrue(finished.wait(1))
        self.assertEqual(events, [('failure', 'queue_execution_deadline')])

    def test_success_persistence_error_is_not_reclassified_as_provider_failure(self):
        events = []
        def persist(value):
            raise RuntimeError('database unavailable')
        with self.assertRaisesRegex(RuntimeError, 'database unavailable'):
            settle_queue_execution(work=lambda signal: 'output', on_success=persist,
                on_failure=lambda error: events.append('failure'))
        self.assertEqual(events, [])
        signal = Cancellation(10000)
        signal.cancelled.set()
        with self.assertRaises(QueueExecutionDeadlineError):
            signal.wait(1)
