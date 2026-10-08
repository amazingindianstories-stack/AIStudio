"""Actual Node/Django history plans on the HTTP harness's disposable fixtures."""
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit
from uuid import uuid4
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or urlsplit(os.environ.get('DATABASE_URL','')).hostname != '127.0.0.1' or urlsplit(os.environ.get('DATABASE_URL','')).path != '/veevee_django_migration':
    raise SystemExit('Disposable isolated loopback required')
sys.path.insert(0,str(Path.cwd()/'backend'))
import django
django.setup()
from django.db import connection
from django.http import QueryDict
from apps.generation.history import query_history
marker = 'history-plan-large-' + uuid4().hex
fixture_ids = []
with connection.cursor() as cursor:
    columns = [column.name for column in connection.introspection.get_table_description(cursor,'generations')]
    quote = connection.ops.quote_name
    expressions = ['gen_random_uuid()' if name=='id' else '%s' if name=='prompt' else 'series.n+10' if name=='created_at' else 'g.'+quote(name) for name in columns]
    cursor.execute('INSERT INTO generations ('+','.join(map(quote,columns))+') SELECT '+','.join(expressions)+
        " FROM generations g CROSS JOIN generate_series(1,5000) series(n) WHERE g.id='aaaaaaaa-aaaa-4aaa-8aaa-000000000000' RETURNING id",[marker])
    fixture_ids = [str(row[0]) for row in cursor.fetchall()]
    assert len(fixture_ids)==5000, 'HTTP fixture source required'
try:
    with connection.cursor() as cursor:
        cursor.execute('ANALYZE generations')
    cases=[{'filter':{'q':'100%_fixture\\ref'}},{'filter':{'q':'history-plan-absent'}},
           {'filter':{'folderId':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'}},
           {'filter':{},'cursor':{'sort':1,'id':'aaaaaaaa-aaaa-4aaa-8aaa-000000000004'}}]
    cases.extend([{'filter':{'q':marker}},{'filter':{'q':marker+'-absent'}}, {'filter':{'folderId':'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'},'cursor':{'sort':2500,'id':'ffffffff-ffff-4fff-8fff-ffffffffffff'}}])
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
    print(json.dumps({'history_plan_comparisons':report,'synthetic_rows_added':5000,'scope':'same narrow physical schema for both drivers on PG18; no production performance SLA'}))
finally:
    with connection.cursor() as cursor:
        cursor.execute('DELETE FROM generations WHERE id=ANY(%s::uuid[])',[fixture_ids])
