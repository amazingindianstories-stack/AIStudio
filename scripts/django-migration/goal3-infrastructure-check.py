"""Read-only release configuration gate; imports no application or credentials."""
import hashlib
import json
from pathlib import Path
import re
import tomllib

ROOT = Path(__file__).resolve().parents[2]


def qualify(root=ROOT):
    files = ('backend/Dockerfile', 'Dockerfile.worker', 'backend/requirements.txt',
             'backend/constraints-qualified.txt', 'backend/railway.toml',
             'backend/railway-export.toml', 'backend/railway-scheduler.toml',
             'railway.toml', 'vercel.json', 'next.config.js', 'package-lock.json')
    text = {name: (root / name).read_text() for name in files}
    base = re.findall(r'^FROM (.+)$', text['backend/Dockerfile'], re.M)
    assert len(base) == 1 and re.fullmatch(r'python:3\.12-slim@sha256:[a-f0-9]{64}', base[0]), 'Base digest missing'
    assert re.findall(r'^FROM (.+)$', text['Dockerfile.worker'], re.M) == base, 'Role bases diverged'
    api = text['backend/Dockerfile']
    for contract in ('exec gunicorn config.wsgi:application', '--workers 2', '--worker-class gthread', '--threads 4', '--timeout 30', '${PORT:-8000}'):
        assert contract in api, 'API profile mismatch: ' + contract
    for name in ('backend/Dockerfile', 'Dockerfile.worker'):
        assert '-c constraints-qualified.txt -r requirements.txt' in text[name]
        assert 'ffmpeg libvips42' in text[name]
        assert not re.search(r'\b(migrate|makemigrations|drizzle|npm)\b', text[name]), 'Startup/build business command in ' + name
    roles = {'backend/railway.toml': None, 'railway.toml': 'generation_worker',
             'backend/railway-export.toml': 'media_export_worker', 'backend/railway-scheduler.toml': 'run_scheduler'}
    for name, command in roles.items():
        config = tomllib.loads(text[name])
        assert 'preDeployCommand' not in config['deploy'], 'Startup must not migrate'
        if command:
            assert config['deploy']['startCommand'] == 'python manage.py ' + command
        else:
            assert config['deploy']['healthcheckPath'] == '/api/health'
            assert 'startCommand' not in config['deploy'], 'API uses exact image CMD'
    assert json.loads(text['vercel.json']) == {}, 'Review Vercel overrides before promotion'
    assert not list((root / 'src/app/api').glob('**/route.*')), 'Node API ownership returned'
    assert not (root / 'drizzle.config.js').exists(), 'Node schema ownership returned'
    assert 'unoptimized: true' in text['next.config.js'], 'Unused remote optimizer enabled'
    constraints = [line for line in text['backend/constraints-qualified.txt'].splitlines() if line and not line.startswith('#')]
    assert all(re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+', line) for line in constraints), 'Unpinned Python constraint'
    assert len({line.split('==')[0].lower() for line in constraints}) == len(constraints)
    lock = json.loads(text['package-lock.json'])
    assert lock['lockfileVersion'] == 3
    return {'gate': 'PASS', 'api_profile': {'workers': 2, 'threads': 4, 'timeout_seconds': 30},
            'roles': ['frontend', 'api', 'generation', 'export', 'scheduler'], 'external_client': 'authenticated GPU depth',
            'base': base[0], 'startup_migrations': False, 'source_sha256': {
                name: hashlib.sha256((root / name).read_bytes()).hexdigest() for name in files},
            'scope': 'local source contracts; no hosted topology, OS reproducibility or runtime assertion'}


if __name__ == '__main__':
    print(json.dumps(qualify(), indent=2))
