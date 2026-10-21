"""Paid guard: admission rules and one-claim-per-POST behaviour (no real DB schema needed)."""
import contextlib
import os
import uuid
from types import SimpleNamespace
from unittest.mock import patch
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from . import paid_guard

UNLIMITED = {'approved_scope': paid_guard.UNLIMITED_SCOPE, 'unlimited_new_jobs': True}
SEEDANCE_ENDPOINT = 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'


def contract(**fields):
    base = {name: None for name in ('id', 'user_id', 'kind', 'model', 'duration', 'resolution', 'generate_audio', 'draft_mode',
            'draft_task_id', 'bitrate_mode', 'video_task_mode', 'aspect_ratio', 'prompt', 'submission_input', 'reference_images',
            'reference_videos', 'reference_audios', 'continuation_frame_url', 'last_frame_url', 'project_id', 'folder_id',
            'track_characters', 'width', 'height')}
    base.update(id=str(uuid.uuid4()), user_id=str(uuid.uuid4()))
    base.update(fields)
    return base


class AdmissionTests(SimpleTestCase):
    def test_unlimited_scope_admits_new_images_and_seedance_video_with_native_mov(self):
        image = paid_guard.quote_for(contract(kind='image', model='Nano Banana Pro'), UNLIMITED)
        self.assertEqual(len(image['allowed_paid_endpoints']), 1)
        video = paid_guard.quote_for(contract(kind='video', model='Seedance 2.5'), UNLIMITED)
        self.assertEqual(video['allowed_paid_endpoints'], [SEEDANCE_ENDPOINT])
        self.assertEqual(video['provider_payload_allowed_values'], {'output_format': ['mov']})

    def test_draft_finals_are_admitted_but_other_drafts_are_not(self):
        final = paid_guard.quote_for(contract(kind='video', model='Seedance 2.5', draft_task_id='cgt-1'), UNLIMITED)
        self.assertEqual(final['provider_payload_allowed_values'], {'output_format': ['mov']})
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='image', model='Nano Banana Pro', draft_task_id='cgt-1'), UNLIMITED)

    def test_each_gemini_image_model_is_pinned_to_its_own_generate_content_endpoint(self):
        root = 'https://generativelanguage.googleapis.com/v1beta/models/'
        for model, code in (('Nano Banana Pro', 'gemini-3-pro-image'), ('nano-banana-pro', 'gemini-3-pro-image'),
                            ('Nano Banana 2.1', 'gemini-nano-banana-2.1'), ('nano-banana-2-1', 'gemini-nano-banana-2.1')):
            for resolution in ('1K', '2K', '4K'):
                quote = paid_guard.quote_for(contract(kind='image', model=model, resolution=resolution), UNLIMITED)
                self.assertEqual(quote, {'maximum_cents': 0, 'pricing_status': 'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE',
                                         'allowed_paid_endpoints': [root + code + ':generateContent'], 'provider_payload_allowed_values': {}})
        # A Gemini entry without a model code (hidden Nano Banana 2) is refused before anything is reserved.
        with self.assertRaisesRegex(ValueError, 'no configured Gemini image model'):
            paid_guard.quote_for(contract(kind='image', model='Nano Banana 2'), UNLIMITED)
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='image', model='Nano Banana 2.1', draft_task_id='cgt-1'), UNLIMITED)

    def test_limited_scope_operator_quote_for_nano_banana_2_1(self):
        quotes = paid_guard.operator_quotes('a' * 64)
        self.assertEqual(quotes['Nano Banana 2.1'], quotes['nano-banana-2-1'])
        self.assertEqual(quotes['Nano Banana 2.1']['allowed_paid_endpoints'],
                         ['https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent'])
        self.assertEqual(quotes['Nano Banana Pro']['allowed_paid_endpoints'],
                         ['https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent'])
        self.assertEqual({key: value for key, value in quotes['Nano Banana 2.1'].items() if key != 'allowed_paid_endpoints'},
                         {key: value for key, value in quotes['Nano Banana Pro'].items() if key != 'allowed_paid_endpoints'})
        limited = {'approved_scope': paid_guard.LIMITED_SCOPE, 'maximum_total_cents': paid_guard.CAP,
                   'reviewed_maximum_quotes': quotes, 'operator_budget_uncertainty_accepted': True}
        self.assertEqual(paid_guard.quote_for(contract(kind='image', model='Nano Banana 2.1', resolution='4K'), limited)['maximum_cents'], 600)
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='image', model='Nano Banana 2.1', resolution='512'), limited)

    @override_settings(VEEVEE_GEMINI_OMNI=True)
    def test_gemini_omni_flash_1_1_is_pinned_to_the_interactions_endpoint_and_its_own_payload(self):
        for model in ('Gemini Omni Flash 1.1', 'gemini-omni-1-1-flash'):
            for resolution, duration, ratio in (('360p', 4, '16:9'), ('720p', 10, '9:16')):
                quote = paid_guard.quote_for(contract(kind='video', model=model, resolution=resolution, duration=duration, aspect_ratio=ratio), UNLIMITED)
                self.assertEqual(quote, {'maximum_cents': 0, 'pricing_status': 'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE',
                    'allowed_paid_endpoints': ['https://generativelanguage.googleapis.com/v1beta/interactions'],
                    'provider_payload_allowed_values': {'model': ['gemini-omni-1.1-flash'], 'background': [True], 'response_format.type': ['video'],
                        'response_format.aspect_ratio': [ratio], 'response_format.resolution': [resolution], 'response_format.duration': [f'{duration}s']}})
        valid = dict(kind='video', model='Gemini Omni Flash 1.1', resolution='720p', duration=8, aspect_ratio='16:9')
        refusals = [({'model': 'Gemini Omni Flash'}, 'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.'),
                    ({'model': 'gemini-omni-flash'}, 'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.'),
                    ({'resolution': '1080p'}, 'Request outside the Omni contract'), ({'resolution': '4k'}, 'Request outside the Omni contract'),
                    ({'duration': 12}, 'Request outside the Omni contract'), ({'duration': '8'}, 'Request outside the Omni contract'),
                    ({'aspect_ratio': '1:1'}, 'Request outside the Omni contract'), ({'draft_task_id': 'v1_x'}, 'New Omni generation only'),
                    ({'user_id': None}, 'New authenticated initial jobs only')]
        for change, message in refusals:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                paid_guard.quote_for(contract(**{**valid, **change}), UNLIMITED)
        # Limited scope has no reviewed Omni quote (and needs a MOV guard Omni cannot meet): refused.
        limited = {'approved_scope': paid_guard.LIMITED_SCOPE, 'maximum_total_cents': paid_guard.CAP,
                   'reviewed_maximum_quotes': paid_guard.operator_quotes('a' * 64), 'operator_budget_uncertainty_accepted': True}
        with self.assertRaisesRegex(ValueError, 'No verified maximum charge quote'):
            paid_guard.quote_for(contract(**valid), limited)

    def test_gemini_omni_flash_1_1_needs_its_switch(self):
        with override_settings(VEEVEE_GEMINI_OMNI=False), self.assertRaisesRegex(ValueError, 'Gemini Omni Flash 1.1 is not enabled'):
            paid_guard.quote_for(contract(kind='video', model='Gemini Omni Flash 1.1', resolution='720p', duration=8, aspect_ratio='16:9'), UNLIMITED)

    def test_unauthenticated_and_unsupported_jobs_are_rejected(self):
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='video', model='Seedance 2.5', user_id=None), UNLIMITED)
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='video', model='Kling 3.0'), UNLIMITED)


