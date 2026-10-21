"""Audio worker admission; ambiguous synchronous provider work is never replayed."""
import logging
from django.conf import settings
from django.db import transaction
from django.db.models import Q
from apps.common.leases import now_ms
from apps.generation.models import Generation
from . import paid_guard

AUDIO_READY = 'AUDIO_READY'


def persist_audio_intent(fields):
    """Commit a new queued transcription intent.

    With the paid guard on, the row is registered in the paid ledger inside
    the same transaction (the worker role sees only registered rows).
    """
    if not paid_guard.enabled():
        return _persist_audio_intent(fields)
    return paid_guard.persist_audio(_persist_audio_intent, fields)


def _persist_audio_intent(fields):
    return Generation.objects.create(**fields)


def transcribe_claimed(claimed, provider, encoded, mime, model, *, signal):
    """The intent's single provider call, made only after its claim committed.

    With the paid guard on, the call runs inside its one-shot ledger claim.
    """
    if not paid_guard.enabled():
        return _transcribe_claimed(claimed, provider, encoded, mime, model, signal=signal)
    return paid_guard.transcribe(_transcribe_claimed, claimed, provider, encoded, mime, model, signal=signal)


def _transcribe_claimed(claimed, provider, encoded, mime, model, *, signal):
    signal.check()
    return provider.transcribe(encoded,mime,model,signal=signal)


def never_sent(error):
    """A refusal raised before any provider request left this process."""
    from apps.integrations.transport import ProviderError
    return isinstance(error,ProviderError) and error.may_have_submitted is False


def audio_limits():
    global_limit=getattr(settings,'AUDIO_MAX_CONCURRENT',2)
    user_limit=getattr(settings,'AUDIO_MAX_PER_USER',1)
    if type(global_limit) is not int or type(user_limit) is not int or global_limit<1 or user_limit<1:
        raise ValueError('Audio admission limits must be positive integers.')
    return global_limit, user_limit


def audio_capacity_available(user_id):
    global_limit, user_limit = audio_limits()
    reserved=Generation.objects.filter(kind='audio',provider_status__in=(
        'SUBMISSION_PENDING','SUBMISSION_UNCERTAIN'))
    return reserved.count()<global_limit and reserved.filter(user_id=user_id).count()<user_limit


def queued_audio():
    return Q(kind='audio',status='queued',user_id__isnull=False,
             provider_status=AUDIO_READY,submission_input__version=2,
             submission_input__operation='audio-transcription')


def claim_audio(identifier, owner, *, now=None, ttl_ms=60000, expected=None):
    """Commit submission intent before paid I/O; never reclaim a pending call."""
    if not identifier or not owner:
        raise ValueError('Audio id and worker owner are required.')
    now = now_ms() if now is None else now
    with transaction.atomic():
        from apps.library.services.idempotency import acquire_scope_locks
        acquire_scope_locks('audio:paid-admission')
        row=Generation.objects.select_for_update().filter(queued_audio(),pk=identifier).filter(
            Q(worker_lease_until__isnull=True)|Q(worker_lease_until__lte=now)).first()
        if row is None or (row.next_poll_at is not None and row.next_poll_at > now):
            return None
        if expected is not None:
            metadata={'project_id','folder_id','location_version','permanent_name','is_favorite','favorited_at',
                'flagged','flagged_at','flag_reason','updated_at'}
            if any(getattr(row,field.attname)!=getattr(expected,field.attname)
                   for field in Generation._meta.concrete_fields if field.attname not in metadata):
                return None
        if not audio_capacity_available(row.user_id):
            return None
        value=row.submission_input
        if type(value.get('version')) is not int or value['version']!=2:
            return None
        Generation.objects.filter(pk=row.id).update(status='running',
            provider_status='SUBMISSION_PENDING',worker_lease_id=owner,
            worker_lease_until=now+ttl_ms,submitted_at=now,
            updated_at=max(now,row.updated_at+1))
        return Generation.objects.get(pk=row.id)


