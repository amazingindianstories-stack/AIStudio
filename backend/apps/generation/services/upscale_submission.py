"""Durable Magnific submission primitive; caller supplies fenced persistence."""
from django.db import OperationalError, InterfaceError
from apps.generation.providers import magnific
from apps.media.keys import media_key_from_ref
from apps.media.storage import get_storage
from .upscale_validation import validate_upscale_request, inspect_image, validate_output_area, MAX_BYTES
from .upscale_validation import validate_video_upscale_request, video_source_key

UPSCALE_PREPARE_FAILED = 'The upscale source could not be prepared. Nothing was sent to Magnific.'
UPSCALE_REJECTED = 'Magnific rejected this upscale. Nothing was charged; check the source and settings.'
# Private diagnostic (failure_copy maps it to the busy copy); the status stays in the stored error.
UPSCALE_RATE_LIMITED = 'Magnific upscale was rate limited (429). Nothing was charged.'


def rejection_message(error):
    return UPSCALE_RATE_LIMITED if getattr(error, 'status', None) == 429 else UPSCALE_REJECTED


def rejection_records(item, error):
    """The provider's own refusal record, stamped with the model, for the failed row's provider_responses."""
    record = getattr(error, 'provider_response', None)
    return [{**record, 'model': record.get('model') or item.model}] if isinstance(record, dict) else None


def definitive_rejection(error):
    """Only the provider's own 4xx refusal of the create call proves no task exists.
    Anything after it answered (receipt checks, persistence) stays uncertain."""
    from apps.generation.providers.transport import ProviderError
    status = getattr(error, 'status', None)
    return isinstance(error, ProviderError) and type(status) is int and 400 <= status < 500 and status != 408


def submit_persisted_upscale(item, *, signal, mark_pending, save_receipt, mark_uncertain,
                             storage=None, submit=None, mark_failed=None):
    value=item.submission_input
    if not isinstance(value,dict) or type(value.get('version')) is not int or value.get('version')!=1:
        raise ValueError('Missing supported durable upscale input.')
    source=value.get('source')
    if item.model in magnific.VIDEO_MODELS:
        return _submit_video(item,value,signal=signal,mark_pending=mark_pending,save_receipt=save_receipt,
                             mark_uncertain=mark_uncertain,storage=storage,submit=submit,mark_failed=mark_failed)
    try:
        if not isinstance(source,str) or not source.startswith('/api/media/references/') or '?' in source or '#' in source:
            raise ValueError('Durable upscale source must be a canonical stored reference.')
        key=media_key_from_ref(source)
        if not key or not key.startswith('references/'):
            raise ValueError('Durable upscale input requires a stored immutable reference.')
        payload=validate_upscale_request({'model':item.model,'image':source,'params':value.get('params')})
        signal.check()
        raw=(storage or get_storage()).read_as_base64(source,max_bytes=MAX_BYTES)
        meta = inspect_image(raw['data'],raw['mimeType'])['meta']
        validate_output_area(item.model, payload['params'], meta)
        signal.check()
    except Exception:
        # Nothing was sent: end the job instead of leaving a spent claim behind.
        if mark_failed is None:
            raise
        mark_failed(UPSCALE_PREPARE_FAILED, 'NOT_SUBMITTED')
        return None
    # Caller must durably fence this marker before any external submission.
    mark_pending()
    try:
        result=(submit or magnific.submit_upscale)({'model':item.model,
            'image':f"data:{raw['mimeType'].lower()};base64,{raw['data']}",
            'params':payload['params']},signal=signal)
    except Exception as error:
        if mark_failed is not None and definitive_rejection(error):
            mark_failed(rejection_message(error), 'REJECTED', responses=rejection_records(item, error))
            return None
        mark_uncertain()
        raise
    try:
        task=result.get('taskId') if isinstance(result,dict) else None
        if not isinstance(task,str) or not task:
            raise RuntimeError('Provider accepted upscale without a valid receipt.')
        # Accepted receipt persists even if cancellation raced the response.
        save_receipt(task)
    except Exception:
        mark_uncertain()
        raise
    return task


# Magnific analyses the source while accepting the task and may fetch it again
# while queued; the signed read must outlive both.
VIDEO_SOURCE_URL_SECONDS = 6*60*60


