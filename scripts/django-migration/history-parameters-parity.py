"""Compare history pagination parsing with the actual current Node decoder."""
import json
import os
from pathlib import Path
import subprocess
import sys
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1':
    raise SystemExit('Isolated runner required')
sys.path.insert(0,str(Path.cwd()/'backend'))
from apps.generation.history_parameters import decode_cursor, page_limit
identifier = 'ABCDEFAB-abcd-4abc-8abc-abcdefabcdef'
cursors = [None,'','junk','.'+identifier,'1.'+identifier,'0.'+identifier,'-1.'+identifier,
    '0x10.'+identifier,'0b10.'+identifier,'1e3.'+identifier,'1e-3.'+identifier,
    '1e21.'+identifier,'Infinity.'+identifier,'NaN.'+identifier,'1e309.'+identifier,
    '\ufeff2\ufeff.'+identifier,' .'+identifier,'2.bad','2.'+identifier+'.extra','1.5.'+identifier]
limits = [None,'','junk','0','-2','1','20','100','101','2tail','+3','  4.5','1e3','0x10',
    '\ufeff5tail','\u00855','٢','９','9'*400,'9'*30,'-9'*20]
source = """
import {readFileSync} from 'node:fs';
if(process.env.MIGRATION_TEST_ISOLATED!=='1')throw new Error('Isolated runner required');
const {decodeCursor}=await import('./src/lib/store-db.js');
const input=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({cursors:input.cursors.map(x=>decodeCursor(x)??null),limits:input.limits.map(x=>{const n=parseInt(x??'',10);return Number.isFinite(n)?Math.min(Math.max(n,1),100):20;})}));
process.exit(0);
"""
expected=json.loads(subprocess.run(['node','--import','tsx','--input-type=module','-e',source],input=json.dumps({'cursors':cursors,'limits':limits}),text=True,capture_output=True,check=True).stdout)
actual={'cursors':[decode_cursor(raw) for raw in cursors],'limits':[page_limit(raw) for raw in limits]}
assert actual==expected,(actual,expected)
print(json.dumps({'history_parameter_cases':len(cursors)+len(limits),'node_equal':True,'database_queries':0}))
