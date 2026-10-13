"""Offline real Gunicorn waiter/worker/disconnect probe in verified isolation."""
import concurrent.futures
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from uuid import uuid4

if os.environ.get('MIGRATION_TEST_ISOLATED')!='1' or Path.cwd().name!='repo':
    raise SystemExit('Verified isolation runner required')
sys.path.insert(0,str(Path('backend').resolve()))
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.test'
import django;django.setup()
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.generation.models import Generation
from apps.common.leases import now_ms
subprocess.run([sys.executable,'backend/manage.py','migrate','--noinput'],check=True,stdout=subprocess.DEVNULL)
identifier=uuid4()
user=User.objects.create(id=identifier,email=f'{identifier}@offline.test',name='Offline runtime',password_hash='x',role='user',created_at=now_ms())
cookie='veevee_session='+sign_session(user)
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'],prefix='audio-runtime-') as folder:
    root=Path(folder)
    root.joinpath('audio_probe_settings.py').write_text("""from config.settings.test import *
import os,time
from pathlib import Path
from apps.media.storage import StorageService,FileSystemAdapter
VEEVEE_MEDIA_STORAGE=StorageService(FileSystemAdapter(Path(os.environ['AUDIO_PROBE_ROOT'])/'media'))
class Offline:
 def transcribe(self,*args,signal=None):
  with open(Path(os.environ['AUDIO_PROBE_ROOT'])/'calls','a') as log:log.write('entered\\n')
  if signal:signal.wait(2000)
  else:time.sleep(2)
  return 'offline worker runtime transcript'
VEEVEE_AUDIO_TRANSCRIBER=Offline
""")
    with socket.socket() as sock:
        sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
    origin=f'http://127.0.0.1:{port}'
    env={**os.environ,'DJANGO_SETTINGS_MODULE':'audio_probe_settings','PYTHONPATH':folder+os.pathsep+str(Path('backend').resolve()),'AUDIO_PROBE_ROOT':folder,'DJANGO_BROWSER_ORIGINS':origin,'PUBLIC_APP_URL':origin}
    processes=[]
    streams=[]
    def launch(command,name):
        stream=root.joinpath(name+'.log').open('w');streams.append(stream)
        process=subprocess.Popen(command,env=env,stdout=stream,stderr=subprocess.STDOUT);processes.append(process);return process
    def health():
        start=time.monotonic()
        with urllib.request.urlopen(origin+'/api/health',timeout=3) as response:
            assert response.status==200
        return time.monotonic()-start
    def submit():
        data=json.dumps({'audioRef':'data:audio/wav;base64,YWJj'}).encode()
        request=urllib.request.Request(origin+'/api/audio/transcribe',data=data,headers={'Content-Type':'application/json','Cookie':cookie,'Origin':origin})
        try:
            with urllib.request.urlopen(request,timeout=15) as response:return response.status,json.loads(response.read())
        except urllib.error.HTTPError as error:
            with error:return error.code,json.loads(error.read())
    try:
        api=launch([sys.executable,'-m','gunicorn','--chdir','backend','config.wsgi:application','--bind',f'127.0.0.1:{port}','--workers','2','--threads','4'],'api')
        deadline=time.monotonic()+20
        while True:
            try:health();break
            except Exception:
                if api.poll() is not None or time.monotonic()>deadline:raise RuntimeError('API readiness failed')
                time.sleep(.1)
        launch([sys.executable,'backend/manage.py','generation_worker','--interval','.1'],'worker')
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            tasks=[pool.submit(submit) for _ in range(2)]
            time.sleep(.4);latency=health();results=[f.result() for f in tasks]
        assert all(status==200 for status,_ in results),results
        assert latency<1,latency
        # Close a real HTTP socket immediately after submitting durable work.
        before=Generation.objects.filter(user_id=identifier,kind='audio').count()
        body=json.dumps({'audioRef':'data:audio/wav;base64,YWJj'}).encode()
        with socket.create_connection(('127.0.0.1',port),timeout=5) as connection:
            headers=f'POST /api/audio/transcribe HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: {origin}\r\nCookie: {cookie}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\n\r\n'.encode()
            connection.sendall(headers+body)
        deadline=time.monotonic()+15
        while time.monotonic()<deadline:
            rows=Generation.objects.filter(user_id=identifier,kind='audio')
            if rows.count()==before+1 and rows.filter(status='succeeded').count()==before+1:break
            time.sleep(.05)
        else:raise RuntimeError('Disconnected audio did not complete')
        assert root.joinpath('calls').read_text().count('entered')==3
        print(json.dumps({'two_waiter_results':[status for status,_ in results],'health_latency_seconds':latency,'actual_client_socket_disconnected':True,'durable_jobs_completed':3,'provider_calls':3,'providers':'explicit offline','scope':'local Gunicorn two workers/four threads and actual Python generation worker; not hosted/image runtime'}))
    finally:
        for process in reversed(processes):
            if process.poll() is None:process.terminate()
            try:process.wait(timeout=10)
            except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
        for stream in streams:stream.close()
        Generation.objects.filter(user_id=identifier,kind='audio').delete()
        User.objects.filter(pk=identifier).delete()
