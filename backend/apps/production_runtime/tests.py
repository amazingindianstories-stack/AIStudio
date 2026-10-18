"""Paid guard: admission rules and one-claim-per-POST behaviour (no real DB schema needed)."""
import contextlib
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
    def installed(self, ledger, sent):
        from apps.generation.services import enqueue, executor, upscale_submission
        from apps.generation.providers.transport import HttpTransport
        originals = (enqueue.persist, executor.execute_admitted, HttpTransport.request, upscale_submission.submit_claimed_upscale)
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
        executor.execute_admitted = fake_execute
        enqueue._goal4_paid_guard_installed = False
        try:
            with patch('django.db.connection.cursor', lambda: FakeCursor(ledger)), \
                 patch('django.db.connection.get_autocommit', lambda: True):
                paid_guard.install_paid_guard(UNLIMITED)
                yield executor
        finally:
            enqueue.persist, executor.execute_admitted, HttpTransport.request, upscale_submission.submit_claimed_upscale = originals
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


class NamespacingTests(TransactionTestCase):
    def test_private_naming_namespace_is_seeded_from_canonical_counter(self):
        from types import SimpleNamespace as Module
        from apps.library.models import NamingCounter
        from apps.library.services import naming
        from . import namespacing
        NamingCounter.objects.create(namespace='project:abc', next_sequence=42, updated_at=1)
        module = Module(allocate_next_sequence=naming.allocate_next_sequence, now_ms=lambda: 5)
        namespacing.install_naming(module, 'private-ns:')
        self.assertEqual(module.allocate_next_sequence('project:abc'), 42)
        self.assertEqual(module.allocate_next_sequence('project:abc'), 43)
        self.assertEqual(NamingCounter.objects.get(namespace='project:abc').next_sequence, 42)  # canonical untouched
        self.assertEqual(NamingCounter.objects.get(namespace='private-ns:project:abc').next_sequence, 44)
        self.assertEqual(module.allocate_next_sequence('fresh'), 1)

    def test_lease_keys_are_prefixed_and_validated(self):
        from types import SimpleNamespace as Module
        from . import namespacing
        seen = []
        module = Module(**{name: (lambda key, *a, _n=name, **k: seen.append((_n, key))) for name in ('claim', 'read', 'release', 'delete_expired')})
        namespacing.install_leases(module, 'lease:private:')
        module.claim('lease:generation:1', 'owner')
        module.read('lease:depth')
        self.assertEqual(seen, [('claim', 'lease:private:generation:1'), ('read', 'lease:private:depth')])
        with self.assertRaises(ValueError):
            module.release('not-a-lease', 'owner')

    def test_pricing_reads_never_write(self):
        from apps.admin_dashboard import queries
        from apps.admin_dashboard.models import Pricing
        from . import namespacing
        original = queries.price_rows
        try:
            namespacing.install_readonly_pricing('generation')
            self.assertEqual(queries.price_rows(), [])
            self.assertEqual(Pricing.objects.count(), 0)
            namespacing.install_readonly_pricing('api')
            self.assertEqual(len(queries.price_rows()), len(queries.DEFAULT_PRICING))
            self.assertEqual(Pricing.objects.count(), 0)
        finally:
            queries.price_rows = original


class UnbilledReadonlyExemptionTests(OneClaimPerPostTests):
    def test_flagged_read_only_transport_bypasses_the_paid_claim(self):
        from apps.generation.providers.transport import HttpTransport
        sent = []
        with self.installed({}, sent):
            class ReadOnly(HttpTransport):
                paid_guard_exempt = True
            ReadOnly(allowed_hosts=['x']).request('POST', 'https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset', body={})
        self.assertEqual(len(sent), 1)
