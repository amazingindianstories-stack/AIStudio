"""Rehearse populated-database baseline adoption on disposable PG16 only.

This is qualification code, not a production baselining command. Catalogs and
application rows must agree before/after; unknown history blocks adoption.
"""
import json
import os
from pathlib import Path
import sys
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
from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test.utils import override_settings


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
            table = model._meta.db_table
            cursor.execute(f'SELECT to_jsonb(t)::text FROM {connection.ops.quote_name(table)} t ORDER BY to_jsonb(t)::text')
            rows[table] = cursor.fetchall()
    assert len(rows) == 21
    return rows


def reject_ddl(execute, sql, params, many, context):
    assert sql.lstrip().split()[0].upper() not in {'CREATE', 'ALTER', 'DROP', 'TRUNCATE'}, 'Adoption attempted DDL'
    return execute(sql, params, many, context)


before_catalog = catalog()
assert before_catalog == payload['expected_catalog'], 'Catalog mismatch before adoption'
before_rows = application_rows()
assert sum(map(len, before_rows.values())) > 0, 'Populated fixture required'
old_executor = MigrationExecutor(connection)
old_targets = old_executor.loader.graph.leaf_nodes()
old_keys = set(old_executor.loader.disk_migrations)
assert not MigrationRecorder(connection).applied_migrations(), 'Expected empty initial recorder'
with connection.execute_wrapper(reject_ddl):
    old_executor.migrate(old_targets)
old_history = MigrationRecorder(connection).applied_migrations()
assert set(old_history) == old_keys
assert catalog() == before_catalog and application_rows() == before_rows

modules = {path.name: f'baseline_candidate.{path.name}' for path in Path('/app/baseline_candidate').iterdir() if path.is_dir() and (path / '__init__.py').exists()}
with override_settings(MIGRATION_MODULES=modules):
    executor = MigrationExecutor(connection)
    targets = executor.loader.graph.leaf_nodes()
    candidate_keys = set(executor.loader.disk_migrations)
    assert len(candidate_keys) == 22 and not candidate_keys & old_keys

    def preflight():
        if catalog() != payload['expected_catalog']:
            raise ValueError('Catalog mismatch')
        if set(MigrationRecorder(connection).applied_migrations()) != old_keys:
            raise ValueError('Unexpected migration history')

    for case in ('missing_index', 'unknown_history'):
        with transaction.atomic():
            if case == 'missing_index':
                with connection.cursor() as cursor:
                    cursor.execute('DROP INDEX generations_created_at_idx')
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
    with connection.execute_wrapper(reject_ddl):
        executor.migrate(targets, fake=True)
    connection.close()
    assert not MigrationExecutor(connection).migration_plan(targets)
    assert set(MigrationRecorder(connection).applied_migrations()) == old_keys | candidate_keys
    assert catalog() == before_catalog and application_rows() == before_rows
    # Repeating the candidate migration command has no pending work.
    history = MigrationRecorder(connection).applied_migrations()
    with connection.execute_wrapper(reject_ddl):
        MigrationExecutor(connection).migrate(targets, fake=True)
    assert MigrationRecorder(connection).applied_migrations() == history

# Selecting the previous graph also remains a no-op; no records were deleted.
assert not MigrationExecutor(connection).migration_plan(old_targets)
print(json.dumps({'transitional_history_records': len(old_keys), 'candidate_history_records': len(candidate_keys),
                  'catalog_unchanged': catalog() == before_catalog, 'application_tables_unchanged': len(before_rows),
                  'application_rows_preserved': sum(map(len, before_rows.values())), 'ddl_rejected_during_adoption': True,
                  'negative_preflights': ['missing_index', 'unknown_history'], 'connection_reopened': True,
                  'repeated_adoption_noop': True, 'previous_graph_no_pending_migrations': True}))
