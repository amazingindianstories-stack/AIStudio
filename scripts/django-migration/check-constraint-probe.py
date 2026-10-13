from frozen_oracle import run as oracle_run, check_output as oracle_output
"""Compare current check SQL and Django checks on rolled-back temporary tables."""
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Explicit isolated qualification settings required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.apps import apps
from django.core.management import call_command
from django.db import connection, transaction, IntegrityError
from django.db.migrations.loader import MigrationLoader

expected = json.loads(oracle_output(['node', 'scripts/django-migration/declared-checks.mjs'], text=True))
assert {(check['table'], check['name']) for check in expected} == {('folders', 'folders_color_check'), ('generation_naming', 'generation_naming_sequence_check')}, 'Review changed check inventory'
registries = [apps, MigrationLoader(None).project_state().apps]
for registry in registries:
    inventory = {(model._meta.db_table, check.name) for model in registry.get_models() for check in model._meta.constraints}
    assert inventory == {(check['table'], check['name']) for check in expected}, 'Check inventory differs'
quote = connection.ops.quote_name
behavior_checks = 0
catalog_checks = 0
with transaction.atomic():
    for check_number, check in enumerate(expected):
        source_definition = None
        for version in range(3):
            table = f'qualification_checks_{check_number}_{version}'
            field = 'color' if check['table'] == 'folders' else 'sequence'
            datatype = 'text' if field == 'color' else 'bigint'
            with connection.cursor() as cursor:
                cursor.execute(f'CREATE TEMP TABLE {quote(table)} ({quote(field)} {datatype}) ON COMMIT DROP')
                if version == 0:
                    cursor.execute(f'ALTER TABLE {quote(table)} ADD CONSTRAINT {quote(check["name"])} CHECK ({check["sql"]})')
                else:
                    model = next(model for model in registries[version-1].get_models() if model._meta.db_table == check['table'])
                    constraint = next(constraint for constraint in model._meta.constraints if constraint.name == check['name'])
                    with connection.schema_editor(atomic=False) as editor:
                        cursor.execute(str(constraint.create_sql(model, editor)).replace(quote(check['table']), quote(table), 1))
                cursor.execute('SELECT pg_get_constraintdef(oid), convalidated, condeferrable, condeferred FROM pg_constraint WHERE conrelid=%s::regclass AND conname=%s', [table, check['name']])
                definition = cursor.fetchone()
                assert definition is not None
                if version == 0:
                    source_definition = definition
                else:
                    assert definition == source_definition, (check['name'], 'Canonical catalog definition differs')
                    catalog_checks += 1
            cases = ([(value, True) for value in [None, 'gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink']] + [(value, False) for value in ['', 'Gray', 'cyan', ' gray ']]) if field == 'color' else [(None, True), (-1, False), (0, False), (1, True), (2, True), (2**63-1, True)]
            for value, accepted in cases:
                try:
                    with transaction.atomic(), connection.cursor() as cursor:
                        cursor.execute(f'INSERT INTO {quote(table)} ({quote(field)}) VALUES (%s)', [value])
                except IntegrityError as error:
                    assert not accepted and error.__cause__.sqlstate == '23514', 'Unexpected constraint error'
                else:
                    assert accepted, 'Invalid value accepted'
                behavior_checks += 1
    transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute("SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'qualification_checks_%'")
    assert cursor.fetchone()[0] == 0, 'Temporary objects remain'
print(json.dumps({'checks_declared': len(expected), 'canonical_catalog_comparisons': catalog_checks, 'constraint_insert_checks': behavior_checks, 'runtime_and_disk_state': True, 'temporary_ddl_rolled_back': True}))
