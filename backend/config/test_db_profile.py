import re
from pathlib import Path

from django.test import SimpleTestCase

from config import db_profile

TEMPLATE = Path(__file__).resolve().parents[2] / 'infra/pgbouncer/pgbouncer.ini.template'
ALIAS = re.compile(r"^(veevee_\w+) = .*? pool_size=(\d+) max_db_connections=(\d+)"
                   r"(?: connect_query='SET statement_timeout=(\d+); SET idle_in_transaction_session_timeout=(\d+)')?$", re.M)


def template_aliases():
    return {name: tuple(int(value) if value else None for value in rest) for name, *rest in ALIAS.findall(TEMPLATE.read_text())}


class PoolerTemplateTests(SimpleTestCase):
    def test_every_component_has_an_alias_with_the_timeouts_the_application_expects(self):
        aliases = template_aliases()
        for component, (statement, idle) in db_profile.TIMEOUTS_MS.items():
            pool, cap, template_statement, template_idle = aliases[db_profile.alias(component)]
            self.assertEqual((template_statement, template_idle), (statement, idle), component)
            self.assertEqual(pool, cap, 'a pool is capped at its own size')

    def test_the_auth_alias_has_no_timeouts_and_nothing_else_is_unaccounted_for(self):
        aliases = template_aliases()
        self.assertEqual(aliases.pop('veevee_auth')[2:], (None, None))
        self.assertEqual(set(aliases), {db_profile.alias(component) for component in db_profile.TIMEOUTS_MS})

    def test_server_connections_fit_in_the_postgres_budget(self):
        """30 max_connections - 3 superuser reserve = 27 for roles; the pooler may take at most 18 (docs/operations/database-connections.md)."""
        self.assertLessEqual(sum(pool for pool, *_ in template_aliases().values()), 18)

    def test_the_template_runs_in_transaction_mode_with_no_prepared_statements(self):
        text = TEMPLATE.read_text()
        self.assertRegex(text, r'(?m)^pool_mode = transaction$')
        self.assertRegex(text, r'(?m)^max_prepared_statements = 0$')


class ApplyTests(SimpleTestCase):
    def database(self):
        return {'ENGINE': 'django.db.backends.postgresql', 'OPTIONS': {}}

    def test_pooled_connections_disable_cursors_and_prepared_statements_and_send_no_startup_options(self):
        for component in db_profile.TIMEOUTS_MS:
            database = db_profile.apply(self.database(), component, True)
            self.assertTrue(database['DISABLE_SERVER_SIDE_CURSORS'])
            self.assertIsNone(database['OPTIONS']['prepare_threshold'])
            self.assertNotIn('options', database['OPTIONS'], 'PgBouncer would apply one client\'s options to all')
            self.assertEqual(database['OPTIONS']['application_name'], f'veevee-{component}')
            self.assertEqual(database['CONN_MAX_AGE'], db_profile.POOLED_CONN_MAX_AGE)

    def test_direct_connections_carry_their_own_timeouts_and_short_request_idle_time(self):
        api = db_profile.apply(self.database(), 'api', False)
        self.assertEqual(api['OPTIONS']['options'], '-c statement_timeout=30000 -c idle_in_transaction_session_timeout=30000')
        self.assertEqual(api['CONN_MAX_AGE'], 10)
        self.assertNotIn('DISABLE_SERVER_SIDE_CURSORS', api)
        self.assertNotIn('prepare_threshold', api['OPTIONS'])
        generation = db_profile.apply(self.database(), 'generation', False)
        self.assertEqual(generation['OPTIONS']['options'], '-c statement_timeout=60000 -c idle_in_transaction_session_timeout=60000')
        self.assertEqual(generation['CONN_MAX_AGE'], db_profile.DIRECT_DEFAULT_CONN_MAX_AGE)

    def test_a_process_without_a_component_is_untouched_apart_from_the_connection_age(self):
        """Management commands, tests and local development."""
        direct = db_profile.apply(self.database(), None, False)
        self.assertEqual(direct['OPTIONS'], {})
        pooled = db_profile.apply(self.database(), None, True)
        self.assertNotIn('application_name', pooled['OPTIONS'])

    def test_an_explicit_option_is_not_overridden(self):
        database = {'OPTIONS': {'application_name': 'custom', 'options': '-c statement_timeout=5'}}
        db_profile.apply(database, 'api', False)
        self.assertEqual(database['OPTIONS'], {'application_name': 'custom', 'options': '-c statement_timeout=5'})
