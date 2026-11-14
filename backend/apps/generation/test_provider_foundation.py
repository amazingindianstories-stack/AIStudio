from testsupport.frozen_oracle import run as oracle_run
import json
from pathlib import Path
import threading
import time

from django.test import SimpleTestCase
from .model_registry import MODEL_REGISTRY, provider_model_id
from .providers.seedream import seedream_payload, resolve_seedream_references, generate_image
from apps.integrations.transport import HttpResult, HttpTransport, ProviderError
from .services.deadline import settle_queue_execution, Cancellation, QueueExecutionDeadlineError


class PureProviderParityTests(SimpleTestCase):
    def test_registry_seedream_payloads_and_reference_resolution_match_node(self):
        # Magnific video upscalers (2026-10-14) and Nano Banana 2.1 (2026-10-16) postdate
        # the frozen Node registry; compare the frozen entries and assert the additions explicitly.
        # Gemini Omni Flash 1.1 (2026-10-18) postdates it as well.
        added = [item for item in MODEL_REGISTRY if item.get('capabilities', {}).get('upscaleMedia') == 'video'
                 or item['id'] in ('seedream-5-5', 'nano-banana-2-1', 'gemini-omni-1-1-flash', 'omnihuman-2', 'gpt-image-2-5-sunburst', 'gpt-image-2-5-flare', 'gpt-image-2-6-sunburst', 'gpt-image-2-6-flare')]
        # GPT Image 2.5 Sunburst and Flare (2026-11-04) and Seedream 5.5 (2026-11-14) postdate it too.
        self.assertEqual([(item['name'], item['provider'], item['kind'], item['pricingKey']) for item in added], [
            ('Seedream 5.5', 'seedream', 'image', 'Seedream 5.5'),
            ('Nano Banana 2.1', 'gemini', 'image', 'Nano Banana 2.1'),
            ('GPT Image 2.5 Sunburst', 'openai', 'image', 'GPT Image 2.5 Sunburst'),
            ('GPT Image 2.5 Flare', 'openai', 'image', 'GPT Image 2.5 Flare'),
            ('GPT Image 2.6 Sunburst', 'openai', 'image', 'GPT Image 2.6 Sunburst'),
            ('GPT Image 2.6 Flare', 'openai', 'image', 'GPT Image 2.6 Flare'),
            ('OmniHuman 2.0', 'omnihuman', 'video', 'OmniHuman 2.0'),
            ('Gemini Omni Flash 1.1', 'omni', 'video', 'Gemini Omni Flash 1.1'),
            *[(name, 'magnific', 'upscale', name) for name in ('Magnific Video Creative', 'Magnific Video Creative Turbo', 'Magnific Video Precision', 'Magnific Video Topaz')]])
        self.assertEqual(provider_model_id('Nano Banana 2.1', {}), 'gemini-nano-banana-2.1')
        self.assertEqual(provider_model_id('Gemini Omni Flash 1.1', {'OMNI_MODEL': 'gemini-omni-flash-preview'}), 'gemini-omni-1.1-flash')
        # Nano Banana Pro's Gemini model code moved from the provider constant into its
        # registry entry (2026-10-16); the frozen Node entry predates that field.
        self.assertEqual(provider_model_id('Nano Banana Pro', {}), 'gemini-3-pro-image')
        pro = ('nano-banana-pro', 'Nano Banana Pro')
        # Gemini Omni Flash was retired on 2026-10-18: no longer offered, no OMNI_MODEL override, no picker
        # badge or hint, and it names its replacement. Everything else in the frozen entry is unchanged.
        omni_frozen = {'providerModelEnv': 'OMNI_MODEL', 'offered': True, 'badge': 'NEW',
                       'hint': 'Google Interactions API \u2014 full NBP-style reference scaffolding, 16:9/9:16 only'}
        retired = next(item for item in MODEL_REGISTRY if item['id'] == 'gemini-omni-flash')
        self.assertEqual((retired['offered'], retired['retiredFor']), (False, 'gemini-omni-1-1-flash'))
        self.assertFalse({'providerModelEnv', 'badge', 'hint'} & set(retired))
        frozen = [{key: value for key, value in item.items() if not (item['id'] == pro[0] and key == 'providerModelId')}
                  for item in MODEL_REGISTRY if item not in added]
        frozen = [{**{key: value for key, value in item.items() if key != 'retiredFor'}, **omni_frozen}
                  if item['id'] == retired['id'] else item for item in frozen]
        # The Kling picker hints lost their em dash on 2026-10-19 (user-facing copy); the frozen Node entries keep it.
        kling_frozen = {'kling-image-3': 'Strong prompt adherence, 1K/2K — takes a single reference image',
                        'kling-image-21': 'Cheapest text-to-image here (~$0.014) — 2K only without a reference'}
        for item in frozen:
            if item['id'] in kling_frozen:
                self.assertEqual(item['hint'], kling_frozen[item['id']].replace(' — ', ' - '))
        frozen = [{**item, 'hint': kling_frozen[item['id']]} if item['id'] in kling_frozen else item for item in frozen]
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
            'Seedance 2.5': {'clipMin': 2, 'clipMax': 30, 'totalMax': 30},
            'OmniHuman 2.0': {'clipMin': 4, 'clipMax': 300, 'totalMax': 300, 'slackSeconds': 0}})
        frozen = [{**item, 'capabilities': {key: value for key, value in item['capabilities'].items() if key != 'referenceAudioSeconds'}}
                  for item in frozen]
        self.assertEqual(expected['models'], frozen)
        self.assertEqual(expected['modelIds'], [None if value in pro else provider_model_id(value, {}) for value in request['modelIds']])
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

    def test_seedream_55_payload_modes(self):
        env = {}
        text = seedream_payload({'model': 'seedream-5-5', 'prompt': 'a fox'}, env)
        self.assertEqual((text['model'], text['size'], text['output_format'], text['background'], text['watermark']),
                         ('dola-seedream-5-5-261028', '2048x2048', 'png', 'opaque', False))
        self.assertNotIn('image', text)
        single = seedream_payload({'model': 'Seedream 5.5', 'prompt': 'edit', 'references': ['a'], 'resolution': '1K',
                                   'aspectRatio': '16:9', 'background': 'transparent'}, env)
        self.assertEqual((single['image'], single['size'], single['background']), (['a'], '1424x800', 'transparent'))
        multi = seedream_payload({'model': 'seedream-5-5', 'prompt': 'blend', 'references': ['r'] * 10}, env)
        self.assertEqual(len(multi['image']), 10)
        with self.assertRaisesRegex(ValueError, 'at most 10'):
            seedream_payload({'model': 'seedream-5-5', 'prompt': 'blend', 'references': ['r'] * 11}, env)
        with self.assertRaisesRegex(ValueError, 'Seedream 5.5 background must be opaque or transparent'):
            seedream_payload({'model': 'seedream-5-5', 'prompt': 'x', 'background': 'auto'}, env)
        with self.assertRaisesRegex(ValueError, 'Seedream 5.5 requires 1K'):
            seedream_payload({'model': 'seedream-5-5', 'prompt': 'x', 'resolution': '4K'}, env)
        self.assertEqual(seedream_payload({'model': 'seedream-5-5', 'prompt': 'x'}, {'SEEDREAM_55_MODEL': 'pinned'})['model'], 'pinned')

    def test_seedream_55_cost_is_flat_output_plus_input_images(self):
        from .services.pricing import compute_cost
        cost = lambda refs, pricing=(): compute_cost({'model': 'Seedream 5.5', 'width': 2048, 'height': 2048, 'referenceCount': refs}, list(pricing))
        self.assertEqual([cost(0), cost(3), cost(10)], [2, 4, 10])
        custom = [{'model': 'Seedream 5.5', 'unit': 'per_1000_images', 'unitCostCents': 3000},
                  {'model': 'Seedream 5.5 \u00b7 input image', 'unit': 'per_1000_images', 'unitCostCents': 1000}]
        self.assertEqual(cost(2, custom), 5)
        self.assertEqual(compute_cost({'model': 'Seedream 5.0 Pro', 'width': 1024, 'height': 1024, 'referenceCount': 0}, []), 5)

    def test_seedream_55_background_is_validated_and_stored(self):
        from .services.enqueue import InvalidRequest, validate_seedream_background
        item = {'model': 'Seedream 5.5'}
        self.assertEqual(validate_seedream_background(item, {}), {'background': 'opaque'})
        self.assertEqual(validate_seedream_background(item, {'imageBackground': 'transparent'}), {'background': 'transparent'})
        with self.assertRaisesRegex(InvalidRequest, 'background must be opaque or transparent'):
            validate_seedream_background(item, {'imageBackground': 'auto'})

    def test_seedream_55_layer_decomposition_payload_and_validation(self):
        layers = {'maxImages': 15, 'textRecognition': True}
        payload = seedream_payload({'model': 'seedream-5-5', 'prompt': 'split', 'references': ['src'], 'resolution': '1.5K',
                                    'layers': layers, 'background': 'transparent'}, {})
        self.assertEqual(payload, {'model': 'dola-seedream-5-5-261028', 'prompt': 'split', 'image': 'src', 'size': '1.5K',
            'layer_decomposition': True, 'layer_decomposition_options': {'max_images': 15, 'text_recognition': True},
            'response_format': 'url', 'output_format': 'png', 'watermark': False})
        for references in ([], ['a', 'b']):
            with self.assertRaisesRegex(ValueError, 'exactly one source image'):
                seedream_payload({'model': 'seedream-5-5', 'prompt': 'x', 'references': references, 'layers': layers}, {})
        whole = seedream_payload({'model': 'seedream-5-5', 'prompt': 'x', 'references': ['a'], 'layers': {'maxImages': 15.0}}, {})
        self.assertIs(type(whole['layer_decomposition_options']['max_images']), int)
        for bad in (1, 101, 2.5, True, float('nan'), float('inf')):
            with self.assertRaisesRegex(ValueError, 'max images'):
                seedream_payload({'model': 'seedream-5-5', 'prompt': 'x', 'references': ['a'], 'layers': {'maxImages': bad}}, {})
        with self.assertRaisesRegex(ValueError, 'does not support layer decomposition'):
            seedream_payload({'model': 'seedream-5-pro', 'prompt': 'x', 'references': ['a'], 'layers': layers}, {})

    def test_seedream_55_layer_decomposition_downloads_base_and_layers_with_ocr(self):
        captured = []
        body = {'data': [
            {'url': 'https://fixture.invalid/text.png', 'size': '300x80', 'z_index': 2,
             'bounding_box': {'absolute': [1, 2, 3, 4], 'normalized': [5, 6, 7, 8]}, 'text_recognition': {'text': 'Hello'}},
            {'url': 'https://fixture.invalid/base.png', 'size': '1000x800', 'z_index': 0},
            {'url': 'https://fixture.invalid/obj.png', 'size': '200x200', 'z_index': 1}]}
        class Transport:
            def request(self, method, url, **kwargs):
                captured.append(kwargs['body'])
                return HttpResult(200, json.dumps(body).encode())
        fetched = []
        def fetcher(url):
            fetched.append(url)
            return (b'png:' + url.rsplit('/', 1)[1].encode(), 'image/png')
        result = generate_image({'model': 'seedream-5-5', 'prompt': 'split', 'references': ['src'],
                                 'layers': {'maxImages': 3, 'textRecognition': True}},
            env={'ARK_API_KEY': 'synthetic'}, transport=Transport(), fetcher=fetcher)
        self.assertEqual(len(captured), 1)
        self.assertEqual(result['base'], b'png:base.png')
        self.assertEqual([(l['zIndex'], l['content']) for l in result['layers']], [(1, b'png:obj.png'), (2, b'png:text.png')])
        self.assertEqual(result['layers'][1]['textRecognition'], {'text': 'Hello'})
        self.assertEqual(result['layers'][1]['boundingBox']['normalized'], [5, 6, 7, 8])
        self.assertNotIn('textRecognition', result['layers'][0])
        for data in ([{'url': 'https://fixture.invalid/only.png'}], [{'url': 'http://insecure/x.png'}, {'url': 'https://a/b.png'}]):
            class Short:
                def request(self, *args, **kwargs):
                    return HttpResult(200, json.dumps({'data': data}).encode())
            with self.assertRaises(ProviderError):
                generate_image({'model': 'seedream-5-5', 'prompt': 'x', 'references': ['s'], 'layers': {'maxImages': 2}},
                    env={'ARK_API_KEY': 'synthetic'}, transport=Short(), fetcher=lambda url: self.fail('no download'))

    def test_seedream_55_layer_options_are_validated_and_stored(self):
        from .services.enqueue import InvalidRequest, validate_seedream_background
        item, src = {'model': 'Seedream 5.5'}, ['data:image/png;base64,AA==']
        self.assertEqual(validate_seedream_background(item, {'imageLayers': {}, 'referenceImages': src}),
                         {'layers': {'maxImages': 30, 'textRecognition': False}})
        self.assertEqual(validate_seedream_background(item, {'imageLayers': {'maxImages': 15, 'textRecognition': True}, 'referenceImages': src}),
                         {'layers': {'maxImages': 15, 'textRecognition': True}})
        for options, phrase in [({'imageLayers': {'maxImages': 1}, 'referenceImages': src}, 'maxImages'),
                                ({'imageLayers': {'textRecognition': 'yes'}, 'referenceImages': src}, 'textRecognition'),
                                ({'imageLayers': 5, 'referenceImages': src}, 'must be an object'),
                                ({'imageLayers': {}, 'referenceImages': src, 'imageBackground': 'transparent'}, 'do not send a background')]:
            with self.assertRaisesRegex(InvalidRequest, phrase):
                validate_seedream_background(item, options)

    def test_seedream_55_layer_source_may_be_one_named_asset_image(self):
        from unittest.mock import patch
        from .services import enqueue
        hero = {'kind': 'character', 'name': 'Hero', 'slug': 'hero', 'images': ['/api/media/assets/hero.png']}
        item = {'model': 'Seedream 5.5', 'prompt': '@hero split', 'aspectRatio': '1:1',
                'submissionInput': {'layers': {'maxImages': 30}}}
        with patch.object(enqueue, 'read_pricing', lambda: []):
            with patch.object(enqueue, 'assets', lambda user_id: [hero]):
                self.assertEqual(enqueue.quote_image(item, {}, None), 61)
                with self.assertRaisesRegex(enqueue.InvalidRequest, 'exactly one source image; this prompt resolves to 2'):
                    enqueue.quote_image(item, {'referenceImages': ['data:image/png;base64,AA==']}, None)
            with patch.object(enqueue, 'assets', lambda user_id: [{**hero, 'images': hero['images'] * 2}]):
                with self.assertRaisesRegex(enqueue.InvalidRequest, 'exactly one source image; this prompt resolves to 2'):
                    enqueue.quote_image(item, {}, None)

    def test_seedream_55_layer_cost_bills_every_returned_image(self):
        from .services.pricing import compute_cost
        base = {'model': 'Seedream 5.5', 'referenceCount': 1, 'submissionInput': {'layers': {'maxImages': 30}}}
        self.assertEqual(compute_cost(base, []), 61)  # 30 x $0.02 + $0.008 reserved at admission
        self.assertEqual(compute_cost({**base, 'outputImages': 13}, []), 27)  # 13 x $0.02 + $0.008 once billed

    def test_seedream_5_pro_payload_has_no_background(self):
        payload = seedream_payload({'prompt': 'x', 'background': 'transparent'}, {})
        self.assertEqual(payload['model'], 'dola-seedream-5-0-pro-260628')
        self.assertNotIn('background', payload)

    def test_seedream_55_sends_one_request_and_names_the_model_when_not_enabled(self):
        captured = []
        class Transport:
            def request(self, method, url, **kwargs):
                captured.append(kwargs['body'])
                return HttpResult(200, b'{"data":[{"url":"https://fixture.invalid/image.png"}]}')
        data = b'\x89PNG\r\n\x1a\nrgba-master'
        result = generate_image({'model': 'seedream-5-5', 'prompt': 'sticker', 'background': 'transparent'},
            env={'ARK_API_KEY': 'synthetic'}, transport=Transport(), fetcher=lambda _url: (data, 'image/png'))
        self.assertEqual(result, data)
        self.assertEqual((len(captured), captured[0]['model'], captured[0]['background'], captured[0]['output_format']),
                         (1, 'dola-seedream-5-5-261028', 'transparent', 'png'))
        class Closed:
            def request(self, *args, **kwargs):
                return HttpResult(400, json.dumps({'error': {'code': 'ModelNotOpen'}}).encode())
        with self.assertRaisesRegex(ProviderError, 'Enable Seedream 5.5 in'):
            generate_image({'model': 'seedream-5-5', 'prompt': 'x'}, env={'ARK_API_KEY': 'synthetic'}, transport=Closed(),
                           fetcher=lambda url: self.fail('Error response must not download'))

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
