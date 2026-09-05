"""Port of the queue/provider-facing half of src/lib/store-db.js:
upsertItem, reapStaleRunningImages, queueSnapshot, getQueuePosition,
lockJob. See that file's comments (reproduced below per function) for the
full reasoning — this is dense, load-bearing concurrency/spend-control
logic and every constant here must stay numerically identical to the TS
side.
"""

import re
import time

from django.db import connection

from . import spend_window as sw
from .generations_service import row_to_item
from .models import Generation

# Global active-request caps, per kind. Anything beyond the cap waits in
# the queue.
MAX_CONCURRENT = {"image": 2, "video": 2}

# Must stay above /api/queue/execute's maxDuration equivalent — see the TS
# comment on STALE_RUNNING_MS in store-db.js. 300s budget + 120s slack.
STALE_RUNNING_MS = 7 * 60 * 1000

REAP_INTERVAL_MS = 30_000
_last_reap_at = 0


def upsert_item(item: dict) -> None:
    """item: the same dict shape row_to_item produces (camelCase keys),
    used both for reads and as the write shape from routes."""
    Generation.objects.update_or_create(
        id=item["id"],
        defaults={
            "kind": item["kind"],
            "status": item["status"],
            "prompt": item["prompt"],
            "model": item["model"],
            "aspect_ratio": item["aspectRatio"],
            "resolution": item.get("resolution"),
            "duration": item.get("duration"),
            "url": item.get("url"),
            "poster": item.get("poster"),
            "error": item.get("error"),
            "moderation_blocked": item.get("moderationBlocked"),
            "reference_images": item.get("referenceImages"),
            "reference_videos": item.get("referenceVideos"),
            "project_id": item.get("projectId"),
            "folder_id": item.get("folderId"),
            "user_id": item.get("userId"),
            "cost_cents": item.get("costCents") or 0,
            "cost_basis": item.get("costBasis") or "estimated",
            "poll_error_count": item.get("pollErrorCount") or 0,
            "last_poll_error_at": item.get("lastPollErrorAt"),
            "seed": item.get("seed"),
            "candidate_task_ids": item.get("candidateTaskIds"),
            "continuation_frame_url": item.get("continuationFrameUrl"),
            "is_favorite": item.get("isFavorite") or False,
            "favorited_at": item.get("favoritedAt"),
            "flagged": item.get("flagged") or False,
            "flagged_at": item.get("flaggedAt"),
            "flag_reason": item.get("flagReason"),
            "judge_score": item.get("judgeScore"),
            "task_id": item.get("taskId"),
            "generate_audio": item.get("generateAudio"),
            "video_task_mode": item.get("videoTaskMode"),
            "progress_percent": item.get("progressPercent"),
            "progress_message": item.get("progressMessage"),
            "track_characters": item.get("trackCharacters"),
            "created_at": item["createdAt"],
            "updated_at": item["updatedAt"],
        },
    )


def reap_stale_running_images() -> None:
    global _last_reap_at
    now = int(time.time() * 1000)
    if now - _last_reap_at < REAP_INTERVAL_MS:
        return
    _last_reap_at = now
    cutoff = now - STALE_RUNNING_MS
    with connection.cursor() as c:
        c.execute(
            """
            UPDATE generations
            SET status = 'failed',
                error = 'Generation timed out — the server process was interrupted.',
                updated_at = %s
            WHERE status = 'running'
              AND (kind = 'image' OR (kind = 'video' AND task_id IS NULL))
              AND updated_at < %s
            """,
            [now, cutoff],
        )


