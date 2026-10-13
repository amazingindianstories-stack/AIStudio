"""Offline native image RSS evidence; no DB or providers and no threshold changes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified isolation runner required')
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--pillow',action='store_true')
parser.add_argument('--expect-unavailable',action='store_true')
args=parser.parse_args()
if args.expect_unavailable and not args.pillow:
    parser.error('--expect-unavailable requires --pillow')
source=hashlib.sha256()
for path in sorted(Path('backend').rglob('*')):
    if not path.is_file() or path.is_symlink() or any(x in {'venv','.venv','__pycache__'} for x in path.parts):
        continue
    if path.suffix!='.py' and not(path.suffix=='.json' and 'testsupport/goldens' in path.as_posix()) and path.name not in {'requirements.txt','constraints-qualified.txt','Dockerfile','Dockerfile.dockerignore'}:
        continue
    source.update(path.as_posix().encode()+b'\0'+hashlib.sha256(path.read_bytes()).digest())
probe=r'''
import hashlib,json,os,resource,subprocess,sys,tempfile,time
from pathlib import Path
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.test'
import django;django.setup()
with tempfile.TemporaryDirectory() as folder:
 for width,height,bands in ((2048,2048,3),(6000,6000,3),(7000,7000,3),(15000,10000,3),(7000,7000,4)):
  target=Path(folder)/f'{width}-{height}-{bands}.png'
  generator="import pyvips,sys;pyvips.Image.black(int(sys.argv[1]),int(sys.argv[4]),bands=int(sys.argv[3])).cast('uchar').pngsave(sys.argv[2])"
  subprocess.run([sys.executable,'-c',generator,str(width),str(target),str(bands),str(height)],check=True)
  child="""import hashlib,json,resource,sys,time
from pathlib import Path
from apps.generation.services.seedream_references import normalize_seedream_reference
baseline=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
raw=Path(sys.argv[1]).read_bytes()
if len(sys.argv)>2:
 Path(sys.argv[2]+'.'+str(__import__('os').getpid())+'.ready').touch()
 deadline=time.monotonic()+15
 while not Path(sys.argv[2]).exists():
  if time.monotonic()>deadline:raise TimeoutError('fixture start gate')
  time.sleep(.005)
started=time.monotonic()
result=normalize_seedream_reference(raw)
print(json.dumps({'baseline_peak_kib':baseline,'peak_rss_kib':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,'elapsed_seconds':time.monotonic()-started,'input_bytes':len(raw),'input_sha256':hashlib.sha256(raw).hexdigest(),'output_bytes':len(result['bytes']),'output_sha256':hashlib.sha256(result['bytes']).hexdigest(),'changed':result['changed'],'ext':result['ext']}))"""
  events=Path('/sys/fs/cgroup/memory.events')
  before=events.read_text() if events.exists() else None
  result=subprocess.run([sys.executable,'-c',child,str(target)],capture_output=True,text=True)
  if result.returncode:
   print(json.dumps({'dimensions':[width,height],'bands':bands,'child_returncode':result.returncode,'memory_events_before':before,'memory_events_after':events.read_text() if events.exists() else None,'stderr':result.stderr[-2000:]}),flush=True)
   if EXPECT_UNAVAILABLE and 'The native image runtime is unavailable.' in result.stderr:
    after=events.read_text() if events.exists() else None
    assert before==after,'Memory events changed during expected early rejection'
    print(json.dumps({'dimensions':[width,height],'bands':bands,'expected_native_unavailable_rejection':True,'memory_events_unchanged':True}),flush=True)
    continue
   raise RuntimeError('Normalization fixture failed; memory events retained')
  print(json.dumps({'dimensions':[width,height],'bands':bands,'measurement':json.loads(result.stdout),'scope':'single native normalization; synthetic solid RGB/RGBA PNG; Linux ru_maxrss KiB'}),flush=True)

 gate=Path(folder)/'start'
 children=[subprocess.Popen([sys.executable,'-c',child,str(target),str(gate)],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True) for _ in range(2)]
 try:
  deadline=time.monotonic()+15
  while len(list(Path(folder).glob('start.*.ready')))<2:
   if any(p.poll() is not None for p in children) or time.monotonic()>deadline:
    raise RuntimeError('Concurrent fixture failed before start gate')
   time.sleep(.01)
  gate.touch();peak=0;samples=0
  while any(p.poll() is None for p in children):
   total=0
   for p in children:
    try:
     text=Path(f'/proc/{p.pid}/status').read_text()
     total+=int(next(line.split()[1] for line in text.splitlines() if line.startswith('VmRSS:')))
    except (FileNotFoundError,StopIteration):pass
   peak=max(peak,total);samples+=1
   if time.monotonic()>deadline+15:raise TimeoutError('Concurrent fixture completion')
   time.sleep(.01)
  outcomes=[]
  for p in children:
   out,error=p.communicate(timeout=5)
   if p.returncode:raise RuntimeError('Concurrent normalization failed: '+error[-1000:])
   outcomes.append(json.loads(out))
  print(json.dumps({'concurrent_processes':2,'dimensions':[7000,7000],'bands':4,'sampled_aggregate_child_rss_peak_kib':peak,'sample_count':samples,'measurements':outcomes,'scope':'10ms sampled child RSS; excludes container cache and parent; not a worst-case bound'}),flush=True)
 finally:
  for p in children:
   if p.poll() is None:p.kill();p.communicate(timeout=5)

'''
if args.pillow:
    probe=probe.replace('baseline=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss', "sys.modules['pyvips']=None\nbaseline=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss")
if args.expect_unavailable:
    probe=probe[:probe.index("\n gate=Path(folder)/'start'")]
probe='EXPECT_UNAVAILABLE='+repr(args.expect_unavailable)+'\n'+probe
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as config:
    Path(config,'config.json').write_text('{}')
    docker=['docker','--config',config,'--host','unix:///Users/ais4/.docker/run/docker.sock']
    image=json.loads(subprocess.check_output(docker+['image','inspect','veevee-django-qualification:local'],text=True))[0]
    assert image['Config']['Labels']['io.veevee.api-source-sha256']==source.hexdigest()
    print(json.dumps({'image_id':image['Id'],'backend_source_sha256':source.hexdigest(),'implementation':'Pillow fallback' if args.pillow else 'libvips','network':'none','memory_limit':'1GiB','fixture_scope':'five single-process solid RGB/RGBA PNG cases including 150MP; two-process RGBA case; no general worst-case bound'}),flush=True)
    subprocess.run(docker+['run','--rm','--network','none','--memory','1g','--memory-swap','1g','--cpus','2','--pids-limit','128','--tmpfs','/tmp:rw,size=512m','--entrypoint','python','-e','DJANGO_SETTINGS_MODULE=config.settings.test','-e','DJANGO_SECRET_KEY=disposable-image-probe','-e','AUTH_SECRET=disposable-image-probe','-e','DATABASE_URL=postgresql://migration@127.0.0.1:1/veevee_django_migration','-e','MIGRATION_TEST_ISOLATED=1','-e','MOCK_GENERATION=1','-e','MOCK_ASSET_PROVIDER=1',image['Id'],'-c',probe],check=True)
