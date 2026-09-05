"""Port of src/lib/admin-stats.js — dashboard headline figures, aggregated
in Postgres. See that file's header: a total is a count(*)/sum(), never
the length of an array shipped over the wire — the 2026-07-30 incident
this file exists to prevent (Total spend under-reporting by 41% because
the dashboard summed only the newest 500 rows)."""

from django.db import connection

OVER_TIME_DAYS = 90

DAY_EXPR = "to_char(to_timestamp(created_at / 1000.0) at time zone 'utc', 'YYYY-MM-DD')"


def read_admin_stats() -> dict:
    import time

    since = int(time.time() * 1000) - OVER_TIME_DAYS * 24 * 60 * 60 * 1000

    with connection.cursor() as c:
        c.execute(
            """SELECT count(*)::int,
                      coalesce(sum(CASE WHEN status = 'succeeded' THEN cost_cents ELSE 0 END), 0)::int,
                      coalesce(sum(CASE WHEN status = 'succeeded' AND cost_basis = 'reconciled' THEN cost_cents ELSE 0 END), 0)::int,
                      coalesce(sum(CASE WHEN status = 'succeeded' AND cost_basis <> 'reconciled' THEN cost_cents ELSE 0 END), 0)::int
                 FROM generations"""
        )
        total_count, total_cost, reconciled_cost, estimated_cost = c.fetchone()

        c.execute("SELECT kind, count(*)::int FROM generations GROUP BY kind")
        kind_rows = c.fetchall()

        c.execute("SELECT model, count(*)::int FROM generations GROUP BY model ORDER BY count(*) DESC")
        model_rows = c.fetchall()

        c.execute(
            f"SELECT {DAY_EXPR} AS day, count(*)::int FROM generations WHERE created_at >= %s "
            f"GROUP BY {DAY_EXPR} ORDER BY 1 ASC",
            [since],
        )
        day_rows = c.fetchall()

    by_kind_map = dict(kind_rows)

    return {
        "totalGenerations": total_count,
        "totalCostCents": total_cost,
        "reconciledCostCents": reconciled_cost,
        "estimatedCostCents": estimated_cost,
        # Fixed order with explicit zeros, so the pie chart doesn't reorder
        # its slices (and recolour them) as the mix shifts.
        "byKind": [{"name": name, "value": by_kind_map.get(name, 0)} for name in ("image", "video")],
        "byModel": [{"name": name, "value": value} for name, value in model_rows],
        "overTime": [{"day": day, "count": count} for day, count in day_rows],
        "models": [name for name, _value in model_rows],
    }
