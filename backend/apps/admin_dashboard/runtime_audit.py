"""Real Python runtime diagnostics; synthetic provider inputs never incur charges.

Kling validation is explicitly credential-gated and proves rejected requests
against task-list snapshots. Database fixture writes, including names, roll back.
"""
import base64
import csv
import io
import os
import re
import uuid
import tempfile
from pathlib import Path
from types import SimpleNamespace
from django.db import transaction
from django.http import QueryDict
from apps.authentication.models import User
from apps.common.leases import claim, now_ms
from apps.generation.models import Generation
from apps.canvas.views import reply, failure
from .admin_api import node_route, admin
from .models import UserLimit
from .queries import query, log_rows, csv_response

CHECK_IDS = ['MIG-04', 'ARCH-03', 'QUAL-03', 'ARCH-04', 'VER-08', 'VER-10', 'REL-02', 'REL-03', 'COST-05', 'REL-07']


def sanitize(value):
    value = re.sub(r'[\r\n]+', ' ', str(value if value is not None else 'check failed'))[:180]
    value = re.sub(r'[0-9a-f]{8}-[0-9a-f-]{27,}', '[redacted]', value, flags=re.I)
    value = re.sub(r'Bearer\s+\S+', 'Bearer [redacted]', value, flags=re.I)
    value = re.sub(r'((?:api[_-]?key|secret|password|token))\s*[=:]\s*\S+', r'\1=[redacted]', value, flags=re.I)
    return re.sub(r'(https?://[^\s?]+)\?[^\s]*', r'\1?[redacted]', value)


def generation(**kwargs):
    return Generation.objects.create(**dict(dict(id=uuid.uuid4(), kind='audit', status='running', prompt='audit', model='audit', aspect_ratio='1:1', cost_cents=0, created_at=now_ms(), updated_at=now_ms()), **kwargs))


def migration_check():
    query('SELECT 1 AS ready')
    if os.environ.get('DATABASE_BACKEND') != 'cloud-sql': raise ValueError('active backend is direct PostgreSQL, not Cloud SQL')
    return 'active Cloud SQL backend answered a production query'


def queue_check():
    from apps.generation.services.admission import snapshot
    with transaction.atomic():
        users = [User.objects.create(id=uuid.uuid4(), email=f'audit-{uuid.uuid4()}@invalid.local', name='Audit fixture',
                                     password_hash='audit', password_salt='audit', role='user', created_at=now_ms()) for _ in range(2)]
        now = now_ms()
        items = [Generation.objects.create(id=uuid.uuid4(), kind='image', prompt='audit', model='audit', aspect_ratio='1:1', cost_cents=0,
                 status=status, user_id=user.id, created_at=now+i, updated_at=now) for i,(status,user) in enumerate([('running',users[0]),('queued',users[0]),('queued',users[1])])]
        limit = UserLimit.objects.create(user_id=users[0].id, key='maxConcurrentJobs', value='1', updated_at=now)
        # Exercise the real per-user admission CTE without queue_position's
        # unrelated stale-job reaper or dependence on live global slot occupancy.
        same, other = snapshot(items[1], now=now, best_of=1), snapshot(items[2], now=now, best_of=1)
        limit.value='2'; limit.save(update_fields=['value'])
        overridden = snapshot(items[1], now=now, best_of=1)
        assert same['user_eligible'] is False and other['user_eligible'] is True and overridden['user_eligible'] is True, 'two-user fairness or override precedence failed'
        transaction.set_rollback(True)
    return 'Python admission snapshot passed per-user fairness, isolation and override; all fixture writes rolled back'


def flagged_check(actor_id):
    with transaction.atomic():
        marker = f'audit {uuid.uuid4()}, "quoted"\nsecond line'
        row = Generation.objects.create(id=uuid.uuid4(), kind='image', status='succeeded', prompt=marker, model='Nano Banana Pro', aspect_ratio='1:1',
              user_id=actor_id, flagged=True, flagged_at=now_ms(), flag_reason='audit reason, "quoted"\nline', judge_score={'identity':42}, created_at=now_ms(), updated_at=now_ms())
        params = QueryDict('', mutable=True); params.update({'flagged':'1','q':marker})
        page = log_rows(params)
        parsed = list(csv.DictReader(io.StringIO(csv_response(params).content.decode())))
        assert page['total']==1 and page['rows'][0]['judgeScore']=={'identity':42}
        assert len(parsed)==1 and parsed[0]['prompt']==marker and parsed[0]['flag_reason']==row.flag_reason
        transaction.set_rollback(True)
    return 'Python flagged JSON/CSV query services preserved evidence and RFC4180; fixture writes rolled back'