MAGNIFIC = 'https://api.magnific.com'


@override_settings(VEEVEE_MAGNIFIC_UPSCALE=True)
class MagnificAdmissionTests(SimpleTestCase):
    def test_each_model_is_pinned_to_its_create_endpoint(self):
        expected = {'Magnific Creative': '/v1/ai/image-upscaler', 'Magnific Precision V1': '/v1/ai/image-upscaler-precision',
                    'Magnific Precision V2': '/v1/ai/image-upscaler-precision-v2'}
        for model, path in expected.items():
            quote = paid_guard.quote_for(contract(kind='image', model=model, submission_input={'version': 1}), UNLIMITED)
            self.assertEqual(quote['allowed_paid_endpoints'], [MAGNIFIC + path], model)
        video = {'Magnific Video Creative': '/v1/ai/video-upscaler', 'Magnific Video Creative Turbo': '/v1/ai/video-upscaler/turbo',
                 'Magnific Video Precision': '/v1/ai/video-upscaler-precision', 'Magnific Video Topaz': '/v1/ai/video-upscaler-topaz'}
        for model, path in video.items():
            quote = paid_guard.quote_for(contract(kind='video', model=model, submission_input={'version': 1}), UNLIMITED)
            self.assertEqual(quote['allowed_paid_endpoints'], [MAGNIFIC + path], model)
            self.assertEqual(quote['provider_payload_allowed_values'],
                             {} if model == 'Magnific Video Topaz' else {'output_format': ['h264', 'prores_422_hq']})

    def test_refused_without_flag_intent_or_unlimited_scope(self):
        row = contract(kind='video', model='Magnific Video Creative', submission_input={'version': 1})
        with override_settings(VEEVEE_MAGNIFIC_UPSCALE=False), self.assertRaises(ValueError):
            paid_guard.quote_for(row, UNLIMITED)
        with self.assertRaises(ValueError):
            paid_guard.quote_for({**row, 'submission_input': None}, UNLIMITED)
        with self.assertRaises(ValueError):
            paid_guard.quote_for({**row, 'kind': 'image'}, UNLIMITED)
        with self.assertRaises(Exception):
            paid_guard.quote_for(row, {'approved_scope': paid_guard.LIMITED_SCOPE, 'maximum_total_cents': paid_guard.CAP,
                                       'reviewed_maximum_quotes': {}})


