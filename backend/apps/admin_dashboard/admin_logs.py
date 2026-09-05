"""Port of src/lib/admin-logs.js — the admin generation log: filtered and
paginated in Postgres. See that file's header for why (the newest-500
window that made search/model-dropdown/row-count all silently partial)."""

import json
import re

from django.db import connection

from apps.generation.generations_service import encode_cursor, like_pattern

PROMPT_PREVIEW_CHARS = 300
MAX_LOG_PAGE = 200
MAX_CSV_ROWS = 20000
MAX_LOG_QUERY_LENGTH = 200

STATUSES = {"queued", "running", "succeeded", "failed"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def _json_value(value):
    if isinstance(value, str):
        try:
            return json.loads(value)
        except ValueError:
            return None
    return value


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

    if params.get("flagged") == "1":
        filter["flagged"] = True

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
    if filter.get("flagged"):
        conds.append("flagged = TRUE")
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
            SELECT id, kind, model, status, cost_cents, cost_basis, user_id,
                   left(prompt, %s) AS prompt, length(prompt) > %s AS prompt_truncated,
                   flagged, flagged_at, flag_reason, judge_score, created_at
            FROM generations
            {page_where}
            ORDER BY created_at DESC, id DESC
            LIMIT %s
            """,
            [PROMPT_PREVIEW_CHARS, PROMPT_PREVIEW_CHARS, *page_params, limit + 1],
        )
        rows = c.fetchall()

        c.execute(
            f"""SELECT count(*)::int,
                       coalesce(sum(CASE WHEN status = 'succeeded' THEN cost_cents ELSE 0 END), 0)::int,
                       coalesce(sum(CASE WHEN status = 'succeeded' AND cost_basis = 'reconciled' THEN cost_cents ELSE 0 END), 0)::int,
                       coalesce(sum(CASE WHEN status = 'succeeded' AND cost_basis <> 'reconciled' THEN cost_cents ELSE 0 END), 0)::int
                  FROM generations {totals_where}""", params
        )
        total_count, total_cost, reconciled_cost, estimated_cost = c.fetchone()

    has_more = len(rows) > limit
    page = rows[:limit] if has_more else rows
    last = page[-1] if page else None

    return {
        "rows": [
            {
                "id": str(r[0]), "kind": r[1], "model": r[2], "status": r[3], "costCents": r[4] or 0,
                "costBasis": "reconciled" if r[5] == "reconciled" else "estimated",
                "userId": str(r[6]) if r[6] else None, "prompt": r[7], "promptTruncated": r[8],
                "flagged": r[9], "flaggedAt": r[10], "flagReason": r[11], "judgeScore": _json_value(r[12]), "createdAt": r[13],
            }
            for r in page
        ],
        "total": total_count or 0,
        "totalCostCents": total_cost or 0,
        "reconciledCostCents": reconciled_cost or 0,
        "estimatedCostCents": estimated_cost or 0,
        "nextCursor": encode_cursor(last[13], str(last[0])) if has_more and last else None,
    }


def read_admin_logs_for_export(filter: dict | None = None) -> list[dict]:
    filter = filter or {}
    conds, params = _conditions(filter)
    where = f"WHERE {' AND '.join(conds)}" if conds else ""
    with connection.cursor() as c:
        c.execute(
            f"""
            SELECT id, kind, model, status, cost_cents, cost_basis, user_id, prompt,
                   flagged, flagged_at, flag_reason, judge_score, created_at
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
            "costBasis": "reconciled" if r[5] == "reconciled" else "estimated",
            "userId": str(r[6]) if r[6] else None, "prompt": r[7], "flagged": r[8],
            "flaggedAt": r[9], "flagReason": r[10], "judgeScore": _json_value(r[11]), "createdAt": r[12],
        }
        for r in rows
    ]
