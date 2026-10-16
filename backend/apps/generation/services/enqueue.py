"""Source-compatible enqueue validation and durable generation insertion."""
import logging
import re
import time
from urllib.parse import unquote
import math
import uuid
from django.db import transaction
from apps.admin_dashboard.models import AppSetting, UserLimit
from apps.admin_dashboard.views import LIMITS, parse
from apps.assets.models import Asset
from apps.assets.views import serialize as asset_json
from apps.canvas.serialization import JS_WHITESPACE
from apps.common.javascript import UNDEFINED, truthy, string, utf16_length
from apps.common.leases import now_ms
from apps.common.responses import log_activity
from apps.generation.model_registry import capability, is_provider_model
from apps.generation.models import Generation
from apps.generation.providers.seedream import seedream_size, resolve_seedream_references
from apps.generation.serialization import camel
from apps.generation.references import mention_indices, reference_warnings
from apps.library.services.naming import assign_generation_naming
from apps.media.audio_duration import audio_seconds
from apps.media.audio_inputs import MAX_AUDIO_BYTES
from apps.media.images import save_reference_images
from apps.media.storage import get_storage
from .pricing import compute_cost, read_pricing
from .seedream_references import prepare_seedream_references, require_native_image_runtime

logger = logging.getLogger(__name__)


class InvalidRequest(ValueError):
    pass


def integer(value):
    return type(value) in (int,float) and math.isfinite(value) and value == int(value)


def default(value, fallback):
    return value if truthy(value) else fallback


def trim(value):
    value = default(value,'')
    if not isinstance(value,str): raise TypeError('Value does not support trim')
    return value.strip(JS_WHITESPACE)


def clean(values):
    return {key:value for key,value in values.items() if value is not UNDEFINED}


def prompt_limit(user_id=None):
    raw = None
    override = UserLimit.objects.filter(user_id=user_id,key='maxPromptLength').first() if user_id else None
    if override:
        raw = override.value
    else:
        raw = AppSetting.objects.filter(key='maxPromptLength').values_list('value',flat=True).first()
    return parse(raw,LIMITS['maxPromptLength'])


def validate_prompt(prompt,user_id=None):
    if not prompt: raise InvalidRequest('Prompt is required.')
    maximum = prompt_limit(user_id)
    length = utf16_length(prompt)
    if length > maximum:
        raise InvalidRequest(f'Prompt is too long (max {maximum} characters, this one is {length}). An admin can raise this limit from the dashboard.')


def image_input(body, user_id):
    model = default(body.get('model'),'Nano Banana Pro')
    resolution = body.get('resolution')
    if resolution is None: resolution = '2K' if is_provider_model(body.get('model'),'seedream') else UNDEFINED
    item = dict(kind='image',prompt=trim(body.get('prompt')),model=model,
        aspectRatio=default(body.get('aspectRatio'),'1:1'),resolution=resolution,
        projectId=default(body.get('projectId'),UNDEFINED),folderId=default(body.get('folderId'),UNDEFINED),
        seed=body['seed'] if capability(model,'seed') and integer(body.get('seed')) else UNDEFINED)
    validate_prompt(item['prompt'],user_id)
    return clean(item)


