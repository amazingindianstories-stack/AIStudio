"""Rehearse populated-database baseline adoption on disposable PG16 only.

This is qualification code, not a production baselining command. Catalogs and
application rows must agree before/after; unknown history blocks adoption.
"""
import json
import os
import sys
import uuid
from contextlib import contextmanager
from urllib.parse import urlsplit

url = urlsplit(os.environ.get('DATABASE_URL', ''))
if (os.environ.get('VEEVEE_BASELINE_TEST') != '1'
        or not (url.hostname or '').startswith('veevee-qualification-pg-')
        or url.path != '/veevee_django_migration'):
    raise SystemExit('Verified disposable container adoption target required')
payload = json.load(sys.stdin)
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings.production'
import django
django.setup()
from django.apps import apps
from django.db import connection, transaction, DatabaseError
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder


def catalog():
    result = {}
    with connection.cursor() as cursor:
        for category, query in payload['queries'].items():
            cursor.execute(query)
            result[category] = [dict(zip([column.name for column in cursor.description], row)) for row in cursor.fetchall()]
    return result


def application_rows():
    rows = {}
    with connection.cursor() as cursor:
        for model in apps.get_models():
            if model._meta.db_table == 'upload_sessions':
                continue
            table = model._meta.db_table
            cursor.execute(f'SELECT to_jsonb(t)::text FROM {connection.ops.quote_name(table)} t ORDER BY to_jsonb(t)::text')
            rows[table] = cursor.fetchall()
    assert len(rows) == 21
    return rows


def reject_ddl(execute, sql, params, many, context):
    assert sql.lstrip().split()[0].upper() not in {'CREATE', 'ALTER', 'DROP', 'TRUNCATE'}, 'Adoption attempted DDL'
    return execute(sql, params, many, context)


@contextmanager
def database_ddl_guard():
    # Target verification above confines this superuser-only qualification
    # mechanism to the disposable container database. Never a production tool.
    name = 'qualification_adoption_' + uuid.uuid4().hex
    quote = connection.ops.quote_name
    trigger = quote(name)
    schema = quote(name)
    with connection.cursor() as cursor:
        cursor.execute(f'CREATE SCHEMA {schema}')
        cursor.execute(f'''CREATE FUNCTION {schema}.reject_ddl() RETURNS event_trigger
            LANGUAGE plpgsql AS $$ BEGIN
            IF current_setting('veevee.adoption_ddl_guard', true) = 'on' THEN
                RAISE EXCEPTION 'Disposable adoption database DDL guard'
                    USING ERRCODE = '42501';
            END IF;
            END $$''')
        cursor.execute(f'''CREATE EVENT TRIGGER {trigger} ON ddl_command_start
            EXECUTE FUNCTION {schema}.reject_ddl()''')
    try:
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute("SET LOCAL veevee.adoption_ddl_guard = 'on'")
            yield
    finally:
        # SET LOCAL is undone by commit/rollback before cleanup. The trigger
        # would reject ordinary application DDL while the guard is active.
        with connection.cursor() as cursor:
            cursor.execute(f'DROP EVENT TRIGGER {trigger}')
            cursor.execute(f'DROP SCHEMA {schema} CASCADE')


before_catalog = catalog()
assert before_catalog == payload['expected_catalog'], 'Catalog mismatch before adoption'
fixture_namespace = {}
exec(payload['populated_fixture_source'], fixture_namespace)
fixture_counts = fixture_namespace['populated_adoption_fixture_counts']
assert len(fixture_counts) == 21 and all(fixture_counts.values())
before_rows = application_rows()
assert sum(map(len, before_rows.values())) > 0, 'Populated fixture required'
old_keys = {(item['app'], item['name']) for item in payload['legacy_history']}
assert len(old_keys) == 49
assert not MigrationRecorder(connection).applied_migrations(), 'Expected empty initial recorder'
# Reproduce known prior recorder rows; archived source hashes identify their
# provenance. There is no second executable migration graph in this source tree.
with database_ddl_guard(), connection.execute_wrapper(reject_ddl):
    for app, name in sorted(old_keys):
        MigrationRecorder(connection).record_applied(app, name)
