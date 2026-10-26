"""BytePlus Seedance task contracts, including native MOV for every 2.5 path."""
import json
import math
import os
import re
from urllib.parse import quote
from apps.generation.model_registry import capability,is_provider_model,provider_model_id
from apps.generation.prompting.shot_spec import parse_ref_roles
from apps.generation.prompting.video_directive import build_video_directive
from apps.generation.prompting.legacy_templates import T as LEGACY
from apps.generation import provider_errors
from apps.integrations.transport import HttpTransport,ProviderError,required_key

MODERATION_MESSAGE = "BytePlus rejected the reference image - its privacy / anti-deepfake filter flags photorealistic faces (it can't tell an AI-generated face from a real one). Retry as text-to-video, or use a clearly stylized reference."


class SeedanceError(ProviderError):
    pass


def legacy_directive(env=None):
    return (os.environ if env is None else env).get('SEEDANCE_LEGACY_DIRECTIVE') == '1'


def is_moderation_message(text):
    return bool(re.search('SensitiveContent|Privacy|real person|portrait|sensitive',text or '',re.I))


TEXT_POLICY_MESSAGE = 'The video provider rejected the prompt under its text content policy. Review the prompt before submitting a new request.'
NEUTRAL_POLICY_MESSAGE = 'The video provider rejected the input under its content policy. Change the prompt or references before submitting a new request.'
EXPIRED_MESSAGE = 'The video provider expired this task before it finished, so no video was generated. Submit a new request to try again.'


def friendly_error(status,body):
    code,message = '',''
    try:
        error = json.loads(body).get('error') or {}
        code,message = error.get('code',''),error.get('message','')
    except (ValueError,AttributeError):
        pass
    if code != 'InvalidEndpointOrModel.NotFound' and status != 404 and is_moderation_message(code+message):
        result = SeedanceError(MODERATION_MESSAGE,code='moderation',status=status)
    else:
        result = SeedanceError(f'Seedance error ({status} {code}): {message or body[:300]}' if code else
            f'Seedance create error {status}: {body[:400]}',code='seedance_error',status=status)
    result.upstream_code = code      # the BytePlus error code, kept for callers that need it (not persisted)
    if status == 404 or code == 'InvalidEndpointOrModel.NotFound':
        return result
    # Name the policy that rejected the request; code/status stay unchanged.
    if code == 'InputTextSensitiveContentDetected' or code.startswith('InputTextSensitiveContentDetected.'):
        result.args = (TEXT_POLICY_MESSAGE, *result.args[1:])
    elif code == 'InputImageSensitiveContentDetected.PrivacyInformation':
        result.args = (MODERATION_MESSAGE, *result.args[1:])
    elif result.code == 'moderation':
        result.args = (NEUTRAL_POLICY_MESSAGE, *result.args[1:])
    return result


def pick_model(display,env=None):
    if not is_provider_model(display or 'Seedance 2.0','byteplus'):
        raise ValueError(f'Unknown BytePlus model: {display or "(missing)"}')
    return provider_model_id(display or 'Seedance 2.0',env)


def build_ref_roles(refs,prompt):
    parsed = parse_ref_roles(prompt)
    roles = {}
    for index,ref in enumerate(refs,1):
        role = {'character':'person','location':'location','style':'style','prop':'prop','outfit':'outfit'}.get(str(ref.get('kind','')).lower()) if ref.get('kind') else parsed.get(ref.get('tag'))
        if role:
            roles[ref.get('index',index)] = role
    return roles or None


def tags_to_image_refs(prompt,refs=None):
    for index,ref in enumerate(refs or [],1):
        if ref.get('tag'):
            prompt = re.sub(re.escape(ref['tag'])+r'(?!\w)',lambda _:f'[image {ref.get("index",index)}]',prompt,flags=re.I|re.ASCII)
    prompt = re.sub(r'@img([0-9]+)',lambda m:f'[image {m[1]}]',prompt,flags=re.I)
    return re.sub(r'@vid([0-9]+)',lambda m:f'[video {m[1]}]',prompt,flags=re.I)


