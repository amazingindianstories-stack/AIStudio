"""Independent Python export worker: bounded streams, native bytes, private ZIPs."""
import hashlib
import base64
import hmac
import logging
import re
import tempfile
import time
import uuid
import zipfile
from apps.common.resilience import recover
from apps.media.storage import get_storage, MediaNotFoundError
from . import services
from .models import MediaExport
from .zip_paths import safe_zip_member_path, folded, MAX_ITEMS

logger = logging.getLogger(__name__)

class LeaseLost(RuntimeError):
    pass


class WorkerStopped(RuntimeError):
    pass


def extension(content_type, key):
    mime = str(content_type or '').split(';')[0].lower()
    known = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif'}
    found = re.search(r'\.([a-z0-9]{2,5})$', key, re.I)
    return known.get(mime) or (found[1].lower() if found else 'bin')


def safe_error(error):
    # Providers can include signed query URLs in exception strings.
    return re.sub(r'https?://\S+', '[redacted URL]', str(error))[:500]


def output_key(job):
    # An obsolete worker can finish a slow upload after lease expiry. A unique
    # attempt key prevents that upload from overwriting the winner's archive.
    token = hashlib.sha256(job.lease_owner.encode()).hexdigest()[:16]
    return f'exports/{job.user_id}/{job.id}/{job.attempt_count}-{token}.zip'


class HeartbeatReader:
    def __init__(self, stream, beat):
        self.stream, self.beat = stream, beat

    def read(self, size=-1):
        self.beat()
        return self.stream.read(size)

    def seek(self, *args):
        return self.stream.seek(*args)

    def tell(self):
        return self.stream.tell()

    def seekable(self):
        return True


