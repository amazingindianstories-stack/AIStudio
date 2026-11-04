"""GPT Image 2.5 Sunburst / Flare: sizes, exact request bodies, a faked OpenAI HTTP layer, token cost and admission.

No test reaches api.openai.com: every response comes from a fake transport or a patched HttpTransport._send.
"""
import base64
import io
import json
import os
from types import SimpleNamespace
from unittest.mock import Mock, patch

from django.test import SimpleTestCase, TransactionTestCase, override_settings
from PIL import Image

from apps.admin_dashboard import status
from apps.admin_dashboard.default_pricing import DEFAULT_PRICING
from apps.generation import failure_copy
from apps.generation.model_registry import MODEL_REGISTRY, model_definition
from apps.generation.providers import openai_image
from apps.generation.services import paid_guard
from apps.generation.services.admission import non_gemini_image_models
from apps.generation.services.enqueue import InvalidRequest, validate_openai_image
from apps.generation.services.image_execution import Dependencies, execute_image
from apps.generation.services.pricing import compute_cost, openai_token_cost
from apps.integrations.transport import HttpResult, HttpTransport, ProviderError
from apps.common.javascript import UNDEFINED
from .test_image_execution import Signal
from .test_paid_guard import UNLIMITED, OneClaimPerPostTests, contract

MODELS = (('GPT Image 2.5 Sunburst', 'gpt-image-2-5-sunburst', 'gpt-image-2.5-sunburst-2026-09-08'),
          ('GPT Image 2.5 Flare', 'gpt-image-2-5-flare', 'gpt-image-2.5-flare-2026-09-08'))
RATIOS = ['1:1', '3:4', '4:3', '4:5', '5:4', '2:3', '3:2', '9:16', '16:9', '21:9']
QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max']
HIGH = {'quality': 'high', 'background': 'opaque'}


def png(size=(64, 48)):
    return encoded('PNG', size)


def encoded(format, size=(64, 48), mode='RGB', **options):
    import pillow_heif
    pillow_heif.register_heif_opener()
    buffer = io.BytesIO()
    Image.new(mode, size, 'blue').save(buffer, format=format, **options)
    return buffer.getvalue()


def reference(mime, content):
    return {'mimeType': mime, 'data': base64.b64encode(content).decode()}


def decoded(image_url):
    header, data = image_url.split(',', 1)
    return header, Image.open(io.BytesIO(base64.b64decode(data)))


def usage(text_in=42, image_in=0, image_out=4160, text_out=0):
    return {'input_tokens': text_in + image_in, 'input_tokens_details': {'text_tokens': text_in, 'image_tokens': image_in},
            'output_tokens': image_out + text_out, 'output_tokens_details': {'image_tokens': image_out, 'text_tokens': text_out},
            'total_tokens': text_in + image_in + image_out + text_out}


def ok(content=None, used=None):
    body = {'created': 1, 'data': [{'b64_json': base64.b64encode(content or png()).decode()}], 'usage': used or usage()}
    return HttpResult(200, json.dumps(body).encode(), {'x-request-id': 'req_fixture'})


class FakeTransport:
    def __init__(self, *responses):
        self.responses, self.calls = list(responses), []

    def request(self, method, url, *, headers=None, body=None, signal=None):
        self.calls.append((method, url, headers, body))
        return self.responses.pop(0)


def assembled(groups=(), instruction='A woman reads by a window', **extra):
    return {'instruction': instruction, 'groups': list(groups), **extra}


def group(header, *images, tiles=(), identity=False):
    return {'tag': 'x', 'header': header, 'images': [{'mimeType': 'image/png', 'data': data} for data in images],
            'tiles': [{'mimeType': 'image/jpeg', 'data': data} for data in tiles], 'identity': identity}


class RegistryTests(SimpleTestCase):
    def test_both_models_are_registered_with_their_pinned_snapshots(self):
        for name, identifier, snapshot in MODELS:
            with self.subTest(name=name):
                definition = model_definition(identifier)
                self.assertEqual((definition['name'], definition['provider'], definition['kind'], definition['providerModelId'],
                                  definition['pricingKey'], definition['offered']), (name, 'openai', 'image', snapshot, name, True))
                self.assertEqual(definition['capabilities'], {
                    'aspectRatios': RATIOS, 'resolutions': ['1K', '2K', '4K'], 'experimentalResolutions': ['2K', '4K'],
                    'maxReferenceImages': 16, 'qualities': QUALITIES,
                    'qualityPriceFactors': {'low': .03, 'medium': .25, 'high': 1, 'xhigh': 2, 'max': 4},
                    'backgrounds': ['opaque', 'transparent'], 'seed': False})
        self.assertEqual([model['id'] for model in MODEL_REGISTRY if model.get('provider') == 'openai'],
                         ['gpt-image-2-5-sunburst', 'gpt-image-2-5-flare'])

    def test_openai_images_never_spend_or_wait_on_the_gemini_window(self):
        for name, identifier, _ in MODELS:
            self.assertIn(name, non_gemini_image_models())
            self.assertIn(identifier, non_gemini_image_models())


