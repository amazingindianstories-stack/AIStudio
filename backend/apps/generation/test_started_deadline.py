"""Started work keeps one budget through the provider response and master download."""
import os
from threading import Event
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.media.storage import MemoryAdapter, StorageService
from testsupport.fake_providers import FakeProviders
from . import worker
from .models import Generation
from .serialization import generation_item
from .services import admission, coordinator
from .test_worker_simulation import ENV


class StartedDeadlineTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def execute(self, provider_seconds, download_seconds=0):
        self.cookie()
        clock = [0.0]
        storage = StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch.dict(os.environ, ENV), FakeProviders() as fake:
            response = self.client.post('/api/generate/image', {
                'prompt': 'a quiet courtyard', 'model': 'Seedream 5.0 Pro',
                'aspectRatio': '1:1', 'resolution': '2K'}, content_type='application/json',
                HTTP_IDEMPOTENCY_KEY='deadline-' + uuid4().hex)
            self.assertEqual(response.status_code, 200, response.content)
            identifier = response.json()['id']
            from apps.integrations.transport import HttpTransport
            send, fetch = HttpTransport._send, fake.fetch
            def delayed_send(*args, **kwargs):
                result = send(*args, **kwargs)
                clock[0] += provider_seconds
                return result
            def delayed_fetch(url):
                result = fetch(url)
                clock[0] += download_seconds
                return result
            with patch('time.monotonic', side_effect=lambda: clock[0]), \
                    patch.object(HttpTransport, '_send', delayed_send), \
                    patch('apps.integrations.remote.get_media_fetcher', lambda **kwargs: delayed_fetch):
                outcome = worker.handle_generation(SimpleNamespace(id=identifier, model='Seedream 5.0 Pro'),
                    worker.process_generation, Event())
            row = Generation.objects.get(pk=identifier)
        self.assertEqual(sum(call[1].endswith('/images/generations') for call in fake.calls), 1)
        return outcome, row, storage

    def test_started_call_past_old_deadline_completes_and_stores_master(self):
        outcome, row, storage = self.execute(300, 1000)
        self.assertEqual(outcome, 'succeeded', row.error)
        self.assertTrue(row.url)
        self.assertIn(row.url.removeprefix('/api/media/'), storage.primary.objects)

    def test_hard_deadline_failure_says_our_time_limit_and_keeps_code(self):
        outcome, row, _ = self.execute(1801)
        self.assertEqual(outcome, 'failed')
        card = generation_item(row)
        self.assertIn('Our 30-minute generation time limit', card['error'])
        self.assertIn('queue_execution_deadline', card['error'])
        self.assertNotIn('connection to the provider dropped', card['error'])
        self.assertIsNone(row.url)

    def test_download_shares_provider_deadline(self):
        outcome, row, _ = self.execute(1700, 101)
        self.assertEqual(outcome, 'failed')
        self.assertIsNone(row.url)
        self.assertIn('time limit', generation_item(row)['error'])

    def test_reaper_and_queue_snapshot_keep_work_inside_hard_deadline(self):
        row = Generation.objects.create(kind='image', status='running', model='Seedream 5.0 Pro',
            prompt='fixture', aspect_ratio='1:1', user_id=uuid4(), created_at=1, updated_at=1)
        self.assertEqual(admission.reap_stale_running_images(now=1800001), 0)
        self.assertIsNone(coordinator.claim_generation(row.id, 'other-worker', now=1800001))
        self.assertEqual(admission.snapshot(row, now=1800001, best_of=1)['running'], 1)
        self.assertEqual(admission.reap_stale_running_images(now=1860002), 1)

    def test_shutdown_cancellation_does_not_claim_the_time_limit_was_reached(self):
        from .failure_copy import INTERRUPTED
        from .services.deadline import QueueExecutionCancelledError
        from .services.executor import provider_responses
        stop = Event()
        signal = worker.WorkerCancellation(stop)
        stop.set()
        with self.assertRaises(QueueExecutionCancelledError) as caught:
            signal.check()
        row = Generation(kind='image', model='Seedream 5.0 Pro', status='failed',
            error=str(caught.exception), provider_responses=provider_responses(caught.exception,
                SimpleNamespace(model='Seedream 5.0 Pro', task_id=None)))
        self.assertTrue(generation_item(row)['error'].startswith(INTERRUPTED))
        self.assertNotIn('30-minute', generation_item(row)['error'])

    def test_earlier_deadline_and_shutdown_rows_keep_their_original_copy(self):
        from .failure_copy import INTERRUPTED
        from .services.deadline import QueueExecutionDeadlineError
        record = {'source': 'veevee', 'provider': 'seedream', 'code': 'queue_execution_deadline'}
        for error in ('Generation exceeded the 270-second internal deadline. It may still have been accepted by the provider.',
                      str(QueueExecutionDeadlineError(60000)), INTERRUPTED):
            with self.subTest(error=error):
                row = Generation(kind='image', model='Seedream 5.0 Pro', status='failed', error=error,
                    provider_responses=[record])
                self.assertNotIn('30-minute', generation_item(row)['error'])
