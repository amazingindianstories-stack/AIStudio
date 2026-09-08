import time

from django.db import connection


def claim_lease(key, owner, ttl_ms=30_000, now=None):
    if not key.startswith("lease:") or not owner:
        raise ValueError("A lease key and owner are required")
    now = int(time.time() * 1000) if now is None else now
    with connection.cursor() as cursor:
        cursor.execute(
            """
            INSERT INTO settings (key, value, updated_at)
            VALUES (%s, %s, %s)
            ON CONFLICT (key) DO UPDATE
              SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
              WHERE settings.updated_at <= %s
            RETURNING key
            """,
            [key, owner, now + ttl_ms, now],
        )
        return cursor.fetchone() is not None


def release_lease(key, owner):
    with connection.cursor() as cursor:
        cursor.execute("DELETE FROM settings WHERE key = %s AND value = %s", [key, owner])
        return cursor.rowcount == 1
