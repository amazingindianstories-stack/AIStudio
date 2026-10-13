"""Offline production-profile transport fault probe; no database/provider traffic.

Runs the real capacity/logging wrappers in a recorded local image. Handlers and
storage waits are injected: this proves scheduling/admission/close/SIGTERM, not
cloud signing, authentication, actual readiness or provider acceptance.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified isolation required')

SERVER = r'''
import logging,sys,time
from types import SimpleNamespace
from django.conf import settings
settings.configure(DEFAULT_CHARSET='utf-8')
from django.http import HttpResponse,StreamingHttpResponse
from django.core.handlers.wsgi import WSGIRequest
from apps.common.middleware import RequestLogMiddleware
from apps.common.wsgi import slow_request_application
logging.basicConfig(stream=sys.stdout,level=logging.INFO)
def chunks():
 try:
  for _ in range(12):
   time.sleep(.1)
   yield b'original-master'
 finally:
  with open('/tmp/closed','a') as out:out.write('closed\n')
def handler(request):
 request.resolver_match=SimpleNamespace(route='api/injected-fault/<kind>')
 if request.path=='/api/health':return HttpResponse(b'liveness-only',status=200)
 if request.path.startswith('/api/media/'):
  return StreamingHttpResponse(chunks(),content_type='video/quicktime')
 time.sleep(1.2)
 return HttpResponse(b'bounded-offline-result',status=200)
logged=RequestLogMiddleware(handler)
def app(env,start):
 response=logged(WSGIRequest(env))
 start(str(response.status_code)+' '+response.reason_phrase,list(response.items()))
 return response
application=slow_request_application(app)
'''
CLIENT = r'''
import concurrent.futures,json,os,socket,subprocess,sys,time,urllib.error,urllib.request
from pathlib import Path
Path('/tmp/fault_server.py').write_text(SERVER)
logs=Path('/tmp/gunicorn.log').open('w')
env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/tmp','PYTHONPATH':'/app:/tmp'}
p=subprocess.Popen([sys.executable,'-m','gunicorn','fault_server:application','--bind','127.0.0.1:8000','--workers','2','--worker-class','gthread','--threads','4','--timeout','30','--error-logfile','-'],env=env,stdout=logs,stderr=subprocess.STDOUT)
def request(path):
 start=time.monotonic()
 try:
  with urllib.request.urlopen('http://127.0.0.1:8000'+path,timeout=5) as result:
   return {'status':result.status,'body_bytes':len(result.read()),'seconds':time.monotonic()-start}
 except urllib.error.HTTPError as error:
  with error:return {'status':error.code,'retry_after':error.headers.get('Retry-After'),'seconds':time.monotonic()-start}
try:
 deadline=time.monotonic()+15
 while True:
  try:request('/api/health');break
  except Exception:
   if p.poll() is not None or time.monotonic()>deadline:raise RuntimeError('Fault server failed')
   time.sleep(.05)
 routes=['/api/media/native.mov?inline=1&private=DO_NOT_LOG','/api/generate/upscale/status?id=DO_NOT_LOG','/api/generations/offline/download?signature=DO_NOT_LOG','/api/media-grant?key=DO_NOT_LOG']
 with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
  tasks=[pool.submit(request,routes[index%4]) for index in range(16)]
  time.sleep(.2)
  health=request('/api/health')
  outcomes=[future.result() for future in tasks]
 assert health['status']==200 and health['seconds']<1,health
 assert sum(item['status']==200 for item in outcomes)<=4,outcomes
 assert any(item['status']==429 and item['retry_after']=='1' for item in outcomes),outcomes
 # Real streaming socket close must release the actual wrapper's slots.
 with socket.create_connection(('127.0.0.1',8000),timeout=5) as stream:
  stream.sendall(b'GET /api/media/native.mov?inline=1 HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n')
  assert b'200 OK' in stream.recv(4096)
 time.sleep(.5)
 assert request('/api/media/native.mov?inline=1')['status']==200
 assert Path('/tmp/closed').read_text().count('closed')>=2
 p.terminate();p.wait(timeout=10)
 logs.close()
 output=Path('/tmp/gunicorn.log').read_text()
 assert p.returncode==0 and 'WORKER TIMEOUT' not in output
 assert 'DO_NOT_LOG' not in output, 'Query/bearer data leaked into actual request logger'
 assert '"event": "request"' in output
 print(json.dumps({'profile':{'workers':2,'threads':4,'timeout_seconds':30},'outcomes':outcomes,'health_liveness_seconds':health['seconds'],'stream_close_observed':True,'sigterm_exit_code':p.returncode,'query_log_redaction':True,'network':'none','handlers':'injected offline; actual admission/request log wrappers','scope':'transport fault scheduling; actual DB readiness/cloud/provider assertions are separate'}))
finally:
 if p.poll() is None:p.kill();p.wait(timeout=5)
 if not logs.closed:logs.close()
'''
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as config:
    Path(config, 'config.json').write_text('{}')
    docker = ['docker', '--config', config, '--host', 'unix:///Users/ais4/.docker/run/docker.sock']
    image = 'veevee-django-qualification:local'
    metadata = json.loads(subprocess.check_output(docker + ['image', 'inspect', image], text=True))[0]
    print(json.dumps({'image_id': metadata['Id'], 'source_labels': metadata['Config']['Labels']}), flush=True)
    subprocess.run(docker + ['run', '--rm', '--network', 'none', '--entrypoint', 'python', metadata['Id'], '-c',
                            'SERVER=' + repr(SERVER) + '\n' + CLIENT], check=True)
