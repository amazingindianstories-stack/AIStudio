"""Offline actual Gunicorn/audio-handler concurrency probe in the qualified image."""
import json, os, subprocess, tempfile, argparse
from pathlib import Path
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified isolation runner required')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--threads',type=int,default=1)
parser.add_argument('--saturation',action='store_true')
args = parser.parse_args()
server = r'''
import os, sys, time, base64
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.test'
os.environ['AUTH_SECRET']='disposable-probe'
os.environ['DJANGO_SECRET_KEY']='disposable-probe'
os.environ['MOCK_GENERATION']='1'
os.environ['MOCK_ASSET_PROVIDER']='1'
os.environ['DATABASE_URL']='postgresql://migration@127.0.0.1:1/veevee_django_migration'
import django; django.setup()
from types import SimpleNamespace
from unittest.mock import Mock
from apps.media import audio
audio.lookup=lambda request:SimpleNamespace(id='00000000-0000-0000-0000-000000000001')
from apps.media.storage import StorageService, MemoryAdapter
class ProbeStorage(StorageService):
 def read_reference_bytes(self,ref,*,max_bytes=None):
  if not ref.startswith('/api/media/'):
   return {'mimeType':'audio/wav','bytes':ref.encode()}
  return super().read_reference_bytes(ref,max_bytes=max_bytes)
probe_storage=ProbeStorage(MemoryAdapter())
audio.get_storage=lambda:probe_storage
class Transcriber:
 def transcribe(self,data,mime,model):
  delay=float(base64.b64decode(data));time.sleep(delay);return 'offline transcript'
audio.get_transcriber=lambda:Transcriber()
audio.Generation.objects.create=lambda **values:SimpleNamespace(**values)
audio._persist_audio_result=lambda expected,transcript,completed:SimpleNamespace(project_id=expected.project_id,updated_at=completed)
from apps.media import views as media_views
from apps.media.storage import MediaObject
media_views.lookup=audio.lookup
class SlowStream:
 def __iter__(self):
  for _ in range(4096):
   time.sleep(.005)
   yield b'x'*16384
 def close(self):
  with open('/tmp/closed-streams','a') as record:record.write('closed\n')
media_views.get_storage=lambda:SimpleNamespace(browser_url=lambda key:None,open=lambda key,range_header:MediaObject(SlowStream(),'video/quicktime',67108864))
from config.wsgi import application
from gunicorn.app.base import BaseApplication
class API(BaseApplication):
 def load_config(self):
  for k,v in {'bind':'127.0.0.1:8000','workers':2,'threads':int(os.environ.get('PROBE_THREADS','1')),'errorlog':'-','accesslog':None}.items(): self.cfg.set(k,v)
 def load(self):return application
API().run()
'''
client = r'''
import concurrent.futures, json, subprocess, sys, time, urllib.request, urllib.error
from pathlib import Path
Path('/tmp/offline-api.py').write_text(SERVER)
p=subprocess.Popen([sys.executable,'/tmp/offline-api.py'],cwd='/app',env=ENV,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
def health():
 # Actual health endpoint may report DB unavailable; scheduling latency is measured.
 try:r=urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=10)
 except urllib.error.HTTPError as e:r=e
 with r:return r.status
try:
 for _ in range(100):
  try:health();break
  except Exception:time.sleep(.1)
 else:
  p.terminate();print(p.communicate(timeout=10)[0]);raise RuntimeError('API failed to start')
 def audio(delay):
  request=urllib.request.Request('http://127.0.0.1:8000/api/audio/transcribe',data=json.dumps({'audioRef':str(delay)}).encode(),headers={'Content-Type':'application/json','Host':'localhost'})
  started=time.monotonic()
  try:
   with urllib.request.urlopen(request,timeout=40) as r:return {'status':r.status,'elapsed':time.monotonic()-started}
  except urllib.error.HTTPError as e:
   status=e.code;e.close();return {'status':status,'elapsed':time.monotonic()-started}
  except Exception as e:return {'error_type':type(e).__name__,'elapsed':time.monotonic()-started}
 with concurrent.futures.ThreadPoolExecutor(2) as pool:
  tasks=[pool.submit(audio,2) for _ in range(2)];time.sleep(.3);started=time.monotonic();h=health();latency=time.monotonic()-started;results=[x.result() for x in tasks]
 disconnects=None
 if ENV['PROBE_SATURATION']=='1':
  import socket
  for _ in range(2):
   with socket.create_connection(('127.0.0.1',8000),timeout=5) as client:
    client.sendall(b'GET /api/media/offline.mov?inline=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
    received=client.recv(4096)
    assert b'200 OK' in received,received
  deadline=time.monotonic()+3
  while time.monotonic()<deadline:
   closed=Path('/tmp/closed-streams').read_text().count('closed') if Path('/tmp/closed-streams').exists() else 0
   if closed>=2:break
   time.sleep(.02)
  assert closed==2,closed
  disconnects={'actual_media_streams_aborted':2,'stream_close_observed':closed}
 saturation=None
 if ENV['PROBE_SATURATION']=='1':
  with concurrent.futures.ThreadPoolExecutor(16) as pool:
   pending=[pool.submit(audio,2) for _ in range(16)];time.sleep(.3);started=time.monotonic();health();busy_latency=time.monotonic()-started;outcomes=[f.result() for f in pending]
  saturation={'outcomes':outcomes,'health_latency':busy_latency}
  assert sum(x.get('status')==200 for x in outcomes)<=4,outcomes
  assert any(x.get('status')==429 for x in outcomes),outcomes
  assert busy_latency<1,busy_latency
  long={'status':'SKIPPED'}
 else:long=audio(35)
 recovered=health()
 p.terminate();out=p.communicate(timeout=10)[0]
 print(json.dumps({'disconnects':disconnects,'saturation':saturation,'short_audio_results':results,'health_latency_during_two_audio_calls':latency,'health_status':h,'long_audio_result':long,'gunicorn_worker_timeout_observed':'WORKER TIMEOUT' in out,'health_after_timeout':recovered,'network':'none','providers':'injected offline','database':'no configured shared target'},indent=2))
 assert all(x.get('status')==200 for x in results),results
 if int(ENV['PROBE_THREADS']) == 1:
  assert latency>1,latency
  assert 'WORKER TIMEOUT' in out and ('error_type' in long or long.get('status')==500),(long,out)
 else:
  assert latency<1,latency
  assert (long.get('status')==200 or ENV['PROBE_SATURATION']=='1') and 'WORKER TIMEOUT' not in out,(long,out)
finally:
 if p.poll() is None:p.terminate();p.communicate(timeout=10)
'''
env_literal={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','PYTHONPATH':'/app','DJANGO_ALLOWED_HOSTS':'localhost,127.0.0.1','MIGRATION_TEST_ISOLATED':'1','AWS_EC2_METADATA_DISABLED':'true'}
env_literal['PROBE_THREADS']=str(args.threads)
env_literal['PROBE_SATURATION']='1' if args.saturation else '0'
code='SERVER='+repr(server)+'\nENV='+repr(env_literal)+'\n'+client
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as config:
 Path(config,'config.json').write_text('{}')
 docker=['docker','--config',config,'--host','unix:///Users/ais4/.docker/run/docker.sock']
 image='veevee-django-qualification:local'
 metadata=json.loads(subprocess.check_output(docker+['image','inspect',image],text=True))[0]
 print(json.dumps({'image_id':metadata['Id'],'source_fingerprint':metadata['Config']['Labels']['io.veevee.api-source-sha256'],'threads':args.threads,'scope':'Recorded local image identity; injected actual audio handler dependencies; measured worker profile'}),flush=True)
 subprocess.run(docker+['run','--rm','--network','none','--entrypoint','python',image,'-c',code],check=True)
