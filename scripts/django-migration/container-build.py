"""Build/inspect the API image only from the isolation runner's clean copy."""
import json
import os
from pathlib import Path
import subprocess
import tempfile

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
