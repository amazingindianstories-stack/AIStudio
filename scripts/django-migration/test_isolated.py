"""Guard clean qualification inputs against archived runtime/credential copying."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('isolated', Path(__file__).with_name('isolated.py'))
isolated = importlib.util.module_from_spec(spec)
spec.loader.exec_module(isolated)


class IsolatedSourceTests(unittest.TestCase):
    def test_runtime_credential_and_archived_browser_recordings_are_excluded(self):
        forbidden = ['backend/.env', 'backend/venv/bin/python', 'backend/.venv/x.py',
                     'backend/key.pem', 'docs/django-migration/release-review/browser-artifacts/x/trace.zip',
                     'docs/goal3/evidence/customer.mov', 'docs/goal3/evidence/signed-recording.webm',
                     'src/node_modules/private.js', 'tests/test-results/trace.json']
        for name in forbidden:
            with self.subTest(name=name):
                self.assertFalse(isolated.copy_source_path(Path(name)))

    def test_source_schema_goldens_operator_contracts_and_public_logo_are_kept(self):
        for name in ['backend/apps/exports/worker.py', 'backend/testsupport/goldens/input.json',
                     'docs/goal3/08-ordered-goal4-cutover-runbook.md', 'docs/goal3/evidence/receipt.json',
                     'scripts/django-migration/test_isolated.py', 'public/logo.png', 'package-lock.json']:
            with self.subTest(name=name):
                self.assertTrue(isolated.copy_source_path(Path(name)))


if __name__ == '__main__':
    unittest.main()
