"""Check integration imports before Django's test runner loads application models."""
import subprocess
import sys
from pathlib import Path

from django.test import SimpleTestCase


class IntegrationImportTests(SimpleTestCase):
    def test_helpers_import_without_models(self):
        result = subprocess.run(
            [sys.executable, '-c', '''
import importlib
import importlib.abc
import sys

class RejectModels(importlib.abc.MetaPathFinder):
    def find_spec(self, fullname, path=None, target=None):
        if 'models' in fullname.split('.'):
            raise AssertionError('Integration imported model module: ' + fullname)

sys.meta_path.insert(0, RejectModels())
importlib.import_module('apps.integrations')
importlib.import_module('apps.integrations.dns')
importlib.import_module('apps.integrations.byteplus')
importlib.import_module('apps.integrations.remote')
assert not any('models' in name.split('.') for name in sys.modules)
'''],
            cwd=Path(__file__).resolve().parents[2],
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
