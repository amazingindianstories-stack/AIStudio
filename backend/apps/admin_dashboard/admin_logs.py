"""Port of src/lib/admin-logs.js — the admin generation log: filtered and
paginated in Postgres. See that file's header for why (the newest-500
window that made search/model-dropdown/row-count all silently partial)."""

import re

from django.db import connection

from apps.generation.generations_service import encode_cursor, like_pattern

PROMPT_PREVIEW_CHARS = 300
MAX_LOG_PAGE = 200
MAX_CSV_ROWS = 20000
MAX_LOG_QUERY_LENGTH = 200

STATUSES = {"queued", "running", "succeeded", "failed"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def parse_admin_log_filter(params) -> dict:
    filter: dict = {}

    user_id = params.get("userId")
    if user_id and UUID_RE.match(user_id):
        filter["userId"] = user_id

    kind = params.get("kind")
    if kind in ("image", "video"):
        filter["kind"] = kind

    model = params.get("model")
    if model:
        filter["model"] = model

    status = params.get("status")
    if status and status in STATUSES:
        filter["status"] = status

    q = (params.get("q") or "").strip()
    if q:
        filter["q"] = q[:MAX_LOG_QUERY_LENGTH]

    return filter


def _conditions(filter: dict) -> tuple[list[str], list]:
    conds = []
    params = []
    if filter.get("userId"):
        conds.append("user_id = %s")
        params.append(filter["userId"])
    if filter.get("kind"):
        conds.append("kind = %s")
        params.append(filter["kind"])
    if filter.get("model"):
        conds.append("model = %s")
        params.append(filter["model"])
    if filter.get("status"):
        conds.append("status = %s")
        params.append(filter["status"])
    q = (filter.get("q") or "").strip()
    if q:
        conds.append("prompt ILIKE %s")
        params.append(like_pattern(q))
    return conds, params


def query_admin_logs(filter: dict | None = None, cursor: tuple[int, str] | None = None, limit_n: int = 100) -> dict:
    filter = filter or {}
    limit = max(1, min(limit_n, MAX_LOG_PAGE))
    conds, params = _conditions(filter)

    page_conds = list(conds)
    page_params = list(params)
    if cursor:
        page_conds.append("(created_at, id) < (%s::bigint, %s::uuid)")
        page_params.extend([cursor[0], cursor[1]])

    page_where = f"WHERE {' AND '.join(page_conds)}" if page_conds else ""
    totals_where = f"WHERE {' AND '.join(conds)}" if conds else ""

    with connection.cursor() as c:
        c.execute(
            f"""
            SELECT id, kind, model, status, cost_cents, user_id,
                   left(prompt, %s) AS prompt, length(prompt) > %s AS prompt_truncated,
                   created_at
            FROM generations
            {page_where}
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            [PROMPT_PREVIEW_CHARS, PROMPT_PREVIEW_CHARS, *page_params, limit + 1],
        )
        rows = c.fetchall()

        c.execute(
            f"SELECT count(*)::int, coalesce(sum(cost_cents), 0)::int FROM generations {totals_where}", params
        )
        total_count, total_cost = c.fetchone()

    has_more = len(rows) > limit
    page = rows[:limit] if has_more else rows
    last = page[-1] if page else None

    return {
        "rows": [
            {
                "id": str(r[0]), "kind": r[1], "model": r[2], "status": r[3], "costCents": r[4] or 0,
                "userId": str(r[5]) if r[5] else None, "prompt": r[6], "promptTruncated": r[7], "createdAt": r[8],
            }
            for r in page
        ],
        "total": total_count or 0,
        "totalCostCents": total_cost or 0,
        "nextCursor": encode_cursor(last[8], str(last[0])) if has_more and last else None,
    }


def read_admin_logs_for_export(filter: dict | None = None) -> list[dict]:
    filter = filter or {}
    conds, params = _conditions(filter)
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    with connection.cursor() as c:
        c.execute(
            f"""
            SELECT id, kind, model, status, cost_cents, user_id, prompt, created_at
            FROM generations
            {where}
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            [*params, MAX_CSV_ROWS],
        )
        rows = c.fetchall()
    return [
        {
            "id": str(r[0]), "kind": r[1], "model": r[2], "status": r[3], "costCents": r[4] or 0,
            "userId": str(r[5]) if r[5] else None, "prompt": r[6], "createdAt": r[7],
        }
        for r in rows
    ]