def video_task_payload(input,env=None):
    env = os.environ if env is None else env
    display = input.get('modelDisplay')
    model = pick_model(display,env)
    modern = capability(display,'editExtend')
    refs = [{**ref,'index':index} if modern else ref for index,ref in enumerate(input.get('references') or [],1)]
    limit = capability(display,'maxReferenceImages',None)
    if limit is not None and len(refs) > limit:
        raise SeedanceError(f'{display or "Seedance"} accepts at most {limit} reference images (got {len(refs)}).',code='too_many_reference_images',status=400)
    mode = input.get('taskMode') or 'generate'
    if mode not in ('generate','edit','extend'):
        raise SeedanceError('Unsupported video task mode.',code='invalid_task_mode',status=400)
    if mode != 'generate' and (not modern or not input.get('referenceVideoUrls')):
        raise SeedanceError('Edit/Extend require Seedance 2.5 and a source video.',code='missing_source_video',status=400)
    if mode != 'generate' and (input.get('firstFrame') or input.get('lastFrame')):
        raise SeedanceError('Frame generation cannot be combined with Edit/Extend.',code='invalid_frame_task',status=400)
    prompt = re.sub(r'@audio([0-9]+)',lambda m:f'[audio {m[1]}]',tags_to_image_refs(input['prompt'].strip(),refs),flags=re.I)
    if mode in ('edit','extend'):
        text = ('Edit the attached reference video as follows: ' if mode == 'edit' else 'Extend the attached reference video forward in time: ')+prompt
    elif legacy_directive(env):
        text = (LEGACY['one' if len(refs) == 1 else 'many'] if refs else '')+prompt
    else:
        text = build_video_directive({'prompt':prompt,'refCount':len(refs),'tagSyntax':'bracket','refRoles':build_ref_roles(refs,input['prompt'])})
    if modern:
        text = re.sub(r'\[(image|video|audio) ([0-9]+)\]',lambda m:f'@{m[1].capitalize()} {m[2]}',text,flags=re.I)
    content = [{'type':'text','text':text}]
    content.extend({'type':'image_url','image_url':{'url':ref['dataUrl']},'role':env.get('SEEDANCE_IMAGE_ROLE') or 'reference_image'} for ref in refs)
    for role,key in (('first_frame','firstFrame'),('last_frame','lastFrame')):
        frame = input.get(key)
        if frame:
            if key == 'lastFrame' and not input.get('firstFrame'):
                raise SeedanceError('A first frame is required when providing a last frame.',code='missing_first_frame',status=400)
            content.append({'type':'image_url','image_url':{'url':frame.get('dataUrl') or frame.get('url')},'role':role})
    videos = input.get('referenceVideoUrls') or []
    audios = input.get('referenceAudioUrls') or []
    video_limit = capability(display,'maxReferenceVideos',None) or 10
    audio_limit = 10 if modern else 3
    for values,limit,kind in ((videos,video_limit,'videos'),(audios,audio_limit,'audios')):
        if len(values) > limit:
            raise SeedanceError(f'{display or "Seedance"} accepts at most {limit} reference {kind} (got {len(values)}).',code='too_many_reference_'+kind,status=400)
    content.extend({'type':'video_url','video_url':{'url':url},'role':'reference_video'} for url in videos)
    content.extend({'type':'audio_url','audio_url':{'url':url},'role':'reference_audio'} for url in audios)
    body = {'model':model,'content':content,'generate_audio':input.get('generateAudio') is True}
    if modern:
        body['output_format'] = 'mov'
    if modern and not input.get('firstFrame') and any(item.get('role') in ('reference_image','reference_video','reference_audio') for item in content):
        body['omni_reference_task_type'] = 'reference' if mode == 'generate' else mode
    if capability(display,'draft'):
        body['draft'] = input.get('draftMode') is True
    if not display or capability(display,'bitrate'):
        body['bitrate_mode'] = 'standard' if input.get('bitrateMode') == 'standard' else 'high'
    if isinstance(input.get('callbackUrl'),str) and re.match('^https://',input['callbackUrl'],re.I):
        body['callback_url'] = input['callbackUrl']
    if mode in ('edit','extend'):
        body['ratio'] = 'adaptive'
        body['duration'] = -1 if mode == 'edit' else input.get('duration') or -1
    elif input.get('firstFrame'):
        body['ratio'] = 'adaptive'
        if input.get('duration'):
            body['duration'] = input['duration']
    else:
        for field in ('ratio','duration'):
            if input.get(field):
                body[field] = input[field]
    if input.get('resolution'):
        body['resolution'] = input['resolution']
    if type(input.get('seed')) in (int,float):
        body['seed'] = input['seed']
    return body


def final_video_task_payload(input,env=None):
    body = {'model':pick_model(input.get('modelDisplay'),env),
        'content':[{'type':'draft_task','draft_task':{'id':input['draftTaskId']}}],
        'resolution':'1080p','output_format':'mov'}
    if isinstance(input.get('callbackUrl'),str) and re.match('^https://',input['callbackUrl'],re.I):
        body['callback_url'] = input['callbackUrl']
    return body


