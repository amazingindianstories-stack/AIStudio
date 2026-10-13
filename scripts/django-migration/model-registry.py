"""Render the managed physical model registry from qualified disk model state."""
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
from django.db import connection
from django.db.migrations.loader import MigrationLoader
from config.db.backends.postgresql.schema import CURRENT_FOREIGN_KEYS
state = MigrationLoader(None).project_state()
physical_models = list(state.apps.get_models())
physical_columns = sum(1 for model in physical_models for field in model._meta.local_fields if field.column)
lines = ['# Physical Django model registry', '',
         f'Local source has one managed Django graph: {len(physical_models)} application tables, {physical_columns} physical columns.',
         'Production catalog/history audit and adoption remain pending. Epoch timestamps are',
         'bigint milliseconds; plain UUID columns remain plain UUIDs. Virtual composite PK',
         'attributes do not add columns. Domain/concurrency obligations are in model-design.md',
         'and the controlling implementation blueprint.', '']
quote = lambda value: str(value).replace('|', '\\|').replace('\n', ' ')
for model in sorted(state.apps.get_models(), key=lambda m: m._meta.label):
    assert model._meta.managed
    meta = model._meta
    pk = meta.pk
    columns = list(pk.columns) if hasattr(pk, 'columns') else [pk.column]
    lines += [f'## {meta.label} — `{meta.db_table}`', '', f'Primary key: `{", ".join(columns)}`. Managed by `{meta.app_label}`.', '',
              '| SQL column | Django attribute | SQL type | Nullable | Database default |', '|---|---|---|---|---|']
    with connection.schema_editor(collect_sql=True, atomic=False) as editor:
        for field in meta.local_fields:
            if not field.column:
                continue
            default = 'none'
            if field.has_db_default():
                expression, params = editor.db_default_sql(field)
                default = expression % tuple(editor.quote_value(value) for value in params) if params else expression
            lines.append(f'| {field.column} | {field.name} | {field.db_type(connection)} | {field.null} | {quote(default)} |')
        lines += ['', 'Indexes (explicit column order, predicates and uniqueness):', '']
        for index in meta.indexes:
            lines += [f'- `{quote(index.create_sql(model, editor))}`']
        if not meta.indexes:
            lines += ['- No extra model indexes; primary/unique keys still have their physical indexes.']
        for field in meta.local_fields:
            if field.unique and not field.primary_key:
                lines += [f'- Unique key on `{field.column}`.']
        for constraint in meta.constraints:
            lines += [f'- Check `{constraint.name}`: `{quote(constraint.constraint_sql(model, editor))}`']
    for field in meta.local_fields:
        if field.is_relation and field.db_constraint:
            target_table, target_column, action, name = CURRENT_FOREIGN_KEYS[(meta.db_table, field.column)]
            lines += [f'- FK `{name}`: `{field.column}` → `{target_table}.{target_column}`, ON DELETE {action}, NOT DEFERRABLE.']
    lines += ['']
lines += ['## Versioned database invariants', '',
          'The library invariant migration runs after all table creation. It preserves four',
          'hierarchy/naming functions, five triggers, and the five additive FK aliases in',
          '`apps/library/baseline_sql/*_v1.py`. The SQL is frozen and drift-checked against',
          'the current source fixture. Deferred scope checks remain database-enforced.', '',
          'PostgreSQL schema-editor policies preserve the four unique-key names, two',
          'composite PK names, seven declared physical FK policies and the absence of',
          'implicit text-pattern/FK indexes. Fresh/adoption catalog tests are the proof',
          'for their physical behavior; this registry is a generated reference.', '']
Path(sys.argv[1]).write_text('\n'.join(lines))
print(f'Registry written: {len(state.models)} managed models')
