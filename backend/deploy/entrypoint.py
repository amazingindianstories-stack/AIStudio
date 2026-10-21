#!/usr/bin/env python3
"""Container entrypoint for the Veevee Django services (replaces env-injected launchers).

Usage: python -m deploy.entrypoint {api|generation|export|scheduler}

Credentials arrive as named environment variables and are written to private
0600 files only where a library needs a file path (PostgreSQL CA, Google ADC).
The API runs the private ingress gateway on $PORT in front of gunicorn
(1 worker x 8 threads on 127.0.0.1:18080, matching the qualified production
process model). Workers run their management command in this process.
"""
import json
import os
import signal
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from deploy import legacy_config

UPSTREAM_PORT = 18080
WORKER_COMMANDS = {
    'generation': ['generation_worker', '--interval', '2'],
    'export': ['media_export_worker', '--interval', '2'],
    'scheduler': ['run_scheduler'],
}
API_THREADS = 8
GUNICORN = ['--bind', f'127.0.0.1:{UPSTREAM_PORT}', '--workers', '1', '--threads', str(API_THREADS), '--timeout', '25',
            '--graceful-timeout', '5', '--access-logfile', '/dev/null', '--error-logfile', '-']


def private_file(directory, name, data):
    path = Path(directory) / name
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as handle:
        handle.write(data)
    return str(path)


def prepare_environment(env):
    """Materialize file-based credentials and return the environment for Django."""
    home = tempfile.mkdtemp(prefix='veevee-runtime-')
    os.chmod(home, 0o700)
    env = dict(env)
    ca = env.pop('VEEVEE_DATABASE_CA_PEM', '')
    if ca:
        ca_path = private_file(home, 'database-ca.pem', ca.encode())
        url = urlsplit(env['DATABASE_URL'])
        query = dict(parse_qsl(url.query))
        query.update({'sslmode': 'verify-full', 'sslrootcert': ca_path})
        env['DATABASE_URL'] = urlunsplit(url._replace(query=urlencode(query)))
    adc = env.pop('GCP_ADC_JSON', '')
    if adc:
        json.loads(adc)  # fail fast on malformed credentials without echoing them
        env['GOOGLE_APPLICATION_CREDENTIALS'] = private_file(home, 'adc.json', adc.encode())
    env.setdefault('HOME', home)
    env.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    return env


def run_api(env):
    secret = env.pop('VEEVEE_INGRESS_SECRET', '')
    if len(secret) < 48:
        raise SystemExit('VEEVEE_INGRESS_SECRET must be at least 48 characters')
    port = int(env.get('PORT', '18081'))
    env['VEEVEE_API_THREADS'] = str(API_THREADS)  # config.wsgi sizes slow-call admission from it
    gateway_config = json.dumps({'secret': secret, 'port': port, 'paid_initial_routes': bool(env.get('VEEVEE_PAID_GUARD')),
                                 'new_exports': env.get('VEEVEE_EXPORT_ADMISSION') == '1',
                                 'magnific_upscale': env.get('VEEVEE_MAGNIFIC_UPSCALE') == '1'})
    children = [
        subprocess.Popen([sys.executable, '-m', 'gunicorn', 'config.wsgi:application', *GUNICORN], env=env),
        subprocess.Popen([sys.executable, str(Path(__file__).with_name('gateway.py')), '--approved-private-stdin'],
                         env={'PATH': env.get('PATH', '/usr/local/bin:/usr/bin:/bin')}, stdin=subprocess.PIPE),
    ]
    children[1].stdin.write(gateway_config.encode())
    children[1].stdin.close()

    def stop(*_):
        for child in children:
            if child.poll() is None:
                child.terminate()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    # Exit (and let Railway restart us) as soon as either process dies.
    while all(child.poll() is None for child in children):
        try:
            os.wait()
        except ChildProcessError:
            break
    stop()
    for child in children:
        child.wait()
    return max((child.returncode or 0) for child in children) or 1


def generation_worker_slots(env):
    """Default applies without a Railway variable; reject malformed overrides."""
    try:
        slots = int(env.get('VEEVEE_GENERATION_WORKER_SLOTS', '4'))
    except ValueError:
        raise SystemExit('VEEVEE_GENERATION_WORKER_SLOTS must be an integer from 1 to 8') from None
    if not 1 <= slots <= 8:
        raise SystemExit('VEEVEE_GENERATION_WORKER_SLOTS must be an integer from 1 to 8')
    return slots


def run_worker(component, env):
    os.environ.clear()
    os.environ.update(env)
    import django
    django.setup()
    from django.core.management import execute_from_command_line
    command = list(WORKER_COMMANDS[component])
    if component == 'generation':
        command.extend(['--concurrency', str(generation_worker_slots(env))])
    execute_from_command_line(['manage.py', *command])
    return 0


def main(argv):
    if len(argv) != 2 or argv[1] not in ('api', *WORKER_COMMANDS):
        raise SystemExit('usage: python -m deploy.entrypoint {api|generation|export|scheduler}')
    component = argv[1]
    env, contract = dict(os.environ), None
    if legacy_config.present(env):
        # Transition: same variables the old launchers read, same startup checks.
        contract = legacy_config.preflight_contract(component, env)
        env = legacy_config.translate(component, env)
    env = prepare_environment(env)
    if contract is not None:
        legacy_config.preflight(env['DATABASE_URL'], contract)
    env['VEEVEE_RUNTIME_COMPONENT'] = component
    return run_api(env) if component == 'api' else run_worker(component, env)


if __name__ == '__main__':
    sys.exit(main(sys.argv))
