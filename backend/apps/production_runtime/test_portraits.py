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
from apps.assets import portrait_lifecycle
result = {
    'installed': bool(getattr(route, '_veevee_portrait_lifecycle_installed', False)),
    'enabled': portrait_lifecycle.enabled(),
    'delete_view_patched': route.portraits.cls.delete.__name__ == 'delete',
    'group_hard_delete_blocked': False,
    'visible': portrait_lifecycle.visible_assets([{'status': 'Active'}, {'status': 'PreviewDeleted'}]),
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
        self.assertTrue(result['enabled'])
        self.assertTrue(result['group_hard_delete_blocked'])
        self.assertEqual(result['visible'], [{'status': 'Active'}])


class RejectedRegistrationDeleteTests(__import__('django.test', fromlist=['SimpleTestCase']).SimpleTestCase):
    """A portrait BytePlus definitively rejected (e.g. quota) can be deleted locally."""

    def run_delete(self, status, marker, remote_id=None):
        import json
        from .portraits.remote_delete import DeleteHold, delete_once
        calls = []

        class Store:
            def group(self, gid):
                return {'id': gid, 'projectId': 'p1', 'projectName': 'default', 'byteplusGroupId': 'group-1'}

            def claim(self, asset, m):
                calls.append(('claim', m['remote_asset_id'], m['previous_status']))
                return True

            def archive(self, aid, m, receipt, outcome):
                calls.append(('archive', outcome))

            def unknown(self, aid, m):
                calls.append(('unknown',))

        class Client:
            def get_asset(self, *a, **k):
                raise AssertionError('BytePlus must not be called')
            delete_asset = get_asset

        asset = {'id': 'a1', 'groupId': 'g1', 'status': status, 'statusMessage': json.dumps(marker),
                 'byteplusAssetId': remote_id, 'imageUrl': '/api/media/uploads/portrait/x'}
        try:
            return delete_once(asset, 'actor', project_id='p1', group_id='g1', store=Store(), client=Client()), calls
        except DeleteHold as exc:
            return str(exc), calls

    def test_rejected_without_remote_asset_is_deleted_locally(self):
        result, calls = self.run_delete('RegistrationFailed', {'state': 'REJECTED', 'error_code': 'QuotaSharedPoolExceeded'})
        self.assertEqual(result['remoteDeletion'], 'not_registered')
        self.assertEqual(calls, [('claim', None, 'RegistrationFailed'), ('archive', 'not_registered')])

    def test_uncertain_or_remote_registrations_stay_held(self):
        for status, marker, remote in (('RegistrationUnknown', {'state': 'REJECTED'}, None),
                                       ('RegistrationPending', {}, None),
                                       ('RegistrationFailed', {'state': 'FAILED_UNVERIFIED'}, None),
                                       ('RegistrationFailed', {'state': 'REJECTED'}, 'asset-9'),
                                       ('RegistrationFailed', {'state': 'SUBMISSION_UNCERTAIN'}, None)):
            result, calls = self.run_delete(status, marker, remote)
            self.assertIsInstance(result, str, (status, marker, remote))
            self.assertEqual(calls, [])
