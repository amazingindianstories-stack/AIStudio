"""Port of src/lib/depth-jobs-db.js — see that file's docstring for the full
reasoning on every function here (FOR UPDATE SKIP LOCKED for claim, the
progress-scoped-to-running guard, why lastSeenAt/status derive "online"
rather than storing it). Numeric constants must stay identical to the JS
side, same rule as queue_service.py."""

import time

from django.db import connection

from .models import DepthWorker, Generation

WORKER_STALE_MS = 45_000


def claim_next_depth_job(worker_id: str) -> dict | None:
    now = int(time.time() * 1000)
    with connection.cursor() as c:
        c.execute(
            """
            UPDATE generations
            SET status = 'running', updated_at = %s, progress_percent = 0,
                progress_message = 'Claimed by worker'
            WHERE id = (
                SELECT id FROM generations
                WHERE kind = 'depth' AND status = 'queued'
                ORDER BY created_at ASC
                LIMIT 1
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, prompt, model, resolution, reference_videos, user_id, created_at, track_characters
            """,
            [now],
        )
        row = c.fetchone()
    if not row:
        return None
    job_id, prompt, model, resolution, reference_videos, user_id, created_at, track_characters = row
    return {
        "id": str(job_id),
        "prompt": prompt,
        "model": model,
        # Encoder choice rides in `resolution` — see the JS claim route's comment.
        "encoder": resolution,
        "trackCharacters": bool(track_characters),
        "referenceVideos": reference_videos,
        "userId": str(user_id) if user_id else None,
        "createdAt": created_at,
    }


def report_depth_progress(job_id: str, percent: float, message: str | None) -> None:
    clamped = max(0, min(100, round(percent)))
    Generation.objects.filter(id=job_id, status="running").update(
        progress_percent=clamped, progress_message=message, updated_at=int(time.time() * 1000)
    )


def complete_depth_job(job_id: str, *, ok: bool, url: str | None = None, aspect_ratio: str | None = None, error: str | None = None) -> None:
    now = int(time.time() * 1000)
    if ok:
        updates = {
            "status": "succeeded",
            "url": url,
            "progress_percent": None,
            "progress_message": None,
            "updated_at": now,
        }
        if aspect_ratio:
            updates["aspect_ratio"] = aspect_ratio
        Generation.objects.filter(id=job_id).update(**updates)
    else:
        Generation.objects.filter(id=job_id).update(
            status="failed",
            error=error or "Depth worker reported failure.",
            progress_percent=None,
            progress_message=None,
            updated_at=now,
        )


def upsert_depth_worker_heartbeat(w: dict) -> None:
    now = int(time.time() * 1000)
    DepthWorker.objects.update_or_create(
        worker_id=w["workerId"],
        defaults={
            "label": w.get("label"),
            "device": w.get("device"),
            "status": w.get("status") or "idle",
            "current_job_id": w.get("currentJobId"),
            "ram_limit_mb": w.get("ramLimitMb"),
            "ram_used_mb": w.get("ramUsedMb"),
            "last_seen_at": now,
            "created_at": now,
        },
    )


def read_depth_worker_status() -> dict:
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
