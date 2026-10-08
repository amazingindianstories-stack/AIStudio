"""Verify targeted pattern-index suppression and default backend behavior."""
import json
import os
from pathlib import Path
import sys

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or os.environ.get('DJANGO_SETTINGS_MODULE') != 'config.settings.test':
    raise SystemExit('Explicit isolated qualification settings required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
import django
django.setup()
from django.apps import apps
from django.db import connection, transaction
from django.db.migrations.loader import MigrationLoader
from config.db.backends.postgresql.schema import CURRENT_TEXT_KEYS_WITHOUT_PATTERN_INDEX

loader = MigrationLoader(None)
checks = 0
for registry in [apps, loader.project_state().apps]:
    checked = set()
    with connection.schema_editor(collect_sql=True, atomic=False) as editor:
        for model in registry.get_models():
            for field in model._meta.local_fields:
                key = (model._meta.db_table, field.column)
                if key in CURRENT_TEXT_KEYS_WITHOUT_PATTERN_INDEX:
                    assert field.get_internal_type() == 'TextField' and field.unique
                    assert editor._create_like_index_sql(model, field) is None
                    checked.add(key)
                    checks += 1
    assert checked == CURRENT_TEXT_KEYS_WITHOUT_PATTERN_INDEX
# A synthetic table outside the scoped policy retains Django's normal index.
state = loader.project_state()
state.models['admin_dashboard', 'appsetting'].options['db_table'] = 'qualification_pattern_control'
control = state.apps.get_model('admin_dashboard', 'AppSetting')
with transaction.atomic(), connection.cursor() as cursor:
    cursor.execute('CREATE TEMP TABLE qualification_pattern_control (key text PRIMARY KEY) ON COMMIT DROP')
    with connection.schema_editor(atomic=False) as editor:
        sql = editor._create_like_index_sql(control, control._meta.get_field('key'))
        assert sql is not None and 'text_pattern_ops' in str(sql)
        cursor.execute(str(sql))
    cursor.execute("SELECT count(*) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relnamespace=pg_my_temp_schema() AND pg_get_indexdef(c.oid) LIKE '%text_pattern_ops%'")
    assert cursor.fetchone()[0] == 1, 'Unrelated table lost its normal pattern index'
    transaction.set_rollback(True)
with connection.cursor() as cursor:
    cursor.execute("SELECT count(*) FROM pg_class WHERE relnamespace=pg_my_temp_schema() AND relname LIKE 'qualification_pattern_control%'")
    assert cursor.fetchone()[0] == 0
print(json.dumps({'runtime_and_disk_suppression_checks': checks, 'unrelated_table_pattern_index_preserved': True, 'temporary_ddl_rolled_back': True}))