class SizeTests(SimpleTestCase):
    def test_documented_examples_and_mirrored_orientations(self):
        self.assertEqual(openai_image.image_size('1K', '1:1'), '1024x1024')
        self.assertEqual(openai_image.image_size('1K', '16:9'), '1360x768')
        self.assertEqual(openai_image.image_size('2K', '1:1'), '2048x2048')
        self.assertEqual(openai_image.image_size('2K', '16:9'), '2736x1536')
        self.assertEqual(openai_image.image_size('4K', '16:9'), '3840x2160')
        self.assertEqual(openai_image.image_size('4K', '9:16'), '2160x3840')
        self.assertEqual(openai_image.image_size('4K', '1:1'), '2880x2880')
        for resolution in ('1K', '2K', '4K'):
            for ratio in RATIOS:
                across, down = ratio.split(':')
                width, height = openai_image.image_size(resolution, ratio).split('x')
                self.assertEqual(openai_image.image_size(resolution, f'{down}:{across}'), f'{height}x{width}')

    def test_every_offered_size_meets_every_documented_constraint(self):
        for resolution in ('1K', '2K', '4K'):
            for ratio in RATIOS:
                with self.subTest(resolution=resolution, ratio=ratio):
                    width, height = map(int, openai_image.image_size(resolution, ratio).split('x'))
                    across, down = map(int, ratio.split(':'))
                    self.assertEqual((width % 16, height % 16), (0, 0))
                    self.assertLessEqual(max(width, height), 3840)
                    self.assertLessEqual(max(width, height) / min(width, height), 3)
                    self.assertTrue(655360 <= width * height <= 8294400)
                    self.assertLess(abs(width / height - across / down) / (across / down), .01)

    def test_unsupported_sizes_and_ratios_are_refused(self):
        for resolution, ratio in (('1.5K', '1:1'), ('8K', '1:1'), (None, '1:1'), ('1K', '4:1'), ('1K', 'wide'), ('1K', '0:1')):
            with self.subTest(resolution=resolution, ratio=ratio), self.assertRaises(ValueError):
                openai_image.image_size(resolution, ratio)