def video_input(body, user_id=None):
    model = default(body.get('model'),'Higgsfield Seedance 2.0')
    prompt, ratio, resolution = trim(body.get('prompt')), default(body.get('aspectRatio'),'16:9'), default(body.get('resolution'),'1080p')
    if 'bitrateMode' in body and body['bitrateMode'] not in ('standard','high'):
        raise InvalidRequest('Bitrate must be either standard or high.')
    controls = {}
    if capability(model,'draft'): controls['draftMode'] = body.get('draftMode') is True
    if capability(model,'bitrate'): controls['bitrateMode'] = body.get('bitrateMode','high')
    if controls.get('draftMode') and resolution != '480p': raise InvalidRequest('Seedance 2.5 draft generations must use 480p resolution.')
    max_videos = capability(model,'maxReferenceVideos',None)
    if max_videos is None: max_videos = 10
    def references(name, enabled, maximum):
        source = body.get(name)
        return [value for value in source if isinstance(value,str) and value][:maximum] if enabled and isinstance(source,list) else []
    videos = references('referenceVideos',capability(model,'videoReference'),max_videos)
    max_audios = 10 if capability(model,'editExtend') else 3
    if capability(model,'audio') and isinstance(body.get('referenceAudios'),list) and len(body['referenceAudios']) > max_audios:
        raise InvalidRequest(f'{string(model)} accepts at most {max_audios} reference audio clips (got {len(body["referenceAudios"])}).')
    audios = references('referenceAudios',capability(model,'audio'),max_audios)
    mode = body.get('videoTaskMode') if body.get('videoTaskMode') in ('generate','edit','extend') else 'generate'
    duration = default(body.get('duration'),UNDEFINED if mode == 'edit' else 5)
    frames = capability(model,'firstLastFrame') or capability(model,'firstFrameContinuation')
    first = body.get('firstFrame') if isinstance(body.get('firstFrame'),str) else body.get('continuationFrame')
    first = first if frames and isinstance(first,str) else UNDEFINED
    last = body.get('lastFrame') if frames and isinstance(body.get('lastFrame'),str) else UNDEFINED
    if mode != 'generate' and (truthy(first) or truthy(last)): raise InvalidRequest('Frame generation cannot be combined with Edit/Extend.')
    if truthy(last) and not truthy(first): raise InvalidRequest('A first frame is required when providing a last frame.')
    if not prompt: raise InvalidRequest('Prompt is required.')
    max_images = capability(model,'maxReferenceImages',None)
    images = body.get('referenceImages')
    if max_images is not None and isinstance(images,list) and len(images)>max_images:
        raise InvalidRequest(f'{string(model)} accepts at most {max_images} reference images (got {len(images)}).')
    validate_prompt(prompt,user_id)
    if isinstance(body.get('referenceVideos'),list) and len(body['referenceVideos'])>max_videos and capability(model,'videoReference'):
        raise InvalidRequest(f'{string(model)} accepts at most {max_videos} reference clips (got {len(body["referenceVideos"])}).')
    resolutions = capability(model,'resolutions',['480p','720p','1080p'])
    if resolutions and resolution not in resolutions:
        raise InvalidRequest(f'{string(model)} supports {"/".join(resolutions)} only (got {string(resolution)}).')
    bounds = capability(model,'durationRange',None)
    if mode != 'edit' and bounds and duration is not None and (not integer(duration) or not bounds['min']<=duration<=bounds['max']):
        raise InvalidRequest(f'{string(model)} supports {bounds["min"]}-{bounds["max"]}s durations (got {string(duration)}).')
    if mode != 'generate':
        if not capability(model,'editExtend'): raise InvalidRequest(f'{string(model)} does not support {"Edit" if mode == "edit" else "Extend"}.')
        if not videos: raise InvalidRequest(f'Attach a reference clip to {"edit" if mode == "edit" else "extend"} a video.')
    if is_provider_model(model,'omni'):
        if ratio not in capability(model,'aspectRatios',[]): raise InvalidRequest(f'Gemini Omni Flash supports 16:9/9:16 aspect ratios only (got {string(ratio)}).')
        durations = capability(model,'durations',[])
        if not integer(duration) or duration not in durations:
            raise InvalidRequest(f'Gemini Omni Flash supports {"/".join(map(str,durations))}s durations (got {string(duration)}).')
    return clean(dict(kind='video',prompt=prompt,model=model,aspectRatio=ratio,resolution=resolution,duration=duration,
        generateAudio=body.get('generateAudio') is True and bool(capability(model,'audio')),
        referenceVideos=videos if videos else UNDEFINED,referenceAudios=audios if audios else UNDEFINED,
        firstFrame=first,lastFrame=last,**controls,videoTaskMode=mode if mode != 'generate' else UNDEFINED,
        projectId=default(body.get('projectId'),UNDEFINED),folderId=default(body.get('folderId'),UNDEFINED),
        seed=body['seed'] if capability(model,'seed') and integer(body.get('seed')) else UNDEFINED,
        sourceGenerationId=None,draftTaskId=None))