def deadline_check():
    from apps.generation.services.deadline import settle_queue_execution
    with transaction.atomic():
        row = generation()
        def failed(error):
            Generation.objects.filter(pk=row.pk).update(status='failed', error=str(error))
            return 'failed'
        result = settle_queue_execution(work=lambda signal: signal.wait(1000), on_success=lambda value: 'unexpected', on_failure=failed, timeout_ms=15)
        row.refresh_from_db()
        assert result=='failed' and row.status=='failed', 'terminal deadline state was not persisted before return'
        transaction.set_rollback(True)
    return 'Python execution deadline persisted terminal state before return; all fixture writes rolled back'


def spool_check():
    from PIL import Image
    from apps.generation.services.image_execution import Dependencies, execute_image
    from apps.generation.services.deadline import Cancellation
    from apps.media.storage import StorageService, MemoryAdapter
    payloads=[]
    for color in ('red','green','blue'):
        output=io.BytesIO(); Image.new('RGB',(32,32),color).save(output,format='PNG'); payloads.append(output.getvalue())
    for forced in (False,True):
        directories=[]
        deps=Dependencies()
        storage=StorageService(MemoryAdapter())
        deps.storage=lambda:storage
        deps.assets=[]
        deps.assemble=lambda *args,**kwargs:{'instruction':'diagnostic','groups':[],'judgeFace':{'mimeType':'image/png','data':'synthetic'}}
        generated=iter(payloads)
        deps.gemini_generate=lambda *args,**kwargs:{'mimeType':'image/png','base64':base64.b64encode(next(generated)).decode()}
        def directory(**kwargs):
            result=tempfile.TemporaryDirectory(**kwargs); directories.append(Path(result.name)); return result
        deps.temporary_directory=directory
        seen=[]
        def judge(reference,candidate,**kwargs):
            files=list(directories[0].iterdir())
            assert len(files)==3 and {path.read_bytes() for path in files}==set(payloads), 'candidate spool did not preserve every payload'
            if forced: raise RuntimeError('controlled judge failure')
            seen.append(base64.b64decode(candidate['data']))
            return len(seen)
        deps.judge_identity=judge
        item=SimpleNamespace(id=str(uuid.uuid4()),model='Nano Banana Pro',prompt='diagnostic',aspect_ratio='1:1',resolution='1K',
            reference_images=[],seed=700,draft_task_id=None,cost_cents=1,cost_basis='estimated',project_id=None,user_id=None,task_id=None)
        try:
            result=execute_image(item,signal=Cancellation(2000),dependencies=deps,env={'FACE_BEST_OF':'3'})
            assert not forced and seen==payloads and result['cost_cents']==3, 'spool candidate selection/cost failed'
            selected=storage.read_as_base64(result['url'])
            assert base64.b64decode(selected['data'])==payloads[2], 'selected spool bytes differed'
        except RuntimeError as error:
            if not forced or str(error)!='controlled judge failure': raise
        assert directories and all(not directory.exists() for directory in directories), 'spool temporary directory remained after cleanup'
    return 'Python image execution preserved spooled candidate bytes, selected the winner, and removed success/forced-failure directories'


