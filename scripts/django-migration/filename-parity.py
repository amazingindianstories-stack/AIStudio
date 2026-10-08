"""Pure filename comparison with the current Node production resolver."""
import json
import os
from pathlib import Path
import subprocess
import sys
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1':
    raise SystemExit('Isolated runner required')
sys.path.insert(0, str(Path.cwd()/'backend'))
from apps.library.filenames import resolve_generation_filename
cases = [{}, {'namespace':'project_unsorted:fixture'}, {'namespace':'unknown'}]
for name in ['Scene 1','R1','sc012','Café Déjà vu','CON','COM1','LPT9','NUL','こんにちは','दृश्य','ﬁlm','__A--B__','  ','\ufeff', 'a'*400, 'A_'*160]:
    cases.append({'namespace':'folder:fixture','ancestry':[{'name':name}], 'sequence':12})
for kind in ['image','video','depth','audio','other']:
    cases.append({'kind':kind})
for url in ['/master.MOV?download=1#x','/image.jpeg','/image.png#x','/unknown.xyz','/no-extension']:
    cases.append({'kind':'video','url':url})
for mime in ['video/quicktime','video/mp4','image/jpeg; charset=utf-8','audio/wav','unknown/type']:
    cases.append({'kind':'video','contentType':mime,'url':'/master.mov'})
for sequence in [0,-2,1,9999,10000,12.8,'42tail','0x10',None]:
    cases.append({'sequence':sequence,'namespace':'folder:fixture','ancestry':[{'name':'R2'},{'name':'Sc3'}]})
cases.extend([{'namespace':'folder:fixture','ancestry':[]}, {'namespace':'folder:fixture','mediaKey':'original.mov','url':'preview.mp4'}])
source = """
import {readFileSync} from 'node:fs';
if(process.env.MIGRATION_TEST_ISOLATED!=='1')throw new Error('Isolated runner required');
const {resolveGenerationFilename}=await import('./src/lib/filename-resolver.js');
console.log(JSON.stringify(JSON.parse(readFileSync(0,'utf8')).map(x=>resolveGenerationFilename(x))));
"""
expected=json.loads(subprocess.run(['node','--import','tsx','--input-type=module','-e',source],input=json.dumps(cases),capture_output=True,text=True,check=True).stdout)
actual=[resolve_generation_filename(**{ {'mediaKey':'media_key','contentType':'content_type'}.get(k,k):v for k,v in case.items()}) for case in cases]
assert actual==expected,[(case,a,b) for case,a,b in zip(cases,actual,expected) if a!=b]
print(json.dumps({'filename_cases':len(cases),'node_equal':True,'database_queries':0}))
