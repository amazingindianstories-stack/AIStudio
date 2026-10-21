"""Worker lease namespace: Green workers hold leases under a private prefix."""
import os
import subprocess
import sys
from django.test import SimpleTestCase, TestCase, override_settings
from apps.admin_dashboard.models import AppSetting
from . import leases

BACKEND = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def settings_error(**env):
    """Load the base settings in a fresh process with extra environment; return the startup error text, if any."""
    done = subprocess.run([sys.executable, '-c', 'import config.settings.base'], capture_output=True, text=True,
                          env=dict(os.environ, **env), cwd=BACKEND, timeout=120)
    return done.stderr if done.returncode else None


class LeaseNamespaceTests(TestCase):
    @override_settings(VEEVEE_RUNTIME_COMPONENT='generation', VEEVEE_LEASE_PREFIX='lease:private:')
    def test_worker_lease_keys_are_prefixed_and_validated(self):
        self.assertTrue(leases.claim('lease:generation:1', 'owner', now=1, ttl_ms=10))
        self.assertEqual(list(AppSetting.objects.values_list('key', flat=True)), ['lease:private:generation:1'])
        self.assertEqual(leases.read('lease:generation:1'), {'owner': 'owner', 'expiresAt': 11})
        self.assertIsNone(leases.read('lease:private:generation:1'))
        for call in (lambda: leases.release('not-a-lease', 'owner'), lambda: leases.claim(None, 'owner'),
                     lambda: leases.read('generation:1'), lambda: leases.delete_expired(b'lease:x')):
            with self.assertRaisesMessage(ValueError, 'Invalid lease key'):
                call()
        self.assertFalse(leases.delete_expired('lease:generation:1', now=10))
        self.assertTrue(leases.delete_expired('lease:generation:1', now=11))
        self.assertTrue(leases.claim('lease:depth', 'owner', now=1))
        self.assertTrue(leases.release('lease:depth', 'owner'))
        self.assertFalse(AppSetting.objects.exists())

    def test_every_worker_component_and_only_workers_use_the_prefix(self):
        for component, key in (('generation', 'lease:private:x'), ('export', 'lease:private:x'), ('scheduler', 'lease:private:x'),
                               ('api', 'lease:x'), (None, 'lease:x')):
            with override_settings(VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_LEASE_PREFIX='lease:private:'):
                self.assertTrue(leases.claim('lease:x', 'owner', now=1))
                self.assertEqual(list(AppSetting.objects.values_list('key', flat=True)), [key], component)
                self.assertTrue(leases.release('lease:x', 'owner'))
        with override_settings(VEEVEE_RUNTIME_COMPONENT='generation', VEEVEE_LEASE_PREFIX=''):
            self.assertEqual(leases.namespaced('lease:x'), 'lease:x')


class LeasePrefixStartupTests(SimpleTestCase):
    def test_a_malformed_worker_lease_prefix_fails_startup(self):
        for component in ('generation', 'export', 'scheduler'):
            for prefix in ('private:', 'lease:private', 'lease'):
                error = settings_error(VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_LEASE_PREFIX=prefix)
                self.assertIn('Lease prefix must start with "lease:" and end with ":"', error or '', (component, prefix))
            self.assertIsNone(settings_error(VEEVEE_RUNTIME_COMPONENT=component, VEEVEE_LEASE_PREFIX='lease:private:'))

    def test_the_api_never_validates_or_uses_a_lease_prefix(self):
        self.assertIsNone(settings_error(VEEVEE_RUNTIME_COMPONENT='api', VEEVEE_LEASE_PREFIX='private'))
