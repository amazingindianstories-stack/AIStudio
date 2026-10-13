"""Advisory-only public npm metadata audit in a verified empty-home source copy."""
import hashlib
import json
import os
from pathlib import Path
import subprocess

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Run through verified isolation qualification')
assert not any(Path.cwd().glob('.env*')), 'Dotenv entered qualification'
result = {'scope': 'public registry metadata; no live providers', 'lock_sha256': hashlib.sha256(Path('package-lock.json').read_bytes()).hexdigest(), 'audits': {}}
for label, arguments in [('all', []), ('production', ['--omit=dev'])]:
    completed = subprocess.run(['npm', 'audit', '--json', *arguments], capture_output=True, text=True)
    payload = json.loads(completed.stdout)
    if completed.returncode not in (0, 1) or 'error' in payload or 'metadata' not in payload:
        raise SystemExit('Public audit failed; do not report vulnerability count as zero')
    result['audits'][label] = {'exit_code': completed.returncode, 'report': payload}
print(json.dumps(result, indent=2))