class PayloadTests(SimpleTestCase):
    def test_text_only_uses_generations_with_the_jobs_quality_and_background(self):
        for quality in QUALITIES:
            for background in ('opaque', 'transparent'):
                with self.subTest(quality=quality, background=background):
                    url, payload = openai_image.build_payload({'model': 'GPT Image 2.5 Flare', 'assembled': assembled(),
                        'aspectRatio': '16:9', 'resolution': '2K', 'options': {'quality': quality, 'background': background}})
                    self.assertEqual(url, 'https://api.openai.com/v1/images/generations')
                    self.assertEqual(payload, {'model': 'gpt-image-2.5-flare-2026-09-08', 'prompt': 'A woman reads by a window', 'n': 1,
                                               'size': '2736x1536', 'quality': quality, 'background': background, 'output_format': 'png'})

    def test_a_job_without_a_valid_stored_quality_and_background_never_builds_a_request(self):
        for options in (None, {}, {'quality': 'high'}, {'background': 'opaque'}, {'quality': 'auto', 'background': 'opaque'},
                        {'quality': 'high', 'background': 'auto'}, {'quality': 'standard', 'background': 'opaque'}, 'high'):
            with self.subTest(options=options), self.assertRaisesMessage(ValueError, 'GPT Image 2.5 Flare has no valid quality and background for this job.'):
                openai_image.build_payload({'model': 'GPT Image 2.5 Flare', 'assembled': assembled(), 'aspectRatio': '1:1', 'options': options})

    def test_references_use_edits_as_ordered_data_urls_with_a_legend(self):
        built = assembled([group('@anna (character: Anna):', 'a1', 'a2', tiles=['t1'], identity=True), group('Reference image 1:', 'u1')],
                          shotInstruction='SHOT: Anna by the window')
        url, payload = openai_image.build_payload({'model': 'gpt-image-2-5-sunburst', 'assembled': built, 'aspectRatio': '1:1',
                                                   'resolution': None, 'options': HIGH})
        self.assertEqual(url, 'https://api.openai.com/v1/images/edits')
        self.assertEqual((payload['model'], payload['size']), ('gpt-image-2.5-sunburst-2026-09-08', '1024x1024'))
        self.assertEqual(payload['images'], [{'image_url': 'data:image/png;base64,a1'}, {'image_url': 'data:image/png;base64,a2'},
                                             {'image_url': 'data:image/jpeg;base64,t1'}, {'image_url': 'data:image/png;base64,u1'}])
        self.assertEqual(payload['prompt'].split('\n\n')[:3],
                         ['Images 1-3: @anna (character: Anna):', 'Image 4: Reference image 1:', 'SHOT: Anna by the window'])
        self.assertTrue(payload['prompt'].endswith('If not, correct it.'))

    def test_tiles_fill_only_the_room_left_under_sixteen(self):
        built = assembled([group('Faces:', *[f'i{n}' for n in range(15)], tiles=['t1', 't2', 't3'])])
        _, payload = openai_image.build_payload({'model': 'GPT Image 2.5 Flare', 'assembled': built, 'aspectRatio': '1:1', 'options': HIGH})
        self.assertEqual(len(payload['images']), 16)
        self.assertEqual(payload['images'][-1], {'image_url': 'data:image/jpeg;base64,t1'})

    def test_too_many_references_or_too_long_a_prompt_is_refused_with_curated_copy(self):
        built = assembled([group('Refs:', *[f'i{n}' for n in range(17)])])
        with self.assertRaises(ValueError) as caught:
            openai_image.build_payload({'model': 'GPT Image 2.5 Flare', 'assembled': built, 'aspectRatio': '1:1', 'options': HIGH})
        self.assertEqual(str(caught.exception), 'Too many reference images: 17. GPT Image 2.5 Flare accepts at most 16 images per prompt - remove 1.')
        long = assembled(instruction='A woman ' + 'x' * 32000)
        with self.assertRaises(ValueError) as too_long:
            openai_image.build_payload({'model': 'GPT Image 2.5 Flare', 'assembled': long, 'aspectRatio': '1:1', 'options': HIGH})
        row = SimpleNamespace(kind='image', model='GPT Image 2.5 Flare', moderation_blocked=False, provider_responses=None)
        for error in (caught.exception, too_long.exception):
            self.assertEqual(failure_copy.public_message(row, str(error)), str(error))

    def test_only_openai_models_build_an_openai_payload(self):
        with self.assertRaises(ValueError):
            openai_image.build_payload({'model': 'Nano Banana Pro', 'assembled': assembled(), 'aspectRatio': '1:1', 'options': HIGH})


class ReferenceTypeTests(SimpleTestCase):
    """The edits endpoint takes PNG, JPEG and WebP only; nothing else is ever sent."""
    env = {'OPENAI_API_KEY': 'k'}

    def input(self, *images):
        built = {'instruction': 'A woman reads', 'groups': [{'tag': 'x', 'header': 'Refs:', 'images': list(images), 'tiles': []}]}
        return {'model': 'GPT Image 2.5 Flare', 'assembled': built, 'aspectRatio': '1:1', 'resolution': '1K', 'options': HIGH}

    def test_other_types_are_sent_as_png_in_their_place_and_accepted_types_pass_through_unchanged(self):
        jpeg, webp = reference('image/jpeg', encoded('JPEG')), reference('image/webp', encoded('WEBP'))
        others = [('image/heic', encoded('HEIF', (40, 30))), ('image/heif', encoded('HEIF', (30, 40))),
                  ('image/avif', encoded('AVIF', (50, 20))), ('image/tiff', encoded('TIFF', (20, 50))),
                  ('image/gif', encoded('GIF', (24, 24))), ('image/bmp', encoded('BMP', (12, 10))), (None, encoded('PNG', (8, 6)))]
        transport = FakeTransport(ok())
        openai_image.generate_image(self.input(jpeg, *[reference(mime, data) for mime, data in others], webp),
                                    transport=transport, env=self.env, signal=Signal())
        ((_, url, _, body),) = transport.calls
        self.assertEqual(url, 'https://api.openai.com/v1/images/edits')
        sent = [image['image_url'] for image in body['images']]
        self.assertEqual((sent[0], sent[-1]), ('data:image/jpeg;base64,' + jpeg['data'], 'data:image/webp;base64,' + webp['data']))
        for image_url, (mime, data) in zip(sent[1:-1], others):
            with self.subTest(mime=mime):
                header, image = decoded(image_url)
                self.assertEqual((header, image.format, image.size), ('data:image/png;base64', 'PNG', Image.open(io.BytesIO(data)).size))

    def test_conversion_keeps_transparency_and_bounds_the_long_edge(self):
        clear = Image.new('RGBA', (8, 8), (0, 0, 0, 0))
        buffer = io.BytesIO()
        clear.save(buffer, format='TIFF')
        transport = FakeTransport(ok())
        openai_image.generate_image(self.input(reference('image/tiff', buffer.getvalue()),
                                               reference('image/x-portable-anymap', encoded('PPM', (4096, 1024)))),
                                    transport=transport, env=self.env)
        ((*_, body),) = transport.calls
        (_, small), (_, large) = (decoded(image['image_url']) for image in body['images'])
        self.assertEqual((small.mode, small.getpixel((0, 0))), ('RGBA', (0, 0, 0, 0)))
        self.assertEqual((large.mode, large.size), ('RGB', (2048, 512)))

    def test_an_unreadable_or_oversized_reference_fails_the_job_before_any_request_with_plain_copy(self):
        row = SimpleNamespace(kind='image', model='GPT Image 2.5 Flare', moderation_blocked=False, provider_responses=None)
        huge = Image.new('1', (9000, 8000))
        buffer = io.BytesIO()
        huge.save(buffer, format='TIFF', compression='group4')
        for images, message in (
                ([reference('image/png', png()), reference('image/heic', b'not an image')],
                 'Reference image 2 (HEIC) could not be converted to PNG for GPT Image 2.5 Flare. Save it as PNG, JPEG or WebP and try again.'),
                ([reference('image/tiff', buffer.getvalue())],
                 'Reference image 1 (TIFF) could not be converted to PNG for GPT Image 2.5 Flare. Save it as PNG, JPEG or WebP and try again.'),
                ([reference('image/<svg>', b'<svg/>')],
                 'Reference image 1 (UNKNOWN) could not be converted to PNG for GPT Image 2.5 Flare. Save it as PNG, JPEG or WebP and try again.')):
            transport = FakeTransport(ok())
            with self.subTest(message=message), self.assertRaises(ValueError) as caught:
                openai_image.generate_image(self.input(*images), transport=transport, env=self.env)
            self.assertEqual(str(caught.exception), message)
            self.assertEqual(failure_copy.public_message(row, str(caught.exception)), message)
            self.assertEqual(transport.calls, [])


