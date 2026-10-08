"""Actual Node/Django history plans on the HTTP harness's disposable fixtures."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or urlsplit(os.environ.get('DATABASE_URL','')).hostname != '127.0.0.1' or urlsplit(os.environ.get('DATABASE_URL','')).path != '/veevee_django_migration':
    raise SystemExit('Disposable isolated loopback required')
sys.path.insert(0,str(Path.cwd()/'backend'))
import django
django.setup()
from django.db import connection
from django.http import QueryDict
from apps.generation.history import query_history
cases=[{'filter':{'q':'100%_fixture\\ref'}},{'filter':{'q':'history-plan-absent'}},
       {'filter':{'folderId':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
       {'filter':{},'cursor':{'sort':1,'id':'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'}}]
expected=json.loads(subprocess.run(['node','--import','tsx','scripts/django-migration/history-plan-oracle.mjs'],input=json.dumps(cases),capture_output=True,text=True,check=True).stdout)
def nodes(node):
    result=[{'type':node['Node Type'],'rows':node['Actual Rows'],'removed':node.get('Rows Removed by Filter',0),'index':node.get('Index Name')}]
    for child in node.get('Plans',[]): result.extend(nodes(child))
    return result
report=[]
for entry,node in zip(cases,expected):
    params=QueryDict(mutable=True)
    params.update(entry['filter'])
    if 'cursor' in entry: params['cursor']=str(entry['cursor']['sort'])+'.'+entry['cursor']['id']
    captured=[]
    def capture(execute,statement,bindings,many,context):
        if not captured: captured.append((statement,bindings))
        return execute(statement,bindings,many,context)
    with connection.execute_wrapper(capture): page=query_history(params)
    assert page==node['page'], 'Actual query response differs'
    statement,bindings=captured[0]
    with connection.cursor() as cursor:
        cursor.execute('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) '+statement,bindings)
        plan=cursor.fetchone()[0][0]
    report.append({'response_equal':True,'node_nodes':node['nodes'],'django_nodes':nodes(plan['Plan']),
                   'node_execution_ms':node['execution_ms'],'django_execution_ms':plan['Execution Time']})
print(json.dumps({'history_plan_comparisons':report,'scope':'six-row HTTP fixtures; no performance SLA'}))
