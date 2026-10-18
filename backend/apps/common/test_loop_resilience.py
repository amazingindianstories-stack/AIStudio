"""The worker and scheduler loops survive a database error in the loop body and carry on with the next iteration."""
from threading import Event
from unittest.mock import MagicMock, patch

from django.db import InterfaceError, OperationalError
from django.test import SimpleTestCase

from apps.common import resilience
from apps.exports import worker as export_worker
from apps.generation import worker as generation_worker
from apps.workers import scheduler


class LoopResilienceTests(SimpleTestCase):
    def setUp(self):
        patcher = patch.object(resilience, 'BACKOFF_BASE_S', 0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def survives(self, module, name, run, error=OperationalError('server closed the connection unexpectedly'), **kwargs):
        """`name` raises `error` on the first iteration and stops the loop on the second."""
        stop, calls = Event(), []

        def body(*args, **kw):
            calls.append(1)
            if len(calls) == 1:
                raise error
            stop.set()
            return {}
        with patch.object(module, name, body), patch.object(resilience, 'connections') as connections:
            run(stop=stop, **kwargs)
        self.assertEqual(len(calls), 2, 'the loop went on after the failed iteration')
        return connections

    def test_generation_worker_survives_a_database_error_and_reconnects(self):
        connections = self.survives(generation_worker, 'run_once', generation_worker.run_worker, interval=.1)
        connections.close_all.assert_called_once()

    def test_generation_worker_survives_an_error_in_the_reap_step(self):
        stop, calls = Event(), []

        def reap():
            calls.append(1)
            if len(calls) == 1:
                raise OperationalError('connection lost')
            stop.set()
        with patch.object(generation_worker, 'reap_stale_running_images', reap), patch.object(generation_worker, 'select_due_generations', lambda **_: []):
            generation_worker.run_worker(interval=.1, stop=stop)
        self.assertEqual(len(calls), 2)

    def test_scheduler_survives_a_database_error_in_the_lease_claim(self):
        stop, calls = Event(), []

        def claim(*args, **kwargs):
            calls.append(1)
            if len(calls) == 1:
                raise OperationalError('connection lost')
            stop.set()
            return False
        with patch.object(scheduler.leases, 'claim', claim), patch.object(resilience, 'connections') as connections:
            scheduler.run(stop=stop, interval=.1)
        self.assertGreaterEqual(len(calls), 2)
        connections.close_all.assert_called_once()

    def test_scheduler_survives_an_interface_error(self):
        self.survives(scheduler, 'tick', scheduler.run, InterfaceError('connection already closed'), interval=.1)

    def test_export_worker_survives_a_database_error_and_reconnects(self):
        connections = self.survives(export_worker, 'run_once', export_worker.run_worker, interval=.1)
        connections.close_all.assert_called_once()

    def test_other_errors_only_refresh_old_connections(self):
        with patch.object(resilience, 'connections') as connections, patch.object(resilience, 'close_old_connections') as old:
            resilience.recover(RuntimeError('x'), 1, stop=Event(), logger=MagicMock(), name='t')
        old.assert_called_once()
        connections.close_all.assert_not_called()

    def test_backoff_grows_and_is_bounded(self):
        stop, logger = MagicMock(), MagicMock()
        with patch.object(resilience, 'BACKOFF_BASE_S', .5), patch.object(resilience, 'connections'):
            for failures in (1, 2, 3, 6, 7, 50):
                resilience.recover(OperationalError('x'), failures, stop=stop, logger=logger, name='t')
        self.assertEqual([call.args[0] for call in stop.wait.call_args_list], [.5, 1, 2, 16, 30, 30])

    def test_the_error_log_carries_no_message_text(self):
        logger = MagicMock()
        with patch.object(resilience, 'connections'):
            resilience.recover(OperationalError('password=hunter2 host=db.internal'), 1, stop=Event(), logger=logger, name='t')
        self.assertNotIn('hunter2', str(logger.error.call_args))

    def test_a_requested_stop_still_ends_the_loop_after_a_failure(self):
        stop = Event()

        def body(*args, **kwargs):
            stop.set()
            raise OperationalError('connection lost')
        with patch.object(scheduler, 'tick', body), patch.object(resilience, 'connections'):
            scheduler.run(stop=stop, interval=.1)
        self.assertTrue(stop.is_set())

    def test_exit_requests_are_not_swallowed(self):
        for exit_error in (SystemExit(0), KeyboardInterrupt()):
            with self.subTest(error=type(exit_error).__name__), patch.object(scheduler, 'tick', side_effect=exit_error):
                with self.assertRaises(type(exit_error)):
                    scheduler.run(stop=Event(), interval=.1)
