"""The Gemini API / Vertex AI switch (``google_genai``): endpoints, host pins, and Application Default Credentials tokens."""
from unittest.mock import patch

from django.test import SimpleTestCase

from . import google_genai
from .errors import ProviderError

VERTEX = {'GOOGLE_GENAI_BACKEND': 'vertex', 'GCP_PROJECT_ID': 'veevee-project'}
TARGET = 'veevee-vertex@veevee-project.iam.gserviceaccount.com'
ROOT = 'https://aiplatform.googleapis.com/v1/projects/veevee-project/locations/global/publishers/google/models'


class FakeCredentials:
    """A google-auth credential: ``refresh`` mints the next token, or raises when told to."""
    made = []

    def __init__(self, source=None, **options):
        self.source, self.options, self.token, self.valid, self.refreshes, self.fail = source, options, None, False, 0, None
        FakeCredentials.made.append(self)

    def refresh(self, request):
        if self.fail:
            raise self.fail
        self.refreshes += 1
        self.token, self.valid = f'token-{self.refreshes}', True


class GoogleGenaiTests(SimpleTestCase):
    def setUp(self):
        google_genai._credentials.clear()
        FakeCredentials.made = []
        self.default_calls = []

        def default(scopes):
            self.default_calls.append(scopes)
            return FakeCredentials(), 'adc-project'
        for target, replacement in (('google.auth.default', default),
                                    ('google.auth.impersonated_credentials.Credentials', FakeCredentials)):
            patcher = patch(target, replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.addCleanup(google_genai._credentials.clear)

    def test_unset_and_gemini_keep_the_gemini_api_and_its_key(self):
        for env in ({'GOOGLE_API_KEY': 'gk'}, {'GOOGLE_API_KEY': 'gk', 'GOOGLE_GENAI_BACKEND': ''},
                    {'GOOGLE_API_KEY': 'gk', 'GOOGLE_GENAI_BACKEND': 'gemini', 'GCP_PROJECT_ID': 'veevee-project',
                     'GOOGLE_VERTEX_LOCATION': 'us-central1'}):
            with self.subTest(env=env):
                self.assertFalse(google_genai.is_vertex(env))
                self.assertEqual(google_genai.host(env), 'generativelanguage.googleapis.com')
                self.assertEqual(google_genai.hosts(env), ['generativelanguage.googleapis.com'])
                self.assertEqual(google_genai.model_url('gemini-3-pro-image', env=env),
                                 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent')
                self.assertEqual(google_genai.auth_headers(env), {'x-goog-api-key': 'gk'})
                self.assertEqual(google_genai.vertex_default(env, 'gemini-2.5-flash'), 'gemini-2.5-flash')
                self.assertEqual(google_genai.credential_name(env), 'GOOGLE_API_KEY')
        with self.assertRaisesMessage(ProviderError, 'GOOGLE_API_KEY is not set.'):
            google_genai.auth_headers({})
        with self.assertRaisesMessage(ProviderError, 'custom refusal'):
            google_genai.auth_headers({'GOOGLE_API_KEY': '[SENSITIVE]'}, 'custom refusal')
        self.assertFalse(google_genai.configured({'GOOGLE_API_KEY': ''}))
        self.assertEqual((self.default_calls, FakeCredentials.made), ([], []))

    def test_an_unknown_backend_is_refused(self):
        for value in ('Vertex', 'vertexai', 'gemini-api'):
            with self.subTest(value=value), self.assertRaises(ProviderError) as raised:
                google_genai.is_vertex({'GOOGLE_GENAI_BACKEND': value})
            self.assertEqual((raised.exception.code, raised.exception.may_have_submitted), ('missing_configuration', False))

    def test_vertex_calls_the_project_global_endpoint_with_a_cached_refreshed_adc_token(self):
        self.assertTrue(google_genai.configured(VERTEX))
        self.assertEqual(google_genai.credential_name(VERTEX), 'GCP_PROJECT_ID or GOOGLE_CLOUD_PROJECT')
        self.assertEqual(google_genai.host(VERTEX), 'aiplatform.googleapis.com')
        self.assertEqual(google_genai.model_url('gemini-nano-banana-2.1', env=VERTEX), f'{ROOT}/gemini-nano-banana-2.1:generateContent')
        self.assertEqual(google_genai.vertex_default(VERTEX, 'gemini-2.5-flash'), 'gemini-3.8-flash')
        self.assertEqual(google_genai.vertex_default(VERTEX, 'gemini-pro-latest', google_genai.VERTEX_PRO), 'gemini-3.1-pro-preview')
        self.assertEqual(google_genai.auth_headers(VERTEX), {'Authorization': 'Bearer token-1'})
        self.assertEqual(google_genai.auth_headers(VERTEX), {'Authorization': 'Bearer token-1'})   # cached, not re-minted
        self.assertEqual(self.default_calls, [['https://www.googleapis.com/auth/cloud-platform']])
        (credentials,) = FakeCredentials.made
        credentials.valid = False                                                                 # expiring: refreshed in place
        self.assertEqual(google_genai.auth_headers(VERTEX), {'Authorization': 'Bearer token-2'})
        self.assertEqual((len(self.default_calls), len(FakeCredentials.made)), (1, 1))
        # GOOGLE_CLOUD_PROJECT stands in for GCP_PROJECT_ID; the ADC file's own project is never used.
        cloud = {'GOOGLE_GENAI_BACKEND': 'vertex', 'GOOGLE_CLOUD_PROJECT': 'other-project'}
        self.assertIn('/projects/other-project/', google_genai.model_url('gemini-3.8-flash', env=cloud))
        self.assertIn('/projects/veevee-project/', google_genai.model_url('gemini-3.8-flash', env={**VERTEX, **cloud}))

    def test_an_impersonation_target_mints_its_own_token_from_the_adc_identity(self):
        env = {**VERTEX, 'GOOGLE_VERTEX_IMPERSONATE_SA': TARGET}
        self.assertEqual(google_genai.auth_headers(env), {'Authorization': 'Bearer token-1'})
        source, impersonated = FakeCredentials.made
        self.assertIs(impersonated.source, None)
        self.assertEqual(impersonated.options, {'source_credentials': source, 'target_principal': TARGET,
                                                'target_scopes': ['https://www.googleapis.com/auth/cloud-platform'], 'lifetime': 3600})
        self.assertEqual((source.refreshes, impersonated.refreshes), (0, 1))
        self.assertEqual(google_genai.auth_headers(env), {'Authorization': 'Bearer token-1'})
        self.assertEqual(len(FakeCredentials.made), 2)
        for value in ('not-an-email', 'someone@example.com', f'{TARGET}/../x'):
            with self.subTest(value=value), self.assertRaisesMessage(ProviderError, 'GOOGLE_VERTEX_IMPERSONATE_SA is not a service account email.'):
                google_genai.auth_headers({**VERTEX, 'GOOGLE_VERTEX_IMPERSONATE_SA': value})
        self.assertEqual(len(FakeCredentials.made), 2)

    def test_a_region_moves_every_call_but_the_global_only_image_models(self):
        regional = {**VERTEX, 'GOOGLE_VERTEX_LOCATION': 'us-central1'}
        self.assertEqual(google_genai.model_url('gemini-3.8-flash', env=regional),
                         'https://us-central1-aiplatform.googleapis.com/v1/projects/veevee-project/locations/us-central1/publishers/'
                         'google/models/gemini-3.8-flash:generateContent')
        for model in ('gemini-3-pro-image', 'gemini-nano-banana-2.1'):
            self.assertEqual(google_genai.model_url(model, env=regional), f'{ROOT}/{model}:generateContent')
            self.assertEqual(google_genai.host(regional, model), 'aiplatform.googleapis.com')
        self.assertEqual(google_genai.host(regional), 'us-central1-aiplatform.googleapis.com')
        self.assertEqual(google_genai.host(regional, 'gemini-3.8-flash'), 'us-central1-aiplatform.googleapis.com')
        self.assertEqual(google_genai.hosts(regional), ['aiplatform.googleapis.com', 'us-central1-aiplatform.googleapis.com'])
        self.assertEqual(google_genai.hosts(VERTEX), ['aiplatform.googleapis.com'])
        for value in ('US-CENTRAL1', 'us-central1.evil.example', 'us central1'):
            with self.subTest(value=value), self.assertRaisesMessage(ProviderError, 'GOOGLE_VERTEX_LOCATION is not a Google Cloud region.'):
                google_genai.auth_headers({**VERTEX, 'GOOGLE_VERTEX_LOCATION': value})
        self.assertEqual(FakeCredentials.made, [])

    def test_vertex_without_a_usable_project_refuses_before_loading_credentials(self):
        bare = {'GOOGLE_GENAI_BACKEND': 'vertex', 'GOOGLE_API_KEY': 'gk'}
        self.assertFalse(google_genai.configured(bare))
        for env, message in ((bare, google_genai.VERTEX_MISSING),
                             ({**bare, 'GCP_PROJECT_ID': 'x/../../evil'}, 'The Vertex AI project is not a Google Cloud project id.')):
            for call in (lambda: google_genai.auth_headers(env, 'ignored on Vertex'), lambda: google_genai.model_url('m', env=env)):
                with self.subTest(message=message), self.assertRaises(ProviderError) as raised:
                    call()
                self.assertEqual((str(raised.exception), raised.exception.may_have_submitted), (message, False))
        self.assertEqual((self.default_calls, FakeCredentials.made), ([], []))

    def test_unavailable_credentials_or_a_failed_mint_say_only_that(self):
        with patch('google.auth.default', side_effect=RuntimeError('no ADC at /secret/path')), \
                self.assertLogs('apps.integrations.google_genai', 'WARNING') as logs, self.assertRaises(ProviderError) as raised:
            google_genai.auth_headers(VERTEX)
        self.assertEqual((str(raised.exception), raised.exception.code, raised.exception.may_have_submitted),
                         ('Vertex AI could not load Application Default Credentials.', 'vertex_auth', False))
        self.assertEqual(logs.output, ['WARNING:apps.integrations.google_genai:vertex_credentials_unavailable error_type=RuntimeError'])
        google_genai.auth_headers(VERTEX)
        (credentials,) = FakeCredentials.made
        credentials.valid, credentials.fail = False, RuntimeError('invalid_grant for private-key-material')
        with self.assertLogs('apps.integrations.google_genai', 'WARNING') as logs, self.assertRaises(ProviderError) as raised:
            google_genai.auth_headers(VERTEX)
        self.assertEqual((str(raised.exception), raised.exception.code, raised.exception.may_have_submitted),
                         ('Vertex AI access token could not be minted.', 'vertex_auth', False))
        self.assertIsNone(raised.exception.__cause__)
        self.assertEqual(logs.output, ['WARNING:apps.integrations.google_genai:vertex_token_refresh_failed error_type=RuntimeError'])
