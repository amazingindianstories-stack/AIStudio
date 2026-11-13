#!/usr/bin/env python3
"""Stage a clean Railway upload for one Green service from an exact commit.

    python3 scripts/release/stage_railway_deploy.py [--no-overlap] <commit> <api|mcp|generation|export|scheduler|agent> <out-dir>

The staged directory contains only ``backend/`` from ``git archive <commit>``
plus a generated ``railway.json`` that records the Dockerfile, the start command
and the health/overlap settings for that service. Any ``railway.toml`` or
``railway.json`` that an older commit carries under ``backend/`` is dropped, so
the generated file is the only service configuration. No variables or secrets
are read or written.

Railway builds and deploys an upload with the service instance's settings, not
the uploaded file's: a service whose instance has no ``dockerfilePath`` is built
by Railpack, which cannot build this tree, and an instance overlap overrides the
file's. The printed ``serviceInstance`` object is the ``serviceInstanceUpdate``
input to apply to the service instance immediately before ``railway up``.

``api`` and ``mcp`` serve HTTP: a readiness health check and a 20 s overlap while the old deployment drains.
``generation`` and ``agent`` overlap 0 (never two workers on one job or run); ``export`` and ``scheduler`` keep
Railway's defaults. Generation's 120 s drain is not its 30-minute work deadline: deploy or restart
interrupts still-running jobs, so drain the queue before deployment. ``agent`` serves no HTTP, so it has no health check, port or domain.
``--no-overlap`` (``api`` and ``mcp`` only) stages ``overlapSeconds`` 0 for a release that must not run the old
and new image together (the runbook's no-overlap section); without it the staged settings are unchanged.
"""
import json
import os
import subprocess
import sys
import tarfile
import io
from pathlib import Path

GATEWAY = {'healthcheckPath': '/__g4_readiness', 'healthcheckTimeout': 120, 'overlapSeconds': 20, 'drainingSeconds': 30}
SERVICES = {
    'api': GATEWAY,
    'mcp': GATEWAY,
    'generation': {'overlapSeconds': 0, 'drainingSeconds': 120},
    'export': {},
    'scheduler': {},
    'agent': {'overlapSeconds': 0},
}
NO_OVERLAP_COMPONENTS = ('api', 'mcp')
DOCKERFILE = 'backend/Dockerfile'


def deploy_settings(component, no_overlap=False):
    """The ``deploy`` section of the staged railway.json for one component."""
    if component not in SERVICES:
        raise SystemExit('component must be one of ' + ', '.join(SERVICES))
    if no_overlap and component not in NO_OVERLAP_COMPONENTS:
        raise SystemExit('--no-overlap applies to ' + ' and '.join(NO_OVERLAP_COMPONENTS) + ' only')
    return {'startCommand': f'python -m deploy.entrypoint {component}', 'restartPolicyType': 'ON_FAILURE',
            'restartPolicyMaxRetries': 10, **SERVICES[component], **({'overlapSeconds': 0} if no_overlap else {})}


def instance_settings(component, no_overlap=False):
    """The ``serviceInstanceUpdate`` input for one component: the deploy settings plus the Dockerfile.

    A new Railway service defaults to Railpack ("could not determine how to build the app"); this is how
    green-django-mcp (2026-11-02) and green-django-agent (2026-11-06) first failed to build."""
    return {'dockerfilePath': DOCKERFILE, **deploy_settings(component, no_overlap)}


def main(commit, component, out, no_overlap=False):
    deploy = deploy_settings(component, no_overlap)
    out = Path(out)
    if out.exists() and any(out.iterdir()):
        raise SystemExit(f'{out} must be empty')
    out.mkdir(parents=True, exist_ok=True)
    full = subprocess.run(['git', 'rev-parse', '--verify', commit + '^{commit}'], check=True, capture_output=True, text=True).stdout.strip()
    gate = Path(os.environ.get('VEEVEE_GATE_DIR', Path.home() / 'Library/Application Support/Veevee/release-gate')) / f'{full}.json'
    if not gate.exists():
        raise SystemExit(f'No release-gate pass for {full[:12]}. Run scripts/release/release_gate.sh {full[:12]} first.')
    if not gate.with_name(f'{full}.rehearsal.json').exists():
        raise SystemExit(f'No local rehearsal pass for {full[:12]}. Run scripts/release/rehearse_local.sh {full[:12]} first.')
    archive = subprocess.run(['git', 'archive', '--format=tar', full, 'backend'], check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = [m for m in tar.getmembers() if Path(m.name).name not in ('railway.toml', 'railway.json')
                   and '__pycache__' not in m.name and not m.issym() and not m.islnk()]
        tar.extractall(out, members=members, filter='data')
    config = {'$schema': 'https://railway.com/railway.schema.json',
              'build': {'builder': 'DOCKERFILE', 'dockerfilePath': DOCKERFILE}, 'deploy': deploy}
    (out / 'railway.json').write_text(json.dumps(config, indent=2) + '\n')
    (out / 'STAGED_COMMIT').write_text(full + '\n')
    print(json.dumps({'commit': full, 'component': component, 'dir': str(out), 'deploy': deploy,
                      'serviceInstance': instance_settings(component, no_overlap)}))


if __name__ == '__main__':
    arguments = [argument for argument in sys.argv[1:] if argument != '--no-overlap']
    if len(arguments) != 3:
        raise SystemExit(__doc__)
    main(*arguments, no_overlap='--no-overlap' in sys.argv[1:])
