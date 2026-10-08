"""Compare current Drizzle columns with Django runtime AND disk migration state.

This is declared column/PK coverage, not physical schema equivalence. Declared FK targets and deletion policies are also compared. No SQL is
executed. Defaults, indexes, constraints, triggers and production catalogs belong
to the separate schema equivalence gate.
"""
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def compare(expected, actual):
    errors = []
    for table in sorted(set(expected) | set(actual)):
        if table not in expected or table not in actual:
            errors.append(f'{table}: table missing from ' + ('Drizzle' if table not in expected else 'Django'))
            continue
        left, right = expected[table], actual[table]
        for column in sorted(set(left['columns']) | set(right['columns'])):
            if left['columns'].get(column) != right['columns'].get(column):
                errors.append(f"{table}.{column}: {left['columns'].get(column)} != {right['columns'].get(column)}")
        if left['primary_key'] != right['primary_key']:
            errors.append(f"{table}: primary key {left['primary_key']} != {right['primary_key']}")
        if left.get('foreign_keys', []) != right.get('foreign_keys', []):
            errors.append(f"{table}: foreign keys {left.get('foreign_keys', [])} != {right.get('foreign_keys', [])}")
    return errors


def inventory(registry, connection):
    tables = {}
    for model in registry.get_models():
        columns = {}
        foreign_keys = []
        for field in model._meta.local_fields:
            if field.column is None:
                continue  # CompositePrimaryKey is a virtual field.
            columns[field.column] = {'type': field.db_type(connection), 'nullable': field.null, 'unique': field.unique}
            if field.is_relation and field.db_constraint:
                foreign_keys.append({'columns': [field.column],
                    'target_table': field.remote_field.model._meta.db_table,
                    'target_columns': [field.target_field.column],
                    'on_delete': field.remote_field.on_delete.__name__.lower().replace('_', ' ')})
        pk = model._meta.pk
        primary = [model._meta.get_field(name).column for name in pk.field_names] if hasattr(pk, 'field_names') else [pk.column]
        if model._meta.db_table in tables:
            raise ValueError('Duplicate Django table declaration')
        tables[model._meta.db_table] = {'columns': columns, 'primary_key': primary, 'foreign_keys': sorted(foreign_keys, key=lambda value: value['columns'])}
    return tables


def main():
    # Use only the already-verified isolated runner or explicit CI test settings.
    import os
    if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
        raise SystemExit('Explicit isolated qualification settings required')
    sys.path.insert(0, str(ROOT / 'backend'))
    import django
    django.setup()
    from django.apps import apps
    from django.db import connection
    from django.db.migrations.loader import MigrationLoader
    expected = json.loads(subprocess.check_output(['node', str(ROOT / 'scripts/django-migration/declared-columns.mjs')], cwd=ROOT, text=True))
    runtime = inventory(apps, connection)
    state = inventory(MigrationLoader(None).project_state().apps, connection)
    errors = [f'{label}: {error}' for label, actual in [('runtime', runtime), ('migration state', state)] for error in compare(expected, actual)]
    if errors:
        print('\n'.join(errors), file=sys.stderr)
        raise SystemExit(1)
    print(f"Declared columns/PK/FK match: {len(expected)} tables, {sum(len(table['columns']) for table in expected.values())} columns; runtime and disk migration state. Physical equivalence remains unproven.")


if __name__ == '__main__':
    main()
