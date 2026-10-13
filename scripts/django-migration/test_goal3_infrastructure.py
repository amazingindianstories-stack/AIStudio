import importlib.util
from pathlib import Path
import shutil
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('infra', Path(__file__).with_name('goal3-infrastructure-check.py'))
infra = importlib.util.module_from_spec(spec)
spec.loader.exec_module(infra)


class InfrastructureReleaseGateTests(unittest.TestCase):
    def test_current_exact_profile_and_topology(self):
        self.assertEqual(infra.qualify()['api_profile'], {'workers': 2, 'threads': 4, 'timeout_seconds': 30})

    def test_negative_profile_startup_migration_and_node_route_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in infra.qualify()['source_sha256']:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(infra.ROOT / name, target)
            path = root / 'backend/Dockerfile'
            original = path.read_text()
            for mutated in (original.replace('--threads 4', '--threads 8'), original + '\nRUN python manage.py migrate\n'):
                path.write_text(mutated)
                with self.assertRaises(AssertionError):
                    infra.qualify(root)
            path.write_text(original)
            route = root / 'src/app/api/new/route.js'
            route.parent.mkdir(parents=True)
            route.write_text('export function GET() {}')
            with self.assertRaises(AssertionError):
                infra.qualify(root)