def _submit(input,body,*,env=None,transport=None,signal=None,final=False):
    env = os.environ if env is None else env
    key = required_key(env,'ARK_API_KEY','ARK_API_KEY is not set. Add it to the backend environment (Seedance / BytePlus ModelArk).')
    transport = transport or HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com'])
    endpoint = (env.get('ARK_BASE_URL') or 'https://ark.ap-southeast.bytepluses.com/api/v3').rstrip('/')
    response = transport.request('POST',endpoint+'/contents/generations/tasks',
        headers={'Content-Type':'application/json','Authorization':'Bearer '+key},body=body,signal=signal or input.get('signal'))
    if not response.ok:
        error = friendly_error(response.status,response.text)
        # Explicit client rejection is safe to continue. Timeout/gateway/server
        # failures cannot establish whether a paid task was accepted remotely.
        error.may_have_submitted = not (400 <= response.status < 500 and response.status != 408)
        error.provider_response = provider_errors.capture('seedance',phase='finalize' if final else 'create',
            status=response.status,body=response.text,headers=response.headers)
        raise error
    result = response.json()
    identifier = result.get('id') or result.get('task_id') or (result.get('data') or {}).get('id')
    if not identifier:
        raise SeedanceError(f'Seedance {"finalization" if final else "create"}: no task id in response.')
    return identifier


def create_video_task(input,*,env=None,transport=None,signal=None):
    return _submit(input,video_task_payload(input,env),env=env,transport=transport,signal=signal)


def create_final_video_task(input,*,env=None,transport=None,signal=None):
    return _submit(input,final_video_task_payload(input,env),env=env,transport=transport,signal=signal,final=True)


def normalize_video_task_payload(payload=None):
    payload = payload or {}
    source = payload.get('data') if isinstance(payload.get('data'),dict) else payload
    raw_status = str(source.get('status') or source.get('state') or '').lower()
    status = 'succeeded' if raw_status == 'succeeded' else 'cancelled' if raw_status == 'cancelled' else 'failed' if raw_status in ('failed', 'expired') else 'queued' if raw_status == 'queued' else 'running'
    result = {'status':status,'raw':payload}
    content = source.get('content') or {}
    content = content[0] if isinstance(content,list) and content else content
    url = (content.get('video_url') if isinstance(content,dict) else None) or source.get('video_url')
    if url:
        result['videoUrl'] = url
    if source.get('output_format') in ('mov','mp4'):
        result['outputFormat'] = source['output_format']
    if status == 'failed':
        error = source.get('error')
        result['error'] = (error.get('message') if isinstance(error,dict) else None) or error or (
            EXPIRED_MESSAGE if raw_status == 'expired' else 'Generation failed')
        # The task's own failure (code, message, task id) for the row's provider_responses and the user's message.
        result['providerError'] = provider_errors.capture('seedance',phase='task',body=json.dumps(source,default=str),
            task_id=source.get('id') if isinstance(source.get('id'),str) else None)
    tokens = (source.get('usage') or {}).get('total_tokens')
    if type(tokens) in (int,float) and math.isfinite(tokens):
        result['totalTokens'] = tokens
    for target,first,second in [('providerCreatedAt','created_at','createdAt'),('providerUpdatedAt','updated_at','updatedAt'),('providerStatus','status','state')]:
        value = source.get(first) if source.get(first) is not None else source.get(second)
        if value is not None:
            result[target] = value
    return result


def get_video_task(task_id,options=None,*,env=None,transport=None,signal=None):
    env = os.environ if env is None else env
    key = required_key(env,'ARK_API_KEY')
    transport = transport or HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com'])
    endpoint = (env.get('ARK_BASE_URL') or 'https://ark.ap-southeast.bytepluses.com/api/v3').rstrip('/')
    response = transport.request('GET',endpoint+'/contents/generations/tasks/'+quote(task_id,safe=''),
        headers={'Authorization':'Bearer '+key},signal=signal or (options or {}).get('signal'))
    if not response.ok:
        raise SeedanceError(f'Seedance poll error {response.status}: {response.text[:500]}',status=response.status,
            provider_response=provider_errors.capture('seedance',phase='status',status=response.status,body=response.text,
                headers=response.headers,task_id=task_id))
    return normalize_video_task_payload(response.json())


def cancel_video_task(task_id, *, env=None, transport=None, signal=None):
    """Queued-only cancellation; DELETE can also remove a finished record.

    This intentionally returns no terminal status. Callers must reconcile by GET.
    """
    env = os.environ if env is None else env
    key = required_key(env, 'ARK_API_KEY')
    transport = transport or HttpTransport(allowed_hosts=['ark.ap-southeast.bytepluses.com'])
    endpoint = (env.get('ARK_BASE_URL') or 'https://ark.ap-southeast.bytepluses.com/api/v3').rstrip('/')
    response = transport.request('DELETE', endpoint + '/contents/generations/tasks/' + quote(task_id, safe=''),
        headers={'Authorization': 'Bearer ' + key}, signal=signal)
    if not response.ok:
        raise SeedanceError('Seedance cancellation was not confirmed.', status=response.status)