class FakeCursor:
    def __init__(self, ledger):
        self.ledger = ledger

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, sql, params):
        if 'transition' in sql:
            generation, _fingerprint, old, new = params
            if self.ledger.get(generation) != old:
                raise RuntimeError('No paid submission retry or stale input')
            self.ledger[generation] = new


class OneClaimPerPostTests(TransactionTestCase):
    @contextlib.contextmanager
    def installed(self, ledger, sent, execute=None):
        from apps.generation.services import enqueue, executor, upscale_submission, audio_submission
        from apps.generation.providers.transport import HttpTransport
        originals = (enqueue.persist, executor.execute_admitted, HttpTransport.request, upscale_submission.submit_claimed_upscale,
                     audio_submission.persist_audio_intent, audio_submission.transcribe_claimed)
        installed_flag = getattr(enqueue, '_goal4_paid_guard_installed', False)

        def fake_request(self, method, url, **kwargs):
            sent.append((method, url, kwargs.get('body')))
            return SimpleNamespace(ok=True, status=200)

        def fake_execute(item, **kwargs):
            transport = HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com'])
            body = {'model': 'seedance', 'output_format': 'mov'}
            transport.request('POST', SEEDANCE_ENDPOINT, body=body)
            transport.request('POST', SEEDANCE_ENDPOINT, body=body)  # a retry loop must be refused

        HttpTransport.request = fake_request
        executor.execute_admitted = execute or fake_execute
        enqueue._goal4_paid_guard_installed = False
        try:
            with patch('django.db.connection.cursor', lambda: FakeCursor(ledger)), \
                 patch('django.db.connection.get_autocommit', lambda: True):
                paid_guard.install_paid_guard(UNLIMITED)
                yield executor
        finally:
            (enqueue.persist, executor.execute_admitted, HttpTransport.request, upscale_submission.submit_claimed_upscale,
             audio_submission.persist_audio_intent, audio_submission.transcribe_claimed) = originals
            enqueue._goal4_paid_guard_installed = installed_flag
            paid_guard.STATE.active = None

    def test_post_outside_a_claimed_execution_is_refused(self):
        from apps.generation.providers.transport import HttpTransport, ProviderError
        with self.installed({}, []):
            with self.assertRaises(ProviderError) as caught:
                HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com']).request('POST', SEEDANCE_ENDPOINT, body={})
            self.assertEqual(caught.exception.code, 'preview_paid_scope')
            self.assertFalse(caught.exception.may_have_submitted)

    def test_each_execution_claims_once_and_a_second_post_is_refused(self):
        row = SimpleNamespace(**contract(kind='video', model='Seedance 2.5'))
        ledger, sent = {row.id: 'RESERVED'}, []
        with self.installed(ledger, sent) as executor:
            with self.assertRaises(RuntimeError):
                executor.execute_admitted(row)
        self.assertEqual(len(sent), 1)
        self.assertEqual(ledger[row.id], 'SUBMITTING')

    def test_execution_without_reservation_never_reaches_the_provider(self):
        row = SimpleNamespace(**contract(kind='video', model='Seedance 2.5'))
        sent = []
        with self.installed({}, sent) as executor:
            with self.assertRaises(RuntimeError):
                executor.execute_admitted(row)
        self.assertEqual(sent, [])

    def test_payload_outside_the_quote_is_refused(self):
        from apps.generation.providers.transport import HttpTransport
        row = SimpleNamespace(**contract(kind='video', model='Seedance 2.5'))
        ledger, sent = {row.id: 'ATTEMPTING'}, []
        with self.installed(ledger, sent):
            quote = paid_guard.quote_for(contract(kind='video', model='Seedance 2.5'), UNLIMITED)
            paid_guard.STATE.active = {'id': row.id, 'contract': contract(kind='video', model='Seedance 2.5'), 'quote': quote}
            with self.assertRaises(ValueError):
                HttpTransport(allowed_hosts=['x']).request('POST', SEEDANCE_ENDPOINT, body={'output_format': 'mp4'})
        self.assertEqual(sent, [])
        self.assertEqual(ledger[row.id], 'ATTEMPTING')

    @override_settings(VEEVEE_GEMINI_OMNI=True)
    def test_gemini_omni_flash_1_1_claim_allows_only_its_own_endpoint_and_payload(self):
        from apps.generation.providers import omni
        from apps.generation.providers.transport import HttpTransport, ProviderError
        row = contract(kind='video', model='Gemini Omni Flash 1.1', resolution='360p', duration=6, aspect_ratio='9:16')
        body = omni.build_payload([{'type': 'text', 'text': 'literal'}], '9:16', 6, {}, model='Gemini Omni Flash 1.1', resolution='360p')
        endpoint = 'https://generativelanguage.googleapis.com/v1beta/interactions'
        cases = [(endpoint, body, True),
                 ('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent', body, False),
                 (endpoint, {**body, 'model': 'gemini-omni-flash-preview'}, False),
                 (endpoint, {**body, 'response_format': {**body['response_format'], 'resolution': '4k'}}, False),
                 (endpoint, {**body, 'response_format': {**body['response_format'], 'duration': '10s'}}, False),
                 (endpoint, {**body, 'background': False}, False)]
        for url, payload, allowed in cases:
            ledger, sent = {row['id']: 'ATTEMPTING'}, []
            with self.subTest(url=url, payload=payload), self.installed(ledger, sent):
                paid_guard.STATE.active = {'id': row['id'], 'contract': row, 'quote': paid_guard.quote_for(row, UNLIMITED)}
                transport = HttpTransport(allowed_hosts=['generativelanguage.googleapis.com'])
                if allowed:
                    transport.request('POST', url, body=payload)
                else:
                    with self.assertRaises((ProviderError, ValueError)):
                        transport.request('POST', url, body=payload)
            self.assertEqual(sent, [('POST', url, payload)] if allowed else [])
            self.assertEqual(ledger[row['id']], 'SUBMITTING' if allowed else 'ATTEMPTING')

    def test_nano_banana_2_1_claim_allows_only_its_own_endpoint(self):
        from apps.generation.providers import gemini
        from apps.generation.providers.transport import HttpTransport, ProviderError
        row = contract(kind='image', model='Nano Banana 2.1', resolution='2K')
        body = gemini.build_payload({'assembled': {'groups': [], 'instruction': 'literal'}, 'aspectRatio': '1:1',
                                     'imageSize': '2K', 'modelDisplay': 'Nano Banana 2.1'})
        for url, allowed in ((gemini.endpoint('Nano Banana Pro'), False), (gemini.endpoint('Nano Banana 2.1'), True)):
            ledger, sent = {row['id']: 'ATTEMPTING'}, []
            with self.subTest(url=url), self.installed(ledger, sent):
                paid_guard.STATE.active = {'id': row['id'], 'contract': row, 'quote': paid_guard.quote_for(row, UNLIMITED)}
                transport = HttpTransport(allowed_hosts=['generativelanguage.googleapis.com'])
                if allowed:
                    transport.request('POST', url, body=body)
                else:
                    with self.assertRaises(ProviderError) as caught:
                        transport.request('POST', url, body=body)
                    self.assertEqual(caught.exception.code, 'preview_paid_scope')
            self.assertEqual(sent, [('POST', url, body)] if allowed else [])
            self.assertEqual(ledger[row['id']], 'SUBMITTING' if allowed else 'ATTEMPTING')


