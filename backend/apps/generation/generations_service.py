"""Port of the history/feed-relevant half of src/lib/store-db.js (the
scoped, keyset-paginated read path — `queryHistory`/`countHistory`/
`countScope`/`readGenerationUpdates` — plus the small mutations the
history route itself performs: `getItem`/`deleteItem`/`setItemFolder`/
`setItemFavorite`). The queue/provider-facing half of that file
(reapStaleRunningImages, queueSnapshot, getQueuePosition, lockJob,
upsertItem) belongs to the generation-core port (task #6).

Pagination is a row-value keyset on (sort_col, id) DESC, NEVER an offset —
see the TS file's header for why (stability under concurrent inserts,
bounded cost at any depth). The trailing `id` tiebreaker is load-bearing:
created_at is a millisecond bigint and batch generation can insert several
rows in the same millisecond.
"""

import re
import time

from django.db import connection

from .models import Generation

MAX_QUERY_LENGTH = 200
MAX_PAGE_SIZE = 100
HISTORY_PAGE_SIZE = 20

_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def row_to_item(g: Generation) -> dict:
    return {
        "id": str(g.id),
        "kind": g.kind,
        "status": g.status,
        "prompt": g.prompt,
        "model": g.model,
        "aspectRatio": g.aspect_ratio,
        "resolution": g.resolution,
        "duration": g.duration,
        "url": g.url,
        "poster": g.poster,
        "referenceImages": g.reference_images,
        "referenceVideos": g.reference_videos,
        "error": g.error,
        "moderationBlocked": g.moderation_blocked,
        "taskId": g.task_id,
        "generateAudio": g.generate_audio,
        "videoTaskMode": g.video_task_mode,
        "projectId": str(g.project_id) if g.project_id else None,
        "folderId": str(g.folder_id) if g.folder_id else None,
        "userId": str(g.user_id) if g.user_id else None,
        "costCents": g.cost_cents,
        "isFavorite": g.is_favorite,
        "favoritedAt": g.favorited_at,
        "createdAt": g.created_at,
        "updatedAt": g.updated_at,
    }


def encode_cursor(sort: int, item_id: str) -> str:
    return f"{sort}.{item_id}"


def decode_cursor(raw: str | None) -> tuple[int, str] | None:
    if not raw:
        return None
    dot = raw.find(".")
    if dot <= 0:
        return None
    sort_raw, item_id = raw[:dot], raw[dot + 1 :]
    try:
        sort = int(sort_raw)
    except ValueError:
        return None
    if not _UUID_RE.match(item_id):
        return None
    return sort, item_id


def like_pattern(q: str) -> str:
    escaped = re.sub(r"[\\%_]", lambda m: f"\\{m.group(0)}", q)
    return f"%{escaped}%"


def _filter_conditions(filter: dict) -> tuple[list[str], list]:
    """Returns (sql_fragments, params) — Generation.objects filtering is done
    via the ORM for everything except the ILIKE clause, which needs the
    escaped-pattern raw comparison `filter_conditions` in the TS file also
    builds as raw SQL."""
    conds = []
    params = []
    if filter.get("projectId"):
        conds.append("project_id = %s")
        params.append(filter["projectId"])
    if "folderId" in filter:
        if filter["folderId"] is None:
            conds.append("folder_id IS NULL")
        elif filter["folderId"]:
            conds.append("folder_id = %s")
            params.append(filter["folderId"])
    if filter.get("kind"):
        conds.append("kind = %s")
        params.append(filter["kind"])
    if filter.get("favorite"):
        conds.append("is_favorite = true")
    q = (filter.get("q") or "").strip()
    if q:
        conds.append("prompt ILIKE %s")
        params.append(like_pattern(q))
    return conds, params


