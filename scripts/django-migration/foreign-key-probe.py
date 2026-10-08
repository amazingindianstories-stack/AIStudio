"""Current SQL FK policies on rolled-back scratch tables, including ADD COLUMN."""
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
from config.db.backends.postgresql.schema import CURRENT_FOREIGN_KEYS
expected = json.loads(subprocess.check_output(['node', 'scripts/django-migration/declared-foreign-keys.mjs'], text=True))
assert len(expected) == len(CURRENT_FOREIGN_KEYS)
for item in expected:
    assert len(item['columns']) == len(item['target_columns']) == 1
    assert CURRENT_FOREIGN_KEYS[item['table'], item['columns'][0]] == (item['target_table'], item['target_columns'][0], item['on_delete'].upper(), item['name'])
checks = 0
for registry in [apps, MigrationLoader(None).project_state().apps]:
    for item in expected:
        for mode in ['constraint', 'add_column']:
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute('CREATE SCHEMA qualification_fk_policy')
                cursor.execute('SET LOCAL search_path TO qualification_fk_policy')
                quote = connection.ops.quote_name
                parent, child = item['target_table'], item['table']
                column = item['columns'][0]
                cursor.execute(f'CREATE TABLE {quote(parent)} (id uuid PRIMARY KEY)')
                if child != parent:
                    cursor.execute(f'CREATE TABLE {quote(child)} (id uuid PRIMARY KEY)')
                model = next(model for model in registry.get_models() if model._meta.db_table == child)
                field = next(field for field in model._meta.local_fields if field.column == column)
                with connection.schema_editor(atomic=False) as editor:
                    if mode == 'constraint':
                        cursor.execute(f'ALTER TABLE {quote(child)} ADD COLUMN {quote(column)} uuid')
                        editor.execute(editor._create_fk_sql(model, field, '_fk'))
                    else:
                        # Isolate ADD COLUMN constraint behavior from this fixture's
                        # existing primary key and required-field constraints.
                        added = field.clone()
                        added.set_attributes_from_name(field.name)
                        added.model = model
                        added.remote_field.model = field.remote_field.model
                        added.primary_key = False
                        added._unique = False
                        added.null = True
                        editor.add_field(model, added)
                cursor.execute('SELECT condeferrable, condeferred, confdeltype FROM pg_constraint WHERE conrelid=%s::regclass AND conname=%s', [child, item['name']])
                assert cursor.fetchone() == (False, False, 'r' if item['on_delete'] == 'restrict' else 'c')
                pid, cid = UUID(int=100), UUID(int=200)
                cursor.execute(f'INSERT INTO {quote(parent)} (id) VALUES (%s)', [pid])
                cursor.execute(f'INSERT INTO {quote(child)} (id, {quote(column)}) VALUES (%s, %s)', [cid, pid])
                try:
                    with transaction.atomic():
                        cursor.execute(f'DELETE FROM {quote(parent)} WHERE id=%s', [pid])
                except IntegrityError as error:
                    assert item['on_delete'] == 'restrict' and error.__cause__.sqlstate in ('23503', '23001')
                else:
                    assert item['on_delete'] == 'cascade'
                    cursor.execute(f'SELECT count(*) FROM {quote(child)} WHERE id=%s', [cid])
                    assert cursor.fetchone()[0] == 0
                try:
                    with transaction.atomic():
                        cursor.execute(f'INSERT INTO {quote(child)} (id, {quote(column)}) VALUES (%s,%s)', [UUID(int=300), UUID(int=999)])
                except IntegrityError as error:
                    assert error.__cause__.sqlstate == '23503'
                else:
                    raise AssertionError('Missing parent accepted before commit')
                transaction.set_rollback(True)
                checks += 1
with connection.cursor() as cursor:
    cursor.execute("SELECT count(*) FROM pg_namespace WHERE nspname='qualification_fk_policy'")
    assert cursor.fetchone()[0] == 0
print(json.dumps({'physical_fk_cases': checks, 'metadata_policies': len(expected), 'runtime_and_disk_state': True, 'add_column_and_constraint_paths': True, 'scratch_ddl_rolled_back': True}))
