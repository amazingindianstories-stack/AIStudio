"""Depth GPU protocol state, with database claim fencing and bounded recovery."""
import uuid
from django.db import connection, transaction
from apps.common import leases
from apps.generation.models import Generation
from .models import DepthWorker

WORKER_STALE_MS = 45000
CLAIM_GRACE_MS = 60000
REAP_INTERVAL_MS = 30000
MAX_REAP_ATTEMPTS = 3
REAP_ERROR = 'Depth worker went offline while processing this job, and it could not be recovered after multiple attempts.'


@transaction.atomic
def claim_next(worker_id, protocol_version=1, now=None):
    now = leases.now_ms() if now is None else now
    row = Generation.objects.select_for_update(skip_locked=True).filter(kind='depth', status='queued').order_by('created_at').first()
    if row is None:
        return None
    row.status = 'running'
    row.updated_at = now
    row.progress_percent = 0
    row.progress_message = 'Claimed by worker'
    row.depth_claim_id = uuid.uuid4() if protocol_version >= 2 else None
    row.depth_claim_worker_id = worker_id
    row.save(update_fields=['status', 'updated_at', 'progress_percent', 'progress_message', 'depth_claim_id', 'depth_claim_worker_id'])
    return row


def active_claim(job_id, claim_id=None):
    return Generation.objects.filter(id=job_id, status='running', depth_claim_id=claim_id or None)


def progress(job_id, claim_id, percent, message=None, now=None):
    return bool(active_claim(job_id, claim_id).update(progress_percent=percent,
        progress_message=message, updated_at=leases.now_ms() if now is None else now))


def complete(job_id, claim_id, *, ok, url=None, aspect_ratio=None, error=None, now=None):
    changes = dict(status='succeeded' if ok else 'failed', progress_percent=None,
        progress_message=None, depth_claim_id=None, depth_claim_worker_id=None,
        updated_at=leases.now_ms() if now is None else now)
    if ok:
        changes['url'] = url
        if aspect_ratio is not None:
            changes['aspect_ratio'] = aspect_ratio
    else:
        changes['error'] = error or 'Depth worker reported failure.'
    return bool(active_claim(job_id, claim_id).update(**changes))


def heartbeat(worker_id, *, now=None, **fields):
    now = leases.now_ms() if now is None else now
    # INSERT ON CONFLICT keeps the original identity and creation timestamp.
    with connection.cursor() as cursor:
        cursor.execute('''INSERT INTO depth_workers
            (id,worker_id,label,device,status,current_job_id,current_claim_id,protocol_version,
             ram_limit_mb,ram_used_mb,last_seen_at,created_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT(worker_id) DO UPDATE SET label=excluded.label,device=excluded.device,
              status=excluded.status,current_job_id=excluded.current_job_id,
              current_claim_id=excluded.current_claim_id,protocol_version=excluded.protocol_version,
              ram_limit_mb=excluded.ram_limit_mb,ram_used_mb=excluded.ram_used_mb,
              last_seen_at=excluded.last_seen_at''',
            [uuid.uuid4(), worker_id, fields.get('label'), fields.get('device'), fields.get('status', 'idle'),
             fields.get('current_job_id'), fields.get('current_claim_id'), fields.get('protocol_version', 1),
             fields.get('ram_limit_mb'), fields.get('ram_used_mb'), now, now])


def reap(*, force=False, now=None):
    now = leases.now_ms() if now is None else now
    owner = str(uuid.uuid4())
    if not force and not leases.claim('lease:depth-reap-cooldown', owner, now=now, ttl_ms=REAP_INTERVAL_MS):
        return 0
    if not leases.claim('lease:depth-reap-running', owner, now=now, ttl_ms=CLAIM_GRACE_MS):
        return 0
    try:
        with connection.cursor() as cursor:
            cursor.execute('''UPDATE generations g SET
                status=CASE WHEN depth_reap_attempts+1 >= %s THEN 'failed' ELSE 'queued' END,
                error=CASE WHEN depth_reap_attempts+1 >= %s THEN %s ELSE NULL END,
                depth_reap_attempts=depth_reap_attempts+1, depth_claim_id=NULL,
                depth_claim_worker_id=NULL, progress_percent=NULL,progress_message=NULL,updated_at=%s
                WHERE kind='depth' AND status='running' AND depth_claim_id IS NOT NULL
                AND updated_at < %s AND NOT EXISTS (SELECT 1 FROM depth_workers w
                    WHERE w.worker_id=g.depth_claim_worker_id AND w.current_job_id=g.id
                    AND w.current_claim_id=g.depth_claim_id AND w.protocol_version >= 2
                    AND w.last_seen_at >= %s)''',
                [MAX_REAP_ATTEMPTS, MAX_REAP_ATTEMPTS, REAP_ERROR, now, now-CLAIM_GRACE_MS, now-WORKER_STALE_MS])
            return cursor.rowcount
    finally:
        leases.release('lease:depth-reap-running', owner)


def status(now=None):
    now = leases.now_ms() if now is None else now
    reap(now=now)
    workers = list(DepthWorker.objects.filter(last_seen_at__gt=now-WORKER_STALE_MS))
    result = {'online': bool(workers), 'workerCount': len(workers),
              'queueDepth': Generation.objects.filter(kind='depth', status='queued').count()}
    busy = next((worker for worker in workers if worker.status == 'busy' and worker.current_job_id), None)
    row = Generation.objects.filter(pk=busy.current_job_id).first() if busy else None
    if row:
        result['currentJob'] = {'id': str(row.id)}
        if row.progress_percent is not None: result['currentJob']['progressPercent'] = row.progress_percent
        if row.progress_message is not None: result['currentJob']['progressMessage'] = row.progress_message
    return result
