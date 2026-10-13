"""Build twice from the clean source; verify exact manifest/modes/CRC identity."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import zipfile

if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or Path.cwd().name != 'repo':
    raise SystemExit('Verified clean-source qualification required')
spec = importlib.util.spec_from_file_location('handoff', Path('scripts/package-project-zip.py'))
handoff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handoff)
with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='package-dry-run-') as directory:
    receipts = [handoff.package(Path(directory) / (name + '.zip'), limit_bytes=100_000_000) for name in ('first', 'second')]
    assert receipts[0]['sha256'] == receipts[1]['sha256'], 'Source package is not deterministic'
    with zipfile.ZipFile(receipts[0]['archive']) as archive:
        names = archive.namelist()
        assert len(set(names)) == len(names) and archive.testzip() is None
        manifest = json.loads(archive.read('HANDOFF-MANIFEST.json'))
        assert set(names) == set(manifest['file_sha256']) | {'HANDOFF-MANIFEST.json'}
        for name, expected in manifest['file_sha256'].items():
            assert handoff.allowed(name), 'Unsafe member path'
            assert not Path(name).is_absolute() and '..' not in Path(name).parts
            assert hashlib.sha256(archive.read(name)).hexdigest() == expected
            assert archive.getinfo(name).external_attr >> 16 == int(manifest['file_modes'][name], 8)
    print(json.dumps({'gate': 'PASS', 'two_byte_identical_builds': True, 'member_count': len(names),
                      'bytes': receipts[0]['bytes'], 'sha256': receipts[0]['sha256'], 'mode_hash_crc_verified': True,
                      'scope': 'dry-run clean copied source; not final frozen release ZIP'}))