@override_settings(VEEVEE_MAGNIFIC_UPSCALE=True)
class MagnificOneClaimTests(TransactionTestCase):
    """The worker's upscale submit claims RESERVED->ATTEMPTING->SUBMITTING exactly once."""
    installed = OneClaimPerPostTests.installed

    def run_submit(self, ledger, sent, posts, row):
        from apps.generation.services import upscale_submission
        from apps.generation.providers.transport import HttpTransport

        def fake_upscale(item, **kwargs):
            for url, body in posts:
                HttpTransport(allowed_hosts=['api.magnific.com']).request('POST', url, body=body)
        original = upscale_submission.submit_claimed_upscale
        upscale_submission.submit_claimed_upscale = fake_upscale
        try:
            with self.installed(ledger, sent):
                upscale_submission.submit_claimed_upscale(row, owner='o', signal=None)
        finally:
            upscale_submission.submit_claimed_upscale = original

    def test_video_submit_claims_once_and_a_second_post_is_refused(self):
        row = SimpleNamespace(**contract(kind='video', model='Magnific Video Creative', submission_input={'version': 1}))
        body = {'video': 'https://storage.example/v', 'output_format': 'h264'}
        ledger, sent = {row.id: 'RESERVED'}, []
        with self.assertRaises(RuntimeError):
            self.run_submit(ledger, sent, [(MAGNIFIC + '/v1/ai/video-upscaler', body)] * 2, row)
        self.assertEqual([url for _, url, _ in sent], [MAGNIFIC + '/v1/ai/video-upscaler'])
        self.assertEqual(ledger[row.id], 'SUBMITTING')

    def test_image_submit_is_claimed_like_any_paid_job(self):
        row = SimpleNamespace(**contract(kind='image', model='Magnific Precision V2', submission_input={'version': 1}))
        ledger, sent = {row.id: 'RESERVED'}, []
        self.run_submit(ledger, sent, [(MAGNIFIC + '/v1/ai/image-upscaler-precision-v2', {'image': 'data:'})], row)
        self.assertEqual(len(sent), 1)
        self.assertEqual(ledger[row.id], 'SUBMITTING')

    def test_wrong_endpoint_payload_or_missing_reservation_never_reaches_magnific(self):
        from apps.generation.providers.transport import ProviderError
        row = SimpleNamespace(**contract(kind='video', model='Magnific Video Creative', submission_input={'version': 1}))
        for posts, ledger, error in (
                ([(MAGNIFIC + '/v1/ai/video-upscaler/turbo', {'output_format': 'h264'})], {row.id: 'RESERVED'}, ProviderError),
                ([(MAGNIFIC + '/v1/ai/video-upscaler', {'output_format': 'gif'})], {row.id: 'RESERVED'}, ValueError),
                ([(MAGNIFIC + '/v1/ai/video-upscaler', {'output_format': 'h264'})], {}, RuntimeError)):
            sent = []
            with self.subTest(posts=posts, ledger=ledger), self.assertRaises(error):
                self.run_submit(ledger, sent, posts, row)
            self.assertEqual(sent, [])


