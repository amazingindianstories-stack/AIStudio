#!/usr/bin/env python3
"""Stage a clean Railway upload for one Green service from an exact commit.

    python3 scripts/stabilization/stage_railway_deploy.py <commit> <api|generation|export|scheduler> <out-dir>

The staged directory contains only ``backend/`` from ``git archive <commit>``
plus a generated ``railway.json`` that pins the Dockerfile, the start command
and the health/overlap settings for that service. Repository ``railway.toml``
files are never uploaded (the root one starts the generation worker). No
variables or secrets are read or written.
"""
import json
import os
import subprocess
import sys
import tarfile
import io
from pathlib import Path

SERVICES = {
    'api': {'healthcheckPath': '/__g4_readiness', 'healthcheckTimeout': 120, 'overlapSeconds': 20, 'drainingSeconds': 30},
    'generation': {'overlapSeconds': 0, 'drainingSeconds': 120},
    'export': {},
    'scheduler': {},
}


def main(commit, component, out):
    if component not in SERVICES:
        raise SystemExit('component must be one of ' + ', '.join(SERVICES))
    out = Path(out)
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f'{out} must be empty')
    out.mkdir(parents=True, exist_ok=True)
    full = subprocess.run(['git', 'rev-parse', '--verify', commit + '^{commit}'], check=True, capture_output=True, text=True).stdout.strip()
    gate = Path(os.environ.get('VEEVEE_GATE_DIR', Path.home() / 'Library/Application Support/Veevee/release-gate')) / f'{full}.json'
    if not gate.exists():
        raise SystemExit(f'No release-gate pass for {full[:12]}. Run scripts/stabilization/release_gate.sh {full[:12]} first.')
    archive = subprocess.run(['git', 'archive', '--format=tar', full, 'backend'], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = [m for m in tar.getmembers() if Path(m.name).name not in ('railway.toml', 'railway.json')
                   and '__pycache__' not in m.name and not m.issym() and not m.islnk()]
        tar.extractall(out, members=members, filter='data')
    deploy = {'startCommand': f'python -m deploy.entrypoint {component}', 'restartPolicyType': 'ON_FAILURE',
              'restartPolicyMaxRetries': 10, **SERVICES[component]}
    config = {'$schema': 'https://railway.com/railway.schema.json',
              'build': {'builder': 'DOCKERFILE', 'dockerfilePath': 'backend/Dockerfile'}, 'deploy': deploy}
    (out / 'railway.json').write_text(json.dumps(config, indent=2) + '\n')
    (out / 'STAGED_COMMIT').write_text(full + '\n')
    print(json.dumps({'commit': full, 'component': component, 'dir': str(out), 'deploy': deploy}))


if __name__ == '__main__':
    if len(sys.argv) != 4:
        raise SystemExit(__doc__)
    main(*sys.argv[1:])