def _submit_video(item, value, *, signal, mark_pending, save_receipt, mark_uncertain, storage=None, submit=None, mark_failed=None):
    try:
        source=value.get('source')
        if not isinstance(source,str) or not source.startswith('/api/media/'):
            raise ValueError('Durable video upscale source must be a canonical stored reference.')
        payload=validate_video_upscale_request({'model':item.model,'video':source,'params':value.get('params')})
        signal.check()
        # Enqueue probed the immutable stored source; Magnific validates it again.
        url=(storage or get_storage()).signed_read_url(video_source_key(source),VIDEO_SOURCE_URL_SECONDS,actor_id=item.user_id)
        if not isinstance(url,str) or not url.startswith('https://'):
            raise ValueError('Magnific video upscaling requires an HTTPS source URL.')
    except Exception:
        # Nothing was sent: end the job instead of leaving a spent claim behind.
        if mark_failed is None:
            raise
        mark_failed(UPSCALE_PREPARE_FAILED, 'NOT_SUBMITTED')
        return None
    mark_pending()
    try:
        result=(submit or magnific.submit_video_upscale)({'model':item.model,'video':url,
            'params':payload['params']},signal=signal)
    except Exception as error:
        if mark_failed is not None and definitive_rejection(error):
            mark_failed(rejection_message(error), 'REJECTED', responses=rejection_records(item, error))
            return None
        mark_uncertain()
        raise
    try:
        task=result.get('taskId') if isinstance(result,dict) else None
        if not isinstance(task,str) or not task:
            raise RuntimeError('Provider accepted upscale without a valid receipt.')
        save_receipt(task)
    except Exception:
        mark_uncertain()
        raise
    return task


def submit_claimed_upscale(item, *, owner, signal, storage=None, submit=None):
    """Persist submission certainty under the existing job/version lease fence."""
    from apps.generation.models import Generation
    from apps.common.leases import now_ms
    from . import coordinator
    from .executor import LeaseLost, ReceiptPersistenceError
    if item.user_id is None:
        raise ValueError('An authenticated account is required for paid submission.')
    current=item
    def update(fields):
        nonlocal current
        fields={**fields,'updated_at':max(now_ms(),current.updated_at+1)}
        if not coordinator.expected_version(current,owner=owner).update(**fields):
            raise LeaseLost('Upscale ownership changed before persistence.')
        current=Generation.objects.get(pk=current.id)
    def pending():
        if current.task_id or current.provider_status in ('SUBMISSION_PENDING','SUBMISSION_UNCERTAIN'):
            raise ValueError('Upscale intent requires reconciliation; automatic submission refused.')
        update({'provider_status':'SUBMISSION_PENDING'})
    def receipt(task):
        timestamp=now_ms()
        for attempt in range(3):
            try:
                _persist_receipt(current,owner,task,timestamp)
                current.refresh_from_db()
                return
            except Exception as error:
                try:
                    durable=Generation.objects.filter(pk=current.id,task_id=task,worker_lease_id=owner).first()
                    if durable and all(getattr(durable,field)==getattr(current,field) for field in (
                            'kind','model','user_id','submission_input')):
                        return
                except (OperationalError,InterfaceError):
                    pass  # An unavailable readback must not abort local retry.
                if isinstance(error,LeaseLost) or attempt==2:
                    raise ReceiptPersistenceError('Accepted upscale receipt could not be saved.') from error
    def uncertain():
        Generation.objects.filter(pk=current.id,worker_lease_id=owner,task_id__isnull=True,
            provider_status='SUBMISSION_PENDING').update(provider_status='SUBMISSION_UNCERTAIN',updated_at=now_ms())
    def failed(message, provider_status, responses=None):
        timestamp=now_ms()
        update({'status':'failed','error':message,'provider_status':provider_status,'completed_at':timestamp,
                **({'provider_responses':responses} if responses else {})})
    import os
    if submit is None and os.environ.get('MOCK_GENERATION')=='1':
        submit=lambda payload,signal: {'taskId':'mock-magnific-'+str(current.id)}
    submit_persisted_upscale(current,signal=signal,mark_pending=pending,save_receipt=receipt,
        mark_uncertain=uncertain,storage=storage,submit=submit,
        mark_failed=failed)
    return Generation.objects.get(pk=current.id)


def _persist_receipt(item,owner,task,timestamp):
    from . import coordinator
    from .executor import LeaseLost
    if coordinator.persist_provider_receipt(item,owner,{'task_id':task,
            'submitted_at':timestamp,'next_poll_at':timestamp+5000,'provider_status':'SUBMITTED',
            'updated_at':max(timestamp,item.updated_at+1)}) is None:
        raise LeaseLost('Upscale ownership changed before receipt persistence.')
