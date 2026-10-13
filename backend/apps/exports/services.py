"""Owned export selections, immutable manifests, and fenced worker transitions."""
from django.conf import settings
from django.db import transaction
from django.db.models import Q, F
from apps.generation.models import Generation
from .zip_paths import resolve_archive_paths, MAX_ITEMS
from apps.library.services.idempotency import now_ms
from apps.media.keys import media_key_from_ref, is_export_key
from apps.media.grants import authorize_owned_upload_read as authorize_upload_read
from .models import MediaExport, MediaExportItem

CHUNK_LIMIT = 500
TTL_MS = 7 * 24 * 60 * 60_000
LEASE_MS = 90_000
MAX_ATTEMPTS = 3

class ExportError(ValueError):
    pass


def create_export(user_id, now=None):
    now = now_ms() if now is None else now
    job = MediaExport.objects.create(user_id=user_id, status='draft', created_at=now, updated_at=now)
    return {'id': str(job.id), 'status': 'draft'}


def owned_export(export_id, user_id, lock=False):
    query = MediaExport.objects.select_for_update() if lock else MediaExport.objects
    return query.filter(pk=export_id, user_id=user_id).first()


@transaction.atomic
def append_items(export_id, user_id, raw_ids, now=None):
    ids = list(dict.fromkeys(value for value in raw_ids if isinstance(value, str) and value))
    if not ids or len(ids) > CHUNK_LIMIT:
        raise ExportError('INVALID_EXPORT_ITEMS')
    job = owned_export(export_id, user_id, lock=True)
    if not job:
        raise ExportError('EXPORT_NOT_FOUND')
    if job.status != 'draft':
        raise ExportError('EXPORT_NOT_DRAFT')
    rows = {str(row.id): row for row in Generation.objects.filter(pk__in=ids).only('id', 'kind', 'url')}
    existing = {str(value) for value in MediaExportItem.objects.filter(export=job).values_list('generation_id', flat=True)}
    accepted, rejected = [], []
    position = len(existing)
    for identifier in ids:
        row = rows.get(identifier)
        key = media_key_from_ref(row.url, getattr(settings, 'GCP_MEDIA_CDN_URL', '')) if row and row.kind in ('image', 'video', 'depth') and row.url else None
        if not row or not key or is_export_key(key):
            rejected.append({'id': identifier, 'reason': 'not_found' if row is None else 'not_downloadable'})
            continue
        try:
            authorize_upload_read(key, user_id)
        except ValueError:
            rejected.append({'id': identifier, 'reason': 'not_downloadable'})
            continue
        if identifier in existing:
            continue
        position += 1
        accepted.append(MediaExportItem(export=job, generation_id=identifier, position=position,
            source_key=key, filename=f'{position:06d}-{identifier}'))
    MediaExportItem.objects.bulk_create(accepted, ignore_conflicts=True)
    total = len(existing) + len(accepted)
    if total > MAX_ITEMS:
        raise ExportError('EXPORT_ITEM_LIMIT')
    job.total_items, job.updated_at = total, now_ms() if now is None else now
    job.save(update_fields=['total_items', 'updated_at'])
    return {'accepted': len(accepted), 'totalItems': total, 'rejected': rejected}


