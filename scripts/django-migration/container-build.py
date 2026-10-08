"""Build/inspect the API image only from the isolation runner's clean copy."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import uuid
import sys

root = Path.cwd()
home = Path(os.environ['HOME'])
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or root.parent.name != home.parent.name or root.name != 'repo' or root.parent.parent != Path('/private/tmp'):
    raise SystemExit('Container qualification requires the verified isolated source copy')
socket = 'unix:///Users/ais4/.docker/run/docker.sock'
plugins = '/Applications/Docker.app/Contents/Resources/cli-plugins'
image = 'veevee-django-qualification:local'
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='docker-config-') as config:
    # No personal registry credentials; explicitly discover bundled BuildKit.
    Path(config, 'config.json').write_text(json.dumps({'cliPluginsExtraDirs': [plugins]}))
    docker = ['docker', '--config', config, '--host', socket]
    env = dict(os.environ, DOCKER_BUILDKIT='1')
    subprocess.run(docker + ['buildx', 'build', '--load', '--file', 'backend/Dockerfile', '--tag', image, '.'], env=env, check=True)
    inspection = '''import json, pathlib, django, rest_framework, gunicorn
files=[p.relative_to('/app').as_posix() for p in pathlib.Path('/app').rglob('*') if p.is_file()]
allowed={'requirements.txt','Dockerfile','Dockerfile.dockerignore'}
unexpected=[p for p in files if not p.endswith('.py') and p not in allowed]
assert not unexpected, unexpected
assert 'manage.py' in files and 'config/wsgi.py' in files
print(json.dumps({'application_file_count':len(files),'unexpected_files':unexpected,'django':django.get_version(),'drf':rest_framework.VERSION,'gunicorn':gunicorn.__version__}))'''
    subprocess.run(docker + ['run', '--rm', '--network', 'none', '--entrypoint', 'python', image, '-c', inspection], env=env, check=True)
    if '--runtime' in sys.argv:
        suffix = uuid.uuid4().hex[:12]
        network, database, api = [f'veevee-qualification-{kind}-{suffix}' for kind in ('net','pg','api')]
        def run(args, **kwargs):
            return subprocess.run(docker + args, env=env, check=True, capture_output=True, text=True, **kwargs).stdout.strip()
        def wait_for(callback, seconds=45):
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                try:
                    return callback()
                except (subprocess.CalledProcessError, AssertionError):
                    time.sleep(.5)
            raise RuntimeError('Disposable container readiness deadline exceeded')
        probe = '''import json, urllib.request, urllib.error
try:
 r=urllib.request.urlopen('http://127.0.0.1:8000/api/health?private=DO_NOT_LOG',timeout=10)
except urllib.error.HTTPError as e:
 r=e
print(json.dumps({'status':r.status,'body':json.loads(r.read()),'cache':r.headers.get('Cache-Control'),'request_id':r.headers.get('X-Request-ID')}))'''
        def health(expected):
            result = json.loads(run(['exec', api, 'python', '-c', probe]))
            assert result['status'] == expected, result
            assert result['cache'] == 'no-store' and result['request_id'], result
            assert result['body'] == {'ok':expected == 200,'django':'ready','database':'ready' if expected == 200 else 'unavailable'}, result
            return result
        created = []
        try:
            run(['network','create','--internal',network])
            run(['run','--detach','--name',database,'--network',network,
                 '--tmpfs','/var/lib/postgresql/data','--env','POSTGRES_USER=migration',
                 '--env','POSTGRES_PASSWORD=disposable-only','--env','POSTGRES_DB=veevee_django_migration','postgres:16'])
            created.append(database)
            # Inspect actual network/image/mount targets before database utilities.
            target = json.loads(run(['inspect',database]))[0]
            assert target['Config']['Image'] == 'postgres:16'
            assert set(target['NetworkSettings']['Networks']) == {network}
            assert all(m['Type'] == 'tmpfs' for m in target['Mounts'])
            wait_for(lambda: run(['exec',database,'pg_isready','-U','migration','-d','veevee_django_migration']))
            version = run(['exec',database,'psql','-U','migration','-d','veevee_django_migration','-Atc','SHOW server_version'])
            assert version.startswith('16.'), version
            run(['run','--detach','--name',api,'--network',network,
                 '--env',f'DATABASE_URL=postgresql://migration:disposable-only@{database}:5432/veevee_django_migration',
                 '--env','DJANGO_SECRET_KEY=disposable-framework-secret',
                 '--env','AUTH_SECRET=disposable-session-secret',
                 '--env','DJANGO_ALLOWED_HOSTS=127.0.0.1',
                 '--env','DJANGO_BROWSER_ORIGINS=https://frontend.example',image])
            created.append(api)
            ready = wait_for(lambda: health(200))
            run(['stop','--time','1',database])
            failed = wait_for(lambda: health(503))
            run(['start',database])
            wait_for(lambda: run(['exec',database,'pg_isready','-U','migration','-d','veevee_django_migration']))
            recovered = wait_for(lambda: health(200))
            logs = run(['logs',api])
            events = [json.loads(line) for line in logs.splitlines() if line.startswith('{')]
            assert any(e.get('status') == 200 for e in events)
            assert any(e.get('status') == 503 for e in events)
            assert 'DO_NOT_LOG' not in logs and 'disposable-only' not in logs
            print(json.dumps({'postgres_version':version,'container_health_ready':ready['status'],
                              'container_health_database_failure':failed['status'],
                              'container_health_recovered':recovered['status'],'sanitized_structured_logs':True}))
        finally:
            for name in reversed(created):
                subprocess.run(docker + ['rm','--force',name], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            subprocess.run(docker + ['network','rm',network], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