class FakedOpenAITests(SimpleTestCase):
    input = {'model': 'GPT Image 2.5 Sunburst', 'assembled': assembled(), 'aspectRatio': '1:1', 'resolution': '1K', 'options': HIGH}

    def test_success_sends_one_authorized_json_post_and_returns_bytes_and_usage(self):
        transport = FakeTransport(ok(png(), usage(text_in=10)))
        result = openai_image.generate_image(self.input, transport=transport, env={'OPENAI_API_KEY': 'fixture-key'}, signal=Signal())
        self.assertEqual(result, {'content': png(), 'usage': usage(text_in=10)})
        ((method, url, headers, body),) = transport.calls
        self.assertEqual((method, url), ('POST', 'https://api.openai.com/v1/images/generations'))
        self.assertEqual(headers, {'Authorization': 'Bearer fixture-key', 'Content-Type': 'application/json'})
        self.assertEqual(body['model'], 'gpt-image-2.5-sunburst-2026-09-08')

    def test_a_missing_key_fails_before_any_request(self):
        transport = FakeTransport()
        for env in ({}, {'OPENAI_API_KEY': ''}):
            with self.subTest(env=env), self.assertRaises(ProviderError) as caught:
                openai_image.generate_image(self.input, transport=transport, env=env)
            self.assertEqual(caught.exception.code, 'missing_configuration')
        self.assertEqual(transport.calls, [])

    def error(self, status, code, message='fixture'):
        body = json.dumps({'error': {'message': message, 'type': 'invalid_request_error', 'param': None, 'code': code}}).encode()
        with self.assertRaises(ProviderError) as caught:
            openai_image.generate_image(self.input, transport=FakeTransport(HttpResult(status, body, {'x-request-id': 'req_1'})),
                                        env={'OPENAI_API_KEY': 'k'})
        return caught.exception

    def test_errors_keep_the_provider_record_and_map_to_plain_copy(self):
        row = SimpleNamespace(kind='image', model='GPT Image 2.5 Sunburst', moderation_blocked=False, provider_responses=None)
        cases = ((429, 'rate_limit_exceeded', failure_copy.BUSY, False), (503, None, failure_copy.BUSY, False),
                 (401, 'invalid_api_key', failure_copy.UNAVAILABLE, True), (400, 'moderation_blocked', failure_copy.POLICY, True),
                 (400, 'invalid_value', failure_copy.IMAGE_REJECTED, True))
        for status_code, code, copy, submitted in cases:
            with self.subTest(status=status_code, code=code):
                error = self.error(status_code, code)
                self.assertEqual((error.status, error.code, error.may_have_submitted), (status_code, code or 'invalid_request_error', submitted))
                self.assertEqual(error.provider_response['provider'], 'openai')
                self.assertEqual(error.provider_response.get('unbilled'), True if not submitted else None)
                self.assertEqual(failure_copy.public_message(row, str(error)), copy)

    def test_an_unreadable_error_body_keeps_a_safe_code(self):
        for body in (b'<html>bad gateway</html>', json.dumps({'error': {'code': 'x' * 101}}).encode(),
                     json.dumps({'error': {'code': '<script>'}}).encode()):
            with self.subTest(body=body), self.assertRaises(ProviderError) as caught:
                openai_image.generate_image(self.input, transport=FakeTransport(HttpResult(502, body)), env={'OPENAI_API_KEY': 'k'})
            self.assertEqual((caught.exception.code, str(caught.exception)), ('provider_error', 'OpenAI image error. (502, provider_error)'))

    def test_a_billed_answer_without_one_image_is_never_resubmitted(self):
        for body in ({'data': []}, {'data': [{'url': 'https://x'}]}, {'data': [{'b64_json': '!!'}]},
                     {'data': [{'b64_json': 'aGk='}, {'b64_json': 'aGk='}]}):
            transport = FakeTransport(HttpResult(200, json.dumps(body).encode()))
            with self.subTest(body=body), self.assertRaises(ProviderError) as caught:
                openai_image.generate_image(self.input, transport=transport, env={'OPENAI_API_KEY': 'k'})
            self.assertEqual((caught.exception.code, caught.exception.may_have_submitted, len(transport.calls)), ('no_result', True, 1))


