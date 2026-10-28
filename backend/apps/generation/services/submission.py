"""Submitting and pricing new generations, shared by the web views and agent tools.

Each entry point takes the acting user and the request values and applies every rule the web API applies:
reference resolution, validation, model availability, pricing, idempotency receipts and the paid guard. A caller
never re-implements one. Success returns the public generation item (or a quote). A refusal raises ``Refused``
with the exact status and body the web API answers with, and a machine ``code`` for callers outside HTTP.
``paid_guard.PaidBudgetHold`` passes through unchanged; the web API answers it as 409 (``paid_guard.wrap_wsgi``).

Only the leased generation worker calls a provider: nothing here submits paid work.
"""
import copy
import logging
import re
import uuid
from django.db import transaction
from apps.common.javascript import truthy
from apps.common.leases import now_ms
from apps.common.responses import log_activity
from apps.library.services import idempotency
from apps.media.images import save_reference_images
from apps.media.storage import get_storage, MediaTooLargeError
from apps.media.uploads import UploadError
from ..model_registry import model_definition
from ..models import Generation
from ..references import resolve_submission_references, InvalidReference
from ..serialization import generation_item
from . import enqueue
from .deadline import with_queue_execution_deadline, QueueExecutionCapacityError
from .paid_guard import PaidBudgetHold
from .pricing import read_pricing
from .upscale_validation import validate_upscale_request, validate_source, inspect_image, aspect_ratio, validate_output_area, InvalidUpscaleRequest, MAX_BYTES
from .upscale_validation import validate_video_upscale_request, inspect_video_source, video_source_key, video_upscale_cost, validate_prores_size

STATUS_CODES = {400: 'INVALID_REQUEST', 404: 'NOT_FOUND', 429: 'CAPACITY_BUSY', 500: 'INTERNAL_ERROR'}


class Refused(Exception):
    """A submission the web API answers with ``status`` and ``body``; ``body`` None is an empty 500."""

    def __init__(self, status, body=None, *, code=None, headers=None):
        super().__init__(body['error'] if body else 'Internal error.')
        self.status, self.body, self.headers = status, body, headers or {}
        self.code = code or (body or {}).get('code') or STATUS_CODES.get(status, 'INVALID_REQUEST')


def invalid(error):
    """The 400 an invalid request gets; an unavailable model keeps the same body with its own code."""
    return Refused(400, {'error': str(error)}, code='MODEL_UNAVAILABLE' if isinstance(error, enqueue.ModelUnavailable) else None)


IDEMPOTENCY_KEY = re.compile(r'^[A-Za-z0-9_.:-]{8,128}$')


def receipt_key(raw, user_id):
    """Per-user receipt key for a submission; a replay returns the first result."""
    if not raw:
        return None
    raw = raw.strip()
    if not IDEMPOTENCY_KEY.match(raw):
        raise Refused(400, {'error': 'Invalid Idempotency-Key header.'})
    return f'generation-enqueue:{user_id}:{raw}'


def validated_generation(actor, kind, body):
    """Resolve references and validate an image or video request: (resolved values, validated item)."""
    try:
        data = resolve_submission_references(body, actor.id)
        # Magnific models are upscales with their own durable source and params.
        if (model_definition(data.get('model')) or {}).get('kind') == 'upscale':
            raise enqueue.InvalidRequest('Upscale models run from the Upscale composer.')
        item = enqueue.image_input(data, actor.id) if kind == 'image' else enqueue.video_input(data, actor.id)
    except UploadError as error:
        raise Refused(error.status, {'error': error.code}) from None
    except (enqueue.InvalidRequest, InvalidReference) as error:
        raise invalid(error) from None
    except Exception:
        raise Refused(500) from None
    return data, item


def quote_generation(actor, kind, body):
    """Validate an image or video request as submit_generation does and price it; nothing is stored or queued.

    Reference bytes (sizes, audio lengths, portraits) are checked only at submission.
    """
    data, item = validated_generation(actor, kind, body)
    try:
        cost = enqueue.quote_image(item, data) if kind == 'image' else enqueue.quote_video(item, data)
    except enqueue.InvalidRequest as error:
        raise invalid(error) from None
    except Exception:
        raise Refused(500, {'error': 'Failed to price the generation request.'}) from None
    return {'kind': kind, 'model': item['model'], 'costCents': cost}


