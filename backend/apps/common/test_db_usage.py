import logging
from unittest.mock import patch

import psycopg
from django.db import connection
from django.test import TestCase

from apps.admin_dashboard import status
from apps.common import db_usage
from apps.workers import scheduler


def usage(used, available=42, **by_application):
    return {'maxConnections': available + 3, 'available': available, 'used': used,
            'ratio': used / available, 'byApplication': by_application or {'veevee-api': used}}


def named_session(name):
    """A second, open session with the given application_name (a SET inside a rolled-back test transaction is not
    reported reliably to pg_stat_activity)."""
    params = {**connection.get_connection_params(), 'application_name': name}
    params.pop('cursor_factory', None)
    return psycopg.connect(**params)


class SnapshotTests(TestCase):
    def test_counts_a_session_under_its_application_name(self):
        with named_session('veevee-test-usage'):
            snapshot = db_usage.snapshot()
        self.assertGreaterEqual(snapshot['byApplication']['veevee-test-usage'], 1)
        self.assertEqual(snapshot['used'], sum(snapshot['byApplication'].values()))

    def test_available_excludes_the_superuser_reserve(self):
        with connection.cursor() as cursor:
            cursor.execute("""SELECT current_setting('max_connections')::int - current_setting('superuser_reserved_connections')::int""")
            expected = cursor.fetchone()[0]
        self.assertLessEqual(db_usage.snapshot()['available'], expected)

    def test_an_empty_application_name_is_listed_not_dropped(self):
        with named_session(''):
            self.assertIn(db_usage.UNNAMED, db_usage.snapshot()['byApplication'])

    def test_a_role_without_pg_read_all_stats_still_counts_other_roles_sessions(self):
        with connection.cursor() as cursor:
            cursor.execute('CREATE ROLE veevee_test_usage_observer NOLOGIN')
            cursor.execute('SET LOCAL ROLE veevee_test_usage_observer')
        with named_session('veevee-test-other-role'):
            snapshot = db_usage.snapshot()
        self.assertGreaterEqual(snapshot['byApplication'].get('veevee-test-other-role', 0), 1)

    def test_ratio_is_full_when_nothing_is_available(self):
        with patch.object(connection, 'cursor') as cursor:
            handle = cursor.return_value.__enter__.return_value
            handle.fetchone.return_value = (30, 30, 0)
            handle.fetchall.return_value = [('veevee-api', 3)]
            self.assertEqual(db_usage.snapshot()['ratio'], 1.0)


class ThresholdTests(TestCase):
    def test_warns_from_eighty_percent(self):
        self.assertFalse(db_usage.is_high(usage(33, 42)))
        self.assertTrue(db_usage.is_high(usage(34, 42)))
        self.assertTrue(db_usage.is_high(usage(42, 42)))

    def test_summary_names_each_application(self):
        text = db_usage.summary(usage(5, **{'veevee-api': 3, 'veevee-generation': 2}))
        self.assertEqual(text, '5/42 connections (12%): veevee-api=3, veevee-generation=2')


class SurfaceTests(TestCase):
    def test_scheduler_logs_a_warning_only_when_high(self):
        with patch.object(db_usage, 'snapshot', return_value=usage(36)):
            with self.assertLogs('veevee.maintenance', logging.WARNING) as logs:
                result = scheduler.check_db_connections()
        self.assertIn('36/42', logs.output[0])
        self.assertEqual(result, {'ok': True, 'used': 36, 'available': 42})
        with patch.object(db_usage, 'snapshot', return_value=usage(5)):
            with self.assertNoLogs('veevee.maintenance', logging.WARNING):
                scheduler.check_db_connections()

    def test_scheduler_runs_it_every_minute(self):
        self.assertIs(scheduler.default_handlers()['db_connections'], scheduler.check_db_connections)

    def test_status_check_is_listed_and_flips_to_error(self):
        self.assertIn(('db-connections', 'Database Connections', status.db_connections), status.CHECKS)
        with patch.object(db_usage, 'snapshot', return_value=usage(5)):
            self.assertEqual(status.db_connections()['status'], 'ok')
        with patch.object(db_usage, 'snapshot', return_value=usage(36)):
            self.assertEqual(status.db_connections()['status'], 'error')