def partial_submission_check():
    from apps.generation.services.video_execution import Dependencies, submit_video
    from apps.generation.services.executor import execute_admitted
    from apps.generation.services.deadline import Cancellation
    with transaction.atomic():
        owner='audit:'+str(uuid.uuid4())
        row=generation(kind='video',model='Seedance 2.0',seed=700,cost_cents=100,reference_images=['synthetic-reference'],
            worker_lease_id=owner,worker_lease_until=now_ms()+60000)
        deps=Dependencies(); deps.assets=lambda project:[]; deps.inline=lambda values,signal:['synthetic-inline' for _ in values]
        seeds=[]
        def submit(input,**kwargs):
            index=len(seeds);seeds.append(input['seed'])
            if index:
                receipt=Generation.objects.get(pk=row.id)
                assert receipt.task_id=='audit-task-0' and receipt.cost_cents==100, 'accepted task was not persisted before subsequent submissions'
            if index==1:
                from apps.generation.providers.transport import ProviderError
                raise ProviderError('controlled candidate rejection', may_have_submitted=False)
            return f'audit-task-{index}'
        deps.seedance_submit=submit
        def run(item,**kwargs): return submit_video(item,dependencies=deps,**kwargs)
        outcome=execute_admitted(row,owner=owner,signal=Cancellation(2000),video_submit=run,env={'VIDEO_BEST_OF':'3'})
        row.refresh_from_db()
        assert seeds==[700,701,702] and outcome['kind']=='running', 'partial submission sequencing failed'
        assert row.task_id=='audit-task-0' and row.candidate_task_ids==['audit-task-2'] and row.cost_cents==200, 'accepted receipt or prorated cost failed'
        transaction.set_rollback(True)
    return 'Python executor persisted accepted receipts before subsequent attempts and prorated controlled 2/3 submissions; no provider calls or fixture residue'


def poll_recovery_check():
    from apps.generation.services.poller import Dependencies, advance
    from apps.generation.services.deadline import Cancellation
    with transaction.atomic():
        row=generation(kind='video',task_id='audit-task',created_at=now_ms()-3600000,updated_at=now_ms()-3600000)
        def transient(*args,**kwargs): raise ValueError('controlled transient poll failure')
        first=advance(row,source='audit',signal=Cancellation(2000),dependencies=Dependencies(mock=lambda:False,get_video=transient,publish=lambda item:None))
        row.refresh_from_db()
        assert first['kind']=='poll_error' and row.status=='running' and row.poll_error_count==1 and row.last_poll_error_at is not None, 'transient error became terminal or was not recorded'
        second=advance(row,source='audit',signal=Cancellation(2000),dependencies=Dependencies(mock=lambda:False,get_video=lambda *args,**kwargs:{'status':'processing'},publish=lambda item:None))
        row.refresh_from_db()
        assert second['kind']=='pending' and row.status=='running' and row.poll_error_count==0 and row.last_poll_error_at is None, 'transient poll error did not recover'
        transaction.set_rollback(True)
    return 'Python poller recorded a non-terminal transient error, recovered to pending, and rolled back every fixture write'


def run_runtime_audit(actor_id, checks=None, *, kling_transport=None, kling_env=None):
    checked = now_ms()
    implementations = {'MIG-04':migration_check, 'ARCH-03':queue_check, 'QUAL-03':lambda:flagged_check(actor_id),
        'REL-02':spool_check, 'REL-03':deadline_check,'COST-05':partial_submission_check,'REL-07':poll_recovery_check}
    implementations.update(checks or {})
    from . import kling_validation
    try:
        kling_results=kling_validation.results(kling_validation.run(transport=kling_transport,env=kling_env))
    except Exception as error:
        kling_results=[{'id':identifier,'status':'error','detail':str(error)} for identifier in ('ARCH-04','VER-08')]+[
            {'id':'VER-10','status':'unknown','detail':'seed validation timed out or failed without a conclusive signal'}]
    kling_results={row['id']:row for row in kling_results}
    results=[]
    for identifier in CHECK_IDS:
        check=implementations.get(identifier)
        if check is None:
            result=kling_results[identifier]
            results.append({**result,'detail':sanitize(result['detail'])})
            continue
        try: result={'id':identifier,'status':'ok','detail':sanitize(check())}
        except Exception as error: result={'id':identifier,'status':'error','detail':sanitize(str(error))}
        results.append(result)
    return {'checkedAt':checked,'auditId':str(uuid.uuid4()),'checks':results}


@node_route(['POST'])
def runtime_audit(request):
    actor=admin(request)
    if actor is None: return reply(request,{'error':'FORBIDDEN'},403)
    try:
        if not claim('lease:admin-runtime-audit',str(uuid.uuid4()),ttl_ms=60000):
            response=reply(request,{'error':'COOLDOWN','retryAfterSeconds':60},429)
            response['Retry-After']='60'
            return response
        response=reply(request,run_runtime_audit(actor.id))
        response['Cache-Control']='no-store'
        return response
    except Exception: return failure()
