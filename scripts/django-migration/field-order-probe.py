"""Verify baseline field ordering remains state-only and rejects invalid orders."""
import os
from pathlib import Path
import subprocess
import sys

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Isolated qualification required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.db import models
from django.db.migrations.state import ModelState, ProjectState
from apps.common.migration_operations.field_order import SetModelFieldOrder

for order in [('id',), ('id', 'id'), ('id', 'unknown')]:
    state = ProjectState()
    state.add_model(ModelState('example', 'Item', [('id', models.IntegerField(primary_key=True)), ('name', models.TextField())]))
    try:
        SetModelFieldOrder('Item', order).state_forwards('example', state)
    except ValueError:
        pass
    else:
        raise AssertionError('Invalid baseline order accepted')
files = sorted(Path('backend/apps').glob('*/migrations/*_baseline_field_order.py'))
assert len(files) == 6
for file in files:
    sql = subprocess.check_output([sys.executable, 'backend/manage.py', 'sqlmigrate', file.parents[1].name, file.stem], text=True)
    executable = '\n'.join(line for line in sql.splitlines() if line.strip() and not line.lstrip().startswith('--'))
    assert executable.strip() in ('', 'BEGIN;\nCOMMIT;'), executable
print('Six field-order migrations emit no DDL; three invalid orders rejected')
