"""PostgreSQL connection usage per ``application_name``, against what the server will accept.

A cheap read (one aggregate over ``pg_stat_activity``) for the scheduler's alert and the admin status page. Every
component names its connections ``veevee-<component>`` (``config/db_profile.py``); behind PgBouncer a server
connection carries the name of the client that last used it. The total counts every client backend, which any role
may see. The per-name split of other roles' sessions is only visible to a role holding ``pg_read_all_stats``
(docs/operations/database-connections.md); without it those sessions are listed as ``(other roles)``.
"""
from django.db import connection

# Share of the connections available to ordinary roles at which the scheduler logs a warning.
WARN_RATIO = 0.8
OTHER_ROLES = '(other roles)'
UNNAMED = '(unnamed)'


def snapshot():
    with connection.cursor() as cursor:
        # Inside a transaction PostgreSQL reuses the first activity snapshot it took; this reads the current one.
        cursor.execute('SELECT pg_stat_clear_snapshot()')
        cursor.execute("""SELECT current_setting('max_connections')::int,
                current_setting('superuser_reserved_connections')::int,
                coalesce(nullif(current_setting('reserved_connections', true), ''), '0')::int""")
        maximum, superuser_reserved, reserved = cursor.fetchone()
        cursor.execute("""SELECT CASE WHEN application_name IS NULL THEN %s WHEN application_name = '' THEN %s
                ELSE application_name END AS name, count(*)::int
            FROM pg_stat_activity WHERE backend_type = 'client backend' GROUP BY 1 ORDER BY 2 DESC, 1""",
            [OTHER_ROLES, UNNAMED])
        by_application = dict(cursor.fetchall())
    available = maximum - superuser_reserved - reserved
    used = sum(by_application.values())
    return {'maxConnections': maximum, 'available': available, 'used': used, 'ratio': used / available if available > 0 else 1.0,
            'byApplication': by_application}


def summary(usage):
    split = ', '.join(f'{name}={count}' for name, count in usage['byApplication'].items())
    return f"{usage['used']}/{usage['available']} connections ({round(usage['ratio'] * 100)}%): {split}"


def is_high(usage):
    return usage['ratio'] >= WARN_RATIO
