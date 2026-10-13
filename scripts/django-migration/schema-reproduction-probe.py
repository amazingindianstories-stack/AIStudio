from frozen_oracle import check_output as oracle_output, schema_sql
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
import sqlparse
from urllib.parse import urlsplit

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('output', nargs='?')
parser.add_argument('--migration-executor', action='store_true', help='Create Django fixture solely through the active migration graph')
parser.add_argument('--require-index-equivalent', action='store_true', help='Require exact physical index catalog equivalence only')
parser.add_argument('--require-invariant-equivalent', action='store_true', help='Require exact function/trigger catalogs and invariant behavior')
parser.add_argument('--require-constraint-equivalent', action='store_true', help='Require exact constraint catalog equivalence')
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
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from apps.library.baseline_sql.invariants_v1 import STATEMENTS as DJANGO_INVARIANTS
from apps.library.baseline_sql.foreign_key_aliases_v1 import STATEMENTS as DJANGO_FK_ALIASES

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


declared_sql = schema_sql().replace('"public".', '"' + namespace + '".')
statements = json.loads(oracle_output(['node', '--import', 'tsx', 'scripts/django-migration/invariant-statements.mjs'], text=True))
source_invariants = tuple(statement for domain in ['hierarchy', 'naming'] for statement in statements[domain] if statement.startswith(('CREATE OR REPLACE FUNCTION', 'DROP TRIGGER', 'CREATE TRIGGER', 'CREATE CONSTRAINT TRIGGER')))
assert DJANGO_INVARIANTS == source_invariants, 'Frozen Django invariant SQL differs from frozen historical source; review required'
source_aliases = tuple(statement for domain in ['hierarchy', 'naming'] for statement in statements[domain] if statement.startswith('DO $$ BEGIN') and 'FOREIGN KEY' in statement)
assert len(source_aliases) == 5 and DJANGO_FK_ALIASES == source_aliases, 'Frozen Django FK aliases differ from frozen historical source; review required'
checks = json.loads(oracle_output(['node', 'scripts/django-migration/declared-checks.mjs'], text=True))
results = {}
for version in ['current', 'django']:
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute('SELECT count(*) FROM pg_namespace WHERE nspname=%s', [namespace])
            assert cursor.fetchone()[0] == 0, 'Scratch namespace already exists'
            cursor.execute(f'CREATE SCHEMA "{namespace}"')
            cursor.execute(f'SET LOCAL search_path TO "{namespace}"')
        if args.migration_executor:
            # Include Django bookkeeping in both catalogs, without filtering it.
            MigrationRecorder(connection).ensure_schema()
        if version == 'current':
            with connection.cursor() as cursor:
                cursor.execute(declared_sql)
                for domain in ['hierarchy', 'naming']:
                    for statement in statements[domain]:
                        cursor.execute(statement)
                color = next(check for check in checks if check['name'] == 'folders_color_check')
                cursor.execute(f'ALTER TABLE folders ADD CONSTRAINT folders_color_check CHECK ({color["sql"]})')
                # Frozen historical evidence remains unchanged. Apply the one
                # reviewed additive contract to the comparison fixture only.
                cursor.execute("ALTER TABLE generations ADD COLUMN submission_input jsonb NULL;\nALTER TABLE assets ADD COLUMN created_by_id uuid NULL;\nALTER TABLE portrait_assets ADD COLUMN created_by_id uuid NULL;\nCREATE TABLE upload_sessions (\nid uuid NOT NULL PRIMARY KEY, actor_id uuid NOT NULL, key text NOT NULL UNIQUE,\npurpose varchar(64) NOT NULL, content_type varchar(100) NOT NULL, byte_size bigint NOT NULL,\nfilename varchar(255) NOT NULL, sha256 varchar(64) NOT NULL, request_key varchar(128) NOT NULL,\nsession_uri text NOT NULL, state varchar(16) NOT NULL, created_at timestamptz NOT NULL,\nexpires_at timestamptz NOT NULL, finalized_at timestamptz NULL,\nCONSTRAINT upload_positive_bytes CHECK (byte_size > 0));\nCREATE INDEX upload_sessions_key_8b9e8a1c_like ON upload_sessions (key text_pattern_ops);\nCREATE INDEX upload_actor_state_expiry_idx ON upload_sessions (actor_id, state, expires_at);\nCREATE UNIQUE INDEX upload_actor_request_unique ON upload_sessions (actor_id, request_key) WHERE NOT (request_key = '');")
        elif args.migration_executor:
            executor = MigrationExecutor(connection)
            targets = executor.loader.graph.leaf_nodes()
            plan = executor.migration_plan(targets)
            assert len(plan) == 25
            assert any(m.app_label == 'generation' and m.name == '0002_generation_submission_input' and not backward for m, backward in plan)
            executor.migrate(targets)
            assert not MigrationExecutor(connection).migration_plan(targets), 'Active graph is not fully recorded'
        else:
            state = MigrationLoader(None).project_state()
            assert all(model.options.get('managed', True) for model in state.models.values())
            with connection.schema_editor(atomic=False) as editor:
                for model in state.apps.get_models():
                    editor.create_model(model)
            with connection.cursor() as cursor:
                for _ in range(2):
                    for statement in (*DJANGO_FK_ALIASES, *DJANGO_INVARIANTS):
                        cursor.execute(statement)
        results[version] = capture()
        # Replay the existing fixture's explicit transaction boundaries as
        # constraint flushes inside our outer rollback-only transaction.
        explicit_transaction = False
        behavior = Path('scripts/django-migration/invariant-behavior.sql').read_text()
        behavior = behavior.replace('WHEN foreign_key_violation THEN', 'WHEN foreign_key_violation OR restrict_violation THEN')
        with connection.cursor() as cursor:
            for statement in sqlparse.split(behavior):
                normalized = sqlparse.format(statement, strip_comments=True).strip().upper()
                if normalized == 'BEGIN;':
                    cursor.execute('SET CONSTRAINTS ALL DEFERRED')
                    explicit_transaction = True
                elif normalized == 'COMMIT;':
                    cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
                    explicit_transaction = False
                else:
                    cursor.execute(statement)
                    if not explicit_transaction:
                        cursor.execute('SET CONSTRAINTS ALL IMMEDIATE')
            assert not explicit_transaction

        transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute('SELECT count(*) FROM pg_namespace WHERE nspname=%s', [namespace])
    assert cursor.fetchone()[0] == 0, 'Scratch schema was not rolled back'
