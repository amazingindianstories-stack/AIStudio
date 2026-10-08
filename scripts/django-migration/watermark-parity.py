"""JavaScript Number oracle for URL watermark strings; no DB operations."""
import json
import os
from pathlib import Path
import subprocess
import sys

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1':
    raise SystemExit('Isolated runner required')
sys.path.insert(0, str(Path.cwd() / 'backend'))
from apps.generation.watermark import since_watermark

cases = [None,'',' ','0','-0','-1','1','+1','1.5','.5','1.','1e3','1E-3','1e309','1e-9999',
    'Infinity','+Infinity','-Infinity','NaN','nan','inf','1tail','1_000','١٢','１２','0x10','0Xff',
    '+0x10','-0x10','0b101','0B10','0o77','0O10','0b12','0o8','0x','01','0x'+('f'*300),
    '\ufeff123\ufeff','\u0085123\u0085','\u2000123\u2000','9007199254740993','1\n2','1e+2']
now = 1700000000000
oracle = "const x=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(x.cases.map(v=>{const n=Number(v);return Number.isFinite(n)&&n>0?n:x.now-300000})))"
result = subprocess.run(['node','-e',oracle],input=json.dumps({'cases':cases,'now':now}),capture_output=True,text=True,check=True)
expected = json.loads(result.stdout)
actual = [since_watermark(value,now) for value in cases]
for value, left, right in zip(cases,expected,actual):
    assert left == right, (repr(value),left,right)
print(json.dumps({'watermark_cases':len(cases),'node_python_equal':True,'database_calls':0}))