def submit_generation(actor, kind, body, *, idempotency_key=None):
    """Queue an image or video generation for ``actor`` and return its public item.

    ``idempotency_key`` is the client's raw key: a repeat with the same key and values returns the first
    generation instead of queueing a second billable job.
    """
    submitted = copy.deepcopy(body)
    data, item = validated_generation(actor, kind, body)
    key = receipt_key(idempotency_key, actor.id)
    identifier, now = uuid.uuid4(), now_ms()
    try:
        prepared = enqueue.prepare_image(item, data, str(identifier), actor.id) if kind == 'image' else enqueue.prepare_video(item, data, str(identifier))
    except enqueue.PortraitUnavailable as error:
        raise Refused(400, {'error': str(error), 'code': 'PORTRAIT_UNAVAILABLE', 'referenceIndex': error.reference_index}) from None
    except enqueue.ReferenceAudioRejected as error:
        raise Refused(400, {'error': str(error), 'code': 'REFERENCE_AUDIO_DURATION', 'audioIndex': error.audio_index}) from None
    except enqueue.ReferenceImageRejected as error:
        raise Refused(400, {'error': str(error), 'code': 'REFERENCE_IMAGE_SIZE', 'referenceIndex': error.reference_index}) from None
    except enqueue.InvalidRequest as error:
        raise invalid(error) from None
    except Exception:
        raise Refused(500, {'error': 'Failed to prepare the generation request.'}) from None
    try:
        # A repeated submission (double click, transport retry) with the same key
        # waits for the first one and returns its generation instead of queueing
        # a second billable job. Prepared values are not part of the fingerprint.
        created = {}
        def submit():
            created['item'] = enqueue.finish_enqueue(item, prepared, identifier, now, actor.id)
            return {'id': created['item']['id']}
        receipt = idempotency.execute('GENERATION_ENQUEUE_' + kind.upper(), submitted, submit,
            actor_id=actor.id, idempotency_key=key)
        if 'item' in created:
            return created['item']
        # The receipt holds only the id; reply with the generation's current state.
        return generation_item(Generation.objects.get(pk=receipt['id']))
    except idempotency.OrganizationError as error:
        raise Refused(error.status, {'error': str(error), 'code': error.code}) from None
    except PaidBudgetHold:
        raise
    except Exception:
        message = 'Failed to save the generation request. Please try again or contact an administrator.' if kind == 'video' else 'Failed to save the generation request.'
        raise Refused(500, {'error': message}) from None


def draft_source(actor, source_generation_id):
    """The Seedance 2.5 draft a final renders from, once it is eligible."""
    if not isinstance(source_generation_id, str) or not source_generation_id:
        raise Refused(400, {'error': 'sourceGenerationId is required.'})
    try:
        source = Generation.objects.filter(pk=source_generation_id).first()
        # Shared studio: any signed-in user may finalize an eligible draft; the
        # final is a new generation billed to the requesting user.
        error = enqueue.validate_draft(source)
    except Exception:
        raise Refused(500) from None
    if error:
        raise Refused(400 if source else 404, {'error': error})
    try:
        enqueue.refuse_unavailable(source.model, 'video')
    except enqueue.ModelUnavailable as error:
        raise invalid(error) from None
    return source


def finalize_draft(actor, source_generation_id):
    """Queue the 1080p final of a Seedance 2.5 draft, billed to ``actor``, and return its public item."""
    source = draft_source(actor, source_generation_id)
    try:
        # One in-flight final per draft: concurrent requests (double clicks,
        # other tabs or users) serialize on the source row and reuse a queued or
        # running final instead of submitting a second billable render. Once a
        # final has finished, finalizing the same draft again is deliberate.
        with transaction.atomic():
            Generation.objects.select_for_update().filter(pk=source.id).first()
            existing = (Generation.objects.filter(source_generation_id=source.id, draft_task_id=source.task_id,
                        status__in=['queued', 'running']).order_by('created_at').first())
            if existing is not None:
                return generation_item(existing)
            item = enqueue.build_final(source, actor.id)
            row = enqueue.persist(item)
        log_activity(actor.id, 'generate', {'id': item['id'], 'kind': 'video', 'model': source.model, 'costCents': item['costCents'], 'sourceGenerationId': str(source.id)})
        return generation_item(row)
    except PaidBudgetHold:
        raise
    except Exception:
        raise Refused(500, {'error': 'Failed to queue the final render.'}) from None