def _queue_snapshot(kind: str, created_at: int, item_id: str, best_of: int, window_start: int) -> dict:
    """Single round trip: concurrency counts plus the rolling spend window.
    See store-db.js's queueSnapshot docstring for the full reasoning
    (6h skirt on created_at is a redundant but index-backed superset of the
    updated_at predicate; failed-with-429 rows excluded since they cost
    nothing; Omni counted alongside images since it bills the same
    GOOGLE_API_KEY)."""
    skirt_start = window_start - 6 * 60 * 60 * 1000
    with connection.cursor() as c:
        c.execute(
            """
            WITH global_user_limit AS (
              SELECT coalesce(
                max(CASE WHEN value ~ '^[0-9]{1,9}$' AND value::int >= 1 THEN value::int END),
                1
              ) AS value
              FROM settings WHERE key = 'maxConcurrentJobs'
            ), running_by_user AS (
              SELECT user_id, count(*)::int AS n
              FROM generations
              WHERE status = 'running' AND kind = %(kind)s AND user_id IS NOT NULL
              GROUP BY user_id
            ), ranked_queue AS (
              SELECT q.id, q.created_at,
                row_number() OVER (
                  PARTITION BY coalesce(q.user_id::text, q.id::text)
                  ORDER BY q.created_at ASC, q.id ASC
                ) AS user_rank,
                coalesce(r.n, 0) AS user_running,
                coalesce(
                  CASE WHEN ul.value ~ '^[0-9]{1,9}$' AND ul.value::int >= 1 THEN ul.value::int END,
                  gl.value
                ) AS user_cap
              FROM generations q
              CROSS JOIN global_user_limit gl
              LEFT JOIN running_by_user r ON r.user_id = q.user_id
              LEFT JOIN user_limits ul ON ul.user_id = q.user_id AND ul.key = 'maxConcurrentJobs'
              WHERE q.status = 'queued' AND q.kind = %(kind)s
            ), eligible_queue AS (
              SELECT * FROM ranked_queue
              WHERE user_rank <= greatest(user_cap - user_running, 0)
            )
            SELECT
              (SELECT count(*) FROM generations
                WHERE status = 'running' AND kind = %(kind)s) AS running,
              (SELECT count(*) FROM eligible_queue
                WHERE (created_at, id) < (%(created_at)s, %(item_id)s::uuid)) AS older,
              EXISTS(SELECT 1 FROM eligible_queue WHERE id = %(item_id)s::uuid) AS user_eligible,
              (SELECT coalesce(sum(
                  CASE WHEN status = 'running' THEN cost_cents * %(best_of)s ELSE cost_cents END
                ), 0) FROM generations
                WHERE created_at > %(skirt_start)s
                  AND updated_at >= %(window_start)s
                  AND status IN ('running', 'succeeded', 'failed')
                  AND (kind = 'image' OR model ILIKE '%%omni%%')
                  AND NOT (status = 'failed' AND coalesce(error, '') LIKE '%%429%%')
              ) AS window_cents,
              (SELECT count(*) FROM generations
                WHERE created_at > %(skirt_start)s
                  AND updated_at >= %(window_start)s
                  AND status IN ('running', 'succeeded', 'failed')
                  AND (kind = 'image' OR model ILIKE '%%omni%%')
                  AND NOT (status = 'failed' AND coalesce(error, '') LIKE '%%429%%')
              ) AS window_rows,
              (SELECT min(updated_at) FROM generations
                WHERE created_at > %(skirt_start)s
                  AND updated_at >= %(window_start)s
                  AND status IN ('running', 'succeeded', 'failed')
                  AND (kind = 'image' OR model ILIKE '%%omni%%')
                  AND NOT (status = 'failed' AND coalesce(error, '') LIKE '%%429%%')
              ) AS oldest_updated_at
            """,
            {"kind": kind, "created_at": created_at, "item_id": item_id, "best_of": best_of, "skirt_start": skirt_start, "window_start": window_start},
        )
        columns = [col[0] for col in c.description]
        row = dict(zip(columns, c.fetchone()))
    return {
        "running": int(row["running"] or 0),
        "older": int(row["older"] or 0),
        "userEligible": bool(row["user_eligible"]),
        "windowCents": int(row["window_cents"] or 0),
        "windowRows": int(row["window_rows"] or 0),
        "oldestUpdatedAt": int(row["oldest_updated_at"]) if row["oldest_updated_at"] is not None else None,
    }


def get_queue_position(item_id: str) -> dict | None:
    reap_stale_running_images()
    gen = Generation.objects.filter(id=item_id).first()
    if not gen:
        return None
    item = row_to_item(gen)
    if item["status"] != "queued":
        return {"position": 0, "status": item["status"], "item": item}

    cap = MAX_CONCURRENT.get(item["kind"], 2)
    now = int(time.time() * 1000)
    best_of = sw.best_of_multiplier()
    snap = _queue_snapshot(item["kind"], item["createdAt"], item["id"], best_of, now - sw.SPEND_WINDOW_MS)

    if not snap["userEligible"]:
        return {"position": 1, "status": item["status"], "heldForConcurrency": True}

    total_ahead = snap["running"] + snap["older"]
    position = max(0, total_ahead - (cap - 1))
    if position > 0:
        return {"position": position, "status": item["status"]}

    bills_gemini = item["kind"] == "image" or bool(re.search(r"omni", item["model"], re.IGNORECASE))
    if not bills_gemini:
        return {"position": position, "status": item["status"]}

    limit_cents = sw.spend_limit_cents()
    job_cents = (item.get("costCents") or 0) * best_of
    if sw.admits(snap["windowCents"], job_cents, limit_cents, snap["windowRows"] > 0):
        return {"position": position, "status": item["status"]}

    return {
        "position": 1,
        "status": item["status"],
        "heldForBudget": True,
        "heldReason": sw.HELD_MESSAGE,
        "retryAfterMs": sw.hold_retry_after_ms(snap["oldestUpdatedAt"], now),
    }


def lock_job(item_id: str) -> bool:
    """Atomic: only locks if still queued."""
    updated = Generation.objects.filter(id=item_id, status="queued").update(
        status="running", updated_at=int(time.time() * 1000)
    )
    return updated > 0
