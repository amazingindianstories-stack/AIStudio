"""Read inert, input-keyed historical Node outputs; never execute an oracle.

The original command is a provenance identifier, not executable configuration.
Unknown inputs and modified outputs fail closed rather than regenerate a golden.
"""
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace

DIRECTORY = Path(__file__).with_name('goldens')


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(',', ':'))


def identity(command, input=None):
    command = [str(value) for value in command]
    # Some probes locate the same source oracle through an absolute path.
    command = [value[value.index('scripts/django-migration/'):] if 'scripts/django-migration/' in value and not '\n' in value else value for value in command]
    input = input.decode() if isinstance(input, bytes) else input
    if input is not None:
        try:
            input = canonical(json.loads(input))
        except (ValueError, TypeError):
            pass
    request = {'command': command, 'input': input}
    return hashlib.sha256(canonical(request).encode()).hexdigest(), request


def provenance(fixture):
    manifest = json.loads((DIRECTORY / 'provenance.json').read_text())
    digest = hashlib.sha256(canonical(manifest['sources']).encode()).hexdigest()
    assert digest == manifest['source_tree_sha256'], 'Frozen source manifest hash mismatch'
    assert fixture['source_revision'] == manifest['source_revision'], 'Frozen source revision mismatch'
    assert fixture['source_tree_sha256'] == digest, 'Frozen source tree mismatch'


def run(command, *, input=None, text=False, **ignored):
    digest, request = identity(command, input)
    path = DIRECTORY / (digest + '.json')
    if not path.exists():
        raise AssertionError(f'No frozen historical oracle for input {digest}; review and add an independently sourced fixture.')
    fixture = json.loads(path.read_text())
    provenance(fixture)
    assert fixture['request'] == request, 'Frozen oracle input mismatch'
    output = fixture['stdout']
    assert hashlib.sha256(output.encode()).hexdigest() == fixture['stdout_sha256'], 'Frozen oracle output hash mismatch'
    return SimpleNamespace(stdout=output if text else output.encode(), stderr='' if text else b'', returncode=0)


def check_output(command, **kwargs):
    return run(command, **kwargs).stdout


def schema_sql():
    fixture = json.loads((DIRECTORY / 'source-schema.json').read_text())
    provenance(fixture)
    assert hashlib.sha256(fixture['sql'].encode()).hexdigest() == fixture['sql_sha256'], 'Frozen SQL hash mismatch'
    return fixture['sql']
