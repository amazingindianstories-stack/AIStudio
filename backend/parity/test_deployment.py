"""Component environment translations and dispatch at unchanged deploy seams."""
import base64
import hashlib
import json
import os
from unittest.mock import patch

from django.test import SimpleTestCase
from deploy import entrypoint, legacy_config


class ComponentDeploymentParityTests(SimpleTestCase):
    def fixture(self, component):
        ca = b'parity fixture certificate'
        common = {'database': 'railway', 'database_password': 'fake-password',
            'ca_base64': base64.b64encode(ca).decode(), 'adc': {'client_email': 'fixture@example.invalid'},
            'media_prefix': 'parity-fixture-only/', 'django_secret': 'd' * 64, 'auth_secret': 'a' * 64,
            'new_exports': True}
        if component == 'api':
            cfg = {**common, 'role': legacy_config.API_ROLE, 'ingress_secret': 'i' * 64}
            key = legacy_config.API_VARIABLE
        else:
            cfg = {**common, 'kind': component, 'role': 'goal4_parity_worker',
                'historical_replay_authorized': False, 'paid_providers_authorized': False,
                'browser_origin': 'https://fixture.invalid', 'lease_prefix': 'lease:g4preview:fixture:',
                'naming_prefix': 'g4preview:fixture:', 'provider_media_hosts': ['fixture.invalid'],
                'rls_tables': [], 'hidden_job_contracts': {}}
            key = legacy_config.WORKER_VARIABLE
        env = {key: json.dumps(cfg), 'GOAL4_PREVIEW_BROWSER_ORIGINS': 'https://fixture.invalid',
            'GOAL4_PREVIEW_APP_ORIGIN': 'https://fixture.invalid', 'VEEVEE_MAGNIFIC_UPSCALE': '1',
            'VEEVEE_KLING': '1', 'VEEVEE_GEMINI_OMNI': '1', 'VEEVEE_MANAGED_PORTRAITS': '1',
            'MAGNIFIC_API_KEY': 'fixture', 'KLING_API': 'fixture',
            'GOAL4_PREVIEW_PORTRAIT_CONFIGURATION': json.dumps({'read_environment': {
                'BYTEPLUS_ACCESS_KEY_ID': 'fixture', 'BYTEPLUS_SECRET_ACCESS_KEY': 'fixture'}}),
            'UNRELATED_SECRET': 'must-be-dropped'}
        return ca, env

    def test_fixed_fake_environment_effective_flags_for_every_component(self):
        for component in ('api', 'generation', 'export', 'scheduler'):
            with self.subTest(component=component):
                ca, env = self.fixture(component)
                with patch.object(legacy_config, 'CA_SHA256', hashlib.sha256(ca).hexdigest()):
                    out = legacy_config.translate(component, env)
                self.assertTrue(legacy_config.present(env))
                self.assertFalse(legacy_config.present({**env, 'DATABASE_URL': 'fixture'}))
                self.assertEqual({k: out[k] for k in ('LOCAL_DATA_MODE', 'MOCK_GENERATION',
                    'MOCK_ASSET_PROVIDER', 'VEEVEE_EXPORT_ADMISSION', 'VEEVEE_MAGNIFIC_UPSCALE',
                    'VEEVEE_KLING', 'VEEVEE_GEMINI_OMNI')}, {'LOCAL_DATA_MODE': 'fixtures',
                    'MOCK_GENERATION': '1', 'MOCK_ASSET_PROVIDER': '1', 'VEEVEE_EXPORT_ADMISSION': '1',
                    'VEEVEE_MAGNIFIC_UPSCALE': '1', 'VEEVEE_KLING': '1', 'VEEVEE_GEMINI_OMNI': '1'})
                self.assertEqual('VEEVEE_MANAGED_PORTRAITS' in out, component != 'export')
                self.assertEqual('VEEVEE_PORTRAIT_LIFECYCLE' in out, component == 'api')
                self.assertEqual('KLING_API' in out, component == 'generation')
                self.assertEqual('VEEVEE_NAMING_PREFIX' in out, component != 'api')
                self.assertEqual('VEEVEE_LEASE_PREFIX' in out, component != 'api')
                self.assertNotIn('UNRELATED_SECRET', out)
                self.assertFalse(any(k.startswith('GOAL4_') for k in out))
                if component != 'api':
                    self.assertEqual(out['VEEVEE_LEASE_PREFIX'], 'lease:g4preview:fixture:')
                    self.assertEqual(out['VEEVEE_NAMING_PREFIX'], 'g4preview:fixture:')
                    self.assertEqual(legacy_config.preflight_contract(component, env), {
                        'role': 'goal4_parity_worker', 'rls_tables': [], 'hidden_job_contracts': {}})

    def test_entrypoint_sets_component_before_dispatch(self):
        for component in ('api', 'generation', 'export', 'scheduler'):
            with self.subTest(component=component), patch.dict(os.environ, {'DATABASE_URL': 'fixture'}, clear=True), \
                 patch.object(entrypoint, 'prepare_environment', side_effect=lambda env: dict(env)), \
                 patch.object(entrypoint, 'run_api', return_value=17) as api, \
                 patch.object(entrypoint, 'run_worker', return_value=18) as worker:
                self.assertEqual(entrypoint.main(['entrypoint', component]), 17 if component == 'api' else 18)
                if component == 'api':
                    self.assertEqual(api.call_args.args[0]['VEEVEE_RUNTIME_COMPONENT'], component)
                    worker.assert_not_called()
                else:
                    self.assertEqual(worker.call_args.args, (component, {
                        'DATABASE_URL': 'fixture', 'VEEVEE_RUNTIME_COMPONENT': component}))
                    api.assert_not_called()

    def test_worker_commands_and_arguments_are_unchanged(self):
        self.assertEqual(entrypoint.WORKER_COMMANDS, {
            'generation': ['generation_worker', '--concurrency', '1', '--interval', '2'],
            'export': ['media_export_worker', '--interval', '2'], 'scheduler': ['run_scheduler']})
        for args in ([], ['entrypoint'], ['entrypoint', 'unknown']):
            with self.assertRaisesRegex(SystemExit, 'usage: python -m deploy.entrypoint'):
                entrypoint.main(args)

    def test_paid_translation_drops_authorization_and_preserves_feature_switches(self):
        for component in ('api', 'generation', 'scheduler'):
            ca, env = self.fixture(component)
            key = legacy_config.API_VARIABLE if component == 'api' else legacy_config.WORKER_VARIABLE
            cfg = json.loads(env[key])
            cfg['paid'] = {'configuration': {'approved_scope': 'fixture-scope',
                'unlimited_new_jobs': True, 'authorization': {'private': 'fixture'}},
                'provider_environment': {'ARK_API_KEY': 'fake', 'GOOGLE_API_KEY': 'fake'}}
            if component != 'api':
                cfg['paid_providers_authorized'] = True
            env[key] = json.dumps(cfg)
            with patch.object(legacy_config, 'CA_SHA256', hashlib.sha256(ca).hexdigest()):
                out = legacy_config.translate(component, env)
            self.assertEqual(json.loads(out['VEEVEE_PAID_GUARD']), {
                'approved_scope': 'fixture-scope', 'unlimited_new_jobs': True})
            self.assertEqual((out['MOCK_GENERATION'], out['MOCK_ASSET_PROVIDER']), ('0', '0'))
            self.assertTrue({'ARK_API_KEY', 'GOOGLE_API_KEY'} <= out.keys())

    def test_preflight_identity_tls_migration_count_and_privilege_refusals(self):
        from unittest.mock import MagicMock
        for count in (60, 61, 62):
            db = MagicMock()
            db.__enter__.return_value = db
            db.execute.return_value.fetchone.side_effect = [
                ('railway', 'fixture-role', legacy_config.SYSTEM_IDENTIFIER), (True,), (count,)]
            legacy_config.preflight('fixture-dsn', {'role': 'fixture-role'}, connect=lambda _: db)
        for rows, message in (([('other', 'fixture-role', legacy_config.SYSTEM_IDENTIFIER)], 'database identity'),
                ([('railway', 'fixture-role', legacy_config.SYSTEM_IDENTIFIER), (False,)], 'database connection is not TLS'),
                ([('railway', 'fixture-role', legacy_config.SYSTEM_IDENTIFIER), (True,), (999,)], 'migration history'),
                ([('railway', 'fixture-role', legacy_config.SYSTEM_IDENTIFIER), (True,), (62,), (True, False, False, False, False, False)], 'worker role has elevated privileges')):
            db = MagicMock()
            db.__enter__.return_value = db
            db.execute.return_value.fetchone.side_effect = rows
            with self.assertRaisesRegex(legacy_config.LegacyConfigError, message):
                legacy_config.preflight('fixture-dsn', {'role': 'fixture-role', 'rls_tables': [],
                    'hidden_job_contracts': {}}, connect=lambda _: db)

    def test_api_supervision_loop_starts_wsgi_and_gateway_with_effective_flags(self):
        import io
        children = []
        class Child:
            def __init__(self, args, **kwargs):
                self.args, self.kwargs, self.stdin = args, kwargs, io.BytesIO()
                self.returncode = None
                children.append(self)
            def poll(self):
                return self.returncode
            def terminate(self):
                self.returncode = 0
            def wait(self):
                return self.returncode
        # Preserve the private-stdin bytes after run_api closes the handle.
        class Input(io.BytesIO):
            def close(self):
                self.captured = self.getvalue()
                super().close()
        def spawn(*args, **kwargs):
            child = Child(*args, **kwargs)
            child.stdin = Input()
            return child
        def child_exits():
            children[0].returncode = 1
            return (1, 1)
        env = {'VEEVEE_INGRESS_SECRET': 's' * 64, 'VEEVEE_PAID_GUARD': '{}',
            'VEEVEE_EXPORT_ADMISSION': '1', 'VEEVEE_MAGNIFIC_UPSCALE': '1', 'PATH': '/usr/bin'}
        with patch.object(entrypoint.subprocess, 'Popen', spawn), patch.object(entrypoint.signal, 'signal'), \
             patch.object(entrypoint.os, 'wait', side_effect=child_exits) as wait:
            self.assertEqual(entrypoint.run_api(env), 1)
        wait.assert_called_once()
        self.assertEqual(children[0].args[1:4], ['-m', 'gunicorn', 'config.wsgi:application'])
        self.assertEqual(children[0].kwargs['env']['VEEVEE_API_THREADS'], '8')
        self.assertNotIn('VEEVEE_INGRESS_SECRET', children[0].kwargs['env'])
        self.assertEqual(children[1].kwargs['env'], {'PATH': '/usr/bin'})
        self.assertEqual(json.loads(children[1].stdin.captured), {'secret': 's' * 64, 'port': 18081,
            'paid_initial_routes': True, 'new_exports': True, 'magnific_upscale': True})
        self.assertEqual(children[1].returncode, 0)
