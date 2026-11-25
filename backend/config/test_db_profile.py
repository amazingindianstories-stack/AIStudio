import configparser
import shlex
from pathlib import Path

from django.test import SimpleTestCase

from config import db_profile

TEMPLATE = Path(__file__).resolve().parents[2] / 'infra/pgbouncer/pgbouncer.ini.template'
# PostgreSQL budget (docs/operations/database-connections.md): a pooler redeploy overlaps the old and new instance, each
# able to open its full cap, and direct connections keep their headroom while it does.
MAX_CONNECTIONS = 45
SUPERUSER_RESERVED = 3
POOLER_INSTANCES_DURING_DEPLOY = 2
POOLER_CAP_PER_INSTANCE = 18
DIRECT_HEADROOM = 6


def template():
    parser = configparser.ConfigParser(interpolation=None, comment_prefixes=(';',), delimiters=('=',))
    parser.read_string(TEMPLATE.read_text())
    return parser


def connect_query_settings(query):
    settings = {}
    for statement in filter(None, (part.strip() for part in query.split(';'))):
        verb, assignment = statement.split(None, 1)
        assert verb.upper() == 'SET', statement
        name, value = (part.strip() for part in assignment.split('=', 1))
        settings[name] = int(value)
    return settings


def template_aliases():
    aliases = {}
    for name, value in template()['databases'].items():
        parameters = dict(token.split('=', 1) for token in shlex.split(value))
        aliases[name] = {'pool_size': int(parameters['pool_size']), 'max_db_connections': int(parameters['max_db_connections']),
                         'settings': connect_query_settings(parameters.get('connect_query', ''))}
    return aliases


class PoolerTemplateTests(SimpleTestCase):
    def test_every_component_has_an_alias_with_the_timeouts_the_application_expects(self):
        aliases = template_aliases()
        for component, (statement, idle) in db_profile.TIMEOUTS_MS.items():
            alias = aliases[db_profile.alias(component)]
            self.assertEqual(alias['settings'], {'statement_timeout': statement, 'idle_in_transaction_session_timeout': idle}, component)
            self.assertEqual(alias['pool_size'], alias['max_db_connections'], 'a pool is capped at its own size')

    def test_the_auth_alias_has_no_timeouts_and_nothing_else_is_unaccounted_for(self):
        aliases = template_aliases()
        self.assertEqual(aliases.pop('veevee_auth')['settings'], {})
        self.assertEqual(set(aliases), {db_profile.alias(component) for component in db_profile.TIMEOUTS_MS})

    def test_server_connections_fit_in_the_postgres_budget_even_while_a_pooler_deploy_overlaps(self):
        cap = sum(alias['max_db_connections'] for alias in template_aliases().values())
        self.assertLessEqual(cap, POOLER_CAP_PER_INSTANCE)
        self.assertLessEqual(SUPERUSER_RESERVED + POOLER_INSTANCES_DURING_DEPLOY * POOLER_CAP_PER_INSTANCE + DIRECT_HEADROOM,
                             MAX_CONNECTIONS)

    def test_the_template_runs_in_transaction_mode_with_no_prepared_statements(self):
        pgbouncer = template()['pgbouncer']
        self.assertEqual(pgbouncer['pool_mode'], 'transaction')
        self.assertEqual(int(pgbouncer['max_prepared_statements']), 0)


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
