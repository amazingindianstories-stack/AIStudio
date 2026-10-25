from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

from apps.authentication.models import User
from apps.admin_dashboard.tests import SettingsTests
from apps.integrations.transport import ProviderError
from .models import Generation
from .providers import omni, seedance
from .services import cancellation, coordinator, poller
from .test_provider_adapters import ScriptedTransport, result


class CancellationTests(TransactionTestCase):
    def job(self, **values):
        return Generation.objects.create(**{**dict(kind='video', status='running', prompt='cancel fixture',
            model='Seedance 2.5', aspect_ratio='16:9', user_id=uuid4(), task_id='paid-task',
            created_at=1, updated_at=2, cost_cents=60), **values})

    def run_cancel(self, row, get_status, cancel=None):
        cancel = cancel or Mock()
        deps = poller.Dependencies(mock=lambda: False, get_video=get_status, get_omni=get_status,
            publish=lambda row: None, save_url=lambda *args: {'url': '/api/media/generations/native.mov'})
        with patch.object(cancellation, 'publish_best_effort'):
            current, message = cancellation.cancel_generation(row.id, SimpleNamespace(id=row.user_id, role='user'),
                env={}, adapters={'byteplus': (get_status, cancel), 'omni': (get_status, cancel)},
                advance=lambda item, **kw: poller.advance(item, dependencies=deps, **kw))
        return current, message, cancel

    def test_confirmed_cancel_is_terminal_cost_conservative_and_no_longer_claimable(self):
        row = self.job()
        query = Mock(side_effect=[{'status': 'queued'}, {'status': 'cancelled'}])
        current, message, cancel = self.run_cancel(row, query)
        self.assertEqual((current.status, current.cancellation_state, current.cost_cents, current.cost_basis),
            ('cancelled', 'confirmed', 60, 'cancelled_billing_unconfirmed'))
        self.assertIsNone(message)
        cancel.assert_called_once()
        self.assertIsNone(coordinator.claim_generation(row.id, 'late-worker'))
        self.assertEqual(poller.advance(current)['kind'], 'cancelled')

    def test_finish_before_cancel_preserves_master_and_skips_delete(self):
        query = Mock(return_value={'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'})
        current, message, cancel = self.run_cancel(self.job(), query)
        cancel.assert_not_called()
        self.assertEqual((current.status, current.url), ('succeeded', '/api/media/generations/native.mov'))
        self.assertIn('kept', message)

    def test_failure_before_cancel_keeps_real_failure(self):
        current, _, cancel = self.run_cancel(self.job(), Mock(return_value={'status': 'failed', 'error': 'synthetic'}))
        cancel.assert_not_called()
        self.assertEqual(current.status, 'failed')

    def test_running_refusal_and_provider_refusal_continue_normally(self):
        for get_status, cancel in (
            (Mock(return_value={'status': 'running'}), Mock()),
            (Mock(side_effect=[{'status': 'queued'}, {'status': 'running'}]), Mock(side_effect=ProviderError('started', status=400))),
        ):
            current, message, _ = self.run_cancel(self.job(), get_status, cancel)
            self.assertEqual((current.status, current.cancellation_state), ('running', 'refused'))
            self.assertIsNone(current.worker_lease_id)
            self.assertIn('started', message)

    def test_delete_race_404_never_claims_cancel_or_deletes_local_evidence(self):
        query = Mock(side_effect=[{'status': 'queued'}, ProviderError('gone', status=404)])
        current, _, cancel = self.run_cancel(self.job(), query)
        cancel.assert_called_once()
        self.assertEqual((current.status, current.cancellation_state, current.task_id), ('running', 'requested', 'paid-task'))
        self.assertIsNotNone(current.next_poll_at)
        deps = poller.Dependencies(mock=lambda: False, publish=lambda row: None,
            get_video=Mock(side_effect=ProviderError('gone', status=404)))
        self.assertEqual(poller.advance(current, dependencies=deps)['kind'], 'poll_error')
        current.refresh_from_db()
        self.assertEqual((current.status, current.cancellation_state), ('running', 'requested'))

    def test_permanent_missing_record_after_cancel_settles_failed_at_the_poll_cap_and_is_deletable(self):
        SettingsTests.setUp(self)
        SettingsTests.cookie(self)
        User.objects.filter(pk='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').update(role='admin')
        row = self.job(cancellation_state='uncertain')
        self.assertEqual(self.client.delete('/api/history?id='+str(row.id)).status_code, 409)
        deps = poller.Dependencies(mock=lambda: False, publish=lambda row: None,
            get_video=Mock(side_effect=ProviderError('gone', status=404)))
        Generation.objects.filter(pk=row.id).update(poll_error_count=1000)
        row.refresh_from_db()
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'failed')
        row.refresh_from_db()
        self.assertEqual((row.status, row.error, row.cancellation_state, row.task_id, row.cost_cents),
            ('failed', poller.POLL_ABANDONED, 'uncertain', 'paid-task', 60))
        self.assertEqual(row.provider_responses[-1]['taskId'], 'paid-task')
        self.assertFalse(cancellation.can_cancel(row, {}))
        self.assertEqual(self.client.delete('/api/history?id='+str(row.id)).status_code, 200)

    def test_timeout_uncertain_and_repeated_request_does_not_reissue(self):
        row = self.job()
        cancel = Mock(side_effect=TimeoutError('unknown'))
        current, message, _ = self.run_cancel(row, Mock(return_value={'status': 'queued'}), cancel)
        self.assertEqual(current.cancellation_state, 'uncertain')
        self.assertIn('not confirmed', message)
        self.run_cancel(current, Mock(), cancel)
        self.assertEqual(cancel.call_count, 1)

    def test_no_worker_or_submit_race_and_owner_authorization(self):
        row = self.job()
        with self.assertRaises(cancellation.CancelError) as caught:
            cancellation.cancel_generation(row.id, SimpleNamespace(id=uuid4(), role='user'), env={})
        self.assertEqual(caught.exception.status, 403)
        coordinator.claim_generation(row.id, 'submitting')
        with self.assertRaises(cancellation.CancelError):
            cancellation.cancel_generation(row.id, SimpleNamespace(id=row.user_id, role='user'), env={})
        row.refresh_from_db()
        self.assertEqual(row.status, 'running')

    def test_local_unsubmitted_queue_cancel_excludes_later_submission(self):
        row = self.job(); Generation.objects.filter(pk=row.id).update(task_id=None, status='queued')
        current, _, _ = self.run_cancel(row, Mock())
        self.assertEqual(current.status, 'cancelled')
        self.assertIsNone(coordinator.claim_generation(row.id, 'submit-after-cancel'))

    def test_unsubmitted_omni_cancel_costs_nothing_and_leaves_the_gemini_spend_window(self):
        from .services import admission
        row = self.job(model='Gemini Omni Flash 1.1', status='queued', task_id=None, created_at=1000, updated_at=2000)
        current, message, _ = self.run_cancel(row, Mock())
        self.assertIsNone(message)
        self.assertEqual((current.status, current.cost_cents, current.cost_basis),
            ('cancelled', 0, cancellation.COST_UNSUBMITTED))
        Generation.objects.filter(pk=row.id).update(updated_at=2000)
        snapshot = admission.snapshot(self.job(), now=3000, best_of=2)
        self.assertEqual((snapshot['window_cents'], snapshot['window_rows'], snapshot['oldest_updated_at']), (0, 0, None))

    def test_supported_capabilities_and_vertex_disabled(self):
        row = self.job()
        self.assertTrue(cancellation.can_cancel(row, {}))
        row.provider_status = 'running'
        self.assertFalse(cancellation.can_cancel(row, {}))
        for model in ('Nano Banana Pro', 'Higgsfield Seedance 2.0', 'Seedream 5.0 Pro', 'Magnific Video Topaz'):
            row.model = model
            self.assertFalse(cancellation.can_cancel(row, {}))
        row.model = 'Gemini Omni Flash 1.1'
        self.assertTrue(cancellation.can_cancel(row, {}))
        self.assertFalse(cancellation.can_cancel(row, {'OMNI_USE_VERTEX': '1'}))

    def test_best_of_cancellation_waits_for_all_candidates_and_keeps_a_completed_winner(self):
        for statuses, expected in ((['cancelled', 'cancelled'], 'cancelled'),
                                   (['cancelled', 'running'], 'pending'),
                                   (['cancelled', 'failed'], 'failed'),
                                   (['cancelled', 'succeeded'], 'succeeded')):
            row = self.job(candidate_task_ids=['second-task'])
            query = Mock(side_effect=[{'status': status, 'videoUrl': 'https://fixture.invalid/master.mov'} for status in statuses])
            deps = poller.Dependencies(mock=lambda: False, get_video=query, publish=lambda row: None,
                save_url=lambda *args: {'url': '/api/media/generations/winner.mov'})
            self.assertEqual(poller.advance(row, dependencies=deps)['kind'], expected)

    def test_cancelled_cost_remains_in_gemini_spend_window(self):
        from .services import admission
        row = self.job()
        Generation.objects.filter(pk=row.id).update(model='Gemini Omni Flash 1.1', status='cancelled',
            cost_basis=cancellation.COST_UNCONFIRMED, created_at=1000, updated_at=2000)
        waiting = self.job()
        snapshot = admission.snapshot(waiting, now=3000, best_of=2)
        self.assertEqual((snapshot['window_cents'], snapshot['window_rows']), (60, 1))

    def test_missing_omni_record_during_cancel_stays_uncertain(self):
        row = self.job()
        row.model = 'Gemini Omni Flash 1.1'
        row.cancellation_state = 'requested'
        row.save()
        deps = poller.Dependencies(mock=lambda: False, get_omni=Mock(return_value={
            'status': 'failed', 'providerError': {'httpStatus': 404}, 'error': 'Not found'}))
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'poll_error')
        row.refresh_from_db()
        self.assertEqual(row.status, 'running')

    def test_paid_guard_lets_only_a_requested_cancel_reach_the_real_adapters(self):
        from django.test import override_settings
        from apps.integrations.transport import HttpTransport
        from .test_paid_guard import SEEDANCE_ENDPOINT, UNLIMITED
        interactions = 'https://generativelanguage.googleapis.com/v1beta/interactions/'
        seedance_task = SEEDANCE_ENDPOINT + '/'
        statuses = {seedance_task + 'seedance-task': ['queued', 'cancelled'], interactions + 'omni-task': ['in_progress', 'cancelled']}
        sent = []

        def send(transport, method, url, **kwargs):
            sent.append((method, url))
            return result({'status': statuses[url].pop(0)} if method == 'GET' else {})

        seedance_row = self.job(task_id='seedance-task')
        omni_row = self.job(task_id='omni-task', model='Gemini Omni Flash 1.1')
        held = self.job(task_id='held-task', cancellation_state='requested')
        actor = SimpleNamespace(id=None, role='admin')
        with override_settings(VEEVEE_PAID_GUARD=UNLIMITED), patch.object(HttpTransport, '_send', send), \
                patch.dict('os.environ', {'ARK_API_KEY': 'mock', 'GOOGLE_API_KEY': 'mock', 'MOCK_GENERATION': '0'}):
            for row in (seedance_row, omni_row):
                current, message = cancellation.cancel_generation(row.id, actor, env={})
                self.assertEqual((current.status, current.cancellation_state, message), ('cancelled', 'confirmed', None))
            self.assertIn(('DELETE', seedance_task + 'seedance-task'), sent)
            self.assertIn(('POST', interactions + 'omni-task/cancel'), sent)
            sent.clear()
            for method, url, body in (('DELETE', seedance_task + 'seedance-task', None),
                                      ('POST', interactions + 'omni-task/cancel', None),
                                      ('DELETE', seedance_task + 'unknown-task', None),
                                      ('POST', interactions + 'held-task/cancel', None),
                                      ('DELETE', seedance_task + 'held-task?force=1', None),
                                      ('DELETE', seedance_task + 'held-task/extra', None),
                                      ('POST', seedance_task + 'held-task', None),
                                      ('DELETE', seedance_task + 'held-task', {'status': 'cancelled'}),
                                      ('POST', SEEDANCE_ENDPOINT, {'model': 'seedance', 'output_format': 'mov'}),
                                      ('PUT', seedance_task + 'held-task', None)):
                with self.subTest(method=method, url=url), self.assertRaises(ProviderError) as caught:
                    HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com', 'generativelanguage.googleapis.com']).request(
                        method, url, body=body)
                self.assertEqual(caught.exception.code, 'preview_paid_scope')
            self.assertEqual(sent, [])
            HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com']).request('DELETE', seedance_task + 'held-task')
        self.assertEqual(sent, [('DELETE', seedance_task + 'held-task')])

    def test_expired_seedance_task_fails_with_accurate_copy(self):
        transport = ScriptedTransport(result({'id': 'paid-task', 'status': 'expired'}))
        deps = poller.Dependencies(mock=lambda: False, publish=lambda row: None,
            get_video=lambda task_id, signal: seedance.get_video_task(task_id, env={'ARK_API_KEY': 'mock'},
                transport=transport, signal=signal))
        row = self.job()
        self.assertEqual(poller.advance(row, dependencies=deps)['kind'], 'failed')
        row.refresh_from_db()
        self.assertEqual((row.status, row.error, row.moderation_blocked), ('failed', seedance.EXPIRED_MESSAGE, False))

    def test_provider_http_contracts(self):
        transport = ScriptedTransport(result({}, 204))
        seedance.cancel_video_task('id/quoted', env={'ARK_API_KEY': 'mock'}, transport=transport)
        self.assertEqual(transport.calls[0][0], ('DELETE', 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/id%2Fquoted'))
        transport = ScriptedTransport(result({'status': 'cancelled'}))
        omni.cancel_video_task('id/quoted', env={'GOOGLE_API_KEY': 'mock'}, transport=transport)
        self.assertEqual(transport.calls[0][0], ('POST', 'https://generativelanguage.googleapis.com/v1beta/interactions/id%2Fquoted/cancel'))
        self.assertEqual(omni.map_status('cancelled'), 'cancelled')

    def test_api_auth_cancel_history_filter_realtime_and_delete(self):
        SettingsTests.setUp(self)
        self.assertEqual(self.client.post('/api/generate/cancel', {'id': str(uuid4())}, content_type='application/json').status_code, 401)
        SettingsTests.cookie(self)
        uid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        User.objects.filter(pk=uid).update(role='admin')
        row = self.job()
        response = self.client.post('/api/generate/cancel', {'id': str(row.id)}, content_type='application/json')
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(response.json()['item']['status'], 'cancelled')
        self.assertFalse(response.json()['item']['canCancel'])
        history = self.client.get('/api/history?status=failed').json()['items']
        self.assertIn(str(row.id), [item['id'] for item in history])
        from .updates import read_generation_updates
        self.assertIn(str(row.id), [item['id'] for item in read_generation_updates(0)[0]])
        self.assertEqual(self.client.delete('/api/history?id='+str(row.id)).status_code, 200)

    def test_upgrade_from_previous_supported_state_preserves_job(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        before = [n for n in final if n[0] != 'generation'] + [('generation', '0005_generation_name_owner')]
        try:
            executor.migrate(before)
            old = executor.loader.project_state(before).apps.get_model('generation', 'Generation')
            identifier = uuid4()
            old.objects.create(id=identifier, kind='video', status='running', prompt='upgrade', model='Seedance 2.5',
                aspect_ratio='16:9', task_id='preserved-task', cost_cents=60, created_at=1, updated_at=2)
            MigrationExecutor(connection).migrate(final)
            row = Generation.objects.get(pk=identifier)
            self.assertEqual((row.task_id, row.cost_cents, row.status, row.cancellation_state), ('preserved-task', 60, 'running', None))
        finally:
            MigrationExecutor(connection).migrate(final)
