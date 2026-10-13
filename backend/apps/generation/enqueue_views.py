from django.conf import settings
import uuid
import logging
from apps.authentication.session import lookup
from apps.canvas.views import node_route, reply, failure, body
from apps.common.javascript import truthy
from apps.common.leases import now_ms
from apps.common.responses import log_activity
from apps.media.images import save_reference_images
from apps.media.storage import get_storage, MediaTooLargeError
from .models import Generation
from .serialization import generation_item
from .providers import magnific
from .services import enqueue
from .references import resolve_submission_references, InvalidReference
from apps.media.uploads import UploadError
from .services.pricing import read_pricing
from .services.poller import advance_magnific
from .services.deadline import with_queue_execution_deadline, QueueExecutionCapacityError
from .services.upscale_validation import validate_upscale_request, validate_source, inspect_image, aspect_ratio, validate_output_area, InvalidUpscaleRequest, MAX_BYTES


def json_body(request):
    value = body(request)
    if value is None: raise TypeError('Cannot read properties of null')
    return value if isinstance(value,dict) else {}


def no_store(request, value):
    response = reply(request,value)
    response['Cache-Control'] = 'no-store'
    return response


@node_route(['POST'])
def generate(request, kind):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    try:
        data = json_body(request)
        data = resolve_submission_references(data, user.id)
        item = enqueue.image_input(data,user.id) if kind == 'image' else enqueue.video_input(data,user.id if user else None)
    except UploadError as error:
        return reply(request, {'error': error.code}, error.status)
    except (enqueue.InvalidRequest, InvalidReference) as error:
        return reply(request,{'error':str(error)},400)
    except Exception:
        return failure()
    identifier, now = uuid.uuid4(), now_ms()
    try:
        prepared = enqueue.prepare_image(item,data,str(identifier),user.id) if kind == 'image' else enqueue.prepare_video(item,data,str(identifier))
    except enqueue.InvalidRequest as error:
        return reply(request,{'error':str(error)},400)
    except Exception:
        return reply(request,{'error':'Failed to prepare the generation request.'},500)
    try:
        return reply(request,enqueue.finish_enqueue(item,prepared,identifier,now,user.id if user else None))
    except Exception:
        message = 'Failed to save the generation request. Please try again or contact an administrator.' if kind == 'video' else 'Failed to save the generation request.'
        return reply(request,{'error':message},500)