def submit_upscale(actor, body, *, origin):
    """Queue a Magnific image or video upscale for ``actor`` and return its public item.

    ``origin`` is this site's own origin, the one source URL outside the media store that is accepted.
    """
    try:
        data = resolve_submission_references(body, actor.id)
        if 'video' in data:
            return video_upscale(actor, data, origin)
        validated = validate_upscale_request(data)
        enqueue.refuse_unavailable(validated['model'], 'upscale')
        validate_source(data['image'], origin)
    except (Refused, PaidBudgetHold):
        raise
    except UploadError as error:
        raise Refused(error.status, {'error': error.code}) from None
    except Exception as error:
        raise invalid(error) from None
    try:
        raw, model, params = validated['image'], validated['model'], validated['params']
        prompt = enqueue.trim(enqueue.default(params.get('prompt'), data.get('prompt')))
        scale = enqueue.default(params.get('scaleFactor'), '2x')
    except Exception:
        raise Refused(500) from None
    identifier, now = uuid.uuid4(), now_ms()
    intent = None
    try:
        cost = next((row['unitCostCents'] for row in read_pricing() if row['model'] == model), None)
        if not enqueue.integer(cost):
            raise ValueError(f'Pricing is not configured for {model}.')
        source = with_queue_execution_deadline(lambda signal: get_storage().read_as_base64(raw, max_bytes=MAX_BYTES), timeout_ms=15000)
        meta = inspect_image(source['data'], source['mimeType'])['meta']
        validate_output_area(model, params, meta)
        data_uri = f"data:{source['mimeType'].lower()};base64,{source['data']}"
        references = save_reference_images([data_uri], str(identifier))
        item = dict(id=str(identifier), kind='image', status='queued', prompt=prompt or f'{model} ({scale})',
            model=model, aspectRatio=aspect_ratio(meta['width'], meta['height']), resolution=scale,
            referenceImages=references, userId=str(actor.id), costCents=cost, costBasis='estimated', createdAt=now, updatedAt=now)
        for name in ('projectId', 'folderId'):
            if truthy(data.get(name)): item[name] = data[name]
        # Persist immutable parameters/reference before returning; only the
        # leased Python worker may perform billable submission.
        intent = enqueue.persist({**item, 'submissionInput': {'version': 1,
            'source': references[0], 'params': params}})
        log_activity(actor.id, 'generate', {'id': str(identifier), 'kind': 'image', 'model': model, 'costCents': cost})
        return generation_item(intent)
    except Exception as error:
        if intent is not None:
            # An ambiguous provider/commit error must leave an inspectable
            # intent, never schedule a second paid request automatically.
            try:
                Generation.objects.filter(pk=intent.id, status='running', task_id__isnull=True).update(
                    provider_status='SUBMISSION_UNCERTAIN', updated_at=now_ms())
            except Exception:
                pass
            logging.getLogger('veevee.generation').error('upscale submission unresolved generation_id=%s error_type=%s', intent.id, type(error).__name__)
        if isinstance(error, PaidBudgetHold):
            raise
        if isinstance(error, QueueExecutionCapacityError):
            raise Refused(429, {'error': 'MEDIA_READ_CAPACITY_BUSY'}, headers={'Retry-After': '1'}) from None
        if isinstance(error, (InvalidUpscaleRequest, MediaTooLargeError)):
            raise invalid(error) from None
        raise Refused(500, {'error': 'Failed to start upscale generation.'}) from None


def video_upscale(actor, data, origin):
    """Queue a Magnific video upscale. No copy of the source and no provider call here."""
    validated = validate_video_upscale_request(data)
    enqueue.refuse_unavailable(validated['model'], 'upscale')
    validate_source(data['video'], origin)
    model, params = validated['model'], validated['params']
    source = '/api/media/' + video_source_key(data['video'])
    identifier, now = uuid.uuid4(), now_ms()
    try:
        meta = inspect_video_source(source, actor_id=actor.id)
        validate_prores_size(model, params, meta)
        cost = video_upscale_cost(model, params, meta, read_pricing())
        item = dict(id=str(identifier), kind='video', status='queued', prompt=f"{model} ({params['resolution']})",
            model=model, aspectRatio=aspect_ratio(meta['width'], meta['height']), resolution=params['resolution'],
            duration=max(1, round(meta['durationSeconds'])), referenceVideos=[source], userId=str(actor.id),
            costCents=cost, costBasis='estimated', createdAt=now, updatedAt=now)
        for name in ('projectId', 'folderId'):
            if truthy(data.get(name)): item[name] = data[name]
        # Only the leased Python worker signs the source and submits it.
        row = enqueue.persist({**item, 'submissionInput': {'version': 1, 'source': source, 'params': params, 'sourceMeta': meta}})
        log_activity(actor.id, 'generate', {'id': str(identifier), 'kind': 'video', 'model': model, 'costCents': cost})
        return generation_item(row)
    except InvalidUpscaleRequest as error:
        raise invalid(error) from None
    except Exception as error:
        logging.getLogger('veevee.generation').exception('video upscale enqueue failed generation_id=%s', identifier)
        if isinstance(error, PaidBudgetHold):
            raise
        raise Refused(500, {'error': 'Failed to start upscale generation.'}) from None
