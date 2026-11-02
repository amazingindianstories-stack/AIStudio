"""Production has no default privileges, so every new table must grant the runtime roles itself."""
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase

TABLES = ['mcp_clients', 'mcp_rate_windows', 'mcp_auth_codes', 'mcp_tokens', 'canvas_board_ai_jobs']
ROLES = ['goal4_green_preview_api', 'goal4_green_preview_worker']
HISTORY_ROLE = 'goal4_green_history_writer'


class NewTableGrantTests(TransactionTestCase):
    def test_runtime_roles_can_use_the_agent_access_and_board_job_tables(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] not in ('mcp_auth', 'canvas')] + [('canvas', '0005_boardactivity'), ('mcp_auth', None)]
        created = []
        try:
            executor.migrate(previous)
            with connection.cursor() as cursor:
                for role in ROLES + [HISTORY_ROLE]:
                    cursor.execute(f'CREATE ROLE {role} NOLOGIN')
                    created.append(role)
            MigrationExecutor(connection).migrate(final)
            with connection.cursor() as cursor:
                for role in ROLES:
                    for table in TABLES:
                        for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE'):
                            cursor.execute('SELECT has_table_privilege(%s, %s, %s)', [role, table, privilege])
                            self.assertTrue(cursor.fetchone()[0], f'{role} lacks {privilege} on {table}')
                for table in TABLES:
                    cursor.execute('SELECT has_table_privilege(%s, %s, %s), has_table_privilege(%s, %s, %s)',
                                   [HISTORY_ROLE, table, 'SELECT', HISTORY_ROLE, table, 'INSERT'])
                    self.assertEqual(cursor.fetchone(), (True, False), table)
        finally:
            MigrationExecutor(connection).migrate(final)
            with connection.cursor() as cursor:
                for role in created:
                    cursor.execute(f'DROP OWNED BY {role}')
                    cursor.execute(f'DROP ROLE {role}')
