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
