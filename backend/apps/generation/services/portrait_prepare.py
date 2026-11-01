"""Prepare face references as managed BytePlus assets before a Seedance job is admitted.

Runs in the generation worker while the job is still ``queued`` — before admission
and before the paid guard's one-shot claim — so waiting never consumes a paid
attempt and the paid contract (which fingerprints the job inputs) is untouched.
Resolved asset ids are read back from the pins table at submission time.
"""
import logging
import re
import time

from django.conf import settings

from apps.assets import managed_pool
from apps.assets.models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitWait
from apps.generation.model_registry import is_provider_model
from apps.media.keys import media_key_from_ref

logger = logging.getLogger('veevee.portraits')
WAITING_STATUS = 'PORTRAIT_WAITING'
REJECTED_MESSAGE = ("A face in your references wasn't prepared as a portrait, so it was rejected. "
                    "It is now marked as a portrait - Retry will send it correctly.")
MESSAGES = {
    'portrait_pool_full': 'Waiting for portrait space - other generations are using it.',
    'portrait_queued': 'Waiting for portrait space - other generations are using it.',
    'portrait_evicting': 'Making room for your portrait...',
    'portrait_registering': 'Preparing portraits...',
    'portrait_paused': 'Preparing portraits - the portrait service asked us to slow down, this continues shortly.',
    'portrait_processing': 'Preparing portraits...',
    'portrait_uncertain': 'Confirming a portrait...',
    'portrait_deleting': 'Making room for your portrait...',
}


def now_ms():
    return int(time.time() * 1000)


def enabled():
    return bool(getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False))


def applies(item):
    model = item.model or ''
    return (enabled() and item.kind == 'video' and not is_provider_model(model, 'omni')
            and not is_provider_model(model, 'higgsfield') and not is_provider_model(model, 'omnihuman'))


def reference_urls(item):
    """Every image the Seedance submission will send: catalog assets, uploads, frames; a final uses its draft's."""
    from apps.generation.models import Generation
    from .video_execution import combined_references, read_assets
    source = item
    if item.draft_task_id and item.source_generation_id:
        source = Generation.objects.filter(pk=item.source_generation_id).first() or item
    refs = [ref['imageUrl'] for ref in combined_references(source.prompt, read_assets(source.project_id), source.reference_images or [])]
    refs += [value for value in (source.continuation_frame_url, source.last_frame_url) if value]
    return refs


def storage_key(ref):
    if not isinstance(ref, str) or ref.startswith(('asset://', 'data:')):
        return None
    return media_key_from_ref(ref.split('#', 1)[0], getattr(settings, 'GCP_MEDIA_CDN_URL', ''))


def prepare(item, *, storage=None, client=None, now=None):
    """Return a pool Outcome for the whole job: ready when every face reference is an ACTIVE pinned asset."""
    from apps.media.storage import get_storage
    storage = storage or get_storage()
    worst = managed_pool.ready(None)
    videos = video_portraits(item)
    if any(row.status == 'FAILED' for row in videos.values()):
        return managed_pool.failed(managed_pool.PORTRAIT_UNPREPARED + managed_pool.NOT_CHARGED, 'portrait_rejected')
    for ref in reference_urls(item):
        key = storage_key(ref)
        if not key:
            continue
        data = storage.read(key)
        _, has_face = managed_pool.scan_reference(data)
        if not has_face:
            continue
        outcome = managed_pool.ensure(data, key, item.id, item.user_id, storage=storage, client=client, now=now)
        if outcome.kind == 'failed':
            return outcome
        worst = _reported(worst, outcome)
    for key, row in videos.items():
        outcome = managed_pool.ensure(b'', key, item.id, item.user_id, storage=storage, client=client, now=now, sha=row.content_sha256, media_kind='video')
        if outcome.kind == 'failed':
            return outcome
        worst = _reported(worst, outcome)
    return worst


def _reported(worst, outcome):
    """The wait the job reports: the first one, except that any other wait outranks an asset still processing (whose time
    counts only against its own processing limit, not the job's wait limit)."""
    if outcome.kind == 'wait' and (worst.kind != 'wait' or worst.reason == 'portrait_processing'):
        return outcome
    return worst