class TokenCostTests(SimpleTestCase):
    """Worked examples at the documented Standard rates: $5 text in, $8 image in, $30 image out per 1M tokens."""

    def test_text_to_image(self):
        # 42 x 500 + 4,160 x 3,000 = 12,501,000 cent-tokens = 12.501 cents
        for name, _, _ in MODELS:
            self.assertEqual(openai_token_cost(name, usage(text_in=42, image_out=4160), DEFAULT_PRICING), 13)

    def test_edit_with_references_bills_image_input_and_never_text_output(self):
        # 300 x 500 + 2,000 x 800 + 6,240 x 3,000 = 20,470,000 = 20.47 cents; the 120 text output tokens are free
        self.assertEqual(openai_token_cost('gpt-image-2-5-sunburst', usage(text_in=300, image_in=2000, image_out=6240, text_out=120),
                                           DEFAULT_PRICING), 20)

    def test_half_a_cent_rounds_up(self):
        self.assertEqual(openai_token_cost('GPT Image 2.5 Flare', usage(text_in=0, image_out=500), DEFAULT_PRICING), 2)

    def test_without_a_token_split_input_is_billed_at_the_image_rate_and_output_as_image(self):
        # 1,000 x 800 + 1,000 x 3,000 = 3.8 cents
        self.assertEqual(openai_token_cost('GPT Image 2.5 Flare', {'input_tokens': 1000, 'output_tokens': 1000}, DEFAULT_PRICING), 4)
        inconsistent = {**usage(text_in=10, image_in=10), 'input_tokens': 1000, 'output_tokens': 1000, 'output_tokens_details': {}}
        self.assertEqual(openai_token_cost('GPT Image 2.5 Flare', inconsistent, DEFAULT_PRICING), 4)

    def test_admin_rates_win_and_missing_rows_fall_back_to_the_defaults(self):
        # Only the image output rate is stored (at half); 42 x 500 + 4,160 x 1,500 = 6.261 cents
        stored = [{'model': 'GPT Image 2.5 Sunburst · image output', 'unitCostCents': 1500, 'unit': 'per_million_tokens', 'notes': ''}]
        self.assertEqual(openai_token_cost('GPT Image 2.5 Sunburst', usage(), stored), 6)
        self.assertEqual(openai_token_cost('GPT Image 2.5 Sunburst', usage(), []), 13)

    def test_unusable_usage_or_rates_keep_the_estimate(self):
        wrong_unit = [{'model': 'GPT Image 2.5 Flare · text input', 'unitCostCents': 500, 'unit': 'per_image', 'notes': ''}]
        self.assertIsNone(openai_token_cost('GPT Image 2.5 Flare', usage(), wrong_unit))
        for value in (None, [], {}, {'input_tokens': '42', 'output_tokens': 1}, {'input_tokens': -1, 'output_tokens': 1},
                      {'input_tokens': 1, 'output_tokens': 1.5}, {'input_tokens': True, 'output_tokens': 1}):
            with self.subTest(value=value):
                self.assertIsNone(openai_token_cost('GPT Image 2.5 Flare', value, DEFAULT_PRICING))

    def test_default_rows_carry_the_documented_rates(self):
        rows = {row['model']: row for row in DEFAULT_PRICING}
        for name, _, _ in MODELS:
            self.assertEqual([(rows[f'{name} · {kind}']['unitCostCents'], rows[f'{name} · {kind}']['unit'])
                              for kind in ('text input', 'image input', 'image output')],
                             [(500, 'per_million_tokens'), (800, 'per_million_tokens'), (3000, 'per_million_tokens')])
            self.assertEqual((rows[name]['unitCostCents'], rows[name]['unit']), (21, 'per_image'))

    def test_the_enqueue_estimate_scales_by_resolution(self):
        for resolution, cents in (('1K', 21), (UNDEFINED, 21), ('2K', 32), ('4K', 63)):
            self.assertEqual(compute_cost({'model': 'GPT Image 2.5 Flare', 'resolution': resolution}, DEFAULT_PRICING), cents)

    def test_the_enqueue_estimate_scales_by_the_jobs_quality(self):
        expected = {'1K': {'low': 1, 'medium': 5, 'high': 21, 'xhigh': 42, 'max': 84},
                    '4K': {'low': 2, 'medium': 16, 'high': 63, 'xhigh': 126, 'max': 252}}
        for name, _, _ in MODELS:
            for resolution, cents in expected.items():
                for quality in QUALITIES:
                    with self.subTest(model=name, resolution=resolution, quality=quality):
                        item = {'model': name, 'resolution': resolution, 'submissionInput': {'quality': quality, 'background': 'transparent'}}
                        self.assertEqual(compute_cost(item, DEFAULT_PRICING), cents[quality])
        self.assertEqual(compute_cost({'model': 'Nano Banana Pro', 'resolution': '1K', 'submissionInput': {'quality': 'low'}}, DEFAULT_PRICING),
                         compute_cost({'model': 'Nano Banana Pro', 'resolution': '1K'}, DEFAULT_PRICING))


