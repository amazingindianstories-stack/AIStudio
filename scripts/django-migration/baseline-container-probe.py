"""Apply/reopen candidate migrations only on the harness's empty PG16 database."""
import json
import os
from pathlib import Path
import sys
from urllib.parse import urlsplit

url = urlsplit(os.environ.get('DATABASE_URL', ''))
if (os.environ.get('VEEVEE_BASELINE_TEST') != '1'
        or not (url.hostname or '').startswith('veevee-qualification-pg-')
        or url.path not in ('/veevee_django_migration', '/veevee_django_baseline')):
    raise SystemExit('Verified disposable container baseline target required')
payload = json.load(sys.stdin)
os.environ['DJANGO_SETTINGS_MODULE'] = 'config.settings.production'
import django
django.setup()
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.db.migrations.recorder import MigrationRecorder
from django.test.utils import override_settings

if url.path == '/veevee_django_baseline':
    modules = {path.name: f'baseline_candidate.{path.name}' for path in Path('/app/baseline_candidate').iterdir() if path.is_dir() and (path / '__init__.py').exists()}
    with override_settings(MIGRATION_MODULES=modules):
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p')")
            assert cursor.fetchone()[0] == 0, 'Candidate target must be an empty database'
        executor = MigrationExecutor(connection)
        targets = executor.loader.graph.leaf_nodes()
        assert len(executor.migration_plan(targets)) == 22
        executor.migrate(targets)
        # Each migration has committed. Reopen to prove persisted history and DDL.
        connection.close()
        executor = MigrationExecutor(connection)
        assert not executor.migration_plan(targets)
        assert len(MigrationRecorder(connection).applied_migrations()) == 22
else:
    # Include bookkeeping in both catalog snapshots; do not filter differences.
    MigrationRecorder(connection).ensure_schema()

result = {}
with connection.cursor() as cursor:
    cursor.execute('SHOW server_version')
    version = cursor.fetchone()[0]
    assert version.startswith('16.'), version
    for category, query in payload['queries'].items():
        cursor.execute(query)
        result[category] = [dict(zip([column.name for column in cursor.description], row)) for row in cursor.fetchall()]
print(json.dumps({'catalog': result, 'server_version': version, 'committed_migrations': 22 if url.path.endswith('baseline') else 0}, default=str))
