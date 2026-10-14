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
        for method in ('GET', 'POST'):
            self.assertTrue(allowed(method, '/api/admin/portrait-settings'), method)
        self.assertTrue(allowed('GET', '/api/portraits/managed'))
        self.assertTrue(allowed('DELETE', '/api/portraits/managed/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'))
        self.assertFalse(allowed('POST', '/api/admin/users'))


class LegacyConfigTests(SimpleTestCase):
    """The versioned image reads the Green services' existing configuration unchanged."""
    CA = b'-----BEGIN CERTIFICATE-----\nfixture\n-----END CERTIFICATE-----\n'

    def setUp(self):
        import base64
        import hashlib
        from unittest.mock import patch
        from deploy import legacy_config
        self.legacy = legacy_config
        patcher = patch.object(legacy_config, 'CA_SHA256', hashlib.sha256(self.CA).hexdigest())
        patcher.start()
        self.addCleanup(patcher.stop)
        self.base = {'database': 'railway', 'database_password': 'p@ss/word', 'ca_base64': base64.b64encode(self.CA).decode(),
                     'adc': {'type': 'service_account', 'client_email': 'svc@example.invalid'}, 'django_secret': 'd' * 64,
                     'auth_secret': 'a' * 64, 'media_prefix': 'private/prefix/value/'}
        self.paid = {'configuration': {'approved_scope': 'SCOPE', 'unlimited_new_jobs': True, 'maximum_total_cents': None,
                                       'authorization': {'kind': 'x'}},
                     'provider_environment': {'ARK_API_KEY': 'ark', 'GOOGLE_API_KEY': 'google', 'SEEDANCE_MODEL': 'm'},
                     'guard_base64': 'ignored'}

    def api_env(self, **cfg):
        import json
        config = {**self.base, 'role': 'goal4_green_preview_api', 'ingress_secret': 'i' * 64, 'paid': self.paid,
                  'new_exports': {'scope': 'x'}, **cfg}
        return {'GOAL4_PREVIEW_CONFIGURATION': json.dumps(config), 'GOAL4_PREVIEW_BROWSER_ORIGINS': 'https://veevee.ai',
                'GOAL4_PREVIEW_APP_ORIGIN': 'https://old-preview.example', 'PATH': '/usr/bin', 'RAILWAY_DEPLOYMENT_ID': 'dep', 'PORT': '8080',
                'GOAL4_PREVIEW_LAUNCHER': 'code-that-must-not-reach-django',
                'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION': json.dumps({'read_environment': {'BYTEPLUS_ACCESS_KEY_ID': 'k', 'BYTEPLUS_SECRET_ACCESS_KEY': 's'}})}

    def worker_env(self, kind, **cfg):
        import json
        config = {**self.base, 'kind': kind, 'role': 'goal4_green_preview_worker', 'historical_replay_authorized': False,
                  'paid_providers_authorized': kind != 'export', 'browser_origin': 'https://veevee.ai',
                  'lease_prefix': 'lease:g4preview:x:', 'naming_prefix': 'g4preview:y:', 'provider_media_hosts': ['cdn.example'],
                  'rls_tables': ['generations'], 'hidden_job_contracts': {'generations': ['id']}, **cfg}
        if kind != 'export':
            config.setdefault('paid', self.paid)
        else:
            config.setdefault('new_exports', {'scope': 'x'})
        return {'GOAL4_PREVIEW_WORKER_CONFIGURATION': json.dumps(config), 'GOAL4_PREVIEW_WORKER_LAUNCHER': 'code', 'PATH': '/usr/bin'}

    def test_api_mapping_matches_the_old_launcher(self):
        import json
        env = self.api_env()
        self.assertTrue(self.legacy.present(env))
        out = self.legacy.translate('api', env)
        self.assertEqual(out['DATABASE_URL'], 'postgresql://goal4_green_preview_api:p%40ss%2Fword@green-postgres18.railway.internal:5432/railway')
        self.assertEqual((out['PUBLIC_APP_URL'], out['DJANGO_BROWSER_ORIGINS'], out['PORT']), ('https://old-preview.example', 'https://veevee.ai', '18081'))
        self.assertEqual((out['MOCK_GENERATION'], out['MOCK_ASSET_PROVIDER'], out['ARK_API_KEY']), ('0', '0', 'ark'))
        self.assertEqual(json.loads(out['VEEVEE_PAID_GUARD']), {'approved_scope': 'SCOPE', 'unlimited_new_jobs': True, 'maximum_total_cents': None})
        self.assertEqual((out['VEEVEE_EXPORT_ADMISSION'], out['VEEVEE_PORTRAIT_LIFECYCLE'], out['BYTEPLUS_ACCESS_KEY_ID']), ('1', '1', 'k'))
        self.assertEqual(out['VEEVEE_INGRESS_SECRET'], 'i' * 64)
        self.assertEqual(out['RAILWAY_DEPLOYMENT_ID'], 'dep')
        self.assertFalse(any(key.startswith('GOAL4_') for key in out), 'launcher code and blobs never reach Django')
        self.assertNotIn('VEEVEE_LEASE_PREFIX', out)
        prepared = entrypoint.prepare_environment(out)
        self.assertIn('sslmode=verify-full', prepared['DATABASE_URL'])
        override = self.legacy.translate('api', {**env, 'VEEVEE_PUBLIC_APP_URL_OVERRIDE': 'https://veevee.ai'})
        self.assertEqual(override['PUBLIC_APP_URL'], 'https://veevee.ai')
        self.assertNotIn('VEEVEE_PUBLIC_APP_URL_OVERRIDE', override)
        self.assertFalse(self.legacy.present({**env, 'DATABASE_URL': 'postgresql://explicit'}))

    def test_worker_mapping_matches_the_old_launcher(self):
        generation = self.legacy.translate('generation', self.worker_env('generation'))
        self.assertEqual((generation['VEEVEE_LEASE_PREFIX'], generation['VEEVEE_NAMING_PREFIX']), ('lease:g4preview:x:', 'g4preview:y:'))
        self.assertEqual((generation['VEEVEE_PROVIDER_MEDIA_HOSTS'], generation['MOCK_GENERATION']), ('cdn.example', '0'))
        self.assertIn('VEEVEE_PAID_GUARD', generation)
        self.assertNotIn('VEEVEE_EXPORT_ADMISSION', generation)
        export = self.legacy.translate('export', self.worker_env('export'))
        self.assertEqual((export['VEEVEE_EXPORT_ADMISSION'], export['MOCK_GENERATION']), ('1', '1'))
        self.assertNotIn('VEEVEE_PAID_GUARD', export)
        self.assertNotIn('ARK_API_KEY', export)
        contract = self.legacy.preflight_contract('export', self.worker_env('export'))
        self.assertEqual(contract['rls_tables'], ['generations'])

    def test_refuses_mismatched_or_unsafe_configuration(self):
        for component, env in (('generation', self.worker_env('export')),
                               ('generation', self.worker_env('generation', historical_replay_authorized=True)),
                               ('export', self.worker_env('export', paid=self.paid, paid_providers_authorized=True)),
                               ('generation', self.worker_env('generation', lease_prefix='lease:other:')),
                               ('api', self.api_env(role='goal4_green_preview_worker')),
                               ('api', self.api_env(database='other'))):
            with self.subTest(component=component), self.assertRaises(SystemExit):
                self.legacy.translate(component, env)
        from unittest.mock import patch
        with patch.object(self.legacy, 'CA_SHA256', '0' * 64), self.assertRaises(SystemExit):
            self.legacy.translate('api', self.api_env())

    def test_preflight_fails_closed(self):
        class Result:
            def __init__(self, row):
                self.row = row

            def fetchone(self):
                return self.row

        class Connection:
            def __init__(self, answers):
                self.answers = answers

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

            def execute(self, query, params=None):
                text = query if isinstance(query, str) else repr(query)
                for marker, row in self.answers:
                    if marker in text:
                        return Result(row)
                raise AssertionError(text)

        good = [('pg_control_system', ('railway', 'goal4_green_preview_worker', self.legacy.SYSTEM_IDENTIFIER)),
                ('pg_stat_ssl', (True,)), ('django_migrations', (60,)), ('pg_roles', (False,) * 6),
                ('relrowsecurity', (True,)), ('held_generations', (0,))]
        contract = {'role': 'goal4_green_preview_worker', 'rls_tables': ['generations'], 'hidden_job_contracts': {'generations': ['id']}}
        self.legacy.preflight('url', contract, connect=lambda url: Connection(good))
        for index, bad in ((0, ('railway', 'someone_else', self.legacy.SYSTEM_IDENTIFIER)), (1, (False,)), (2, (59,)),
                           (3, (False, True, False, False, False, False)), (4, (False,)), (5, (3,))):
            answers = list(good)
            answers[index] = (good[index][0], bad)
            with self.subTest(index=index), self.assertRaises(SystemExit):
                self.legacy.preflight('url', contract, connect=lambda url, a=answers: Connection(a))