KLING_CREATE = 'https://api-singapore.klingai.com/v1/images/generations'


def kling_body(**change):
    from apps.generation.providers import kling
    return {**kling.build_payload({'model': 'Kling Image 3.0', 'prompt': 'literal', 'aspectRatio': '16:9', 'resolution': '2K'}), **change}


@override_settings(VEEVEE_KLING=True)
class KlingAdmissionTests(SimpleTestCase):
    def test_each_model_is_pinned_to_the_create_endpoint_its_model_code_one_image_and_this_jobs_ratio_and_size(self):
        for model, code in (('Kling Image 3.0', 'kling-v3'), ('kling-image-3', 'kling-v3'), ('Kling Image 2.1', 'kling-v2-1'),
                            ('kling-image-21', 'kling-v2-1')):
            for resolution, ratio, wire in (('1K', '1:1', '1k'), ('2K', '21:9', '2k'), (None, '3:2', '1k')):
                with self.subTest(model=model, resolution=resolution):
                    quote = paid_guard.quote_for(contract(kind='image', model=model, resolution=resolution, aspect_ratio=ratio), UNLIMITED)
                    self.assertEqual(quote, {'maximum_cents': 0, 'pricing_status': 'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE',
                        'allowed_paid_endpoints': [KLING_CREATE],
                        'provider_payload_allowed_values': {'model_name': [code], 'n': [1], 'aspect_ratio': [ratio], 'resolution': [wire]}})

    def test_the_configured_kling_host_moves_the_endpoint_and_any_other_host_is_refused(self):
        row = contract(kind='image', model='Kling Image 2.1', resolution='1K', aspect_ratio='1:1')
        with patch.dict(os.environ, {'KLING_API_HOST': 'https://api.klingai.com/'}):
            self.assertEqual(paid_guard.quote_for(row, UNLIMITED)['allowed_paid_endpoints'], ['https://api.klingai.com/v1/images/generations'])
        for host in ('http://api.klingai.com', 'https://evil.example', 'https://api.klingai.com.evil.example', 'https://api.klingai.com:8443',
                     'https://api.klingai.com/v2'):
            with self.subTest(host=host), patch.dict(os.environ, {'KLING_API_HOST': host}), self.assertRaisesRegex(ValueError, 'KLING_API_HOST'):
                paid_guard.quote_for(row, UNLIMITED)

    def test_requests_outside_the_kling_contract_are_refused_before_anything_is_reserved(self):
        valid = dict(kind='image', model='Kling Image 3.0', resolution='2K', aspect_ratio='16:9')
        refusals = [({'resolution': '4K'}, 'Request outside the Kling contract'), ({'resolution': '2k'}, 'Request outside the Kling contract'),
                    ({'aspect_ratio': '5:4'}, 'Request outside the Kling contract'), ({'kind': 'video'}, 'New Kling image generation only'),
                    ({'draft_task_id': 'x'}, 'New authenticated initial jobs only'), ({'user_id': None}, 'New authenticated initial jobs only')]
        for change, message in refusals:
            with self.subTest(change=change), self.assertRaisesRegex(ValueError, message):
                paid_guard.quote_for(contract(**{**valid, **change}), UNLIMITED)
        limited = {'approved_scope': paid_guard.LIMITED_SCOPE, 'maximum_total_cents': paid_guard.CAP,
                   'reviewed_maximum_quotes': paid_guard.operator_quotes('a' * 64), 'operator_budget_uncertainty_accepted': True}
        with self.assertRaisesRegex(ValueError, 'No verified maximum charge quote'):
            paid_guard.quote_for(contract(**valid), limited)

    def test_kling_needs_its_switch(self):
        for model, name in (('Kling Image 3.0', 'Kling Image 3.0'), ('Kling Image 2.1', 'Kling Image 2.1'), ('kling-image-3', 'Kling Image 3.0')):
            with self.subTest(model=model), override_settings(VEEVEE_KLING=False), \
                    self.assertRaisesRegex(ValueError, '^' + name + r' is not enabled\. Choose another image model\.$'):
                paid_guard.quote_for(contract(kind='image', model=model, resolution='1K', aspect_ratio='1:1'), UNLIMITED)