class ExecutionTests(SimpleTestCase):
    def setUp(self):
        self.item = SimpleNamespace(id='fixture', model='GPT Image 2.5 Sunburst', prompt='A woman reads', aspect_ratio='16:9',
            resolution='2K', reference_images=[], seed=None, draft_task_id=None, cost_cents=32, cost_basis='estimated',
            project_id=None, user_id=None, task_id=None, submission_input={'quality': 'xhigh', 'background': 'transparent'})
        from apps.media.storage import MemoryAdapter, StorageService
        self.storage = StorageService(MemoryAdapter())
        self.deps = Dependencies()
        self.deps.assets, self.deps.pricing = [], DEFAULT_PRICING
        self.deps.storage = lambda: self.storage
        self.deps.assemble = Mock(return_value=assembled(instruction='A woman reads'))
        self.deps.now = lambda: 1234
        self.deps.openai_generate = Mock(return_value={'content': png((96, 54)), 'usage': usage(text_in=42, image_out=4160)})
        self.deps.gemini_generate = Mock(side_effect=AssertionError('Gemini must not be called'))

    def execute(self):
        return execute_image(self.item, signal=Signal(), dependencies=self.deps, env={})

    def test_a_success_stores_the_png_and_reconciles_the_token_cost(self):
        result = self.execute()
        self.assertEqual((result['status'], result['cost_cents'], result['cost_basis'], result['seed']), ('succeeded', 13, 'reconciled', None))
        self.assertTrue(result['url'])
        (call,) = self.deps.openai_generate.call_args_list
        self.assertEqual(call.args[0], {'model': 'GPT Image 2.5 Sunburst', 'assembled': assembled(instruction='A woman reads'),
                                        'aspectRatio': '16:9', 'resolution': '2K',
                                        'options': {'quality': 'xhigh', 'background': 'transparent'}})

    def test_unusable_usage_keeps_the_enqueue_estimate(self):
        self.deps.openai_generate.return_value = {'content': png(), 'usage': None}
        result = self.execute()
        self.assertEqual((result['cost_cents'], result['cost_basis']), (32, 'estimated'))