@node_route(['POST'])
def finalize(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    try:
        data = json_body(request)
        source_id = data.get('sourceGenerationId')
        if not isinstance(source_id,str) or not source_id: return reply(request,{'error':'sourceGenerationId is required.'},400)
        source = Generation.objects.filter(pk=source_id).first()
        if source is not None and str(source.user_id) != str(user.id) and user.role != 'admin':
            return reply(request,{'error':'FORBIDDEN'},403)
        error = enqueue.validate_draft(source)
        if error: return reply(request,{'error':error},400 if source else 404)
    except Exception:
        return failure()
    try:
        item = enqueue.build_final(source,user.id)
        enqueue.persist(item)
        log_activity(user.id,'generate',{'id':item['id'],'kind':'video','model':source.model,'costCents':item['costCents'],'sourceGenerationId':str(source.id)})
        return reply(request,item)
    except Exception:
        return reply(request,{'error':'Failed to queue the final render.'},500)


@node_route(['GET'])
def video_status(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    values = request.query_params.getlist('id')
    identifier = values[0] if values else None
    if not identifier: return reply(request,{'error':'Missing id.'},400)
    try:
        row = Generation.objects.filter(pk=identifier).first()
        if row is None: return reply(request,{'error':'Not found.'},404)
        if str(row.user_id) != str(user.id) and user.role != 'admin':
            return reply(request,{'error':'FORBIDDEN'},403)
        item = generation_item(row)
        return no_store(request,{**item,'transientPollError':row.last_poll_error_at is not None,
            'pollErrorCount':row.poll_error_count or 0,'retryAfterMs':max(0,row.next_poll_at-now_ms()) if row.next_poll_at else 0})
    except Exception:
        return failure()


@node_route(['POST'])
def upscale(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    try:
        data = json_body(request)
        data = resolve_submission_references(data, user.id)
        validated = validate_upscale_request(data)
        validate_source(data['image'],request.build_absolute_uri('/').rstrip('/'))
    except UploadError as error:
        return reply(request, {'error': error.code}, error.status)
    except Exception as error:
        return reply(request,{'error':str(error)},400)
    try:
        raw, model, params = validated['image'], validated['model'], validated['params']
        prompt = enqueue.trim(enqueue.default(params.get('prompt'),data.get('prompt')))
        scale = enqueue.default(params.get('scaleFactor'),'2x')
    except Exception:
        return failure()
    identifier, now = uuid.uuid4(), now_ms()
    intent = None
    try:
        cost = next((row['unitCostCents'] for row in read_pricing() if row['model'] == model), None)
        if not enqueue.integer(cost):
            raise ValueError(f'Pricing is not configured for {model}.')
        source = with_queue_execution_deadline(lambda signal: get_storage().read_as_base64(raw,max_bytes=MAX_BYTES), timeout_ms=15000)
        meta = inspect_image(source['data'],source['mimeType'])['meta']
        validate_output_area(model, params, meta)
        data_uri = f"data:{source['mimeType'].lower()};base64,{source['data']}"
        references = save_reference_images([data_uri],str(identifier))
        item = dict(id=str(identifier),kind='image',status='queued',prompt=prompt or f'{model} ({scale})',
            model=model,aspectRatio=aspect_ratio(meta['width'],meta['height']),resolution=scale,
            referenceImages=references,userId=str(user.id),costCents=cost,costBasis='estimated',createdAt=now,updatedAt=now)
        for name in ('projectId','folderId'):
            if truthy(data.get(name)): item[name] = data[name]
        # Persist immutable parameters/reference before returning; only the
        # leased Python worker may perform billable submission.
        intent = enqueue.persist({**item,'submissionInput':{'version':1,
            'source':references[0],'params':params}})
        log_activity(user.id,'generate',{'id':str(identifier),'kind':'image','model':model,'costCents':cost})
        return reply(request,item)
    except Exception as error:
        if intent is not None:
            # An ambiguous provider/commit error must leave an inspectable
            # intent, never schedule a second paid request automatically.
            try:
                Generation.objects.filter(pk=intent.id,status='running',task_id__isnull=True).update(
                    provider_status='SUBMISSION_UNCERTAIN',updated_at=now_ms())
            except Exception:
                pass
            logging.getLogger('veevee.generation').error('upscale submission unresolved generation_id=%s error_type=%s',intent.id,type(error).__name__)
        if isinstance(error,QueueExecutionCapacityError):
            response = reply(request,{'error':'MEDIA_READ_CAPACITY_BUSY'},429)
            response['Retry-After'] = '1'
            return response
        if isinstance(error,(InvalidUpscaleRequest,MediaTooLargeError)):
            return reply(request,{'error':str(error)},400)
        return reply(request,{'error':'Failed to start upscale generation.'},500)


@node_route(['GET'])
def upscale_status(request):
    user = lookup(request)
    if user is None: return reply(request,{'error':'UNAUTHENTICATED'},401)
    values = request.query_params.getlist('id')
    identifier = values[0] if values else None
    if not identifier: return reply(request,{'error':'Missing id parameter.'},400)
    try:
        row = Generation.objects.filter(pk=identifier).first()
        if row is None: return reply(request,{'error':'Generation not found.'},404)
        if str(row.user_id) != str(user.id) and user.role != 'admin': return reply(request,{'error':'FORBIDDEN'},403)
        if row.model not in magnific.MODELS or row.kind != 'image':
            return reply(request,{'error':'Generation is not a Magnific job.'},400)
        if str(row.user_id) != str(user.id) and user.role != 'admin': return reply(request,{'error':'FORBIDDEN'},403)
        if settings.LOCAL_DATA_MODE == 'read_only_viewer' or not row.task_id or row.status in ('succeeded','failed'): return no_store(request,generation_item(row))
        try:
            result = advance_magnific(row)
            current = Generation.objects.filter(pk=identifier).first() if result['kind']=='raced' else result.get('item')
            return no_store(request,generation_item(current) if current else None)
        except Exception:
            return no_store(request,generation_item(row))
    except Exception:
        return failure()
