from frozen_oracle import run as oracle_run, check_output as oracle_output
"""Verify one managed graph, complete physical field order, and historical names."""
import json
import os
from pathlib import Path
import subprocess
import sys
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Isolated qualification required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.apps import apps
from django.conf import settings
from django.db.migrations.loader import MigrationLoader
from django.db.migrations.operations.models import CreateModel
from django.db.migrations.operations.special import RunSQL

assert not getattr(settings, 'MIGRATION_MODULES', {}), 'Alternative migration graph selected'
assert not list(Path('backend/baseline_candidate').rglob('*.py')), 'Alternative candidate source remains'
loader = MigrationLoader(None)
assert len(loader.disk_migrations) == 25
operations = [op for migration in loader.disk_migrations.values() for op in migration.operations]
assert sum(isinstance(op, CreateModel) for op in operations) == 22
assert sum(isinstance(op, RunSQL) for op in operations) == 1
assert all(model._meta.managed for model in apps.get_models())
expected = json.loads(oracle_output(['node', 'scripts/django-migration/declared-columns.mjs'], text=True))
baseline_targets = [node for node in loader.graph.leaf_nodes() if node[0] not in {'generation', 'assets', 'media'}] + [('generation', '0001_baseline_generation'), ('assets', '0003_baseline_portraitasset')]
state = loader.project_state(baseline_targets)
assert len(state.models) == len(expected) == 21
for model in state.apps.get_models():
    assert model._meta.managed
    assert [field.column for field in model._meta.local_fields if field.column] == list(expected[model._meta.db_table]['columns'])
legacy = json.loads(Path('docs/django-migration/transitional-migration-history.json').read_text())['migrations']
assert len(legacy) == 49
assert not {(item['app'], item['name']) for item in legacy} & set(loader.disk_migrations)
assert len(loader.project_state().models) == 22
assert {('generation', '0002_generation_submission_input'), ('assets', '0004_uploader_provenance'), ('media', '0001_uploadsession')} <= set(loader.disk_migrations)
print('One active managed graph: reviewed 21-model 22-migration baseline plus three additive migrations and one upload model; no transitional name collision')
