"""Actual disposable worker SIGKILL/restart evidence; injected offline audio only."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

if os.environ.get('MIGRATION_TEST_ISOLATED')!='1' or Path.cwd().name!='repo':
    raise SystemExit('Verified isolation runner required')
sys.path.insert(0,str(Path('backend').resolve()))
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.test'
import django
django.setup()
from apps.generation.models import Generation
from apps.media.storage import StorageService,FileSystemAdapter
from apps.media.audio_inputs import capture_audio_input
from apps.generation.services.audio_submission import AUDIO_READY
from apps.common.leases import now_ms
from uuid import uuid4
subprocess.run([sys.executable,'backend/manage.py','migrate','--noinput'],check=True,stdout=subprocess.DEVNULL)
identifier=uuid4()
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'],prefix='audio-restart-') as folder:
    root=Path(folder)
    storage=StorageService(FileSystemAdapter(root/'media'))
    snapshot=capture_audio_input(storage,'data:audio/wav;base64,YWJj',identifier,model='fixture',name='restart')
    row=Generation.objects.create(id=identifier,kind='audio',status='queued',prompt='',model='Gemini (fixture)',
        aspect_ratio='audio',user_id=uuid4(),provider_status=AUDIO_READY,submission_input=snapshot,
        created_at=now_ms(),updated_at=now_ms())
    code="""import os,sys,time
sys.path.insert(0,'backend')
os.environ['DJANGO_SETTINGS_MODULE']='config.settings.test'
import django;django.setup()
from pathlib import Path
from apps.generation.services.audio_submission import process_audio
from apps.generation.services.deadline import Cancellation
from apps.media.storage import StorageService,FileSystemAdapter
class Offline:
 def transcribe(self,*args,**kwargs):
  with open(sys.argv[2]+'/provider-calls','a') as record:record.write('entered\\n');record.flush()
  if sys.argv[3]=='block':
   while True:time.sleep(.1)
  return 'offline transcript'
result=process_audio(sys.argv[1],'audio:restart-probe',signal=Cancellation(),provider=Offline(),storage=StorageService(FileSystemAdapter(Path(sys.argv[2])/'media')))
print(result['kind'],flush=True)
"""
    process=None
    try:
        process=subprocess.Popen([sys.executable,'-c',code,str(identifier),folder,'block'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        deadline=time.monotonic()+15
        calls=root/'provider-calls'
        while not calls.exists():
            if process.poll() is not None:
                raise RuntimeError('Worker exited before provider entry: '+process.communicate()[1][-1000:])
            if time.monotonic()>deadline:raise TimeoutError('Provider entry not observed')
            time.sleep(.02)
        process.kill()
        process.communicate(timeout=5)
        assert process.returncode==-9,process.returncode
        row.refresh_from_db()
        assert row.status=='running' and row.provider_status=='SUBMISSION_PENDING'
        before=Generation.objects.filter(pk=row.id).values().get()
        restarted=subprocess.run([sys.executable,'-c',code,str(identifier),folder,'finish'],capture_output=True,text=True,timeout=15,check=True)
        assert restarted.stdout.strip()=='unclaimed',restarted.stdout
        assert calls.read_text()=='entered\n'
        assert Generation.objects.filter(pk=row.id).values().get()==before
        assert storage.read_reference_bytes(snapshot['source'])['bytes']==b'abc'
        print(json.dumps({'actual_worker_sigkill':True,'restart_outcome':'unclaimed','provider_calls':1,
            'pending_row_exactly_preserved':True,'original_snapshot_preserved':True,
            'scope':'verified disposable local database/storage; injected provider; no live billing'}))
    finally:
        if process is not None and process.poll() is None:
            process.kill();process.communicate(timeout=5)
        Generation.objects.filter(pk=identifier).delete()