differences = catalog.compare(results['current'], results['django'])
report = {'reference_source': 'frozen historical Node schema and additive invariant SQL plus explicit reviewed Goal2 additive SQL contracts', 'live_node_execution': False, 'equivalent': not differences, 'different_categories': differences, 'scratch_schema_rolled_back': True, 'invariant_behavior_both_fixtures': True,
          'django_fixture_source': ('active managed Django migration executor; production adoption pending' if args.migration_executor else 'disk migration model state plus frozen Django invariant and FK alias SQL; diagnostic schema-editor path'),
          'category_counts': {version: {category: len(rows) for category, rows in data.items()} for version, data in results.items()},
          'differences': {category: {'current_only': [row for row in results['current'][category] if row not in results['django'][category]], 'django_only': [row for row in results['django'][category] if row not in results['current'][category]]} for category in differences}}
if args.output:
    Path(args.output).write_text(json.dumps(report, indent=2, default=str) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'differences'}))

if args.require_equivalent and differences:
    raise SystemExit(1)

if args.require_index_equivalent and 'indexes' in differences:
    raise SystemExit(1)

if args.require_invariant_equivalent and any(category in differences for category in ('functions', 'triggers')):
    raise SystemExit(1)

if args.require_constraint_equivalent and "constraints" in differences:
    raise SystemExit(1)
