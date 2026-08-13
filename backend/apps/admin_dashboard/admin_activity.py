"""Port of src/lib/admin-activity.js — the admin audit trail: filtered
and paginated in Postgres."""

import re

from django.db import connection

from apps.generation.generations_service import encode_cursor

ACTIVITY_PAGE_SIZE = 50
MAX_ACTIVITY_PAGE = 200
MAX_ACTION_LENGTH = 64

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def parse_admin_activity_filter(params) -> dict:
    filter: dict = {}

    action = (params.get("action") or "").strip()
    if action:
        filter["action"] = action[:MAX_ACTION_LENGTH]

    user_id = params.get("userId")
    if user_id and UUID_RE.match(user_id):
        filter["userId"] = user_id

    return filter


def _conditions(filter: dict) -> tuple[list[str], list]:
    conds = []
    params = []
    if filter.get("action"):
        conds.append("action = %s")
        params.append(filter["action"])
    if filter.get("userId"):
        conds.append("user_id = %s")
        params.append(filter["userId"])
    return conds, params


def read_activity_actions() -> list[str]:
    with connection.cursor() as c:
        c.execute("SELECT DISTINCT action FROM activity_logs ORDER BY action")
        return [r[0] for r in c.fetchall()]


def query_activity(filter: dict | None = None, cursor: tuple[int, str] | None = None, limit_n: int = ACTIVITY_PAGE_SIZE) -> dict:
    filter = filter or {}
    limit = max(1, min(limit_n, MAX_ACTIVITY_PAGE))
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
            SELECT id, user_id, action, detail, created_at
            FROM activity_logs
            {page_where}
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            [*page_params, limit + 1],
        )
        rows = c.fetchall()

        c.execute(f"SELECT count(*)::int FROM activity_logs {totals_where}", params)
        (total_count,) = c.fetchone()

    has_more = len(rows) > limit
    page = rows[:limit] if has_more else rows
    last = page[-1] if page else None

    result = {
        "rows": [
            {"id": str(r[0]), "userId": str(r[1]) if r[1] else None, "action": r[2], "detail": r[3], "createdAt": r[4]}
            for r in page
        ],
        "total": total_count or 0,
        "nextCursor": encode_cursor(last[4], str(last[0])) if has_more and last else None,
    }
    if not cursor:
        result["actions"] = read_activity_actions()
    return result