@transaction.atomic
def finalize_export(export_id, user_id, now=None):
    job = owned_export(export_id, user_id, lock=True)
    if not job or job.status not in ('draft', 'failed') or job.total_items <= 0:
        raise ExportError('EXPORT_NOT_FINALIZABLE')
    # Only drafts receive the new mapping. Already-finalized V1/V2 retries
    # retain their original object keys and filenames byte-for-byte.
    if job.status == 'draft':
        items = list(MediaExportItem.objects.filter(export=job).order_by('position'))
        try:
            paths = resolve_archive_paths(items)
        except ValueError as error:
            raise ExportError('EXPORT_MANIFEST_INVALID') from error
        sources = {str(row.id): row for row in Generation.objects.filter(id__in=[item.generation_id for item in items]).only('id', 'url')}
        for item in items:
            item.filename = paths[str(item.generation_id)]
            item.source_key = media_key_from_ref(sources[str(item.generation_id)].url, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
            if not item.source_key:
                raise ExportError('EXPORT_MANIFEST_INVALID')
            try:
                authorize_upload_read(item.source_key, user_id)
            except ValueError as error:
                raise ExportError('EXPORT_MANIFEST_INVALID') from error
        MediaExportItem.objects.bulk_update(items, ['filename', 'source_key'])
        job.manifest_version = 3
    job.status, job.error, job.attempt_count = 'queued', None, 0
    job.updated_at = now_ms() if now is None else now
    job.save(update_fields=['status', 'error', 'attempt_count', 'updated_at', 'manifest_version'])
    return job


@transaction.atomic
def claim_export(owner, now=None):
    now = now_ms() if now is None else now
    # A draft selection belongs to its actor and may be intentionally retained.
    # Worker polling must never collect it solely because it has not been edited.
    MediaExport.objects.filter(status='failed', updated_at__lt=now - TTL_MS).delete()
    MediaExport.objects.filter(status='running', lease_until__lt=now, attempt_count__gte=MAX_ATTEMPTS).update(
        status='failed', error='Export worker stopped before completing the archive.',
        lease_owner=None, lease_until=None, updated_at=now)
    job = MediaExport.objects.select_for_update(skip_locked=True).filter(
        Q(status='queued') | Q(status='running', lease_until__lt=now),
        attempt_count__lt=MAX_ATTEMPTS).order_by('created_at', 'id').first()
    if job is None:
        return None
    job.status, job.lease_owner, job.lease_until = 'running', owner, now + LEASE_MS
    job.attempt_count += 1
    job.processed_items, job.skipped_items, job.warnings, job.error, job.updated_at = 0, 0, [], None, now
    job.save(update_fields=['status', 'lease_owner', 'lease_until', 'attempt_count', 'processed_items', 'skipped_items', 'warnings', 'error', 'updated_at'])
    job.items = list(MediaExportItem.objects.filter(export=job).order_by('position'))
    return job


def leased_query(export_id, owner, now, attempt=None):
    query = MediaExport.objects.filter(pk=export_id, status='running', lease_owner=owner, lease_until__gte=now)
    return query.filter(attempt_count=attempt) if attempt is not None else query


def heartbeat_export(export_id, owner, progress=None, now=None, attempt=None):
    now = now_ms() if now is None else now
    changes = {key: value for key, value in (progress or {}).items() if key in ('processed_items', 'skipped_items', 'warnings')}
    changes.update(lease_until=now + LEASE_MS, updated_at=now)
    return bool(leased_query(export_id, owner, now, attempt).update(**changes))


@transaction.atomic
def complete_export(export_id, owner, *, output_key, output_bytes, skipped_items=0, warnings=None, now=None, attempt=None):
    now = now_ms() if now is None else now
    if skipped_items or warnings or output_bytes <= 0:
        raise ExportError('EXPORT_INCOMPLETE')
    updated = leased_query(export_id, owner, now, attempt).filter(total_items__gt=0).update(status='ready', output_key=output_key,
        output_bytes=output_bytes, processed_items=F('total_items'), skipped_items=skipped_items,
        warnings=warnings or [], expires_at=now + TTL_MS, lease_owner=None, lease_until=None, updated_at=now)
    if updated:
        MediaExportItem.objects.filter(export_id=export_id).delete()
    return bool(updated)


@transaction.atomic
def fail_export(export_id, owner, error, now=None, attempt=None):
    now = now_ms() if now is None else now
    job = leased_query(export_id, owner, now, attempt).select_for_update().first()
    if not job:
        return False
    job.status = 'failed' if job.attempt_count >= MAX_ATTEMPTS else 'queued'
    job.error, job.lease_owner, job.lease_until, job.updated_at = str(error)[:500], None, None, now
    job.save(update_fields=['status', 'error', 'lease_owner', 'lease_until', 'updated_at'])
    return True


def cleanup_expired_archives(storage, now=None):
    """Idempotent object TTL cleanup; status rows stay so downloads return 410."""
    now = now_ms() if now is None else now
    count = 0
    for job in MediaExport.objects.filter(status='ready', expires_at__lte=now, output_key__isnull=False).iterator():
        storage.delete_by_urls(['/api/media/' + job.output_key])
        count += 1
    return count
