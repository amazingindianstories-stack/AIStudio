#!/usr/bin/env python3
"""Load test: many concurrent jobs and requests through a local transaction-mode PgBouncer never exhaust PostgreSQL.

Runs the repository's real ``infra/pgbouncer/entrypoint.sh`` (so the real template, aliases and ``connect_query``
timeouts) in front of a scratch PostgreSQL, drives every service's alias at once, samples ``pg_stat_activity`` while
it runs, and fails unless server connections stay inside the pooler budget with zero client errors. A control run
sends the same request load straight to PostgreSQL and must hit "too many clients", which is the 2026-11-24 failure.
A last phase runs Django itself through the pooler (settings profile, leases, heartbeat pool, transactions).

Needs ``pgbouncer``, ``envsubst`` and ``openssl`` on PATH and a scratch PostgreSQL with ``max_connections=30`` that has
the schema migrated and the roles granted. It is a local qualification tool: Docker is not needed, and nothing here
touches a deployed database. See docs/operations/database-connections.md.

    python3 scripts/dev/pooler-load-test.py --pg-port 54390 --database railway \\
        --api-password ... --worker-password ... --auth-password ... [--seconds 15] [--clients 200]

``--superuser`` names the role used to sample connections (default ``postgres``, trust authentication on the scratch server).
"""
import argparse
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from collections import Counter
from pathlib import Path

import psycopg

ROOT = Path(__file__).resolve().parents[2]
POOL_BUDGET = 18          # sum of pool_size over every alias including veevee_auth (docs/operations/database-connections.md)
ALIAS_ROLE = {'api': 'api', 'mcp': 'api', 'agent': 'api', 'generation': 'worker', 'export': 'worker', 'scheduler': 'worker'}
CLIENTS_PER_SERVICE = {'mcp': 8, 'agent': 8, 'generation': 16, 'export': 4, 'scheduler': 2}


class Result:
    def __init__(self):
        self.lock = threading.Lock()
        self.ok = Counter()
        self.errors = Counter()

    def good(self, service):
        with self.lock:
            self.ok[service] += 1

    def bad(self, service, error):
        with self.lock:
            self.errors[(service, str(error).strip().splitlines()[0].rpartition(' failed: ')[2][:100])] += 1


