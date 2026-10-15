"""Full Playwright UI suite against Django + independent Python workers.

Run through scripts/dev/test-db.sh (locally) or the CI browser job, which supply
a disposable loopback database and an allowlisted environment. Next receives no
database, cloud, provider or session-signing credentials.
"""
import argparse
import io
import hashlib
import json
import os
import secrets
from pathlib import Path
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]


def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_ready(url, process, timeout=120):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError('Local qualification server exited before readiness')
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(.2)
    raise RuntimeError('Local qualification server readiness timed out')


def seed_fixture():
    sys.path.insert(0, str(ROOT / 'backend'))
    import django
    django.setup()
    from django.core.management import call_command
    from django.db import connection
    from PIL import Image
    from apps.authentication.models import User
    from apps.authentication.password import hash_password
    from apps.generation.models import Generation
    from apps.library.services.naming import assign_generation_naming
    from apps.media.storage import get_storage
    call_command('migrate', interactive=False, verbosity=0)
    user_id = 'e33e1832-9e29-427f-af61-796b842a4b37'
    credentials = hash_password('LocalBrowserFixture!42')
    User.objects.update_or_create(id=user_id, defaults={'email': 'desktop-browser@example.test', 'name': 'Desktop fixture',
        'password_hash': credentials['hash'], 'password_salt': credentials['salt'], 'role': 'admin', 'created_at': 1})
    for index in range(12):
        identifier = f'10000000-0000-4000-8000-{index:012d}'
        image = Image.new('RGB', (384, 256 + index % 3 * 64), (40 + index * 10, 80, 120))
        buffer = io.BytesIO()
        image.save(buffer, format='PNG')
        url = get_storage().upload_buffer(buffer.getvalue(), f'generations/{identifier}.png', 'png')
        Generation.objects.update_or_create(id=identifier, defaults={'kind': 'image', 'status': 'succeeded',
            'model': 'Nano Banana Pro', 'prompt': f'Desktop fixture image {index}', 'aspect_ratio': '3:2',
            'url': url, 'user_id': user_id, 'created_at': 1000 + index, 'updated_at': 1000 + index})
        assign_generation_naming(identifier)
    movie_path = Path(os.environ['TMPDIR']) / 'native-browser-fixture.mov'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i',
        'color=c=blue:s=32x32:r=10', '-t', '0.2', '-c:v', 'prores_ks', '-profile:v', '2',
        '-pix_fmt', 'yuv422p10le', '-f', 'mov', str(movie_path)], check=True)
    movie_bytes = movie_path.read_bytes()
    identifier = '20000000-0000-4000-8000-000000000001'
    url = get_storage().upload_buffer(movie_bytes, f'generations/{identifier}.mov', 'mov')
    Generation.objects.update_or_create(id=identifier, defaults={'kind': 'video', 'status': 'succeeded',
        'model': 'Seedance 2.5', 'prompt': 'Native MOV fixture', 'aspect_ratio': '1:1', 'duration': 1,
        'url': url, 'user_id': user_id, 'created_at': 1, 'updated_at': 1})
    assign_generation_naming(identifier)
    os.environ['E2E_MOV_SHA256'] = hashlib.sha256(movie_bytes).hexdigest()
    connection.close()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--install-browser', action='store_true')
    parser.add_argument('--grep')
    parser.add_argument('--list', action='store_true')
    parser.add_argument('--trace', choices=['on', 'retain-on-failure'], default='retain-on-failure')
    args = parser.parse_args()
    target = urlsplit(os.environ.get('DATABASE_URL', ''))
    if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or target.hostname != '127.0.0.1' or target.path != '/veevee_django_migration':
        raise SystemExit('Run this harness through scripts/dev/test-db.sh against a disposable database')
    if any(not path.name.endswith('.example') for path in ROOT.glob('.env*')):
        raise SystemExit('Browser qualification refuses a checkout with dotenv files; Next would load them')
    handlers = list((ROOT / 'src/app/api').rglob('route.*'))
    if handlers:
        raise SystemExit('Final browser qualification requires retired Node API handlers')
    print('Browser boundary verified: zero Node API handlers; Next receives no backend credentials.', flush=True)
    artifact = Path(os.environ['TMPDIR']) / 'browser-qualification'
    artifact.mkdir(parents=True, exist_ok=True)
    backend_port, frontend_port = available_port(), available_port()
    frontend = f'http://127.0.0.1:{frontend_port}'
    backend = f'http://127.0.0.1:{backend_port}'
    os.environ.update(VEEVEE_MEDIA_BACKEND='filesystem', VEEVEE_MEDIA_ROOT=str(artifact / 'media'),
        DJANGO_BROWSER_ORIGINS=frontend, PUBLIC_APP_URL=frontend)
    seed_fixture()
    # Test-only settings live in this disposable artifact directory. The
    # production provider factory and UI remain unchanged, and Next never
    # receives this backend-only path or provider configuration.
    audio_settings = artifact / 'browser_qualification_settings.py'
    audio_settings.write_text('''from config.settings.test import *
import base64
class OfflineAudioTranscriber:
    def transcribe(self, data, mime, model, *, signal=None):
        if signal: signal.check()
        raw = base64.b64decode(data, validate=True)
        if mime != 'audio/wav' or raw[:4] != b'RIFF' or raw[8:12] != b'WAVE':
            raise ValueError('Invalid offline audio fixture.')
        return '[00:00.000 - 00:00.100] Sound: Offline audio fixture.'
VEEVEE_AUDIO_TRANSCRIBER = OfflineAudioTranscriber
''')
    if args.install_browser:
        subprocess.run(['node', 'node_modules/playwright-core/cli.js', 'install', 'chromium'], check=True, cwd=ROOT)
    env = dict(os.environ)
    env.update(DJANGO_SETTINGS_MODULE='browser_qualification_settings',
        PYTHONPATH=str(artifact)+os.pathsep+str(ROOT/'backend'))
    env.update(E2E_BASE_URL=frontend, E2E_DATABASE_URL=env['DATABASE_URL'], E2E_PYTHON=sys.executable,
        E2E_START_SERVER='0', DJANGO_API_ORIGIN=backend, DJANGO_API_ALLOW_LOCAL='1')
    # Transparent frontend routing is the only backend configuration in Next.
    frontend_env = {key: env[key] for key in ('PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'NEXT_TELEMETRY_DISABLED') if key in env}
    # The middleware fails closed without its server-only ingress value. Django
    # runs here without the production gateway, so a throwaway value suffices.
    frontend_env.update(DJANGO_API_ORIGIN=backend, DJANGO_API_ALLOW_LOCAL='1',
        GOAL4_PRIVATE_INGRESS_SECRET='browser-suite-ingress-' + secrets.token_hex(24))
    processes, streams = [], []
    def launch(command, name, environment):
        stream = (artifact / (name + '.log')).open('w')
        streams.append(stream)
        process = subprocess.Popen(command, cwd=ROOT, env=environment, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        return process
    try:
        django = launch([sys.executable, '-m', 'gunicorn', '--chdir', 'backend', 'config.wsgi:application',
            '--bind', f'127.0.0.1:{backend_port}', '--workers', '2', '--threads', '4'], 'django', env)
        wait_ready(backend + '/api/health', django)
        next_process = launch(['node', 'node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', str(frontend_port)], 'next', frontend_env)
        wait_ready(frontend + '/login', next_process)
        launch([sys.executable, 'backend/manage.py', 'generation_worker', '--interval', '.2'], 'generation-worker', env)
        launch([sys.executable, 'backend/manage.py', 'media_export_worker', '--interval', '.2'], 'export-worker', env)
        command = ['node', 'node_modules/@playwright/test/cli.js', 'test']
        command.extend(['--trace', args.trace])
        if args.grep:
            command.extend(['--grep', args.grep])
        if args.list:
            command.append('--list')
        browser_process = subprocess.Popen(command, cwd=ROOT, env=env, start_new_session=True)
        processes.append(browser_process)
        browser_process.wait()
        print(json.dumps({'browser_exit_code': browser_process.returncode, 'frontend': 'Next transport only; no backend credentials',
            'backend': 'Django Gunicorn', 'workers': ['Python generation', 'Python export'], 'logs': str(artifact)}), flush=True)
        return browser_process.returncode
    except KeyboardInterrupt:
        print("Browser qualification interrupted; stopping its owned process groups.", flush=True)
        return 130
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in reversed(processes):
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        for stream in streams:
            stream.close()


if __name__ == '__main__':
    raise SystemExit(main())
