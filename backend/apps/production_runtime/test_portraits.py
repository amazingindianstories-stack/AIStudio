"""Portrait lifecycle install runs in a separate process: it rewrites module code in place."""
import json
import os
import subprocess
import sys
from django.test import SimpleTestCase

SCRIPT = r"""
import json, django
django.setup()
from apps.production_runtime.apps import install_portrait_lifecycle
from apps.assets import portraits as route, portrait_sync
from apps.assets import portrait_db
install_portrait_lifecycle()
install_portrait_lifecycle()  # idempotent
from apps.production_runtime.portraits import tombstones
result = {
    'installed': bool(getattr(route, '_veevee_portrait_lifecycle_installed', False)),
    'tombstones': bool(getattr(route, '_preview_tombstones_installed', False)),
    'delete_view_patched': route.portraits.cls.delete.__name__ == 'delete',
    'group_hard_delete_blocked': False,
    'visible': tombstones.visible_assets([{'status': 'Active'}, {'status': 'PreviewDeleted'}]),
}
try:
    portrait_db.delete_portrait_group('x')
except ValueError:
    result['group_hard_delete_blocked'] = True
print('RESULT' + json.dumps(result))
"""


class PortraitLifecycleInstallTests(SimpleTestCase):
    def test_install_applies_cleanly_to_current_source(self):
        env = dict(os.environ, VEEVEE_PORTRAIT_LIFECYCLE='1', VEEVEE_RUNTIME_COMPONENT='api')
        done = subprocess.run([sys.executable, '-c', SCRIPT], capture_output=True, text=True, env=env,
                              cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__))), timeout=120)
        line = next((l for l in done.stdout.splitlines() if l.startswith('RESULT')), None)
        self.assertIsNotNone(line, done.stderr[-2000:])
        result = json.loads(line[6:])
        self.assertTrue(result['installed'])
        self.assertTrue(result['tombstones'])
        self.assertTrue(result['group_hard_delete_blocked'])
        self.assertEqual(result['visible'], [{'status': 'Active'}])
