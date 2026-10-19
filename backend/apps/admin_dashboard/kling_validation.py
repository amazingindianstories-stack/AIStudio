"""No-task Kling validator: invalid n plus before/after task-list evidence."""
import base64
import io
import os
import re
from urllib.parse import urlsplit
from PIL import Image
from apps.generation.providers.kling import MODELS, api_host
from apps.generation.providers.transport import HttpTransport
from apps.generation.services.deadline import Cancellation


def rejected(result):
    data = result['json'].get('data') or {}
    return result['status'] >= 400 and result['json'].get('code') != 0 and not data.get('task_id') and not data.get('taskId')


def snapshot(result):
    data = result['json'].get('data')
    if result['status'] != 200 or result['json'].get('code') != 0 or not isinstance(data,(dict,list)): return None
    identifiers = set()
    def visit(value):
        if isinstance(value,dict):
            for key in ('task_id','taskId'):
                if isinstance(value.get(key),str): identifiers.add(value[key])
            for child in value.values(): visit(child)
        elif isinstance(value,list):
            for child in value: visit(child)
    visit(data)
    return sorted(identifiers)


def message(result):
    return str(result['json'].get('message') or '')


def classify_seed(baseline,valid,invalid):
    value = message(invalid)
    if re.search(r'unknown|unexpected|not support',value,re.I) and re.search('seed',value,re.I): return 'unsupported'
    if re.search('seed',value,re.I) and value != message(baseline): return 'supported'
    return 'inconclusive'


def run(*,env=None,transport=None,signal=None):
    env = os.environ if env is None else env
    key = env.get('KLING_API')
    if not key: return {'configured':False}
    host = api_host(env)
    transport = transport or HttpTransport(allowed_hosts=[urlsplit(host).hostname],timeout=20)
    signal = signal or Cancellation(20000)
    def call(path,body=None):
        signal.check()
        response = transport.request('POST' if body is not None else 'GET',host+path,
            headers={'Authorization':'Bearer '+key,'Content-Type':'application/json'},body=body,signal=signal)
        try: value = response.json()
        except (ValueError,TypeError): value = {}
        return {'status':response.status,'json':value if isinstance(value,dict) else {}}
    path = '/v1/images/generations?pageNum=1&pageSize=20'
    before = call(path)
    if before['status'] != 200 or before['json'].get('code') != 0:
        return {'configured':True,'authenticated':False,'noTaskCreated':True}
    output = io.BytesIO()
    Image.new('RGB',(512,512),'#c82828').save(output,format='PNG')
    reference = base64.b64encode(output.getvalue()).decode()
    def invalid(**body):
        # No diagnostic may send a valid n; task-list equality alone is insufficient.
        return call('/v1/images/generations',{'prompt':'validation-only',**body,'n':99})
    matrix, raw = {}, []
    for model in MODELS:
        for resolution in ('1k','2k'):
            for mode in ('t2i','i2i'):
                response = invalid(model_name=model['modelName'],resolution=resolution,aspect_ratio='1:1',**({'image':reference} if mode=='i2i' else {}))
                raw.append(response)
                text = message(response)
                matrix[f'{model["modelName"]}:{resolution}:{mode}'] = dict(resolutionRejected=bool(re.search('resolution',text,re.I)),
                    modelRejected=bool(re.search('model',text,re.I)),validationReachedN=bool(re.search(r'\bn\b',text,re.I)),rejectedWithoutTask=rejected(response))
    baseline = invalid(model_name=MODELS[0]['modelName'])
    valid = invalid(model_name=MODELS[0]['modelName'],seed=12345)
    invalid_seed = invalid(model_name=MODELS[0]['modelName'],seed='not-a-number')
    after = call(path)
    safety = all(rejected(item) for item in [*raw,baseline,valid,invalid_seed])
    before_ids,after_ids = snapshot(before),snapshot(after)
    stable = before_ids is not None and after_ids is not None and before_ids==after_ids
    return dict(configured=True,authenticated=True,requestSafetyPass=safety,taskListStable=stable,
        noTaskCreated=safety and stable,matrix=matrix,seedVerdict=classify_seed(baseline,valid,invalid_seed))


def results(value):
    def result(identifier,status,detail): return {'id':identifier,'status':status,'detail':detail}
    if not value.get('configured') or not value.get('authenticated'):
        detail = 'Kling authentication failed' if value.get('configured') else 'Kling validation credential is not configured'
        return [result(identifier,'unknown',detail) for identifier in ('ARCH-04','VER-08','VER-10')]
    if not value.get('noTaskCreated'):
        reason = 'task-list stability could not be proven' if value.get('requestSafetyPass') else 'one or more requests did not reject safely'
        return [result('ARCH-04','error','no-task invariant failed: '+reason),result('VER-08','error','no-task invariant failed: '+reason),
                result('VER-10','unknown','seed verdict suppressed because the no-task invariant failed')]
    matrix=value.get('matrix',{})
    routing_failed,resolution_failed=[],[]
    routing_passed=0
    for model in MODELS:
        model_pass=True
        for resolution in ('1k','2k'):
            for mode in ('t2i','i2i'):
                key=f'{model["modelName"]}:{resolution}:{mode}'
                entry=matrix.get(key,{})
                passed=bool(entry and not entry.get('modelRejected') and not entry.get('resolutionRejected') and entry.get('validationReachedN') and entry.get('rejectedWithoutTask'))
                if resolution=='1k' and not passed:
                    routing_failed.append(key);model_pass=False
                expected_rejection=model['modelName']=='kling-v2-1' and resolution=='2k' and mode=='i2i'
                if not (entry.get('resolutionRejected') and entry.get('rejectedWithoutTask') if expected_rejection else passed): resolution_failed.append(key)
        routing_passed+=int(model_pass)
    def labels(keys):
        grouped={}
        for key in keys:
            model,resolution,mode=key.split(':')
            grouped.setdefault(model,[]).append(f'{resolution}:{mode}')
        return ';'.join(f'{model}[{",".join(cases)}]' for model,cases in grouped.items())
    total=len(MODELS)*4
    routing_detail=f'{routing_passed}/{len(MODELS)} registered wire models reached safe validation; no task was created' if not routing_failed else f'{routing_passed}/{len(MODELS)} wire models matched; mismatches: {labels(routing_failed)}; no task was created'
    resolution_detail=f'resolution verdict suppressed; routing mismatches: {labels(routing_failed)}; no task was created' if routing_failed else f'{total-len(resolution_failed)}/{total} live 1K/2K text/reference cases matched configured capabilities; no task was created' if not resolution_failed else f'{total-len(resolution_failed)}/{total} capability cases matched; mismatches: {labels(resolution_failed)}; no task was created'
    seed=value.get('seedVerdict','inconclusive')
    return [result('ARCH-04','error' if routing_failed else 'ok',routing_detail),
        result('VER-08','unknown' if routing_failed else 'error' if resolution_failed else 'ok',resolution_detail),
        result('VER-10','unknown' if seed=='inconclusive' else 'ok','valid and invalid seed probes were inconclusive; support remains disabled; no task was created' if seed=='inconclusive' else f'validator conclusively classified seed as {seed}; no task was created')]