@override_settings(VEEVEE_KLING=True)
class KlingOneClaimTests(TransactionTestCase):
    """A Kling image claims RESERVED->ATTEMPTING->SUBMITTING once, for exactly its own payload."""
    installed = OneClaimPerPostTests.installed

    def row(self, **fields):
        return SimpleNamespace(**contract(kind='image', model='Kling Image 3.0', resolution='2K', aspect_ratio='16:9', **fields))

    def execute_posting(self, *posts):
        from apps.generation.providers.transport import HttpTransport

        def execute(item, **kwargs):
            for url, body in posts:
                HttpTransport(allowed_hosts=['api-singapore.klingai.com', 'api.klingai.com']).request('POST', url, body=body)
        return execute

    def test_the_exact_payload_is_claimed_once_and_sent(self):
        row, sent = self.row(), []
        ledger = {row.id: 'RESERVED'}
        with self.installed(ledger, sent, self.execute_posting((KLING_CREATE, kling_body()))) as executor:
            executor.execute_admitted(row)
        self.assertEqual(sent, [('POST', KLING_CREATE, {'model_name': 'kling-v3', 'prompt': 'literal', 'n': 1, 'aspect_ratio': '16:9',
                                                        'resolution': '2k'})])
        self.assertEqual(ledger[row.id], 'SUBMITTING')

    def test_a_second_post_is_refused(self):
        row, sent = self.row(), []
        ledger = {row.id: 'RESERVED'}
        with self.installed(ledger, sent, self.execute_posting((KLING_CREATE, kling_body()), (KLING_CREATE, kling_body()))) as executor:
            with self.assertRaisesRegex(RuntimeError, 'No paid submission retry'):
                executor.execute_admitted(row)
        self.assertEqual(len(sent), 1)
        self.assertEqual(ledger[row.id], 'SUBMITTING')

    def test_a_post_without_a_claim_is_refused(self):
        from apps.generation.providers.transport import HttpTransport, ProviderError
        sent = []
        with self.installed({}, sent):
            with self.assertRaises(ProviderError) as caught:
                HttpTransport(allowed_hosts=['api-singapore.klingai.com']).request('POST', KLING_CREATE, body=kling_body())
        self.assertEqual((caught.exception.code, caught.exception.may_have_submitted), ('preview_paid_scope', False))
        self.assertEqual(sent, [])
        with self.installed({}, sent, self.execute_posting((KLING_CREATE, kling_body()))) as executor:
            with self.assertRaisesRegex(RuntimeError, 'No paid submission retry'):
                executor.execute_admitted(self.row())     # never reserved by the API
        self.assertEqual(sent, [])

    def test_any_other_model_count_ratio_size_or_endpoint_is_refused_unsent(self):
        from apps.generation.providers.transport import ProviderError
        without_n = {key: value for key, value in kling_body().items() if key != 'n'}
        cases = [(KLING_CREATE, kling_body(model_name='kling-v2-1'), ValueError), (KLING_CREATE, kling_body(model_name='kling-v3-omni'), ValueError),
                 (KLING_CREATE, kling_body(n=2), ValueError), (KLING_CREATE, without_n, ValueError),
                 (KLING_CREATE, kling_body(aspect_ratio='1:1'), ValueError), (KLING_CREATE, kling_body(resolution='1k'), ValueError),
                 ('https://api-singapore.klingai.com/v1/images/omni-image', kling_body(), ProviderError),
                 ('https://api.klingai.com/v1/images/generations', kling_body(), ProviderError)]
        for url, body, error in cases:
            row, sent = self.row(), []
            ledger = {row.id: 'RESERVED'}
            with self.subTest(url=url, body=body), self.installed(ledger, sent, self.execute_posting((url, body))) as executor:
                with self.assertRaises(error):
                    executor.execute_admitted(row)
            self.assertEqual(sent, [])
            self.assertEqual(ledger[row.id], 'ATTEMPTING')

    def test_an_accepted_task_resumes_polling_without_a_claim_and_cannot_post(self):
        from apps.generation.providers.transport import HttpTransport, ProviderError
        row, sent = self.row(task_id='kling-task-1'), []
        ledger = {row.id: 'SUBMITTING'}
        poll = 'https://api-singapore.klingai.com/v1/images/generations/kling-task-1'

        def resume(item, **kwargs):
            transport = HttpTransport(allowed_hosts=['api-singapore.klingai.com'])
            transport.request('GET', poll)
            transport.request('POST', KLING_CREATE, body=kling_body())
        with self.installed(ledger, sent, resume) as executor:
            with self.assertRaises(ProviderError) as caught:
                executor.execute_admitted(row)
        self.assertEqual(caught.exception.code, 'preview_paid_scope')
        self.assertEqual(sent, [('GET', poll, None)])
        self.assertEqual(ledger[row.id], 'SUBMITTING')
        sent.clear()
        with override_settings(VEEVEE_KLING=False), self.installed(ledger, sent, resume) as executor:
            with self.assertRaisesRegex(ValueError, 'not enabled'):
                executor.execute_admitted(row)
        self.assertEqual(sent, [])


