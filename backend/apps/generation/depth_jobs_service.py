"""Port of src/lib/depth-jobs-db.js — see that file's docstring for the full
reasoning on every function here (FOR UPDATE SKIP LOCKED for claim, the
progress-scoped-to-running guard, why lastSeenAt/status derive "online"
rather than storing it). Numeric constants must stay identical to the JS
side, same rule as queue_service.py."""

import time
import uuid

from django.db import connection

from .models import DepthWorker, Generation

WORKER_STALE_MS = 45_000
MAX_DEPTH_REAP_ATTEMPTS = 3
CLAIM_GRACE_MS = 60_000
REAP_INTERVAL_MS = 30_000
_last_reap_at = 0


def claim_next_depth_job(worker_id: str) -> dict | None:
    now = int(time.time() * 1000)
    claim_id = uuid.uuid4()
    with connection.cursor() as c:
        c.execute(
            """
            UPDATE generations
            SET status = 'running', updated_at = %s, progress_percent = 0,
                progress_message = 'Claimed by worker', depth_claim_id = %s,
                depth_claim_worker_id = %s
            WHERE id = (
                SELECT id FROM generations
                WHERE kind = 'depth' AND status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, prompt, model, resolution, reference_videos, user_id,
                      created_at, track_characters, depth_claim_id
            """,
            [now, claim_id, worker_id],
        )
        row = c.fetchone()
    if not row:
        return None
    job_id, prompt, model, resolution, reference_videos, user_id, created_at, track_characters, claim_id = row
    return {
        "id": str(job_id),
        "claimId": str(claim_id),
        "prompt": prompt,
        "model": model,
        # Encoder choice rides in `resolution` — see the JS claim route's comment.
        "encoder": resolution,
        "trackCharacters": bool(track_characters),
        "referenceVideos": reference_videos,
        "userId": str(user_id) if user_id else None,
        "createdAt": created_at,
    }


def report_depth_progress(job_id: str, claim_id: str, percent: float, message: str | None) -> bool:
    clamped = max(0, min(100, round(percent)))
    return Generation.objects.filter(id=job_id, status="running", depth_claim_id=claim_id).update(
        progress_percent=clamped, progress_message=message, updated_at=int(time.time() * 1000)
    ) > 0


def complete_depth_job(job_id: str, claim_id: str, *, ok: bool, url: str | None = None, aspect_ratio: str | None = None, error: str | None = None) -> bool:
    now = int(time.time() * 1000)
    if ok:
        updates = {
            "status": "succeeded",
            "url": url,
            "progress_percent": None,
            "progress_message": None,
            "depth_claim_id": None,
            "depth_claim_worker_id": None,
            "updated_at": now,
        }
        if aspect_ratio:
            updates["aspect_ratio"] = aspect_ratio
        return Generation.objects.filter(id=job_id, status="running", depth_claim_id=claim_id).update(**updates) > 0
    else:
        return Generation.objects.filter(id=job_id, status="running", depth_claim_id=claim_id).update(
            status="failed",
            error=error or "Depth worker reported failure.",
            progress_percent=None,
            progress_message=None,
            depth_claim_id=None,
            depth_claim_worker_id=None,
            updated_at=now,
        ) > 0


def is_active_depth_claim(job_id: str, claim_id: str) -> bool:
    return Generation.objects.filter(id=job_id, status="running", depth_claim_id=claim_id).exists()


def upsert_depth_worker_heartbeat(w: dict) -> None:
    now = int(time.time() * 1000)
    DepthWorker.objects.update_or_create(
        worker_id=w["workerId"],
        defaults={
            "label": w.get("label"),
            "device": w.get("device"),
            "status": w.get("status") or "idle",
            "current_job_id": w.get("currentJobId"),
            "current_claim_id": w.get("currentClaimId"),
            "ram_limit_mb": w.get("ramLimitMb"),
            "ram_used_mb": w.get("ramUsedMb"),
            "last_seen_at": now,
            "created_at": now,
        },
    )


def reap_stale_depth_jobs(*, force: bool = False, now: int | None = None) -> int:
    global _last_reap_at
    now = now or int(time.time() * 1000)
    if not force and now - _last_reap_at < REAP_INTERVAL_MS:
        return 0
    _last_reap_at = now
    with connection.cursor() as c:
        c.execute(
            """
            UPDATE generations g
            SET depth_reap_attempts = depth_reap_attempts + 1,
                status = CASE WHEN depth_reap_attempts + 1 >= %s THEN 'failed' ELSE 'queued' END,
                error = CASE WHEN depth_reap_attempts + 1 >= %s
                  THEN 'Depth worker went offline while processing this job, and it could not be recovered after multiple attempts.'
                  ELSE NULL END,
                progress_percent = NULL, progress_message = NULL,
                depth_claim_id = NULL, depth_claim_worker_id = NULL,
                updated_at = %s
            WHERE g.kind = 'depth' AND g.status = 'running'
              AND g.updated_at < %s
              AND NOT EXISTS (
                SELECT 1 FROM depth_workers w
                WHERE w.worker_id = g.depth_claim_worker_id
                  AND w.current_job_id = g.id
                  AND w.current_claim_id = g.depth_claim_id
                  AND w.last_seen_at >= %s
              )
            """,
            [MAX_DEPTH_REAP_ATTEMPTS, MAX_DEPTH_REAP_ATTEMPTS, now, now - CLAIM_GRACE_MS, now - WORKER_STALE_MS],
        )
        return c.rowcount


def read_depth_worker_status() -> dict:
    reap_stale_depth_jobs()
    now = int(time.time() * 1000)
    workers = list(DepthWorker.objects.all())
    online = [w for w in workers if now - w.last_seen_at < WORKER_STALE_MS]

    queue_depth = Generation.objects.filter(kind="depth", status="queued").count()

    running_worker = next((w for w in online if w.status == "busy" and w.current_job_id), None)
    current_job = None
    if running_worker:
        g = Generation.objects.filter(id=running_worker.current_job_id).first()
        if g:
            current_job = {
                "id": str(g.id),
                "progressPercent": g.progress_percent,
                "progressMessage": g.progress_message,
            }

    return {
        "online": len(online) > 0,
        "workerCount": len(online),
        "queueDepth": queue_depth,
        "currentJob": current_job,
    }
