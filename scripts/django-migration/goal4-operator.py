"""Operator-only ordered cutover executor. Default is a local, read-only NOOP.

Goal 3 supplies the plan; Goal 4 operator supplies reviewed site-specific hooks
and evidence. No shell interpolation, implicit target discovery or paid replay.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

STEPS = ('inventory', 'backup', 'fence', 'reconcile', 'migrate', 'verify_schema',
         'api', 'generation', 'export', 'scheduler', 'frontend', 'smoke')
ROLLBACK = ('rollback_fence', 'rollback_compatible', 'rollback_verify')
PREREQUISITES = ('target_identity', 'backup_pitr', 'catalog_equivalence', 'paid_receipts', 'release_source', 'approval')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save_receipt(path, state):
    descriptor, temporary = tempfile.mkstemp(prefix=path.name + '.', dir=path.parent)
    try:
        with os.fdopen(descriptor, 'w') as stream:
            json.dump(state, stream, indent=2)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
        descriptor = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    finally:
        Path(temporary).unlink(missing_ok=True)


def validate(plan):
    required = ('railway_project_id', 'railway_environment_id', 'api_service_id',
                'generation_service_id', 'export_service_id', 'scheduler_service_id',
                'vercel_project_id', 'database_fingerprint', 'bucket_identity',
                'api_image_digest', 'worker_image_digest', 'release_zip_sha256')
    for name in required:
        value = plan.get('targets', {}).get(name)
        if not isinstance(value, str) or not value or 'UNKNOWN' in value or '\n' in value:
            raise ValueError('Operator input required: ' + name)
    for name in PREREQUISITES:
        record = plan.get('evidence', {}).get(name, {})
        if record.get('verified') is not True or digest(record['path']) != record.get('sha256'):
            raise ValueError('Missing or changed operator evidence: ' + name)
    if plan.get('approval_scope') != 'GOAL4_PRODUCTION_CUTOVER':
        raise ValueError('Separate Goal 4 approval required')
    if set(plan.get('hooks', {})) != set(STEPS + ROLLBACK):
        raise ValueError('Every cutover/rollback hook must be reviewed')
    for name, hook in plan['hooks'].items():
        path = Path(hook['path'])
        if not path.is_absolute() or path.is_symlink() or not path.is_file() or digest(path) != hook.get('sha256'):
            raise ValueError('Missing or changed reviewed executable: ' + name)
        if not isinstance(hook.get('timeout_seconds'), int) or not 1 <= hook['timeout_seconds'] <= 3600:
            raise ValueError('Bounded hook timeout required: ' + name)


def run(args):
    plan_path = Path(args.plan).resolve()
    plan = json.loads(plan_path.read_text())
    plan_hash = digest(plan_path)
    if not args.execute:
        print(json.dumps({'mode': 'NOOP', 'plan_sha256': plan_hash, 'cutover_order': STEPS,
                          'rollback_order': ROLLBACK, 'remote_calls': 0, 'mutations': 0,
                          'unknown_targets': [key for key, value in plan.get('targets', {}).items() if value == 'UNKNOWN']}))
        return
    if args.confirm != 'GOAL4_PRODUCTION_CUTOVER' or not args.step or not args.receipts:
        raise ValueError('Explicit execute, step, confirmation and receipt destination required')
    validate(plan)
    receipts = Path(args.receipts).resolve()
    # One controlled operator on one execution host; local lock rejects two
    # concurrent invocations before reading state or causing any side effect.
    with open(str(receipts) + '.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        execute_step(plan, plan_path, plan_hash, receipts, args.step)


def execute_step(plan, plan_path, plan_hash, receipts, step):
    state = json.loads(receipts.read_text()) if receipts.exists() else {'plan_sha256': plan_hash, 'steps': {}}
    if state['plan_sha256'] != plan_hash:
        raise ValueError('Plan changed after execution; review and reconcile, never silently resume')
    order = ROLLBACK if step in ROLLBACK else STEPS
    for previous in order[:order.index(step)]:
        if state['steps'].get(previous, {}).get('status') != 'VERIFIED':
            raise ValueError('Previous step is not operator-verified: ' + previous)
    if step in state['steps']:
        raise ValueError('Step already attempted; reconcile outcome before any repeat')
    hook = plan['hooks'][step]
    # Persist intent BEFORE side effects: timeout, crash or ACK loss cannot
    # silently permit another migration/rollout/reconciliation execution.
    state['steps'][step] = {'status': 'ATTEMPTING', 'started_unix': int(time.time()), 'hook_sha256': hook['sha256']}
    save_receipt(receipts, state)
    # Hooks receive metadata plan path, never command-line secrets. The operator
    # provisions separate credentials outside the release source. Hook output
    # stays private; this executor emits only status and a diagnostic hash.
    try:
        result = subprocess.run([hook['path'], str(plan_path)], capture_output=True, timeout=hook['timeout_seconds'])
        state['steps'][step].update(status='AWAITING_OPERATOR_VERIFICATION' if result.returncode == 0 else 'FAILED',
            exit_code=result.returncode, diagnostic_sha256=hashlib.sha256(result.stdout + result.stderr).hexdigest())
    except subprocess.TimeoutExpired:
        state['steps'][step]['status'] = 'AMBIGUOUS_TIMEOUT_DO_NOT_REPEAT'
    finally:
        save_receipt(receipts, state)
    print(json.dumps({'step': step, 'status': state['steps'][step]['status']}))
    if state['steps'][step]['status'] != 'AWAITING_OPERATOR_VERIFICATION':
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', default='docs/goal3/goal4-operator-plan.json')
    parser.add_argument('--step', choices=STEPS + ROLLBACK)
    parser.add_argument('--receipts')
    parser.add_argument('--execute', action='store_true')
    parser.add_argument('--confirm')
    run(parser.parse_args())
