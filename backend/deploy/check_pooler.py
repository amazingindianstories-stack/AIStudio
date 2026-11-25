"""Check a component's pooler alias from inside one of its containers, before the service is switched to it.

    python -m deploy.check_pooler <component> <host:port>
    python -m deploy.check_pooler admin <host:port> "SHOW POOLS"     (password of pgbouncer_admin on stdin)

Builds the component's database URL exactly as the entrypoint would with ``VEEVEE_DB_POOLER=<host:port>`` set, opens one
connection through the pooler and compares what the session reports with ``config/db_profile.py``: the role, the
``application_name`` and both timeouts. Prints settings only, never the URL or a credential, and exits 1 on any
difference (docs/operations/release-runbook.md, database pooler rollout). The ``admin`` form runs one console command
on the pooler (the application image has no ``psql``); only ``SHOW`` and ``RECONNECT``/``KILL`` of one alias are allowed."""
import os
import re
import sys
from urllib.parse import unquote, urlsplit

import psycopg

from config import db_profile
from deploy import entrypoint, legacy_config

SETTINGS = ('application_name', 'statement_timeout', 'idle_in_transaction_session_timeout')


def expected(component):
    statement, idle = db_profile.TIMEOUTS_MS[component]
    return {'application_name': f'veevee-{component}', 'statement_timeout': str(statement),
            'idle_in_transaction_session_timeout': str(idle)}


def database_url(component, pooler, env):
    env = legacy_config.translate(component, {**env, legacy_config.POOLER_VARIABLE: pooler})
    return entrypoint.prepare_environment(env)['DATABASE_URL']


def observed(url, component):
    with psycopg.connect(url, connect_timeout=5, prepare_threshold=None, application_name=f'veevee-{component}') as connection:
        rows = connection.execute('SELECT name, setting FROM pg_settings WHERE name = ANY(%s)', [list(SETTINGS)]).fetchall()
        role = connection.execute('SELECT current_user').fetchone()[0]
    return role, dict(rows)


ADMIN_COMMAND = re.compile(r'SHOW (POOLS|STATS|CLIENTS|SERVERS|DATABASES|CONFIG)|(RECONNECT|KILL) veevee_[a-z]+')


def admin(pooler, command, password):
    allowed = legacy_config.POOLER_HOST.fullmatch(pooler) and ADMIN_COMMAND.fullmatch(command)
    if not allowed:
        raise SystemExit('admin takes a *.railway.internal host:port and one SHOW, RECONNECT or KILL command')
    host, _, port = pooler.partition(':')
    with psycopg.connect(host=host, port=int(port), dbname='pgbouncer', user='pgbouncer_admin', password=password,
                         sslmode='require', connect_timeout=5, autocommit=True, prepare_threshold=None) as connection:
        cursor = connection.execute(command)
        if cursor.description:
            names = [column.name for column in cursor.description]
            print('\t'.join(names))
            for row in cursor.fetchall():
                print('\t'.join(str(value) for value in row))


def main(argv, env=os.environ, stdin=sys.stdin):
    if len(argv) == 4 and argv[1] == 'admin':
        admin(argv[2], argv[3], stdin.readline().rstrip('\n'))
        return 0
    if len(argv) != 3 or argv[1] not in db_profile.TIMEOUTS_MS:
        raise SystemExit('usage: python -m deploy.check_pooler {' + '|'.join(db_profile.TIMEOUTS_MS) + '} <host:port>')
    component = argv[1]
    url = database_url(component, argv[2], dict(env))
    role, settings = observed(url, component)
    wanted = expected(component)
    expected_role = unquote(urlsplit(url).username or '')
    failed = role != expected_role
    print(f'{component}:')
    print(f'  role={role} expected={expected_role} {"MISMATCH" if failed else "ok"}')
    for name in SETTINGS:
        match = settings.get(name) == wanted[name]
        failed = failed or not match
        print(f'  {name}={settings.get(name)} expected={wanted[name]} {"ok" if match else "MISMATCH"}')
    print('FAILED' if failed else 'OK')
    return 1 if failed else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