class EnqueueValidationTests(SimpleTestCase):
    def item(self, **change):
        return {'model': 'GPT Image 2.5 Flare', 'aspectRatio': '1:1', 'resolution': '1K', **change}

    def test_registry_sizes_ratios_and_up_to_sixteen_references_are_accepted(self):
        for resolution in ('1K', '2K', '4K', UNDEFINED):
            for ratio in RATIOS:
                validate_openai_image(self.item(resolution=resolution, aspectRatio=ratio), {'referenceImages': ['ref'] * 16})
        validate_openai_image(self.item(), {'referenceImages': None})

    def test_quality_and_background_become_the_stored_submission_input_with_high_opaque_defaults(self):
        self.assertEqual(validate_openai_image(self.item(), {}), {'quality': 'high', 'background': 'opaque'})
        for quality in QUALITIES:
            for background in ('opaque', 'transparent'):
                with self.subTest(quality=quality, background=background):
                    self.assertEqual(validate_openai_image(self.item(), {'imageQuality': quality, 'imageBackground': background}),
                                     {'quality': quality, 'background': background})

    def test_anything_else_is_refused_before_it_is_stored(self):
        qualities = 'GPT Image 2.5 Flare quality must be one of low, medium, high, xhigh, max'
        backgrounds = 'GPT Image 2.5 Flare background must be opaque or transparent'
        for item, body, message in (
                (self.item(resolution='1.5K'), {}, 'GPT Image 2.5 Flare supports 1K/2K/4K only (got 1.5K).'),
                (self.item(aspectRatio='4:1'), {}, 'GPT Image 2.5 Flare does not support 4:1. Supported: ' + ', '.join(RATIOS)),
                (self.item(), {'referenceImages': ['ref'] * 17}, 'GPT Image 2.5 Flare accepts at most 16 reference images per request (got 17).'),
                (self.item(), {'imageQuality': 'auto'}, qualities + ' (got auto).'),
                (self.item(), {'imageQuality': 'standard'}, qualities + ' (got standard).'),
                (self.item(), {'imageQuality': 'HIGH'}, qualities + ' (got HIGH).'),
                (self.item(), {'imageQuality': None}, qualities + ' (got null).'),
                (self.item(), {'imageBackground': 'auto'}, backgrounds + ' (got auto).'),
                (self.item(), {'imageBackground': ''}, backgrounds + ' (got ).'),
                (self.item(), {'imageBackground': True}, backgrounds + ' (got true).')):
            with self.subTest(message=message), self.assertRaisesMessage(InvalidRequest, message):
                validate_openai_image(item, body)


@override_settings(VEEVEE_OPENAI_IMAGE=True)
class OpenAIAdmissionTests(SimpleTestCase):
    def test_each_model_is_pinned_to_its_snapshot_one_image_and_this_jobs_size(self):
        for name, identifier, snapshot in MODELS:
            for model in (name, identifier):
                for resolution, ratio, size in (('1K', '1:1', '1024x1024'), ('4K', '9:16', '2160x3840'), (None, '16:9', '1360x768')):
                    with self.subTest(model=model, resolution=resolution):
                        quote = paid_guard.quote_for(contract(kind='image', model=model, resolution=resolution, aspect_ratio=ratio,
                                                              submission_input=HIGH), UNLIMITED)
                        self.assertEqual(quote, {'maximum_cents': 0, 'pricing_status': 'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE',
                            'allowed_paid_endpoints': ['https://api.openai.com/v1/images/generations', 'https://api.openai.com/v1/images/edits'],
                            'provider_payload_allowed_values': {'model': [snapshot], 'n': [1], 'size': [size], 'quality': ['high'],
                                                                'background': ['opaque'], 'output_format': ['png']}})

    def test_quality_and_background_are_pinned_to_the_jobs_own_choice(self):
        for quality in QUALITIES:
            for background in ('opaque', 'transparent'):
                with self.subTest(quality=quality, background=background):
                    quote = paid_guard.quote_for(contract(kind='image', model='GPT Image 2.5 Sunburst', resolution='1K', aspect_ratio='1:1',
                        submission_input={'quality': quality, 'background': background}), UNLIMITED)
                    allowed = quote['provider_payload_allowed_values']
                    self.assertEqual((allowed['quality'], allowed['background'], allowed['output_format']), ([quality], [background], ['png']))

    def test_requests_outside_the_contract_or_with_the_switch_off_are_refused(self):
        valid = dict(kind='image', model='GPT Image 2.5 Flare', resolution='2K', aspect_ratio='16:9', submission_input=HIGH)
        for change, message in (({'resolution': '1.5K'}, 'Request outside the OpenAI contract'),
                                ({'aspect_ratio': '4:1'}, 'Request outside the OpenAI contract'),
                                ({'submission_input': None}, 'Request outside the OpenAI contract'),
                                ({'submission_input': {'quality': 'auto', 'background': 'opaque'}}, 'Request outside the OpenAI contract'),
                                ({'submission_input': {'quality': 'high', 'background': 'auto'}}, 'Request outside the OpenAI contract'),
                                ({'kind': 'video'}, 'New OpenAI image generation only'),
                                ({'draft_task_id': 'x'}, 'New authenticated initial jobs only')):
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                paid_guard.quote_for(contract(**{**valid, **change}), UNLIMITED)
        with override_settings(VEEVEE_OPENAI_IMAGE=False), \
                self.assertRaisesRegex(ValueError, r'^GPT Image 2\.5 Flare is not enabled\. Choose another image model\.$'):
            paid_guard.quote_for(contract(**valid), UNLIMITED)