def query_history(filter: dict | None = None, cursor: tuple[int, str] | None = None, limit_n: int = 20) -> dict:
    filter = filter or {}
    sort_col = "favorited_at" if filter.get("favorite") else "created_at"

    conds, params = _filter_conditions(filter)
    if cursor:
        conds.append(f"({sort_col}, id) < (%s::bigint, %s::uuid)")
        params.extend([cursor[0], cursor[1]])

    where_sql = f"WHERE {' AND '.join(conds)}" if conds else ""
    sql = f"""
        SELECT * FROM generations
        {where_sql}
        ORDER BY {sort_col} DESC, id DESC
        LIMIT %s
    """
    params_with_limit = params + [limit_n + 1]

    rows = list(Generation.objects.raw(sql, params_with_limit))
    has_more = len(rows) > limit_n
    page = rows[:limit_n] if has_more else rows
    items = [row_to_item(g) for g in page]

    next_cursor = None
    if has_more and page:
        last = page[-1]
        sort_value = last.favorited_at if filter.get("favorite") else last.created_at
        next_cursor = encode_cursor(int(sort_value or last.created_at), str(last.id))

    return {"items": items, "nextCursor": next_cursor}


def count_history(filter: dict | None = None) -> dict:
    """True counts for the folder rail, in one grouped query. `folderId` is
    the grouping key here, so it must not also be a predicate — dropped from
    the filter before building conditions."""
    filter = {k: v for k, v in (filter or {}).items() if k != "folderId"}
    conds, params = _filter_conditions(filter)
    where_sql = f"WHERE {' AND '.join(conds)}" if conds else ""
    with connection.cursor() as c:
        c.execute(f"SELECT folder_id, count(*) FROM generations {where_sql} GROUP BY folder_id", params)
        rows = c.fetchall()

    by_folder: dict = {}
    total = 0
    unsorted = 0
    for folder_id, n in rows:
        n = int(n)
        total += n
        if folder_id:
            by_folder[str(folder_id)] = n
        else:
            unsorted += n
    return {"total": total, "unsorted": unsorted, "byFolder": by_folder}


def count_scope(filter: dict | None = None) -> int:
    conds, params = _filter_conditions(filter or {})
    where_sql = f"WHERE {' AND '.join(conds)}" if conds else ""
    with connection.cursor() as c:
        c.execute(f"SELECT count(*) FROM generations {where_sql}", params)
        return int(c.fetchone()[0])


def get_item(item_id: str) -> Generation | None:
    return Generation.objects.filter(id=item_id).first()


def delete_item(item_id: str) -> None:
    Generation.objects.filter(id=item_id).delete()


def set_item_folder(item_id: str, project_id: str | None, folder_id: str | None) -> dict | None:
    updated = Generation.objects.filter(id=item_id).update(
        project_id=project_id, folder_id=folder_id, updated_at=int(time.time() * 1000)
    )
    if not updated:
        return None
    return row_to_item(Generation.objects.get(id=item_id))


def set_item_favorite(item_id: str, is_favorite: bool) -> dict | None:
    now = int(time.time() * 1000)
    updated = Generation.objects.filter(id=item_id).update(
        is_favorite=is_favorite, favorited_at=now if is_favorite else None, updated_at=now
    )
    if not updated:
        return None
    return row_to_item(Generation.objects.get(id=item_id))


def read_generation_updates(since: int, limit_n: int = 100) -> list[dict]:
    """Answers "what changed since `since`, and what is still in flight?" —
    the OR clause is why an item that appeared and finished between two
    polls is never missed: a pure `updated_at > since` filter would never
    mention it."""
    # Resolve matching ids first (two simple indexed queries) rather than a
    # Django union() queryset, which doesn't combine cleanly with ORDER BY +
    # LIMIT across backends — then refetch ordered. Cheap: both sides are
    # small (in-flight jobs; rows touched since the last poll).
    ids = list(
        Generation.objects.filter(status__in=["queued", "running"]).values_list("id", flat=True)
    ) + list(Generation.objects.filter(updated_at__gt=since).values_list("id", flat=True))
    unique_ids = list(dict.fromkeys(ids))
    items = list(Generation.objects.filter(id__in=unique_ids).order_by("-updated_at")[:limit_n])
    return [row_to_item(g) for g in items]