def has_length(value):
    return bool(value) if isinstance(value,(str,list)) else bool(value.get('length')) if isinstance(value,dict) else False


def assets():
    return [asset_json(row) for row in Asset.objects.all()]


def prepare_image(item, body, identifier, user_id):
    references = body.get('referenceImages')
    reference_count = None
    if is_provider_model(item['model'],'seedream'):
        try:
            seedream_size(item.get('resolution','2K'),item['aspectRatio'])
            resolved = resolve_seedream_references(item['prompt'],assets(),references if references is not None else [])
            if resolved['references']:
                require_native_image_runtime()
        except ValueError as error:
            raise InvalidRequest(str(error)) from error
        # Storage failures are internal errors, not public input validation.
        references = save_reference_images(references if references is not None else [],identifier)
        try:
            resolved = resolve_seedream_references(item['prompt'],assets(),references)
            reference_count = len(resolved['references'])
            prepare_seedream_references(resolved['references'],identifier,user_id=user_id,sign=False,persist=False)
        except ValueError as error:
            raise InvalidRequest(str(error)) from error
    cost_input = {**item,'hasReferenceImage':has_length(references)}
    if reference_count is not None: cost_input['referenceCount'] = reference_count
    prepared = {'costCents':compute_cost(cost_input,read_pricing())}
    if has_length(references): prepared['referenceImages'] = save_reference_images(references,identifier)
    return prepared


def registered_portrait_ids(item, body):
    """Registered BytePlus portrait identities referenced by a video request."""
    values = list(body.get('referenceImages') or [])
    values.extend(item.get(key) for key in ('firstFrame', 'lastFrame', 'continuationFrame'))
    result = []
    for value in values:
        if not isinstance(value, str):
            continue
        identifier = None
        if value.startswith('asset://'):
            identifier = value[len('asset://'):]
        elif '#bp_asset_id=' in value:
            fragment = value.split('#', 1)[1]
            identifier = unquote(fragment[len('bp_asset_id='):]) if fragment.startswith('bp_asset_id=') else None
        if identifier is None:
            continue
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,256}', identifier):
            raise ValueError('Invalid registered portrait identity.')
        if identifier not in result:
            result.append(identifier)
    if len(result) > 50:
        raise ValueError('Too many registered portrait references.')
    return result


def verify_registered_portraits(item, body, client_factory=None):
    """Stop before queueing (and billing) when a registered portrait is gone at BytePlus."""
    try:
        refs = registered_portrait_ids(item, body)
        if refs:
            if client_factory is None:
                from apps.assets.byteplus_readonly import get_asset_client as client_factory
            client = client_factory()
            for ref in refs:
                remote = client.get_asset(ref, project_name='default')
                if (not isinstance(remote, dict) or remote.get('Id') != ref or str(remote.get('Status', '')).lower() != 'active'
                        or remote.get('ProjectName', 'default') != 'default'):
                    raise ValueError('inactive')
    except Exception:
        raise InvalidRequest('Portrait unavailable or remote registration could not be verified. No generation was queued.') from None


class PortraitUnavailable(InvalidRequest):
    def __init__(self, message, reference_index=None):
        super().__init__(message)
        self.reference_index = reference_index


