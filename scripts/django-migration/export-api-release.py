"""Export qualified committed API inputs without copying the shared checkout.

No environment files, Git metadata, frontend code or credential home are read.
This exports files only: it does not build, deploy, connect or change resources.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
BUILD_INPUTS = {'requirements.txt', 'Dockerfile', 'Dockerfile.dockerignore'}


def allowed(name):
    path = PurePosixPath(name)
    return (len(path.parts) > 1 and path.parts[0] == 'backend'
            and not any(part in {'.', '..', '__pycache__', '.venv', 'venv'} or part.startswith('.env') for part in path.parts)
            and (path.suffix == '.py' or path.name in BUILD_INPUTS or name == 'backend/railway.toml'
                 or (path.parent == PurePosixPath('backend/testsupport/goldens') and path.suffix == '.json')))


def fingerprint(files):
    digest = hashlib.sha256()
    for name, data in sorted(files.items()):
        if name == 'backend/railway.toml':
            continue  # Build harness fingerprints image inputs, not deploy config.
        digest.update(name.encode() + b'\0' + hashlib.sha256(data).digest())
    return digest.hexdigest()


def committed_inputs(repository, revision):
    if not re.fullmatch(r'[0-9a-f]{40}', revision):
        raise ValueError('Exact 40-character committed source revision required')
    listing = subprocess.check_output(['git', 'ls-tree', '-rz', '--full-tree', revision, '--', 'backend'], cwd=repository)
    files = {}
    for entry in listing.split(b'\0'):
        if not entry:
            continue
        metadata, name = entry.split(b'\t', 1)
        name = name.decode()
        if not allowed(name):
            continue
        mode, kind, identifier = metadata.decode().split()
        if mode not in {'100644', '100755'} or kind != 'blob':
            raise ValueError(f'Refusing non-regular release input: {name}')
        files[name] = subprocess.check_output(['git', 'cat-file', 'blob', identifier], cwd=repository)
    required = {'backend/manage.py', 'backend/config/wsgi.py', 'backend/requirements.txt',
                'backend/Dockerfile', 'backend/Dockerfile.dockerignore', 'backend/railway.toml'}
    if required - files.keys():
        raise ValueError('Required API/build/deploy inputs are missing')
    return files


def export(repository, evidence, destination_parent):
    files = committed_inputs(repository, evidence['source_revision'])
    actual = fingerprint(files)
    if actual != evidence['api_source_sha256']:
        raise ValueError('Committed API inputs do not match qualified image fingerprint')
    destination = Path(tempfile.mkdtemp(prefix='veevee-api-release-', dir=destination_parent))
    for name, data in files.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    manifest = {'source_revision': evidence['source_revision'], 'api_source_sha256': actual,
                'qualified_image_id': evidence['image_id'], 'qualified_platform': evidence['platform'],
                'railway_config_sha256': hashlib.sha256(files['backend/railway.toml']).hexdigest(),
                'file_sha256': {name: hashlib.sha256(data).hexdigest() for name, data in sorted(files.items())},
                'deployed': False}
    (destination / 'release-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    return destination, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, default=ROOT / 'docs/django-migration/api-image-qualification.json')
    args = parser.parse_args()
    destination, manifest = export(ROOT, json.loads(args.evidence.read_text()), '/private/tmp')
    print(json.dumps({'release_directory': str(destination), 'source_revision': manifest['source_revision'],
                      'api_source_sha256': manifest['api_source_sha256'], 'files': len(manifest['file_sha256']),
                      'railway_config_sha256': manifest['railway_config_sha256'], 'deployed': False}))


if __name__ == '__main__':
    main()