@override_settings(VEEVEE_KLING=True)
class KlingWorkerTests(TransactionTestCase):
    """The real worker, paid guard and Kling adapter over the fake provider network (only the ledger function is faked)."""

    @contextlib.contextmanager
    def guarded(self, ledger):
        from django.db import connection
        from apps.generation.services import enqueue, executor, upscale_submission, audio_submission
        from apps.generation.test_provider_throttle import LedgerCursor
        originals = (enqueue.persist, executor.execute_admitted, upscale_submission.submit_claimed_upscale,
                     audio_submission.persist_audio_intent, audio_submission.transcribe_claimed)
        flag = getattr(enqueue, '_goal4_paid_guard_installed', False)
        real_cursor = connection.cursor
        enqueue._goal4_paid_guard_installed = False
        try:
            with patch.object(connection, 'cursor', lambda *args, **kwargs: LedgerCursor(real_cursor(*args, **kwargs), ledger)):
                paid_guard.install_paid_guard(UNLIMITED)    # wraps the transport FakeProviders installed; undone with it
                yield
        finally:
            (enqueue.persist, executor.execute_admitted, upscale_submission.submit_claimed_upscale,
             audio_submission.persist_audio_intent, audio_submission.transcribe_claimed) = originals
            enqueue._goal4_paid_guard_installed = flag
            paid_guard.STATE.active = None

    def test_one_paid_post_then_polls_and_a_failed_download_resumes_without_resubmitting(self):
        from apps.generation.models import Generation
        from apps.generation.services import executor
        from apps.media.storage import MemoryAdapter, StorageService
        from testsupport.fake_providers import FakeProviders
        storage = StorageService(MemoryAdapter())
        row = Generation.objects.create(id=uuid.uuid4(), kind='image', status='queued', prompt='a lighthouse at dusk', model='Kling Image 3.0',
            aspect_ratio='16:9', resolution='2K', cost_cents=3, user_id=uuid.uuid4(), created_at=executor.now_ms(), updated_at=executor.now_ms())
        ledger = {row.id: 'RESERVED'}
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, {'KLING_API': 'fixture', 'MOCK_GENERATION': '0'}), \
                FakeProviders() as fake, self.guarded(ledger):
            fake.kling_running_polls = 0
            fake.faults.append({'match': r'^FETCH https://h1\.inkwai\.com/', 'status': 503, 'count': 1})
            first = executor.process_generation(str(row.id), heartbeat=False)
            self.assertEqual((first['kind'], ledger[row.id]), ('pending', 'SUBMITTING'))
            Generation.objects.filter(pk=row.id).update(next_poll_at=0)
            second = executor.process_generation(str(row.id), heartbeat=False)
        row.refresh_from_db()
        self.assertEqual((second['kind'], row.task_id, row.cost_cents, row.cost_basis), ('succeeded', 'kling-sim-1', 3, 'reconciled'))
        self.assertEqual(ledger[row.id], 'SUBMITTING')
        self.assertEqual(fake.kling_payloads, [{'model_name': 'kling-v3', 'prompt': 'a lighthouse at dusk', 'n': 1, 'aspect_ratio': '16:9',
                                                'resolution': '2k'}])
        poll = ('GET', 'api-singapore.klingai.com/v1/images/generations/kling-sim-1')
        download = ('FETCH', 'https://h1.inkwai.com/bs2/upload-kling-api/sim/kling-sim-1.png')
        self.assertEqual(fake.calls, [('POST', 'api-singapore.klingai.com/v1/images/generations'), poll, download, poll, download])
        self.assertEqual(storage.primary.objects[row.url[len('/api/media/'):]][0], fake.png, 'the Kling master bytes are stored unchanged')