def wait_for_port(port, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        with socket.socket() as probe:
            probe.settimeout(.2)
            if probe.connect_ex(('127.0.0.1', port)) == 0:
                return
        time.sleep(.1)
    raise SystemExit(f'pooler did not listen on {port}')


def start_pooler(args):
    env = {'PATH': os.environ['PATH'], 'PGBOUNCER_UPSTREAM_HOST': args.pg_host, 'PGBOUNCER_UPSTREAM_PORT': str(args.pg_port),
           'PGBOUNCER_AUTH_PASSWORD': args.auth_password, 'PGBOUNCER_ADMIN_PASSWORD': 'load-test-admin', 'PGBOUNCER_PORT': str(args.pooler_port),
           'PGBOUNCER_TEMPLATE': str(ROOT / 'infra/pgbouncer/pgbouncer.ini.template'), 'PGBOUNCER_SERVER_TLS_MODE': 'disable', 'PGBOUNCER_CLIENT_TLS_MODE': 'disable'}
    log = tempfile.NamedTemporaryFile('w+', prefix='pooler-load-', suffix='.log', delete=False)
    process = subprocess.Popen(['sh', str(ROOT / 'infra/pgbouncer/entrypoint.sh')], env=env, stdout=log, stderr=subprocess.STDOUT)
    try:
        wait_for_port(args.pooler_port)
    except BaseException:
        process.kill()
        raise
    return process, log.name


def dsn(user, password, host, port, database):
    return f'host={host} port={port} dbname={database} user={user} password={password} sslmode=disable connect_timeout=10'


def sample(args, stop, peak):
    """Peak PostgreSQL backends the application roles hold, taken from a superuser (reserved) connection."""
    with psycopg.connect(host=args.pg_host, port=args.pg_port, dbname=args.database, user=args.superuser, autocommit=True) as db:
        while not stop.is_set():
            roles = ('goal4_test_api', 'goal4_test_worker', 'pgbouncer_auth')
            count = db.execute("SELECT count(*) FROM pg_stat_activity WHERE backend_type = 'client backend' AND usename = ANY(%s)", [list(roles)]).fetchone()[0]
            peak[0] = max(peak[0], count)
            time.sleep(.05)


def request_loop(connect, service, deadline, result, hold=0.0):
    """One client: a new connection per iteration (a fresh gunicorn thread or process), a short transaction, close."""
    while time.monotonic() < deadline:
        try:
            with connect() as db:
                with db.transaction():
                    db.execute("INSERT INTO settings (key, value, updated_at) VALUES (%s, '1', 0) ON CONFLICT (key) DO UPDATE SET updated_at = settings.updated_at + 1", [f'load:{service}:{threading.get_ident()}'])
                    db.execute('SELECT pg_sleep(0.01)')
                if hold:
                    time.sleep(hold)         # a connection held open and idle between requests (CONN_MAX_AGE)
            result.good(service)
        except Exception as error:
            result.bad(service, error)
            time.sleep(.05)


def job_loop(connect, deadline, result):
    """A generation: claims a lease, then waits on a provider with no transaction open and renews now and then."""
    owner = f'load-{threading.get_ident()}'
    key = f'lease:load-job:{threading.get_ident()}'
    try:
        with connect() as db:
            db.execute("INSERT INTO settings (key, value, updated_at) VALUES (%s, %s, 0) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [key, owner])
            while time.monotonic() < deadline:
                time.sleep(.5)               # the provider call: outside any transaction, so no server connection is held
                db.execute("UPDATE settings SET updated_at = updated_at + 1 WHERE key = %s AND value = %s", [key, owner])
                result.good('job')
    except Exception as error:
        result.bad('job', error)


def run_pooled(args, result):
    deadline = time.monotonic() + args.seconds
    threads = []

    def connect_for(service):
        role = ALIAS_ROLE[service]
        user, password = ('goal4_test_api', args.api_password) if role == 'api' else ('goal4_test_worker', args.worker_password)
        return lambda: psycopg.connect(dsn(user, password, '127.0.0.1', args.pooler_port, f'veevee_{service}'), prepare_threshold=None, autocommit=True)

    for service, count in {'api': args.clients, **CLIENTS_PER_SERVICE}.items():
        for _ in range(count):
            hold = .2 if service == 'api' else 0
            threads.append(threading.Thread(target=request_loop, args=(connect_for(service), service, deadline, result, hold)))
    for _ in range(args.jobs):
        threads.append(threading.Thread(target=job_loop, args=(connect_for('generation'), deadline, result)))
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


def run_direct_control(args, result, seconds=6):
    deadline = time.monotonic() + seconds
    connect = lambda: psycopg.connect(dsn('goal4_test_api', args.api_password, args.pg_host, args.pg_port, args.database), autocommit=True)
    threads = [threading.Thread(target=request_loop, args=(connect, 'direct', deadline, result, .2)) for _ in range(args.clients)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()


DJANGO_PROBE = r'''
import threading, time
from uuid import uuid4
from django.conf import settings
from django.db import connection, connections, transaction
from apps.common import leases
from apps.generation.models import Generation
from apps.generation.services.deadline import Cancellation
from apps.generation.services.heartbeat import HeartbeatPool, _Registration

database = settings.DATABASES['default']
assert database['DISABLE_SERVER_SIDE_CURSORS'] is True and database['OPTIONS']['prepare_threshold'] is None, database['OPTIONS']
assert 'options' not in database['OPTIONS'], 'a pooled connection must send no startup options'
with connection.cursor() as cursor:
    cursor.execute("SELECT current_setting('application_name'), current_setting('statement_timeout'), current_user")
    name, statement_timeout, role = cursor.fetchone()
print('profile', name, statement_timeout, role)
assert name == 'veevee-generation' and statement_timeout == '1min', (name, statement_timeout)

owner = str(uuid4())
assert leases.claim('lease:load:django', owner, ttl_ms=60000)
assert not leases.claim('lease:load:django', 'other', ttl_ms=60000)
assert leases.renew('lease:load:django', owner, ttl_ms=60000)
leases.release('lease:load:django', owner)

rows = [Generation.objects.create(kind='image', status='running', model='Seedream 5.0 Pro', prompt='load', aspect_ratio='1:1',
        created_at=100, updated_at=100, cost_cents=1, user_id=uuid4(), worker_lease_id=f'owner-{i}', worker_lease_until=1) for i in range(JOBS)]
try:
    # the iterator() path would use a server-side cursor on a direct connection
    assert len(list(Generation.objects.filter(pk__in=[r.pk for r in rows]).iterator(chunk_size=3))) == JOBS
    pool = HeartbeatPool(interval=.3, retry=.1)
    signals = [Cancellation() for _ in rows]
    registrations = [pool.register(r.pk, r.worker_lease_id, s) for r, s in zip(rows, signals)]
    errors = []

    def transact():
        try:
            for _ in range(20):
                with transaction.atomic():
                    with connection.cursor() as cursor:
                        cursor.execute('SELECT pg_advisory_xact_lock(%s)', [4242])
                        cursor.execute('SELECT pg_sleep(0.005)')
                connections.close_all()
        except Exception as error:
            errors.append(repr(error))

    workers = [threading.Thread(target=transact) for _ in range(24)]
    for w in workers: w.start()
    for w in workers: w.join()
    time.sleep(1.2)
    assert not errors, errors[:3]
    assert not any(s.cancelled.is_set() for s in signals), 'a healthy lease was cancelled'
    renewed = sum(Generation.objects.filter(pk=r.pk, worker_lease_until__gt=leases.now_ms()).count() for r in rows)
    assert renewed == JOBS, renewed
    for registration in registrations:
        pool.unregister(registration)
    print('django ok: profile, leases, iterator, 24 threads x 20 transactions with advisory xact locks, one heartbeat connection for', JOBS, 'jobs')
finally:
    Generation.objects.filter(pk__in=[r.pk for r in rows]).delete()
    connections.close_all()
'''


def run_django(args):
    env = {key: value for key, value in os.environ.items() if key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DYLD_FALLBACK_LIBRARY_PATH',
           'DJANGO_SECRET_KEY', 'AUTH_SECRET', 'DJANGO_ALLOWED_HOSTS', 'MOCK_GENERATION', 'MOCK_ASSET_PROVIDER', 'CI')}
    env.update({'DJANGO_SETTINGS_MODULE': os.environ.get('LOAD_SETTINGS', 'config.settings.local'), 'VEEVEE_RUNTIME_COMPONENT': 'generation',
                'VEEVEE_DB_POOLED': '1',
                'DATABASE_URL': f'postgresql://goal4_test_worker:{args.worker_password}@127.0.0.1:{args.pooler_port}/veevee_generation?sslmode=disable'})
    code = DJANGO_PROBE.replace('JOBS', str(args.jobs))
    done = subprocess.run([sys.executable, 'manage.py', 'shell', '-c', code], cwd=ROOT / 'backend', env=env, capture_output=True, text=True, timeout=120)
    sys.stdout.write(done.stdout)
    if done.returncode:
        sys.stderr.write(done.stderr[-2000:])
    return done.returncode == 0


def admin_pools(args):
    with psycopg.connect(f'host=127.0.0.1 port={args.pooler_port} dbname=pgbouncer user=pgbouncer_admin password=load-test-admin sslmode=disable', autocommit=True) as db:
        return db.execute('SHOW POOLS').fetchall(), [c.name for c in db.execute('SHOW POOLS').description]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--pg-host', default='127.0.0.1')
    parser.add_argument('--pg-port', type=int, required=True)
    parser.add_argument('--database', default='railway')
    parser.add_argument('--superuser', default='postgres')
    parser.add_argument('--api-password', required=True)
    parser.add_argument('--worker-password', required=True)
    parser.add_argument('--auth-password', required=True)
    parser.add_argument('--pooler-port', type=int, default=6545)
    parser.add_argument('--seconds', type=int, default=15)
    parser.add_argument('--clients', type=int, default=200, help='concurrent API clients')
    parser.add_argument('--jobs', type=int, default=12, help='concurrent running generations')
    parser.add_argument('--skip-django', action='store_true')
    args = parser.parse_args()

    process, log = start_pooler(args)
    failures = []
    try:
        peak, stop = [0], threading.Event()
        sampler = threading.Thread(target=sample, args=(args, stop, peak))
        sampler.start()
        result = Result()
        run_pooled(args, result)
        pools, columns = admin_pools(args)
        stop.set()
        sampler.join()
        total_ok, total_errors = sum(result.ok.values()), sum(result.errors.values())
        print(f'pooled: {args.clients} api clients + {sum(CLIENTS_PER_SERVICE.values())} other-service clients + {args.jobs} running jobs for {args.seconds}s')
        print(f'  completed={total_ok} errors={total_errors} by_service={dict(result.ok)}')
        print(f'  peak PostgreSQL backends held by the application roles: {peak[0]} (budget {POOL_BUDGET})')
        for row in pools:
            record = dict(zip(columns, row))
            if record['database'] != 'pgbouncer':
                print(f"  pool {record['database']}: cl_active={record['cl_active']} sv_active={record['sv_active']} sv_idle={record['sv_idle']} maxwait={record['maxwait']}")
        if total_errors:
            failures.append(f'client errors through the pooler: {dict(result.errors)}')
        if peak[0] > POOL_BUDGET:
            failures.append(f'server connections {peak[0]} exceed the budget {POOL_BUDGET}')

        control = Result()
        run_direct_control(args, control)
        # PostgreSQL words the refusal "too many clients" once max_connections is reached and "remaining connection
        # slots are reserved" once only the superuser reserve is left, which is what an application role sees first.
        exhausted = sum(count for (service, message), count in control.errors.items() if 'too many clients' in message or 'slots are reserved' in message)
        print(f'control (same {args.clients} clients straight to PostgreSQL): completed={sum(control.ok.values())} connection_refused_errors={exhausted}')
        print('  control errors:', dict(control.errors))
        if not exhausted:
            failures.append('the direct control did not exhaust connections, so the test proves nothing')

        if not args.skip_django and not run_django(args):
            failures.append('the Django phase failed')
    finally:
        process.terminate()
        process.wait(timeout=10)
        os.unlink(log)
    if failures:
        print('FAILED:\n  ' + '\n  '.join(failures))
        return 1
    print('OK')
    return 0


if __name__ == '__main__':
    sys.exit(main())