assert set(MigrationRecorder(connection).applied_migrations()) == old_keys
assert catalog() == before_catalog and application_rows() == before_rows
executor = MigrationExecutor(connection)
targets = [node for node in executor.loader.graph.leaf_nodes() if node[0] not in {'generation', 'assets', 'media'}] + [('generation', '0001_baseline_generation'), ('assets', '0003_baseline_portraitasset')]
candidate_keys = set()
for target in targets:
    candidate_keys.update(executor.loader.graph.forwards_plan(target))
assert len(candidate_keys) == 22 and not candidate_keys & old_keys

def preflight():
    if catalog() != payload['expected_catalog']:
        raise ValueError('Catalog mismatch')
    if set(MigrationRecorder(connection).applied_migrations()) != old_keys:
        raise ValueError('Unexpected migration history')

negative_cases = ('missing_index', 'missing_trigger', 'different_default', 'altered_foreign_key', 'unknown_history')
for case in negative_cases:
    with transaction.atomic():
        if case == 'missing_index':
            with connection.cursor() as cursor:
                cursor.execute('DROP INDEX generations_created_at_idx')
        elif case == 'missing_trigger':
            with connection.cursor() as cursor:
                cursor.execute('DROP TRIGGER trg_check_folder_scope ON folders')
        elif case == 'different_default':
            with connection.cursor() as cursor:
                cursor.execute('ALTER TABLE generations ALTER COLUMN location_version SET DEFAULT 2')
        elif case == 'altered_foreign_key':
            with connection.cursor() as cursor:
                cursor.execute('ALTER TABLE folders DROP CONSTRAINT folders_project_id_projects_id_fk')
                cursor.execute('''ALTER TABLE folders ADD CONSTRAINT folders_project_id_projects_id_fk
                    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE''')
        else:
            MigrationRecorder(connection).record_applied('unknown_legacy', '0001_unreviewed')
        try:
            preflight()
        except ValueError:
            pass
        else:
            raise AssertionError(f'{case} was not rejected')
        # No candidate migration can be recorded after a failed preflight.
        assert not candidate_keys & set(MigrationRecorder(connection).applied_migrations())
        transaction.set_rollback(True)

preflight()
assert len(executor.migration_plan(targets)) == 22
ddl_bypass_cases = {
    'comment_prefixed_create': '-- bypass a first-token check\nCREATE TABLE qualification_forbidden (id integer)',
    'do_nested_create': "DO $$ BEGIN EXECUTE 'CREATE TABLE qualification_forbidden (id integer)'; END $$",
}
with database_ddl_guard(), connection.execute_wrapper(reject_ddl):
    for label, statement in ddl_bypass_cases.items():
        try:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute(statement)
        except DatabaseError as error:
            assert error.__cause__.sqlstate == '42501' and 'Disposable adoption database DDL guard' in str(error), label
        else:
            raise AssertionError(f'{label} bypassed the database DDL guard')
    executor.migrate(targets, fake=True)
connection.close()
assert not MigrationExecutor(connection).migration_plan(targets)
assert set(MigrationRecorder(connection).applied_migrations()) == old_keys | candidate_keys
assert catalog() == before_catalog and application_rows() == before_rows
# Repeating the candidate migration command has no pending work.
history = MigrationRecorder(connection).applied_migrations()
with database_ddl_guard(), connection.execute_wrapper(reject_ddl):
    MigrationExecutor(connection).migrate(targets, fake=True)
assert MigrationRecorder(connection).applied_migrations() == history

assert old_keys <= set(MigrationRecorder(connection).applied_migrations())
print(json.dumps({'transitional_history_records': len(old_keys), 'candidate_history_records': len(candidate_keys),
                  'catalog_unchanged': catalog() == before_catalog, 'application_tables_unchanged': len(before_rows),
                  'application_rows_preserved': sum(map(len, before_rows.values())), 'ddl_rejected_during_adoption': True,
                  'database_ddl_guard': 'ddl_command_start event trigger; transaction-local activation',
                  'ddl_bypass_cases_rejected': list(ddl_bypass_cases),
                  'populated_table_counts': fixture_counts,
                  'negative_preflights': list(negative_cases), 'connection_reopened': True,
                  'repeated_adoption_noop': True, 'legacy_history_preserved': True}))