class ExportAdmissionTests(TransactionTestCase):
    def test_api_admits_only_exports_it_created(self):
        from apps.exports import services
        from apps.exports.models import MediaExport
        from apps.library.models import OrganizationIdempotencyKey
        from . import export_admission
        originals = {name: getattr(services, name) for name in ('create_export', 'append_items', 'finalize_export')}
        try:
            export_admission.install('api')
            actor = uuid.uuid4()
            created = services.create_export(actor, now=1000)
            receipt = OrganizationIdempotencyKey.objects.get(pk=export_admission.marker_key(created['id']))
            self.assertEqual(receipt.result, {'id': created['id']})
            # Admitted export passes the guard and reaches normal validation.
            try:
                services.append_items(created['id'], actor, [])
            except services.ExportError as error:
                self.assertNotEqual(error.args[0], 'EXPORT_NOT_FOUND')
            # An export without a receipt (e.g. pre-cutover history) is invisible.
            legacy = MediaExport.objects.create(user_id=actor, status='draft', created_at=1, updated_at=1)
            for call in (lambda: services.append_items(str(legacy.id), actor, []), lambda: services.finalize_export(str(legacy.id), actor)):
                with self.assertRaises(services.ExportError) as hidden:
                    call()
                self.assertEqual(hidden.exception.args[0], 'EXPORT_NOT_FOUND')
            # Another actor cannot use someone else's admission.
            with self.assertRaises(services.ExportError) as other:
                services.finalize_export(created['id'], uuid.uuid4())
            self.assertEqual(other.exception.args[0], 'EXPORT_NOT_FOUND')
        finally:
            for name, function in originals.items():
                setattr(services, name, function)


class UnbilledReadonlyExemptionTests(OneClaimPerPostTests):
    def test_flagged_read_only_transport_bypasses_the_paid_claim(self):
        from apps.generation.providers.transport import HttpTransport
        sent = []
        with self.installed({}, sent):
            class ReadOnly(HttpTransport):
                paid_guard_exempt = True
            ReadOnly(allowed_hosts=['x']).request('POST', 'https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset', body={})
        self.assertEqual(len(sent), 1)