def run_once(*, owner=None, storage=None, clock=None, stop=None):
    if stop is not None and stop.is_set():
        return {'claimed': 0}
    clock = clock or services.now_ms
    owner = owner or 'export-worker:' + str(uuid.uuid4())
    job = services.claim_export(owner, now=clock())
    if job is None:
        return {'claimed': 0}
    warnings, processed, entries = [], 0, 0
    names = set()
    last_heartbeat = clock()
    key = output_key(job)
    def beat(force=False):
        nonlocal last_heartbeat
        if stop is not None and stop.is_set():
            raise WorkerStopped('Export worker stopped; retry pending.')
        now = clock()
        if force or now - last_heartbeat >= 30_000:
            if not services.heartbeat_export(job.id, owner,
                {'processed_items': processed, 'skipped_items': len(warnings), 'warnings': warnings},
                now=now, attempt=job.attempt_count):
                raise LeaseLost('Export lease lost.')
            last_heartbeat = now
    try:
        storage = storage or get_storage()
        if not job.items or len(job.items) != job.total_items or len(job.items) > MAX_ITEMS:
            raise ValueError('Export manifest is incomplete.')
        with tempfile.TemporaryFile(mode='w+b') as archive:
            with zipfile.ZipFile(archive, mode='w', compression=zipfile.ZIP_STORED, allowZip64=True) as output:
                for item in job.items:
                    beat(force=True)
                    try:
                        media = storage.open(item.source_key)
                    except Exception as error:
                        code = getattr(error, 'status_code', getattr(error, 'code', None))
                        reason = ('source_missing' if isinstance(error, MediaNotFoundError) else
                            'source_forbidden' if isinstance(error, PermissionError) or code == 403 else
                            'source_timeout' if isinstance(error, TimeoutError) else
                            'source_access_failed:' + type(error).__name__)
                        warnings.append({'id': str(item.generation_id), 'reason': reason[:160]})
                        processed += 1
                        beat(force=True)
                        raise RuntimeError('Export source unavailable; no archive was published.') from error
                    try:
                        size = media.content_length
                        if type(size) is not int or size < 0 or size > 9007199254740991:
                            raise ValueError(f'source length unavailable for {item.generation_id}')
                        name = item.filename
                        if job.manifest_version < 2:
                            ext = extension(media.content_type, item.source_key)
                            if not name.lower().endswith('.' + ext.lower()):
                                name += '.' + ext
                        if job.manifest_version >= 3:
                            safe_zip_member_path(name)
                        elif not name or name in ('.', '..') or any(char in name for char in ('/', '\\', '\x00', ':')):
                            raise ValueError('Unsafe export filename.')
                        if folded(name) in names:
                            raise ValueError('Duplicate export member.')
                        names.add(folded(name))
                        info = zipfile.ZipInfo(name)
                        info.compress_type = zipfile.ZIP_STORED
                        info.file_size = size
                        actual = 0
                        expected_sha = getattr(media, 'sha256', None)
                        expected_crc = getattr(media, 'crc32c', None)
                        digest = hashlib.sha256() if expected_sha else None
                        crc = None
                        if expected_crc:
                            import google_crc32c
                            crc = google_crc32c.Checksum()
                        with output.open(info, 'w', force_zip64=True) as target:
                            for chunk in media.stream:
                                if digest is not None:
                                    digest.update(chunk)
                                if crc is not None:
                                    crc.update(chunk)
                                target.write(chunk)
                                actual += len(chunk)
                                if actual > size:
                                    raise ValueError('Source integrity mismatch: declared length exceeded.')
                                beat()
                        if actual != size:
                            raise ValueError('Source integrity mismatch: truncated bytes.')
                        if digest is not None and not hmac.compare_digest(digest.hexdigest(), str(expected_sha).lower()):
                            raise ValueError('Source integrity mismatch: SHA256.')
                        if crc is not None and not hmac.compare_digest(base64.b64encode(crc.digest()).decode(), str(expected_crc)):
                            raise ValueError('Source integrity mismatch: CRC32C.')
                    finally:
                        media.stream.close()
                    processed += 1
                    entries += 1
                    beat(force=True)
            if entries == 0 or entries != job.total_items:
                raise ValueError('Export is incomplete.')
            output_bytes = archive.tell()
            archive.seek(0)
            beat(force=True)
            uploaded = storage.upload_stream(HeartbeatReader(archive, beat), key,
                content_type='application/zip', cache_control='private, max-age=0')
            if uploaded != output_bytes:
                raise ValueError('Archive upload length mismatch.')
            beat(force=True)
            if not services.complete_export(job.id, owner, output_key=key, output_bytes=output_bytes,
                skipped_items=len(warnings), warnings=warnings, now=clock(), attempt=job.attempt_count):
                raise LeaseLost('Export lease lost.')
        return {'claimed': 1, 'completed': 1, 'entries': entries, 'skipped': len(warnings)}
    except Exception as error:
        # A commit can succeed while its acknowledgment is lost. Never delete
        # an authoritative archive; if the database is unavailable, retain the
        # possible orphan for later reference-aware cleanup.
        if storage:
            try:
                if not MediaExport.objects.filter(output_key=key).exists():
                    storage.delete_by_urls(['/api/media/' + key])
            except Exception:
                pass
        try:
            services.fail_export(job.id, owner, safe_error(error), now=clock(), attempt=job.attempt_count)
        except Exception:
            # Database outage leaves the frozen manifest and lease recoverable.
            logger.error('media_export_failure_record_error export_id=%s', job.id)
        logger.error('media_export_worker_error export_id=%s error_type=%s', job.id, type(error).__name__)
        return {'claimed': 1, 'completed': 0, 'errors': 1}


def run_worker(*, interval=2.0, stop=None):
    failures = 0
    while stop is None or not stop.is_set():
        try:
            run_once(stop=stop)
            failures = 0
        except Exception as error:
            failures += 1
            recover(error, failures, stop=stop, logger=logger, name='media_export_worker')
            continue
        if stop is None:
            time.sleep(interval)
        else:
            stop.wait(interval)
