"""Django system check: warn loudly (not fail hard) when DATABASE_URL isn't
Postgres.

This backend leans on Postgres-specific raw SQL in several places that have
no ORM-portable equivalent — `pg_advisory_xact_lock` (projects_service.py's
default-project race guard, queue_service.py's job locking), `jsonb`
operators (canvas board state), `ILIKE`/escaped `LIKE` patterns and
`to_char(... at time zone 'utc')` (admin_stats.py/admin_logs.py/
generations_service.py's history and dashboard queries). None of that is
optional or swappable for a "lighter" engine — this app runs on Railway/Cloud
SQL Postgres in every real environment.

Pointing DATABASE_URL at SQLite (easy to do by accident — django-environ's
env.db() happily parses a sqlite:// URL with no complaint) doesn't fail at
startup; it fails ~60 tests deep into `manage.py test` with opaque errors
like `OperationalError: unrecognized token: ":"` (the `::int` cast) or
`no such function: pg_advisory_xact_lock`, with nothing pointing back at the
actual cause. That gap is what this check closes — it doesn't require a
Postgres connection can be *reached* right now, only that the configured
engine is honestly Postgres, so a missing/misconfigured DATABASE_URL is
surfaced as one clear line instead of a wall of unrelated-looking failures.

Deliberately a Warning, not an Error: a subset of the suite — anything that
doesn't touch the raw-SQL modules above — genuinely works fine against
SQLite (verified: apps.media, most of apps.admin_dashboard's parser tests,
apps.canvas's serialization tests all pass either way), and a contributor
running a quick subset of tests in an environment with no Postgres available
(no root, no Docker) shouldn't be hard-blocked from that. Silencing this
check without fixing the underlying engine is exactly what
DJANGO_ALLOW_NON_POSTGRES_TESTS is for, when that quick-subset use case is
genuinely what's wanted.
"""

from django.core.checks import Warning, register


@register()
def postgres_engine_check(app_configs, **kwargs):
    from django.conf import settings

    engine = settings.DATABASES.get("default", {}).get("ENGINE", "")
    if "postgresql" in engine:
        return []

    import os

    if os.environ.get("DJANGO_ALLOW_NON_POSTGRES_TESTS"):
        return []

    return [
        Warning(
            f"DATABASE_URL resolves to engine {engine!r}, not PostgreSQL. "
            "This backend uses Postgres-only raw SQL throughout (advisory "
            "locks, jsonb, ILIKE, to_char(...at time zone)) — a large chunk "
            "of the test suite will fail here with confusing, unrelated-"
            "looking errors rather than because of an actual bug. Point "
            "DATABASE_URL at a real Postgres instance (Railway, Cloud SQL, "
            "or a local `docker run -p 5432:5432 -e POSTGRES_PASSWORD=x "
            "postgres:16`) for a trustworthy run. Set "
            "DJANGO_ALLOW_NON_POSTGRES_TESTS=1 to silence this when you "
            "deliberately only want the subset of tests that don't touch "
            "raw SQL (e.g. no Postgres available in a sandboxed environment).",
            id="common.W001",
        )
    ]
