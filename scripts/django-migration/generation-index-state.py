"""Declared generation index comparison; does not apply index DDL."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
if os.environ.get('MIGRATION_TEST_ISOLATED')!='1':
    raise SystemExit('Isolated runner required')
sys.path.insert(0,str(Path.cwd()/'backend'))
import django
django.setup()
from django.apps import apps
from django.db import connection
from django.db.migrations.loader import MigrationLoader
expected=json.loads(subprocess.run(['node','scripts/django-migration/declared-generation-indexes.mjs'],capture_output=True,text=True,check=True).stdout)
pending={'generations_stale_video_poll_idx','generations_coordinator_due_idx'}
expected={index['name']:index for index in expected if index['name'] not in pending}
def normalize(predicate):
    return re.sub(r'[\s"()]','', (predicate or '').replace('"generations".',''))
for registry in [apps,MigrationLoader(None).project_state().apps]:
    model=registry.get_model('generation','Generation')
    indexes={index.name:index for index in model._meta.indexes}
    assert set(indexes)==set(expected), 'Index inventory differs'
    with connection.schema_editor(collect_sql=True,atomic=False) as editor:
        for name,index in indexes.items():
            columns=[{'name':model._meta.get_field(field).column,'order':order.lower() or 'asc'} for field,order in index.fields_orders]
            assert columns==expected[name]['columns'], (name,columns,expected[name]['columns'])
            predicate=index._get_condition_sql(model,editor)
            assert normalize(predicate)==normalize(expected[name]['predicate']), name
print(json.dumps({'generation_indexes_matched':len(expected),'runtime_and_disk_state':True,'index_ddl_applied':False,'worker_indexes_pending':sorted(pending)}))
