"""All declared index DDL on disposable transactional temporary tables only."""
import json
import os
from pathlib import Path
import subprocess
import sys
from uuid import UUID

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Explicit isolated qualification settings required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.apps import apps
from django.db import connection, transaction, IntegrityError
from django.db.migrations.loader import MigrationLoader

expected = json.loads(subprocess.check_output(['node', 'scripts/django-migration/declared-indexes.mjs'], text=True))
checks = 0
behavior_checks = 0
quote = connection.ops.quote_name


def insert(table, columns, values, rejected=False):
    global behavior_checks
    try:
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(f'INSERT INTO {quote(table)} ({", ".join(map(quote, columns))}) VALUES ({", ".join(["%s"] * len(values))})', values)
    except IntegrityError as error:
        assert rejected and error.__cause__.sqlstate == '23505', 'Unexpected insertion failure'
    else:
        assert not rejected, 'Expected unique-index rejection'
    behavior_checks += 1


with transaction.atomic():
    for registry_number, registry in enumerate([apps, MigrationLoader(None).project_state().apps]):
        for model_number, model in enumerate(registry.get_models()):
            declarations = {index['name']: index for index in expected[model._meta.db_table]}
            if not declarations:
                continue
            table = f'qualification_all_indexes_{registry_number}_{model_number}'
            columns = ', '.join(f'{quote(field.column)} {field.db_type(connection)}' for field in model._meta.local_fields if field.column)
            with connection.cursor() as cursor:
                cursor.execute(f'CREATE TEMP TABLE {quote(table)} ({columns}) ON COMMIT DROP')
                with connection.schema_editor(atomic=False) as editor:
                    for index_number, index in enumerate(model._meta.indexes):
                        candidate = index.clone()
                        candidate.name = f'qualification_all_index_{registry_number}_{model_number}_{index_number}'
                        cursor.execute(str(candidate.create_sql(model, editor)).replace(f' ON {quote(model._meta.db_table)} ', f' ON {quote(table)} '))
                        cursor.execute('''SELECT a.attname, (i.indoption[k.ordinality-1]::integer & 1) != 0,
                            (i.indoption[k.ordinality-1]::integer & 2) != 0, i.indisunique, i.indpred IS NOT NULL
                            FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
                            CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ordinality)
                            JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum
                            WHERE c.relnamespace=pg_my_temp_schema() AND c.relname=%s ORDER BY k.ordinality''', [candidate.name])
                        rows = cursor.fetchall()
                        actual = [{'name': name, 'order': 'desc' if descending else 'asc', 'nulls': 'first' if nulls_first else 'last'} for name, descending, nulls_first, unique, partial in rows]
                        declaration = declarations[index.name]
                        assert actual == declaration['columns'], index.name
                        assert all(unique == declaration['unique'] and partial == bool(declaration['predicate']) for _, _, _, unique, partial in rows), index.name
                        checks += 1
            if model._meta.db_table == 'folders':
                fields = ['name_normalized', 'project_id', 'parent_id']
                p1, p2, parent1, parent2 = [UUID(int=n) for n in range(1, 5)]
                insert(table, fields, ['global', None, None])
                insert(table, fields, ['global', None, None], rejected=True)
                insert(table, fields, ['project', p1, None])
                insert(table, fields, ['project', p1, None], rejected=True)
                insert(table, fields, ['project', p2, None])
                insert(table, fields, ['child', p1, parent1])
                insert(table, fields, ['child', p2, parent1], rejected=True)
                insert(table, fields, ['child', p1, parent2])
            elif model._meta.db_table == 'generation_naming':
                fields = ['namespace', 'sequence']
                insert(table, fields, ['scope', 1])
                insert(table, fields, ['scope', 1], rejected=True)
                insert(table, fields, ['scope', 2])
                insert(table, fields, ['other', 1])
    transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute("SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'qualification_all_%'")
    assert cursor.fetchone()[0] == 0, 'Temporary objects remain'
print(json.dumps({'physical_index_checks': checks, 'unique_index_insert_checks': behavior_checks, 'runtime_and_disk_state': True, 'temporary_ddl_rolled_back': True, 'persistent_schema_changed': False}))
