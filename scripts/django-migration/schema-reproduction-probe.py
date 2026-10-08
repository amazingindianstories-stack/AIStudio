"""Expose full physical reproduction gaps without changing schema authority.

Build both fixtures in the same transactionally rolled-back scratch namespace.
Django fixture uses migration-state model declarations, not current runtime code.
This diagnostic is deliberately not an equivalence approval or production tool.
"""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', nargs='?')
parser.add_argument('--require-index-equivalent', action='store_true', help='Require exact physical index catalog equivalence only')
parser.add_argument('--require-equivalent', action='store_true', help='Fail if any physical catalog category differs')
args = parser.parse_args()
url = urlsplit(os.environ.get('DATABASE_URL', ''))
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test' or url.hostname != '127.0.0.1' or url.path != '/veevee_django_migration':
    raise SystemExit('Explicit disposable loopback qualification target required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.db import connection, transaction
from django.db.migrations.loader import MigrationLoader

spec = importlib.util.spec_from_file_location('schema_catalog', Path(__file__).with_name('schema-catalog.py'))
catalog = importlib.util.module_from_spec(spec)
spec.loader.exec_module(catalog)
namespace = 'qualification_schema_reproduction'


def capture():
    data = {}
    with connection.cursor() as cursor:
        for category, query in catalog.QUERIES.items():
            # Scope the same catalog queries to the disposable scratch schema.
            query = query.replace("'public'", "'" + namespace + "'")
            cursor.execute(query)
            data[category] = [dict(zip([column.name for column in cursor.description], row)) for row in cursor.fetchall()]
    return data


with tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR'), prefix='schema-reproduction-') as output:
    generated = subprocess.run(['node', 'node_modules/drizzle-kit/bin.cjs', 'generate', '--dialect=postgresql', '--schema=./src/lib/schema.js', f'--out={output}'], capture_output=True, text=True, check=True)
    files = list(Path(output).glob('*.sql'))
    assert len(files) == 1, 'Expected one fresh schema migration'
    declared_sql = files[0].read_text().replace('"public".', '"' + namespace + '".')
statements = json.loads(subprocess.check_output(['node', '--import', 'tsx', 'scripts/django-migration/invariant-statements.mjs'], text=True))
checks = json.loads(subprocess.check_output(['node', 'scripts/django-migration/declared-checks.mjs'], text=True))
results = {}
for version in ['current', 'django']:
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT count(*) FROM pg_namespace WHERE nspname=%s', [namespace])
            assert cursor.fetchone()[0] == 0, 'Scratch namespace already exists'
            cursor.execute(f'CREATE SCHEMA "{namespace}"')
            cursor.execute(f'SET LOCAL search_path TO "{namespace}"')
        if version == 'current':
            with connection.cursor() as cursor:
                cursor.execute(declared_sql)
                for domain in ['hierarchy', 'naming']:
                    for statement in statements[domain]:
                        cursor.execute(statement)
                color = next(check for check in checks if check['name'] == 'folders_color_check')
                cursor.execute(f'ALTER TABLE folders ADD CONSTRAINT folders_color_check CHECK ({color["sql"]})')
        else:
            state = MigrationLoader(None).project_state()
            # Materialize unmanaged declarations only in this diagnostic fixture.
            # Normal migration files and production ownership remain unmanaged.
            for model in state.models.values():
                model.options['managed'] = True
            with connection.schema_editor(atomic=False) as editor:
                for model in state.apps.get_models():
                    editor.create_model(model)
        results[version] = capture()
        transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute('SELECT count(*) FROM pg_namespace WHERE nspname=%s', [namespace])
    assert cursor.fetchone()[0] == 0, 'Scratch schema was not rolled back'
differences = catalog.compare(results['current'], results['django'])
report = {'equivalent': not differences, 'different_categories': differences, 'scratch_schema_rolled_back': True,
          'django_fixture_source': 'disk migration model state; schema_editor materialization, not production migrations',
          'category_counts': {version: {category: len(rows) for category, rows in data.items()} for version, data in results.items()},
          'differences': {category: {'current_only': [row for row in results['current'][category] if row not in results['django'][category]], 'django_only': [row for row in results['django'][category] if row not in results['current'][category]]} for category in differences}}
if args.output:
    Path(args.output).write_text(json.dumps(report, indent=2, default=str) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'differences'}))

if args.require_equivalent and differences:
    raise SystemExit(1)

if args.require_index_equivalent and 'indexes' in differences:
    raise SystemExit(1)
