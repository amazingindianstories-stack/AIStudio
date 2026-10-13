from frozen_oracle import run as oracle_run, check_output as oracle_output
"""Compile Django indexes into a transactional temporary PostgreSQL table.

No persistent application DDL. Require the verified disposable qualification
runner (or CI's explicit isolated environment), never shared credentials.
"""
import json
import os
from pathlib import Path
import subprocess
import sys

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Explicit isolated qualification settings required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.apps import apps
from django.db import connection, transaction
from django.db.migrations.loader import MigrationLoader

expected = json.loads(oracle_output(['node', 'scripts/django-migration/declared-generation-indexes.mjs'], text=True))
expected = {index['name']: index for index in expected}
checks = 0
negative_checks = 0
with transaction.atomic():
    for registry_number, registry in enumerate([apps, MigrationLoader(None).project_state().apps]):
        model = registry.get_model('generation', 'Generation')
        table = f'qualification_generation_indexes_{registry_number}'
        columns = ', '.join(f'{connection.ops.quote_name(field.column)} {field.db_type(connection)}' for field in model._meta.local_fields if field.column)
        with connection.cursor() as cursor:
            cursor.execute(f'CREATE TEMP TABLE {connection.ops.quote_name(table)} ({columns}) ON COMMIT DROP')
            with connection.schema_editor(atomic=False) as editor:
                for index_number, index in enumerate(model._meta.indexes):
                    candidate = index.clone()
                    candidate.name = f'qualification_generation_index_{registry_number}_{index_number}'
                    sql = str(candidate.create_sql(model, editor)).replace(' ON "generations" ', f' ON "{table}" ')
                    cursor.execute(sql)
                    cursor.execute('''SELECT a.attname, (i.indoption[k.ordinality-1]::integer & 1) != 0,
                        (i.indoption[k.ordinality-1]::integer & 2) != 0
                        FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
                        CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
                        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                        WHERE c.relnamespace=pg_my_temp_schema() AND c.relname=%s ORDER BY k.ordinality''', [candidate.name])
                    actual = [{'name': name, 'order': 'desc' if descending else 'asc', 'nulls': 'first' if nulls_first else 'last'} for name, descending, nulls_first in cursor.fetchall()]
                    assert actual == expected[index.name]['columns'], (index.name, actual)
                    checks += 1
            # A descending shorthand silently defaults to NULLS FIRST. Prove
            # this previous declaration is rejected by the catalog comparison.
            from apps.common.indexes import PostgreSQLIndex
            wrong = PostgreSQLIndex(fields=['-favorited_at', '-id'], name=f'qualification_generation_wrong_{registry_number}')
            with connection.schema_editor(atomic=False) as editor:
                cursor.execute(str(wrong.create_sql(model, editor)).replace(' ON "generations" ', f' ON "{table}" '))
            cursor.execute('SELECT indoption[0]::integer FROM pg_index WHERE indexrelid=%s::regclass', [wrong.name])
            assert cursor.fetchone()[0] == 3, 'Negative control must have DESC NULLS FIRST'
            assert expected['generations_favorite_keyset_idx']['columns'][0]['nulls'] == 'last'
            negative_checks += 1
    transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute("SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'qualification_generation_%'")
    assert cursor.fetchone()[0] == 0, 'Temporary DDL was not rolled back'
print(json.dumps({'physical_index_order_checks': checks, 'wrong_null_order_controls': negative_checks, 'runtime_and_disk_state': True, 'temporary_ddl_rolled_back': True, 'persistent_schema_changed': False}))
