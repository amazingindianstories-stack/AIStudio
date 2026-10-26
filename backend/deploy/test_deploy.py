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
        self.assertTrue(allowed('POST', '/api/admin/users'))
        self.assertFalse(allowed('POST', '/api/admin/audit/runtime'))

    def test_magnific_upscale_route_needs_paid_routes_and_its_flag(self):
        self.assertFalse(gateway.allowed('POST', '/api/generate/upscale', True, True))
        self.assertFalse(gateway.allowed('POST', '/api/generate/upscale', True, True, False))
        self.assertFalse(gateway.allowed('POST', '/api/generate/upscale', False, True, True))
        self.assertTrue(gateway.allowed('POST', '/api/generate/upscale', True, True, True))
        for method, path in (('GET', '/api/generate/upscale/status'), ('PUT', '/api/generate/upscale'), ('POST', '/api/generate/upscale/x'),
                             ('POST', '/api/queue/execute')):
            self.assertFalse(gateway.allowed(method, path, True, True, True), (method, path))
        # Everything allowed before stays allowed; nothing else opens with the flag.
        for method, path in (('POST', '/api/generate/image'), ('POST', '/api/generate/video'), ('GET', '/api/history'),
                             ('POST', '/api/admin/users'), ('POST', '/api/worker/other')):
            self.assertEqual(gateway.allowed(method, path, True, True, True), gateway.allowed(method, path, True, True), (method, path))

    def test_entrypoint_passes_the_flag_to_the_gateway(self):
        import json
        from unittest.mock import patch
        captured = {}

        class Child:
            def __init__(self, args, **kwargs):
                self.stdin, self.returncode = self, 0
            def write(self, data):
                captured['config'] = json.loads(data)
            def close(self):
                pass
            def poll(self):
                return 0
            def wait(self):
                return 0
            def terminate(self):
                pass
        for value, expected in (('1', True), (None, False)):
            env = {'VEEVEE_INGRESS_SECRET': 's' * 64, 'PORT': '18081', 'VEEVEE_PAID_GUARD': '{}'}
            if value:
                env['VEEVEE_MAGNIFIC_UPSCALE'] = value
            with patch('subprocess.Popen', Child), patch('signal.signal'):
                entrypoint.run_api(env)
            self.assertIs(captured['config']['magnific_upscale'], expected)


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

    def test_magnific_key_flag_and_cdn_pass_through_only_when_set(self):
        plain = self.legacy.translate('generation', {**self.worker_env('generation'), 'MAGNIFIC_API_KEY': 'mk'})
        self.assertNotIn('MAGNIFIC_API_KEY', plain, 'a key set ahead of the flag stays out of Django')
        self.assertNotIn('VEEVEE_MAGNIFIC_UPSCALE', plain)
        self.assertEqual(plain['VEEVEE_PROVIDER_MEDIA_HOSTS'], 'cdn.example')
        enabled = self.legacy.translate('generation', {**self.worker_env('generation'), 'MAGNIFIC_API_KEY': 'mk', 'VEEVEE_MAGNIFIC_UPSCALE': '1'})
        self.assertEqual((enabled['MAGNIFIC_API_KEY'], enabled['VEEVEE_MAGNIFIC_UPSCALE']), ('mk', '1'))
        self.assertEqual(enabled['VEEVEE_PROVIDER_MEDIA_HOSTS'], 'cdn.example,cdn-magnific.freepik.com,ai-statics.magnific.com')
        api = self.legacy.translate('api', {**self.api_env(), 'MAGNIFIC_API_KEY': 'mk', 'VEEVEE_MAGNIFIC_UPSCALE': '1'})
        self.assertEqual((api['MAGNIFIC_API_KEY'], api['VEEVEE_MAGNIFIC_UPSCALE']), ('mk', '1'))

    def test_gemini_omni_switch_passes_through_only_when_set(self):
        for component, env in (('generation', self.worker_env('generation')), ('api', self.api_env())):
            self.assertNotIn('VEEVEE_GEMINI_OMNI', self.legacy.translate(component, env))
            self.assertEqual(self.legacy.translate(component, {**env, 'VEEVEE_GEMINI_OMNI': '1'})['VEEVEE_GEMINI_OMNI'], '1')

    def test_omnihuman_reuses_the_byteplus_pair_on_the_enabled_generation_worker_only(self):
        import json
        portrait = {'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION': json.dumps({'read_environment': {
            'BYTEPLUS_ACCESS_KEY_ID': 'k', 'BYTEPLUS_SECRET_ACCESS_KEY': 's', 'BYTEPLUS_ARK_REGION': 'ap-southeast-1'}})}
        pair = {'BYTEPLUS_ACCESS_KEY_ID', 'BYTEPLUS_SECRET_ACCESS_KEY'}
        for kind in ('generation', 'export', 'scheduler'):
            env = {**self.worker_env(kind), **portrait, 'OMNIHUMAN_ACCESS_KEY_ID': 'a', 'OMNIHUMAN_SECRET_ACCESS_KEY': 'b'}
            off = self.legacy.translate(kind, env)
            self.assertFalse(pair & set(off), 'the pair stays out of a worker without the switch')
            on = self.legacy.translate(kind, {**env, 'VEEVEE_OMNIHUMAN': '1'})
            self.assertEqual(on['VEEVEE_OMNIHUMAN'], '1')
            self.assertFalse({key for key in on if key.startswith('OMNIHUMAN_') or key.startswith('GOAL4_')})
            self.assertEqual({key: on[key] for key in pair if key in on}, {'BYTEPLUS_ACCESS_KEY_ID': 'k', 'BYTEPLUS_SECRET_ACCESS_KEY': 's'}
                             if kind == 'generation' else {}, kind)
            self.assertNotIn('BYTEPLUS_ARK_REGION', on)
        with self.assertRaises(SystemExit):
            self.legacy.translate('generation', {**self.worker_env('generation'), 'VEEVEE_OMNIHUMAN': '1'})
        for reads in ({'BYTEPLUS_ACCESS_KEY_ID': 'k'}, {'BYTEPLUS_ACCESS_KEY_ID': 'k', 'BYTEPLUS_SECRET_ACCESS_KEY': 's', 'ARK_API_KEY': 'x'}):
            with self.subTest(reads=reads), self.assertRaises(SystemExit):
                self.legacy.translate('generation', {**self.worker_env('generation'), 'VEEVEE_OMNIHUMAN': '1',
                    'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION': json.dumps({'read_environment': reads})})
        api = self.legacy.translate('api', {**self.api_env(), 'VEEVEE_OMNIHUMAN': '1'})
        self.assertEqual(api['VEEVEE_OMNIHUMAN'], '1')

    def test_omnihuman_result_host_only_on_the_enabled_generation_worker(self):
        import json
        import socket
        from apps.integrations.remote import UnsafeMediaURL, validated_target
        portrait = {'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION': json.dumps({'read_environment': {'BYTEPLUS_ACCESS_KEY_ID': 'k', 'BYTEPLUS_SECRET_ACCESS_KEY': 's'}})}
        for kind in ('generation', 'export', 'scheduler'):
            off = self.legacy.translate(kind, {**self.worker_env(kind), **portrait})
            on = self.legacy.translate(kind, {**self.worker_env(kind), **portrait, 'VEEVEE_OMNIHUMAN': '1'})
            self.assertEqual(on['VEEVEE_PROVIDER_MEDIA_HOSTS'], 'cdn.example,v16m-default.tiktokcdn.com' if kind == 'generation'
                             else off['VEEVEE_PROVIDER_MEDIA_HOSTS'], kind)
        both = self.legacy.translate('generation', {**self.worker_env('generation'), **portrait, 'VEEVEE_OMNIHUMAN': '1', 'VEEVEE_KLING': '1'})
        self.assertEqual(both['VEEVEE_PROVIDER_MEDIA_HOSTS'], 'cdn.example,h1.inkwai.com,cdn.klingai.com,v16m-default.tiktokcdn.com')
        public = lambda host, port, type=None: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443))]
        hosts = both['VEEVEE_PROVIDER_MEDIA_HOSTS'].split(',')
        url = 'https://v16m-default.tiktokcdn.com/0a1b2c/68f0/video/tos/alisg/tos-alisg-ve-0051c001-sg/o/?a=4475&x-expires=1761500000'
        self.assertEqual(validated_target(url, hosts, public)[0], 'v16m-default.tiktokcdn.com')
        for url in ('https://v16-default.tiktokcdn.com/x.mp4', 'https://evil.tiktokcdn.com/x.mp4', 'http://v16m-default.tiktokcdn.com/x.mp4'):
            with self.subTest(url=url), self.assertRaises(UnsafeMediaURL):
                validated_target(url, hosts, public)

    def test_kling_switch_key_host_and_result_hosts(self):
        kling = {'KLING_API': 'kk', 'KLING_API_HOST': 'https://api.klingai.com'}
        envs = {'api': self.api_env(), **{kind: self.worker_env(kind) for kind in ('generation', 'export', 'scheduler')}}
        for component, env in envs.items():
            off = self.legacy.translate(component, {**env, **kling})
            self.assertFalse({'VEEVEE_KLING', 'KLING_API', 'KLING_API_HOST'} & set(off), 'a key set ahead of the flag stays out of Django')
            self.assertNotIn('h1.inkwai.com', off.get('VEEVEE_PROVIDER_MEDIA_HOSTS', ''))
            on = self.legacy.translate(component, {**env, **kling, 'VEEVEE_KLING': '1'})
            self.assertEqual(on['VEEVEE_KLING'], '1', component)
            # Only the generation worker calls Kling; the API quotes the same host but never holds the key.
            self.assertEqual(on.get('KLING_API'), 'kk' if component == 'generation' else None, component)
            self.assertEqual(on.get('KLING_API_HOST'), 'https://api.klingai.com' if component in ('api', 'generation') else None, component)
        generation = self.legacy.translate('generation', {**envs['generation'], 'KLING_API': 'kk', 'VEEVEE_KLING': '1'})
        self.assertNotIn('KLING_API_HOST', generation, 'the documented default host needs no variable')
        self.assertEqual(generation['VEEVEE_PROVIDER_MEDIA_HOSTS'], 'cdn.example,h1.inkwai.com,cdn.klingai.com')
        both = self.legacy.translate('generation', {**envs['generation'], 'VEEVEE_KLING': '1', 'VEEVEE_MAGNIFIC_UPSCALE': '1'})
        self.assertEqual(both['VEEVEE_PROVIDER_MEDIA_HOSTS'],
                         'cdn.example,cdn-magnific.freepik.com,ai-statics.magnific.com,h1.inkwai.com,cdn.klingai.com')
        self.assertNotIn('KLING_API', both, 'switched on without a key: Kling jobs fail as not configured, nothing else changes')
        for host in ('http://api.klingai.com', 'https://evil.example', 'https://api.klingai.com.evil.example', 'https://klingai.com',
                     'https://api.klingai.com:8443', 'https://api.klingai.com/v2', 'https://user@api.klingai.com'):
            for component in ('api', 'generation'):
                with self.subTest(host=host, component=component), self.assertRaises(self.legacy.LegacyConfigError):
                    self.legacy.translate(component, {**envs[component], 'VEEVEE_KLING': '1', 'KLING_API_HOST': host})

    def test_kling_result_hosts_pass_the_provider_media_fetcher(self):
        import socket
        from apps.integrations.remote import UnsafeMediaURL, validated_target
        public = lambda host, port, type=None: [(socket.AF_INET, socket.SOCK_STREAM, 6, '', ('1.1.1.1', 443))]
        hosts = self.legacy.translate('generation', {**self.worker_env('generation'), 'VEEVEE_KLING': '1'})['VEEVEE_PROVIDER_MEDIA_HOSTS'].split(',')
        # Kling's documented result URL shape; signed query strings are kept.
        for url in ('https://h1.inkwai.com/bs2/upload-ylab-stunt/1fa0ac67d8ce6cd55b50d68b967b3a59.png',
                    'https://cdn.klingai.com/bs2/upload-kling-api/0923471513/image/a-0.png?x-kcdn-sig=t'):
            self.assertEqual(validated_target(url, hosts, public)[0], url.split('/')[2])
        for url in ('https://h2.inkwai.com/x.png', 'https://p1-kling.klingai.com/x.png', 'http://h1.inkwai.com/x.png'):
            with self.subTest(url=url), self.assertRaises(UnsafeMediaURL):
                validated_target(url, hosts, public)

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

    def test_managed_portraits_flag_and_worker_credentials(self):
        import json
        portrait = {'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION': json.dumps({'read_environment': {'BYTEPLUS_ACCESS_KEY_ID': 'k', 'BYTEPLUS_SECRET_ACCESS_KEY': 's'}})}
        self.assertNotIn('VEEVEE_MANAGED_PORTRAITS', self.legacy.translate('api', self.api_env()), 'off unless the variable is set')
        self.assertNotIn('BYTEPLUS_ACCESS_KEY_ID', self.legacy.translate('generation', self.worker_env('generation')))
        on = {'VEEVEE_MANAGED_PORTRAITS': '1'}
        self.assertEqual(self.legacy.translate('api', {**self.api_env(), **on})['VEEVEE_MANAGED_PORTRAITS'], '1')
        for kind in ('generation', 'scheduler'):
            out = self.legacy.translate(kind, {**self.worker_env(kind), **on, **portrait})
            self.assertEqual((out['VEEVEE_MANAGED_PORTRAITS'], out['BYTEPLUS_ACCESS_KEY_ID']), ('1', 'k'), kind)
            self.assertFalse(any(key.startswith('GOAL4_') for key in out))
            with self.subTest(kind=kind), self.assertRaises(SystemExit):
                self.legacy.translate(kind, {**self.worker_env(kind), **on})     # flag without credentials: refuse
        export = self.legacy.translate('export', {**self.worker_env('export'), **on, **portrait})
        self.assertNotIn('VEEVEE_MANAGED_PORTRAITS', export)
        self.assertNotIn('BYTEPLUS_ACCESS_KEY_ID', export)
        api_without = {key: value for key, value in self.api_env().items() if key != 'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION'}
        with self.assertRaises(SystemExit):
            self.legacy.translate('api', {**api_without, **on})

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