def portrait_reference_problem(portrait):
    """Why a Gallery portrait cannot be sent to Seedance, or None when it can."""
    if portrait is None:
        return None
    status = str(portrait.get('status') or '').lower()
    if portrait.get('byteplusAssetId') and status == 'active':
        return None
    if status in ('previewdeleted', 'deleted'):
        return 'was removed from the Portrait Gallery'
    if status in ('failed', 'error', 'rejected'):
        return 'could not be prepared for video'
    return 'is not ready for video yet'


def verify_portrait_references(item, body, lookup=None):
    """Refuse at submit time what the worker would refuse later (deleted or unready portraits).

    Plain portrait URLs are looked up locally; nothing is sent to a provider.
    Applies to the native Seedance path, the one that resolves Gallery portraits.
    """
    model = item.get('model') or ''
    if is_provider_model(model, 'omni') or is_provider_model(model, 'higgsfield'):
        return
    if lookup is None:
        from apps.assets.portrait_db import get_portrait_asset_by_image_url as lookup
    labelled = [(f'Reference {index}', value, index) for index, value in enumerate(body.get('referenceImages') or [], start=1)]
    labelled += [(label, item.get(key), None) for key, label in (('firstFrame', 'The first frame'), ('lastFrame', 'The last frame'),
                                                                 ('continuationFrame', 'The continuation frame'))]
    for label, value, index in labelled:
        if not isinstance(value, str) or not value or value.startswith(('asset://', 'data:')) or re.search(r'[?&#]bp[-_]asset', value):
            continue
        try:
            portrait = lookup(value)
            problem = portrait_reference_problem(portrait)
        except Exception:
            raise InvalidRequest('Portraits could not be checked right now. Try again; nothing was queued.') from None
        if problem:
            name = portrait.get('name')
            named = f'{label} ("{str(name)[:80]}")' if name else label
            raise PortraitUnavailable(f'{named} {problem}. Remove it from the references and try again; nothing was queued.', index)


class ReferenceAudioRejected(InvalidRequest):
    def __init__(self, message, audio_index=None):
        super().__init__(message)
        self.audio_index = audio_index


# BytePlus enforces a 30 s clip limit as "<= 30.2"; match what it really accepts.
AUDIO_LIMIT_SLACK_SECONDS = 0.2
# Measuring runs inside the enqueue request (gunicorn times out at 25 s), and a model may take
# up to 10 clips. Past this budget the remaining clips are left to the provider.
AUDIO_CHECK_BUDGET_SECONDS = 8.0


def verify_reference_audio_durations(item, measure=None, *, budget_seconds=AUDIO_CHECK_BUDGET_SECONDS, clock=time.monotonic):
    """Refuse audio the provider would reject on length, before anything is queued.

    A clip that cannot be read or measured, or is reached after the time
    budget, is let through: the provider stays the authority, and a measuring
    problem here must never block an artist or time out the request.
    Only the clips the worker sends are checked: the @audioN tags the prompt
    names, or every clip when it names none (resolve_references).
    """
    limits = capability(item.get('model'), 'referenceAudioSeconds', None)
    refs = item.get('referenceAudios') or []
    if not limits or not refs:
        return
    measure = measure or measure_reference_audio
    rule = (f'{string(item.get("model"))} accepts reference audio clips of '
            f'{limits["clipMin"]}-{limits["clipMax"]}s each and {limits["totalMax"]}s in total')
    sent = [n for n in mention_indices(item.get('prompt'), 'audio') if n <= len(refs)] or range(1, len(refs) + 1)
    total, complete = 0.0, True
    deadline = clock() + budget_seconds
    for index in sent:
        if clock() >= deadline:
            logger.warning('reference_audio_check_budget_exhausted unchecked_from=%s', index)
            complete = False
            break
        seconds = measure(refs[index - 1])
        if seconds is None:
            complete = False
            continue
        if seconds > limits['clipMax'] + AUDIO_LIMIT_SLACK_SECONDS:
            raise ReferenceAudioRejected(f'@audio{index} is {seconds:.1f}s long. {rule}. Trim it and try again; nothing was queued.', index)
        if seconds < limits['clipMin'] - AUDIO_LIMIT_SLACK_SECONDS:
            raise ReferenceAudioRejected(f'@audio{index} is only {seconds:.1f}s long. {rule}. Use a longer clip and try again; nothing was queued.', index)
        total += seconds
    if complete and total > limits['totalMax'] + AUDIO_LIMIT_SLACK_SECONDS:
        raise ReferenceAudioRejected(f'The reference audio adds up to {total:.1f}s. {rule}. Shorten or remove a clip and try again; nothing was queued.')


