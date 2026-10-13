from frozen_oracle import run as oracle_run, check_output as oracle_output
"""Compare frozen historical Node driver and Django's explicit bigint operand binding."""
import json
import os
from pathlib import Path
import subprocess
import sys

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1':
    raise SystemExit('Isolated runner required')
sys.path.insert(0,str(Path.cwd()/'backend'))
import django
django.setup()
from django.db import connection
from apps.generation.updates import operand_text

result = oracle_run(['node','--import','tsx','scripts/django-migration/update-operand-oracle.mjs'],capture_output=True,text=True,check=True)
expected = json.loads(result.stdout)
actual = []
for case in expected:
    item = {'value':case['value']}
    try:
        with connection.cursor() as cursor:
            binding = operand_text(float(case['value']))
            cursor.execute('SELECT 2::bigint > %s::bigint, %s::bigint::text',[binding,binding])
            item['matched'], item['operand'] = cursor.fetchone()
    except Exception as error:
        item['error_code'] = getattr(error.__cause__,'sqlstate',None)
    actual.append(item)
assert actual == expected,(actual,expected)
print(json.dumps({'update_operand_cases':len(actual),'driver_binding_equal':True,'read_only':True}))