INVALID_INPUT_MESSAGES = frozenset((
    'Unsupported audio intent.', 'Invalid audio intent MIME.',
    'Invalid audio intent source.', 'Invalid audio intent parameters.',
    'Audio snapshot integrity failed.',
))
PREPARATION_BACKOFF_MS = 30000


def settle_preparation_failure(expected, *, terminal):
    """Fence pre-paid failures; never mutate a claimed or changed intent."""
    now = now_ms()
    with transaction.atomic():
        row = Generation.objects.select_for_update().filter(queued_audio(),pk=expected.id).first()
        if row is None or (row.worker_lease_until is not None and row.worker_lease_until > now):
            return {'kind':'unclaimed'}
        metadata={'project_id','folder_id','location_version','permanent_name','is_favorite','favorited_at',
                  'flagged','flagged_at','flag_reason','updated_at'}
        if any(getattr(row,field.attname)!=getattr(expected,field.attname)
               for field in Generation._meta.concrete_fields if field.attname not in metadata):
            return {'kind':'unclaimed'}
        updates={'updated_at':max(now,row.updated_at+1)}
        if terminal:
            updates.update(status='failed',error='Audio input is invalid or unavailable.',
                           completed_at=now,provider_status='AUDIO_INPUT_INVALID',next_poll_at=None)
        else:
            updates['next_poll_at']=now+PREPARATION_BACKOFF_MS
        Generation.objects.filter(pk=row.id).update(**updates)
        logging.getLogger('veevee.generation').warning(
            'audio_preparation_deferred generation_id=%s terminal=%s',row.id,terminal)
        return {'kind':'failed' if terminal else 'deferred'}


def process_audio(identifier, owner, *, signal, provider=None, storage=None):
    """Execute a fresh queued intent once; pending calls have no replay path."""
    from apps.media.audio import get_transcriber, _persist_audio_result, _mark_audio_uncertain, _mark_audio_failed
    from .upscale_submission import definitive_rejection, rejection_records
    from apps.media.audio_inputs import validated_audio_input
    from apps.media.storage import get_storage
    from .coordinator import release_generation
    expected=Generation.objects.filter(queued_audio(),pk=identifier).first()
    if expected is None or (expected.next_poll_at is not None and expected.next_poll_at > now_ms()):
        return {'kind':'unclaimed'}
    if not audio_capacity_available(expected.user_id):
        return {'kind':'unclaimed'}
    signal.check()
    from .deadline import QueueExecutionDeadlineError
    try:
        storage=get_storage() if storage is None else storage
        try:
            encoded,mime,model=validated_audio_input(expected,storage,signal=signal)
        except ValueError as error:
            if type(error) is ValueError and str(error) in INVALID_INPUT_MESSAGES:
                return settle_preparation_failure(expected,terminal=True)
            raise
        provider=get_transcriber() if provider is None else provider
        signal.check()
    except QueueExecutionDeadlineError:
        raise
    except Exception:
        # Storage outages, missing provider configuration and unknown errors are
        # not proof of an invalid immutable input. Back off before account ranking.
        return settle_preparation_failure(expected,terminal=False)
    claimed=claim_audio(identifier,owner,expected=expected)
    if claimed is None:
        return {'kind':'unclaimed'}
    try:
        transcript=transcribe_claimed(claimed,provider,encoded,mime,model,signal=signal)
        if not isinstance(transcript,str) or not transcript.strip():
            raise ValueError('Gemini returned an empty transcription.')
        # A paid response may arrive during cancellation. Persist it first.
        saved=_persist_audio_result(claimed,transcript,now_ms())
        return {'kind':'completed','item':saved}
    except Exception as error:
        try:
            if definitive_rejection(error) or never_sent(error):
                # A 4xx (a 429 included) refused the call before any work, or nothing was sent at all
                # (e.g. the paid guard refused the claim): end the row so the user's slot is freed.
                _mark_audio_failed(claimed,str(error),rejection_records(claimed,error))
                return {'kind':'failed','item':Generation.objects.get(pk=identifier)}
            _mark_audio_uncertain(claimed)
        except Exception:
            pass  # Committed pending evidence remains held, never replayed.
        raise
    finally:
        release_generation(identifier,owner)
