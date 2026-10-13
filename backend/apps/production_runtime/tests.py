"""Paid guard: admission rules and one-claim-per-POST behaviour (no real DB schema needed)."""
import contextlib
import uuid
from types import SimpleNamespace
from unittest.mock import patch
from django.test import SimpleTestCase, TransactionTestCase
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

    def test_unauthenticated_and_unsupported_jobs_are_rejected(self):
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='video', model='Seedance 2.5', user_id=None), UNLIMITED)
        with self.assertRaises(ValueError):
            paid_guard.quote_for(contract(kind='video', model='Kling 3.0'), UNLIMITED)


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
        from apps.generation.services import enqueue, executor
        from apps.generation.providers.transport import HttpTransport
        originals = (enqueue.persist, executor.execute_admitted, HttpTransport.request)
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
            enqueue.persist, executor.execute_admitted, HttpTransport.request = originals
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
                unbilled_readonly = True
            ReadOnly(allowed_hosts=['x']).request('POST', 'https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset', body={})
        self.assertEqual(len(sent), 1)
