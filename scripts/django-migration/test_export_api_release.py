from copy import deepcopy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('export_api_release', Path(__file__).with_name('export-api-release.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ReleaseExportTests(unittest.TestCase):
    def setUp(self):
        self.files = {name: b'committed input' for name in ['backend/manage.py',
            'backend/config/wsgi.py', 'backend/requirements.txt', 'backend/Dockerfile',
            'backend/Dockerfile.dockerignore', 'backend/railway.toml']}
        self.evidence = {'source_revision': 'a' * 40, 'api_source_sha256': module.fingerprint(self.files),
                         'image_id': 'sha256:fixture', 'platform': 'linux/arm64'}

    def test_path_allowlist_excludes_credentials_and_unrelated_files(self):
        for name in ['.env', 'backend/.env.production', 'backend/.venv/key.py',
                     'backend/__pycache__/app.py', 'backend/../secret.py',
                     'src/app/page.jsx', 'backend/credentials.json', 'backend/archive.zip']:
            self.assertFalse(module.allowed(name), name)
        self.assertTrue(module.allowed('backend/config/settings/production.py'))

    def test_fingerprint_order_and_configuration_scope(self):
        self.assertEqual(module.fingerprint(self.files), module.fingerprint(dict(reversed(list(self.files.items())))))
        changed = deepcopy(self.files)
        changed['backend/railway.toml'] = b'new deploy config'
        self.assertEqual(module.fingerprint(self.files), module.fingerprint(changed))
        changed['backend/config/wsgi.py'] = b'changed application'
        self.assertNotEqual(module.fingerprint(self.files), module.fingerprint(changed))

    def test_export_and_manifest_match_committed_bytes(self):
        with tempfile.TemporaryDirectory() as parent, patch.object(module, 'committed_inputs', return_value=self.files):
            target, manifest = module.export(Path(parent), self.evidence, parent)
            for name, data in self.files.items():
                self.assertEqual((target / name).read_bytes(), data)
            self.assertEqual(set(manifest['file_sha256']), set(self.files))
            self.assertFalse(manifest['deployed'])
            self.assertFalse((target / '.git').exists())

    def test_mismatch_creates_no_release_directory(self):
        evidence = dict(self.evidence, api_source_sha256='0' * 64)
        with tempfile.TemporaryDirectory() as parent, patch.object(module, 'committed_inputs', return_value=self.files):
            with self.assertRaisesRegex(ValueError, 'fingerprint'):
                module.export(Path(parent), evidence, parent)
            self.assertEqual(list(Path(parent).iterdir()), [])

    def test_exact_revision_and_symlink_rejection(self):
        with self.assertRaises(ValueError):
            module.committed_inputs(Path('/unused'), 'HEAD')
        listing = b'120000 blob ' + b'a' * 40 + b'\tbackend/config/wsgi.py\0'
        with patch.object(module.subprocess, 'check_output', return_value=listing) as command:
            with self.assertRaisesRegex(ValueError, 'non-regular'):
                module.committed_inputs(Path('/unused'), 'a' * 40)
            self.assertEqual(command.call_count, 1)
