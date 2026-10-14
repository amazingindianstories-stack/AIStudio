"""Prepare face references as managed BytePlus assets before a Seedance job is admitted.

Runs in the generation worker while the job is still ``queued`` — before admission
and before the paid guard's one-shot claim — so waiting never consumes a paid
attempt and the paid contract (which fingerprints the job inputs) is untouched.
Resolved asset ids are read back from the pins table at submission time.
"""
import time

from django.conf import settings

from apps.assets import managed_pool
from apps.assets.models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitWait
from apps.generation.model_registry import is_provider_model
from apps.media.keys import media_key_from_ref

WAITING_STATUS = 'PORTRAIT_WAITING'
MESSAGES = {
    'portrait_pool_full': 'Waiting for portrait space — other generations are using it.',
    'portrait_evicting': 'Making room for your portrait…',
    'portrait_registering': 'Preparing portraits…',
    'portrait_processing': 'Preparing portraits…',
    'portrait_uncertain': 'Confirming a portrait with BytePlus…',
    'portrait_deleting': 'Making room for your portrait…',
}


def now_ms():
    return int(time.time() * 1000)


def enabled():
    return bool(getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False))


def applies(item):
    model = item.model or ''
    return (enabled() and item.kind == 'video' and not is_provider_model(model, 'omni')
            and not is_provider_model(model, 'higgsfield'))


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
        if outcome.kind == 'wait' and worst.kind != 'wait':
            worst = outcome
    return worst


def assets_for(generation_id):
    """{content_sha256: byteplus_asset_id} for ACTIVE assets pinned by this generation."""
    rows = ManagedPortraitAsset.objects.filter(status='ACTIVE', id__in=ManagedPortraitPin.objects.filter(generation_id=generation_id)
                                               .values('asset_id')).values_list('content_sha256', 'byteplus_asset_id')
    return dict(rows)


def wait_started(generation_id, reason, now):
    row, _ = ManagedPortraitWait.objects.get_or_create(generation_id=generation_id, defaults={'started_at': now, 'reason': reason})
    return row.started_at


def clear_wait(generation_id):
    ManagedPortraitWait.objects.filter(generation_id=generation_id).delete()


def finish(generation_id):
    """Generation reached a terminal state: release its assets for expiry/eviction."""
    clear_wait(generation_id)
    return managed_pool.release_pins(generation_id)
