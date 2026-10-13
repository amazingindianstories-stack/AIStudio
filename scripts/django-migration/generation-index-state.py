from frozen_oracle import run as oracle_run, check_output as oracle_output
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
expected=json.loads(oracle_run(['node','scripts/django-migration/declared-generation-indexes.mjs'],capture_output=True,text=True,check=True).stdout)
pending=set()
expected={index['name']:index for index in expected if index['name'] not in pending}
def normalize(predicate):
    tokens=re.findall(r"\"[^\"]*\"|'(?:''|[^'])*'|[A-Za-z_][A-Za-z_0-9]*|[^\s]",(predicate or '').replace('"generations".',''))
    tokens=[token[1:-1] if token.startswith('"') else token for token in tokens]
    # Strip only parentheses enclosing the whole predicate. Retain internal
    # grouping and whitespace inside SQL literals such as 'Magnific %'.
    while tokens and tokens[0]=='(' and tokens[-1]==')':
        depth=0
        for index,token in enumerate(tokens):
            depth += (token=='(')-(token==')')
            if depth==0: break
        if index!=len(tokens)-1: break
        tokens=tokens[1:-1]
    return tokens
for registry in [apps,MigrationLoader(None).project_state().apps]:
    model=registry.get_model('generation','Generation')
    indexes={index.name:index for index in model._meta.indexes}
    assert set(indexes)==set(expected), 'Index inventory differs'
    with connection.schema_editor(collect_sql=True,atomic=False) as editor:
        for name,index in indexes.items():
            # Inspect compiled CREATE INDEX, including explicit/default NULL ordering.
            ddl=str(index.create_sql(model,editor))
            match=re.search(r' ON "generations"(?: USING btree)? \((.*?)\)(?: WHERE |$)',ddl)
            assert match, (name,'Unsupported index SQL')
            columns=[]
            for part in match[1].split(','):
                column=re.fullmatch(r'\s*"([^"\n]+)"(?: (ASC|DESC))?(?: NULLS (FIRST|LAST))?\s*',part)
                assert column, (name,'Unsupported index expression')
                order=(column[2] or 'ASC').lower()
                columns.append({'name':column[1],'order':order,'nulls':(column[3] or ('FIRST' if order=='desc' else 'LAST')).lower()})
            assert columns==expected[name]['columns'], (name,columns,expected[name]['columns'])
            predicate=index._get_condition_sql(model,editor)
            assert normalize(predicate)==normalize(expected[name]['predicate']), name
print(json.dumps({'generation_indexes_matched':len(expected),'runtime_and_disk_state':True,'index_ddl_applied':False,'worker_indexes_pending':sorted(pending)}))
