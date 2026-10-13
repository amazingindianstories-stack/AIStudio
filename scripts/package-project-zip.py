#!/usr/bin/env python3
"""Create a deterministic, sanitized source handoff below 10,000,000 bytes.

Includes current tracked/untracked source and qualification evidence, never reads
excluded credential/runtime files, and does not copy the archive elsewhere.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
LIMIT = 10_000_000
DIRECTORIES = {'src', 'backend', 'scripts', 'tests', 'docs', '.github', 'depth-worker', 'pyserver', 'infra'}
EXTENSIONS = {'.py', '.js', '.jsx', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.md', '.txt', '.toml', '.sql', '.sh', '.css', '.html', '.svg', '.log'}
FORBIDDEN_PARTS = {'node_modules', '.git', '.next', 'out', 'build', '__pycache__', '.venv', 'venv', 'models', 'screenshots', 'support', 'playwright-report', 'test-results', 'eval-results'}
FORBIDDEN_NAMES = {'.worker-id', '.higgsfield-mcp-token.json', 'vercel-gcp-cred.json', 'gcp-sa-key.json', 'hmac.json', 'mag_key.png', 'test.json'}
SECRET_PATTERNS = [
    re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----'),
    re.compile(rb'\bAIza[0-9A-Za-z_-]{30,}\b'),
    re.compile(rb'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b'),
    re.compile(rb'\bgh[pousr]_[0-9A-Za-z]{30,}\b'),
    re.compile(rb'\bsk-(?:proj-)?[0-9A-Za-z_-]{35,}\b'),
    re.compile(rb'[?&](?:X-Goog-Signature|X-Amz-Signature)=[0-9a-fA-F]{64,}'),
]


def allowed(name):
    path = Path(name)
    if path.is_absolute() or '..' in path.parts or any(part in FORBIDDEN_PARTS for part in path.parts):
        return False
    if path.name in FORBIDDEN_NAMES or path.suffix in {'.zip', '.pyc', '.pem', '.key', '.credentials'}:
        return False
    if any(part.startswith('.env') for part in path.parts):
        return path.name.endswith(('.example', '.sample'))
    if name in {'public/logo.png','src/app/icon.png','src/app/apple-icon.png'}:
        return True
    if name.startswith(('docs/goal2/UI-screenshots/', 'docs/goal3/UI-screenshots/')) and path.suffix == '.png':
        # Approved screenshots are exclusively disposable fixtures, never live data.
        return True
    if name.startswith('public/'):
        return path.name == '.gitkeep'
    if len(path.parts) == 1:
        return path.suffix in EXTENSIONS or path.name.startswith('Dockerfile') or path.name in {'.gitignore', '.dockerignore'}
    return path.parts[0] in DIRECTORIES and (path.suffix in EXTENSIONS or path.name.startswith('Dockerfile') or path.name in {'.gitignore', '.dockerignore', '.gitkeep'})


def package(destination, *, limit_bytes=LIMIT):
    listing = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT).decode().split('\0')
    # Evidence logs are ignored by Git globally but form part of this handoff.
    listing += [str(p.relative_to(ROOT)) for p in (ROOT / 'docs/django-migration/evidence').rglob('*.log')]
    listing += [str(p.relative_to(ROOT)) for p in (ROOT / 'docs/django-migration/release-review').rglob('*.log')]
    listing += [str(p.relative_to(ROOT)) for p in (ROOT / 'docs/django-migration/independent-audit').rglob('*.log')]
    listing += [str(p.relative_to(ROOT)) for p in (ROOT / 'docs/goal2/evidence').rglob('*.log')]
    listing += [str(p.relative_to(ROOT)) for p in (ROOT / 'docs/goal3/evidence').rglob('*.log')]
    listing += ['.env.local.example', 'backend/.env.example']
    # Generated archives/checksums and the external archive attestation must not
    # change the manifest between two packages or introduce self-referential hashes.
    listing = [name for name in listing if not name.endswith(('.zip', '.zip.tmp', '.sha256'))
               and not (Path(name).name == 'archive-verification.json' and
                        (name.startswith('docs/django-migration/release-review/') or
                         name.startswith('docs/django-migration/independent-audit/') or
                         name.startswith('docs/goal2/') or name.startswith('docs/goal3/')))]
    included, omitted, modes = {}, [], {}
    for name in sorted(set(listing) - {''}):
        source = ROOT / name
        if not allowed(name) or source.is_symlink() or not source.is_file():
            omitted.append(name)
            continue
        data = source.read_bytes()
        if any(pattern.search(data) for pattern in SECRET_PATTERNS):
            raise ValueError(f'Potential credential detected; archive not written: {name}')
        included[name] = data
        modes[name] = 0o100755 if source.stat().st_mode & 0o111 else 0o100644
    revision = subprocess.run(['git','rev-parse','--verify','HEAD'],cwd=ROOT,text=True,capture_output=True)
    manifest = {
        'scope': 'Local undeployed Django migration working tree; production adoption pending',
        'base_commit': revision.stdout.strip() if revision.returncode == 0 else os.environ.get('VEEVEE_SOURCE_REVISION','UNCOMMITTED_ISOLATED_COPY'),
        'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip(),
        'working_tree': 'Includes current uncommitted changes',
        'file_sha256': {name: hashlib.sha256(data).hexdigest() for name, data in included.items()},
        'file_modes': {name: oct(mode) for name, mode in modes.items()},
        'excluded': omitted,
        'sanitization': 'Path allowlist, no symlinks/live env/runtime data, credential-pattern scan, ZIP CRC and member hash verification',
    }
    included['HANDOFF-MANIFEST.json'] = (json.dumps(manifest, indent=2) + '\n').encode()
    temporary = destination.with_suffix('.zip.tmp')
    try:
        with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in included.items():
                info = zipfile.ZipInfo(name, date_time=(2026, 10, 8, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.create_system = 3
                info.external_attr = modes.get(name, 0o100644) << 16
                archive.writestr(info, data, compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
        if temporary.stat().st_size >= limit_bytes:
            raise ValueError('Source archive exceeds configured size limit; no files silently omitted')
        with zipfile.ZipFile(temporary) as archive:
            assert archive.testzip() is None
            for name, digest in manifest['file_sha256'].items():
                assert hashlib.sha256(archive.read(name)).hexdigest() == digest
                assert archive.getinfo(name).external_attr >> 16 == modes[name]
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return {'archive': str(destination), 'bytes': destination.stat().st_size, 'files': len(included), 'sha256': hashlib.sha256(destination.read_bytes()).hexdigest(), 'limit_bytes': limit_bytes}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'image-video-project.zip')
    parser.add_argument('--limit-bytes', type=int, default=LIMIT,
                        help='Explicit archive cap; default preserves the historical 10 MB handoff contract')
    args = parser.parse_args()
    if args.limit_bytes < 1:
        parser.error('--limit-bytes must be positive')
    print(json.dumps(package(args.output.resolve(), limit_bytes=args.limit_bytes), indent=2))