@override_settings(VEEVEE_OPENAI_IMAGE=True)
class OpenAIOneClaimTests(TransactionTestCase):
    """The real adapter's one POST is claimed once, for exactly its own pinned payload."""
    guarded = OneClaimPerPostTests.guarded

    def row(self):
        return SimpleNamespace(**contract(kind='image', model='GPT Image 2.5 Flare', resolution='2K', aspect_ratio='16:9',
                                          submission_input={'quality': 'medium', 'background': 'transparent'}))

    def execute(self, input, posts=1):
        class Answering(HttpTransport):
            def _send(self, method, url, **kwargs):
                super()._send(method, url, **kwargs)   # the guarded fixture records it
                return ok()

        def run(item, **kwargs):
            for _ in range(posts):
                openai_image.generate_image(input, transport=Answering(allowed_hosts=['api.openai.com']), env={'OPENAI_API_KEY': 'k'})
        return run

    def input(self, **change):
        return {'model': 'GPT Image 2.5 Flare', 'assembled': assembled(), 'aspectRatio': '16:9', 'resolution': '2K',
                'options': {'quality': 'medium', 'background': 'transparent'}, **change}

    def test_the_exact_payload_is_claimed_once_and_sent(self):
        row, sent = self.row(), []
        ledger = {row.id: 'RESERVED'}
        with self.guarded(ledger, sent, self.execute(self.input())) as executor:
            executor.execute_admitted(row)
        self.assertEqual([(method, url, body['model'], body['size'], body['quality'], body['background']) for method, url, body in sent],
                         [('POST', 'https://api.openai.com/v1/images/generations', 'gpt-image-2.5-flare-2026-09-08', '2736x1536',
                           'medium', 'transparent')])
        self.assertEqual(ledger[row.id], 'SUBMITTING')

    def test_a_second_post_and_any_other_model_or_size_are_refused_unsent(self):
        row, sent = self.row(), []
        ledger = {row.id: 'RESERVED'}
        with self.guarded(ledger, sent, self.execute(self.input(), posts=2)) as executor:
            with self.assertRaisesRegex(RuntimeError, 'No paid submission retry'):
                executor.execute_admitted(row)
        self.assertEqual(len(sent), 1)
        for change in ({'model': 'GPT Image 2.5 Sunburst'}, {'resolution': '4K'}, {'aspectRatio': '1:1'},
                       {'options': {'quality': 'max', 'background': 'transparent'}}, {'options': {'quality': 'medium', 'background': 'opaque'}}):
            row, sent = self.row(), []
            ledger = {row.id: 'RESERVED'}
            with self.subTest(change=change), self.guarded(ledger, sent, self.execute(self.input(**change))) as executor:
                with self.assertRaises(ValueError):
                    executor.execute_admitted(row)
            self.assertEqual(sent, [])


class SerializationTests(SimpleTestCase):
    def row(self, **change):
        from apps.generation.models import Generation
        fields = dict(kind='image', status='succeeded', prompt='A woman reads', model='GPT Image 2.5 Flare', aspect_ratio='1:1',
                      depth_reap_attempts=0, is_favorite=False, flagged=False, created_at=1, updated_at=1)
        return Generation(**{**fields, **change})

    def test_a_gpt_image_row_reopens_with_its_quality_and_background(self):
        from apps.generation.serialization import generation_item
        item = generation_item(self.row(submission_input={'quality': 'max', 'background': 'transparent'}), filename='x.png')
        self.assertEqual((item['imageQuality'], item['imageBackground']), ('max', 'transparent'))
        self.assertNotIn('submissionInput', item)
        for row in (self.row(), self.row(model='Nano Banana Pro'),
                    self.row(kind='video', model='Seedance 2.5', submission_input={'quality': 'high', 'background': 'opaque'})):
            with self.subTest(model=row.model, kind=row.kind):
                item = generation_item(row, filename='x.png')
                self.assertNotIn('imageQuality', item)
                self.assertNotIn('imageBackground', item)


class StatusTests(SimpleTestCase):
    def test_the_check_names_where_the_key_lives_without_reading_it(self):
        self.assertIn(('openai', 'OpenAI / GPT Image 2.5', status.openai), status.CHECKS)
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'sentinel-openai'}):
            result = status.openai()
        self.assertEqual(result['status'], 'ok')
        self.assertNotIn('sentinel', json.dumps(result))
        with patch.dict(os.environ, {}, clear=False) as environ, override_settings(VEEVEE_OPENAI_IMAGE=True):
            environ.pop('OPENAI_API_KEY', None)
            self.assertEqual(status.openai()['status'], 'unknown')
