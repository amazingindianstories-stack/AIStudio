from frozen_oracle import run as oracle_run, check_output as oracle_output
"""Current defaults vs Django runtime/disk state on transactional temp tables."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from uuid import UUID

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Explicit isolated qualification settings required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.apps import apps
from django.core.management import call_command
from django.db import connection, transaction
from django.db.migrations.loader import MigrationLoader

expected = json.loads(oracle_output(['node', 'scripts/django-migration/declared-defaults.mjs'], text=True))
loader = MigrationLoader(None)
registries = [apps, loader.project_state().apps]
for registry in registries:
    models = {model._meta.db_table: model for model in registry.get_models()}
    assert set(models) == set(expected), 'Table inventory differs'
    for table, columns in expected.items():
        fields = {field.column: field for field in models[table]._meta.local_fields if field.column}
        assert set(fields) == set(columns), (table, 'Column inventory differs')
        for column, default in columns.items():
            assert fields[column].has_db_default() == (default['kind'] != 'none'), (table, column, 'Default presence differs')
quote = connection.ops.quote_name
catalog_checks = 0
insert_checks = 0
uuid_checks = 0
orm_checks = 0
with transaction.atomic():
    for table_number, (original, columns) in enumerate(expected.items()):
        source_catalog = None
        for version in range(3):
            table = f'qualification_defaults_{table_number}_{version}'
            definitions = []
            model = None if version == 0 else next(model for model in registries[version-1].get_models() if model._meta.db_table == original)
            fields = {} if model is None else {field.column: field for field in model._meta.local_fields if field.column}
            with connection.schema_editor(atomic=False) as editor:
                for column, default in columns.items():
                    datatype = default['type'] if version == 0 else fields[column].db_type(connection)
                    definition = f'{quote(column)} {datatype}'
                    if default['kind'] != 'none':
                        if version:
                            sql, params = editor.db_default_sql(fields[column])
                            sql = sql % tuple(editor.quote_value(value) for value in params)
                        elif default['kind'] == 'sql':
                            sql = default['value']
                        elif datatype == 'jsonb':
                            sql = editor.quote_value(json.dumps(default['value'])) + '::jsonb'
                        else:
                            sql = editor.quote_value(default['value'])
                        definition += f' DEFAULT ({sql})'
                    definitions.append(definition)
            with connection.cursor() as cursor:
                cursor.execute(f'CREATE TEMP TABLE {quote(table)} ({", ".join(definitions)}) ON COMMIT DROP')
                cursor.execute('''SELECT a.attname, pg_get_expr(d.adbin, d.adrelid)
                    FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
                    WHERE a.attrelid=%s::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum''', [table])
                catalog = dict(cursor.fetchall())
                if version == 0:
                    source_catalog = catalog
                else:
                    assert catalog == source_catalog, (original, 'Canonical database defaults differ')
                    catalog_checks += len(catalog)
                cursor.execute(f'INSERT INTO {quote(table)} DEFAULT VALUES RETURNING *')
                values = dict(zip([column.name for column in cursor.description], cursor.fetchone()))
                for column, default in columns.items():
                    if default['type'] == 'jsonb' and isinstance(values[column], str):
                        values[column] = json.loads(values[column])
                    if default['kind'] == 'sql':
                        assert UUID(str(values[column])).version == 4, (original, column, 'UUID fallback invalid')
                        uuid_checks += 1
                    else:
                        value = None if default['kind'] == 'none' else default['value']
                        assert values[column] == value, (original, column, 'Omitted-field insert default differs')
                        insert_checks += 1
            if version:
                original_table = model._meta.db_table
                try:
                    model._meta.db_table = table
                    supplied = {fields[column].attname: None for column, default in columns.items() if default['kind'] == 'none'}
                    instance = model.objects.create(**supplied)
                    for column, default in columns.items():
                        if default['kind'] == 'none':
                            continue
                        value = getattr(instance, fields[column].attname)
                        if default['kind'] == 'sql':
                            assert UUID(str(value)).version == 4, (original, column, 'ORM UUID default invalid')
                        else:
                            assert value == default['value'], (original, column, 'ORM omitted-field default differs')
                        orm_checks += 1
                finally:
                    model._meta.db_table = original_table
    transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute("SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'qualification_defaults_%'")
    assert cursor.fetchone()[0] == 0, 'Temporary objects remain'
print(json.dumps({'tables': len(expected), 'declared_defaults': sum(default['kind'] != 'none' for columns in expected.values() for default in columns.values()), 'canonical_column_default_checks': catalog_checks, 'omitted_field_value_checks': insert_checks, 'uuid_fallback_checks': uuid_checks, 'orm_default_checks': orm_checks, 'temporary_ddl_rolled_back': True}))
