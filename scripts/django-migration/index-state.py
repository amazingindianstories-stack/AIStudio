from frozen_oracle import run as oracle_run, check_output as oracle_output
"""Compare all declared indexes in runtime and disk state; no DDL applied."""
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
from django.db import connection
from django.db.migrations.loader import MigrationLoader


def normalize(predicate, table):
    tokens = re.findall(r'"[^"]*"|\'(?:\'\'|[^\'])*\'|[A-Za-z_][A-Za-z_0-9]*|[^\s]', (predicate or '').replace(f'"{table}".', ''))
    tokens = [token[1:-1] if token.startswith('"') else token for token in tokens]
    while tokens and tokens[0] == '(' and tokens[-1] == ')':
        depth = 0
        for position, token in enumerate(tokens):
            depth += (token == '(') - (token == ')')
            if depth == 0:
                break
        if position != len(tokens) - 1:
            break
        tokens = tokens[1:-1]
    return tokens


def compiled(index, model, editor):
    ddl = str(index.create_sql(model, editor))
    match = re.fullmatch(r'CREATE (UNIQUE )?INDEX "[^"]+" ON "([^"]+)"(?: USING btree)? \((.*?)\)(?: WHERE (.*))?', ddl)
    assert match, (index.name, 'Unsupported index SQL')
    columns = []
    for part in match[3].split(','):
        column = re.fullmatch(r'\s*"([^"\n]+)"(?: (ASC|DESC))?(?: NULLS (FIRST|LAST))?\s*', part)
        assert column, (index.name, 'Unsupported expression')
        order = (column[2] or 'ASC').lower()
        columns.append({'name': column[1], 'order': order, 'nulls': (column[3] or ('FIRST' if order == 'desc' else 'LAST')).lower()})
    assert match[2] == model._meta.db_table
    return {'name': index.name, 'unique': bool(match[1]), 'columns': columns, 'predicate': normalize(match[4], model._meta.db_table)}


def main():
    expected = json.loads(oracle_output(['node', 'scripts/django-migration/declared-indexes.mjs'], text=True))
    for table, indexes in expected.items():
        for index in indexes:
            index['predicate'] = normalize(index['predicate'], table)
    for registry in [apps, MigrationLoader(None).project_state().apps]:
        actual = {}
        with connection.schema_editor(collect_sql=True, atomic=False) as editor:
            for model in registry.get_models():
                for field in model._meta.local_fields:
                    if field.is_relation and field.db_constraint:
                        assert not field.db_index, (model._meta.db_table, field.column, 'Implicit FK index is absent from current schema declarations')
                actual[model._meta.db_table] = [compiled(index, model, editor) for index in model._meta.indexes]
        assert set(actual) == set(expected), 'Table inventory differs'
        for table in expected:
            assert sorted(actual[table], key=lambda i: i['name']) == sorted(expected[table], key=lambda i: i['name']), (table, actual[table], expected[table])
    print(json.dumps({'tables_matched': len(expected), 'declared_indexes_matched': sum(map(len, expected.values())), 'runtime_and_disk_state': True, 'index_ddl_applied': False}))


if __name__ == '__main__':
    main()
