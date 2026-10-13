"""Repeatable sanitized full-tree and qualification-input identities, no env reads."""
import argparse
import datetime
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('package_allowlist', ROOT / 'scripts/package-project-zip.py')
allowlist = importlib.util.module_from_spec(spec)
spec.loader.exec_module(allowlist)


def qualification_input(name):
    path = Path(name)
    if name.startswith('docs/goal3/'):
        return path.suffix == '.py'
    if name.startswith('docs/') and ('evidence' in path.parts or 'browser-artifacts' in path.parts):
        return False
    return True


def capture():
    names = subprocess.check_output(['git', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], cwd=ROOT, text=True).split('\0')
    full = {}
    for name in sorted(set(names) - {''}):
        source = ROOT / name
        if name.startswith('docs/goal3/evidence/') or name == 'docs/goal3/archive-verification.json':
            continue  # Generated receipts cannot hash themselves; final ZIP manifest covers them.
        if not allowlist.allowed(name) or source.is_symlink() or not source.is_file():
            continue
        data = source.read_bytes()
        if any(pattern.search(data) for pattern in allowlist.SECRET_PATTERNS):
            raise ValueError('Potential credential in allowed source: ' + name)
        full[name] = hashlib.sha256(data).hexdigest()
    inputs = {name: digest for name, digest in full.items() if qualification_input(name)}
    digest = hashlib.sha256()
    for name, value in inputs.items():
        digest.update(name.encode() + b'\0' + bytes.fromhex(value))
    revision = subprocess.run(['git', 'rev-parse', '--verify', 'HEAD'], cwd=ROOT, text=True, capture_output=True)
    return {'captured_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'HEAD': revision.stdout.strip() if revision.returncode == 0 else None,
            'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip(),
            'full_file_sha256': full, 'qualification_input_sha256': inputs,
            'qualification_sha256': digest.hexdigest(),
            'scope': 'Sanitized source snapshot excluding generated Goal3 evidence; final ZIP manifest covers receipts. Sealed qualification inputs exclude generated reports, include executable drivers and static contracts'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--verify', type=Path)
    args = parser.parse_args()
    current = capture()
    if args.verify:
        before = json.loads(args.verify.read_text())['qualification_input_sha256']
        after = current['qualification_input_sha256']
        changed = sorted(name for name in before.keys() | after.keys() if before.get(name) != after.get(name))
        print(json.dumps({'unchanged': not changed, 'changed_inputs': changed, 'qualification_sha256': current['qualification_sha256']}))
        if changed:
            raise SystemExit(1)
    if args.output:
        args.output.write_text(json.dumps(current, indent=2) + '\n')
    elif not args.verify:
        print(json.dumps({'qualification_sha256': current['qualification_sha256'], 'files': len(current['full_file_sha256']), 'inputs': len(current['qualification_input_sha256'])}))


if __name__ == '__main__':
    main()
