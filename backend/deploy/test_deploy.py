"""Entrypoint credential materialization and gateway route allowlist."""
import importlib.util
import os
import stat
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit
from django.test import SimpleTestCase
from deploy import entrypoint

spec = importlib.util.spec_from_file_location('veevee_gateway', Path(__file__).with_name('gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)


class EntrypointTests(SimpleTestCase):
    def test_credentials_are_private_files_and_tls_is_verified(self):
        env = entrypoint.prepare_environment({
            'DATABASE_URL': 'postgresql://role:pw@db.internal:5432/railway',
            'VEEVEE_DATABASE_CA_PEM': '-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n',
            'GCP_ADC_JSON': '{"type": "service_account", "client_email": "x@example.invalid"}',
        })
        self.assertNotIn('VEEVEE_DATABASE_CA_PEM', env)
        self.assertNotIn('GCP_ADC_JSON', env)
        query = dict(parse_qsl(urlsplit(env['DATABASE_URL']).query))
        self.assertEqual(query['sslmode'], 'verify-full')
        for path in (query['sslrootcert'], env['GOOGLE_APPLICATION_CREDENTIALS']):
            self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(os.stat(os.path.dirname(query['sslrootcert'])).st_mode), 0o700)
        self.assertEqual(env['DJANGO_SETTINGS_MODULE'], 'config.settings.production')

    def test_malformed_credentials_and_weak_ingress_fail_fast(self):
        with self.assertRaises(ValueError):
            entrypoint.prepare_environment({'DATABASE_URL': 'postgresql://a@b/c', 'GCP_ADC_JSON': 'not json'})
        with self.assertRaises(SystemExit):
            entrypoint.run_api({'VEEVEE_INGRESS_SECRET': 'short'})
        with self.assertRaises(SystemExit):
            entrypoint.main(['entrypoint', 'shell'])


class GatewayAllowlistTests(SimpleTestCase):
    def test_routes(self):
        allowed = lambda method, path: gateway.allowed(method, path, True, True)  # noqa: E731
        for method, path in (('POST', '/api/generate/image'), ('POST', '/api/generate/video'), ('POST', '/api/generate/video/finalize'),
                             ('POST', '/api/generate/depth'), ('GET', '/api/generate/depth/status'), ('POST', '/api/worker/depth/claim'),
                             ('POST', '/api/worker/depth/complete'), ('GET', '/api/history'), ('GET', '/api/worker/depth/status')):
            self.assertTrue(allowed(method, path), (method, path))
        for method, path in (('POST', '/api/generate/upscale'), ('POST', '/api/queue/execute'), ('POST', '/api/worker/other'),
                             ('GET', '/api/worker/depth/claim'), ('POST', '/api/webhooks/x'), ('GET', '/healthz')):
            self.assertFalse(allowed(method, path), (method, path))
        self.assertFalse(gateway.allowed('POST', '/api/generate/video', False, True))