def measure_reference_audio(ref):
    try:
        data = get_storage().read_reference_bytes(ref, max_bytes=MAX_AUDIO_BYTES)['bytes']
    except Exception as error:
        logger.warning('reference_audio_read_failed reason=%s', type(error).__name__)
        return None
    return audio_seconds(data)


def prepare_video(item, body, identifier):
    verify_reference_audio_durations(item)
    verify_portrait_references(item, body)
    verify_registered_portraits(item, body)
    result = {'costCents':compute_cost(item,read_pricing())}
    if has_length(body.get('referenceImages')): result['referenceImages'] = save_reference_images(body['referenceImages'],identifier)
    for field,suffix,output in [('firstFrame','firstframe','continuationFrameUrl'),('lastFrame','lastframe','lastFrameUrl')]:
        value = item.pop(field,None)
        if truthy(value): result[output] = save_reference_images([value],f'{identifier}-{suffix}')[0]
    return result


@transaction.atomic
def persist(item):
    fields = {camel(field.attname):field.attname for field in Generation._meta.concrete_fields}
    values = {fields[key]:value for key,value in item.items() if key in fields}
    row = Generation.objects.create(**values)
    assign_generation_naming(row.id,row.folder_id,row.project_id,item['createdAt'])
    return row


def finish_enqueue(item, prepared, identifier, now, user_id):
    result = {**item,**prepared,'id':str(identifier),'status':'queued','createdAt':now,'updatedAt':now}
    if user_id is not None: result['userId'] = str(user_id)
    warnings = reference_warnings(item['prompt'], result.get('referenceImages'), assets())
    persist(result)
    log_activity(user_id,'generate',{'id':str(identifier),'kind':item['kind'],'model':item['model'],'costCents':prepared['costCents']})
    if warnings:
        result['referenceWarnings'] = warnings
    return result


def validate_draft(source, now=None):
    now = now_ms() if now is None else now
    if source is None: return 'Source generation not found.'
    if source.kind != 'video': return 'Only video drafts can be finalized.'
    if source.model != 'Seedance 2.5': return 'Only Seedance 2.5 drafts can be finalized.'
    if source.draft_mode is not True: return 'This generation is not a draft.'
    if source.status != 'succeeded': return 'The draft must finish successfully before it can be finalized.'
    if not source.task_id: return 'The draft has no provider task ID and cannot be finalized.'
    if now-source.created_at>7*24*60*60*1000: return 'This draft is older than seven days and can no longer be finalized.'
    return None


def build_final(source,user_id,now=None):
    now = now_ms() if now is None else now
    item = dict(id=str(uuid.uuid4()),kind='video',status='queued',prompt=source.prompt,model=source.model,
        aspectRatio=source.aspect_ratio,resolution='1080p',userId=str(user_id),costBasis='estimated',
        draftMode=False,sourceGenerationId=str(source.id),draftTaskId=source.task_id,createdAt=now,updatedAt=now)
    for field in ('duration','reference_images','reference_videos','reference_audios','project_id','folder_id','generate_audio','bitrate_mode','video_task_mode'):
        value = getattr(source,field)
        if value is not None: item[camel(field)] = str(value) if isinstance(value,uuid.UUID) else value
    item['costCents'] = compute_cost(item,read_pricing())
    return item