def video_portraits(item):
    """{storage key: Gallery upload row} of the Gallery video portraits among this job's reference videos (sent as BytePlus assets)."""
    from apps.generation.references import resolve_references
    keys = {storage_key(ref) for ref in resolve_references(item.prompt, item.reference_videos or [], 'vid')}
    rows = ManagedPortraitAsset.objects.filter(media_kind='video', origin='upload', source_key__in=[key for key in keys if key]).order_by('created_at', 'id')
    return {row.source_key: row for row in rows}


INPUT_IMAGE_PRIVACY_CODE = 'InputImageSensitiveContentDetected.PrivacyInformation'


def privacy_rejection(message, raw=None):
    """True only when Seedance refused an input image as a real person (a face): by the BytePlus error code
    InputImageSensitiveContentDetected.PrivacyInformation when the payload has one (the code decides), else by its
    input-image wording. Output video or audio privacy, text policy and any other rejection are not about our references."""
    error = raw.get('data', raw).get('error') if isinstance(raw, dict) and isinstance(raw.get('data', raw), dict) else None
    code = error.get('code') if isinstance(error, dict) else ''
    if code:
        return code == INPUT_IMAGE_PRIVACY_CODE
    return bool(re.search(r'input image[^.]{0,80}\b(real person|privacy)', message or '', re.I))


def learn_from_rejection(item, storage=None):
    """Seedance refused an image we sent inline: a face the detector missed. Remember the exact bytes of every inline
    reference (all references minus the ones sent as pinned assets) as a face, so a Retry registers them as portraits.
    Returns how many images were learned. Never raises: the failure itself is already being recorded."""
    try:
        if not applies(item) or not is_provider_model(item.model or '', 'byteplus'):
            return 0
        from apps.media.storage import get_storage
        storage = storage or get_storage()
        sent_as_assets = set(assets_for(item.id))
        learned = 0
        for ref in reference_urls(item):
            key = storage_key(ref)
            if not key:
                continue
            sha = managed_pool.content_sha256(storage.read(key))
            if sha not in sent_as_assets:
                learned += 1 if managed_pool.force_face(sha, 'provider_rejection') else 0
        return learned
    except Exception:
        logger.exception('portrait learning from a provider rejection failed')
        return 0


def assets_for(generation_id):
    """{content_sha256: byteplus_asset_id} for ACTIVE assets pinned by this generation."""
    rows = ManagedPortraitAsset.objects.filter(status='ACTIVE', id__in=ManagedPortraitPin.objects.filter(generation_id=generation_id)
                                               .values('asset_id')).values_list('content_sha256', 'byteplus_asset_id')
    return dict(rows)


def video_assets_for(item):
    """{storage key: byteplus_asset_id} of this job's Gallery video portraits, matched by content to the ACTIVE video
    assets it pinned (a pinned asset may have been registered from another upload of the same clip)."""
    pinned = dict(ManagedPortraitAsset.objects.filter(status='ACTIVE', media_kind='video', id__in=ManagedPortraitPin.objects.filter(generation_id=item.id)
                                                      .values('asset_id')).values_list('content_sha256', 'byteplus_asset_id'))
    return {key: pinned[row.content_sha256] for key, row in video_portraits(item).items() if row.content_sha256 in pinned}


def wait_started(generation_id, reason, now):
    """When the job's wait limit started counting. A wait for a registered asset to finish processing is bounded by the
    asset's own processing limit instead: it never counts, and the job's clock starts again when that wait ends."""
    row, _ = ManagedPortraitWait.objects.get_or_create(generation_id=generation_id, defaults={'started_at': now, 'reason': reason})
    if reason != 'portrait_processing':
        return row.started_at
    ManagedPortraitWait.objects.filter(generation_id=generation_id).update(started_at=now)
    return now


def clear_wait(generation_id):
    ManagedPortraitWait.objects.filter(generation_id=generation_id).delete()


def check_ready():
    """Worker startup: with automatic portraits on, the packaged face model must be present and match its
    checksum. Without it every reference would fail closed (treated as a face) and fill the pool."""
    if enabled():
        from apps.assets import face_detect
        face_detect._model_path()


def finish(generation_id, failed=False):
    """Generation reached a terminal state: release its assets for expiry/eviction. After a failure (which may be
    BytePlus refusing a vanished asset) its assets are confirmed with BytePlus again before their next use."""
    clear_wait(generation_id)
    if failed:
        managed_pool.require_verification(generation_id)
    return managed_pool.release_pins(generation_id)
