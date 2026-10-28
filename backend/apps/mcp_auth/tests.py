"""Agent access: personal access tokens, the OAuth 2.1 server, the bearer principal and the spending controls."""
import base64
import hashlib
import json
import secrets
import threading
import uuid
from unittest.mock import patch
from urllib.parse import parse_qs, urlencode, urlsplit

from django.db import connection, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase, override_settings

from apps.admin_dashboard.models import AppSetting, UserLimit
from apps.authentication.models import User
from apps.authentication.password import hash_password
from apps.authentication.session import sign_session
from apps.common.models import ActivityLog
from apps.generation.models import Generation
from . import clients, controls, policy, tokens
from .models import McpAuthCode, McpClient, McpRateWindow, McpToken
from .principal import AgentAccessDisabled, AuthenticationError, InsufficientScope, authenticate_bearer, challenge

SITE = 'https://veevee.test'
RESOURCE = SITE + '/mcp'
LOOPBACK = 'http://127.0.0.1:33418/callback'
CLAUDE_CODE_CIMD = 'https://claude.ai/oauth/claude-code-client-metadata'
CHATGPT_CIMD = 'https://chatgpt.com/oauth/client.json'
# Shapes of the published Claude Code and ChatGPT client metadata documents (fixtures; no network).
CIMD_FIXTURES = {
    CLAUDE_CODE_CIMD: {'client_id': CLAUDE_CODE_CIMD, 'client_name': 'Claude Code', 'client_uri': 'https://claude.ai',
                       'redirect_uris': ['http://localhost/callback', 'http://127.0.0.1/callback'],
                       'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'],
                       'token_endpoint_auth_method': 'none'},
    CHATGPT_CIMD: {'client_id': CHATGPT_CIMD, 'client_name': 'ChatGPT', 'client_uri': 'https://chatgpt.com',
                   'logo_uri': 'https://chatgpt.com/favicon.ico',
                   'redirect_uris': ['https://chatgpt.com/connector_platform_oauth_redirect'],
                   'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'],
                   'token_endpoint_auth_method': 'none'},
}


def fixture_fetch(url):
    return json.dumps(CIMD_FIXTURES[url]).encode()


def pkce_pair():
    verifier = secrets.token_urlsafe(48)
    return verifier, base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')


@override_settings(PUBLIC_APP_URL=SITE, VEEVEE_BROWSER_ORIGINS=(SITE,))
class AgentAccessCase(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        credentials = hash_password('fixture-password')
        self.user = User.objects.create(id=uuid.uuid4(), email='artist@example.invalid', name='Artist', role='user',
            password_hash=credentials['hash'], password_salt=credentials['salt'], created_at=1, auth_version=3)
        self.admin = User.objects.create(id=uuid.uuid4(), email='admin@example.invalid', name='Admin', role='admin',
            password_hash=credentials['hash'], password_salt=credentials['salt'], created_at=1, auth_version=0)

    def enable(self, user=None):
        policy.set_enabled((user or self.user).id, True, 1)

    def sign_in(self, user=None):
        self.client.cookies['veevee_session'] = sign_session(user or self.user)

    def post_json(self, path, data, **headers):
        return self.client.post(path, json.dumps(data), content_type='application/json', **headers)

    def create_pat(self, **overrides):
        body = {'name': 'Claude Code laptop', 'scopes': ['veevee.read', 'veevee.generate'], 'expiresInDays': 90,
                'dailyCapCents': 1000, 'autoApproveCents': 25, **overrides}
        return self.post_json('/api/mcp/tokens', body)


class PersonalAccessTokenTests(AgentAccessCase):
    def test_access_is_opt_in_and_a_token_is_shown_once_and_stored_hashed(self):
        self.sign_in()
        self.assertEqual(self.client.get('/api/mcp/tokens').json()['access']['enabled'], False)
        refused = self.create_pat()
        self.assertEqual((refused.status_code, refused.json()['code']), (403, 'MCP_DISABLED'))
        self.enable()
        response = self.create_pat()
        self.assertEqual(response.status_code, 201)
        raw = response.json()['token']
        self.assertTrue(raw.startswith('vv_pat_') and len(raw) > 40)
        row = McpToken.objects.get()
        self.assertEqual(row.token_hash, hashlib.sha256(raw.encode()).hexdigest())
        self.assertEqual(row.family_id, row.id)
        self.assertEqual(row.resource, RESOURCE)
        self.assertNotIn(raw, json.dumps(list(McpToken.objects.values())[0], default=str))
        listed = self.client.get('/api/mcp/tokens').json()
        self.assertNotIn(raw, json.dumps(listed))
        self.assertEqual([(item['name'], item['hint'], item['scopes']) for item in listed['tokens']],
                         [('Claude Code laptop', 'vv_pat_…' + raw[-4:], ['veevee.read', 'veevee.generate'])])
        self.assertEqual(listed['access']['userDailyCapCents'], 2000)
        self.assertTrue(ActivityLog.objects.filter(action='mcp_token_issued', user_id=self.user.id).exists())
        self.assertNotIn(raw, json.dumps(list(ActivityLog.objects.values('detail'))))

    def test_validation_of_name_scopes_expiry_and_caps(self):
        self.enable()
        self.sign_in()
        for overrides, message in [({'name': ' '}, 'name'), ({'scopes': []}, 'permission'), ({'scopes': ['veevee.admin']}, 'permission'),
                                   ({'expiresInDays': 366}, 'expiry'), ({'dailyCapCents': 2001}, 'daily limit'),
                                   ({'dailyCapCents': 0}, 'daily limit'), ({'autoApproveCents': 101}, 'auto-approve'),
                                   ({'autoApproveCents': 2.5}, 'auto-approve')]:
            with self.subTest(overrides=overrides):
                response = self.create_pat(**overrides)
                self.assertEqual(response.status_code, 400)
                self.assertIn(message, response.json()['error'])
        UserLimit.objects.create(user_id=self.user.id, key='mcpDailyCapCents', value='5000', updated_at=1)
        self.assertEqual(self.create_pat(dailyCapCents=5000).status_code, 201)
        self.assertEqual(McpToken.objects.count(), 1)

    def test_revoke_and_password_change_end_every_token(self):
        self.enable()
        self.sign_in()
        first = self.create_pat().json()['token']
        second = self.create_pat(name='Cursor').json()['token']
        self.assertEqual(authenticate_bearer('Bearer ' + first).user.id, self.user.id)
        identifier = McpToken.objects.get(token_hash=tokens.digest(first)).id
        self.assertEqual(self.client.delete(f'/api/mcp/tokens/{identifier}').status_code, 200)
        self.assertEqual(self.client.delete(f'/api/mcp/tokens/{identifier}').status_code, 404)
        with self.assertRaises(AuthenticationError):
            authenticate_bearer('Bearer ' + first)
        authenticate_bearer('Bearer ' + second)
        response = self.client.generic('PATCH', '/api/auth/password', json.dumps({'currentPassword': 'fixture-password',
                                       'newPassword': 'another-fixture-password'}), content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(McpToken.objects.filter(revoked_at__isnull=True).exists())
        with self.assertRaises(AuthenticationError):
            authenticate_bearer('Bearer ' + second)
        self.client.cookies['veevee_session'] = response.cookies['veevee_session'].value
        self.assertEqual(self.client.get('/api/mcp/tokens').json()['tokens'], [])

    def test_another_users_token_cannot_be_revoked(self):
        self.enable()
        self.enable(self.admin)
        self.sign_in(self.admin)
        self.create_pat()
        identifier = McpToken.objects.get().id
        self.sign_in()
        self.assertEqual(self.client.delete(f'/api/mcp/tokens/{identifier}').status_code, 404)
        self.assertIsNone(McpToken.objects.get().revoked_at)


class PrincipalTests(AgentAccessCase):
    def issue(self, kind='pat', revoked_at=None, **overrides):
        values = {'scopes': ['veevee.read', 'veevee.generate'], 'daily_cap_cents': 1000, 'auto_approve_cents': 25,
                  'expires_at': 10 ** 13}
        values.update(overrides)
        client = None if kind == 'pat' else McpClient.objects.create(client_id='vvc_' + uuid.uuid4().hex, kind='dcr',
            client_name='Fixture app', redirect_uris=[LOOPBACK], created_at=1)
        raw, row = tokens.issue(self.user, kind, client=client, family_id=uuid.uuid4() if client else None, **values)
        if revoked_at:
            McpToken.objects.filter(pk=row.pk).update(revoked_at=revoked_at)
        return raw, row

    def test_principal_carries_scopes_grant_and_caps(self):
        self.enable()
        raw, row = self.issue()
        principal = authenticate_bearer('Bearer ' + raw)
        self.assertEqual((principal.user.id, principal.kind, principal.token_id, principal.client_id),
                         (self.user.id, 'pat', row.id, None))
        self.assertEqual(principal.scopes, frozenset({'veevee.read', 'veevee.generate'}))
        self.assertEqual((principal.caps.token_daily_cap_cents, principal.caps.auto_approve_cents, principal.caps.user_daily_cap_cents,
                          principal.caps.active_jobs, principal.caps.confirm_at_cents), (1000, 25, 2000, 4, 100))
        self.assertEqual(principal.origin_fields(), {'created_via': 'mcp', 'mcp_token_id': row.id, 'mcp_client_id': None})
        with self.assertRaises(InsufficientScope) as refused:
            principal.require('veevee.organize')
        self.assertEqual(refused.exception.status, 403)
        self.assertIn('scope="veevee.organize"', refused.exception.www_authenticate())
        access, access_row = self.issue('access')
        oauth_principal = authenticate_bearer(access)
        self.assertEqual((oauth_principal.kind, oauth_principal.token_id, oauth_principal.client_id),
                         ('oauth', access_row.family_id, access_row.client_id))

    def test_every_invalid_token_is_refused(self):
        self.enable()
        cases = {'revoked': self.issue(revoked_at=5)[0], 'expired': self.issue(expires_at=10)[0],
                 'refresh token': self.issue('refresh')[0]}
        raw, row = self.issue()
        McpToken.objects.filter(pk=row.pk).update(resource='https://other.example/mcp')
        cases['other audience'] = raw
        cases['unknown'] = 'vv_pat_' + 'x' * 43
        for name, raw in cases.items():
            with self.subTest(name=name), self.assertRaises(AuthenticationError) as refused:
                authenticate_bearer('Bearer ' + raw, now=1000)
            self.assertEqual(refused.exception.error, 'invalid_token')
        for header in ('Basic abc', 'Bearer', 'Bearer two words', 'Bearer ' + 'x' * 300):
            with self.subTest(header=header), self.assertRaises(AuthenticationError):
                authenticate_bearer(header)
        with self.assertRaises(AuthenticationError) as missing:
            authenticate_bearer(None)
        self.assertIsNone(missing.exception.error)

    def test_account_changes_and_opt_out_end_access(self):
        raw, _ = self.issue()
        with self.assertRaises(AgentAccessDisabled):
            authenticate_bearer(raw)
        self.enable()
        authenticate_bearer(raw)
        User.objects.filter(pk=self.user.pk).update(is_active=False)
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(raw)
        User.objects.filter(pk=self.user.pk).update(is_active=True, auth_version=4)
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(raw)

    def test_admin_scope_needs_the_admin_role_and_last_use_is_recorded_once_a_minute(self):
        self.enable()
        raw, row = self.issue(scopes=['veevee.read', 'veevee.admin'])
        self.assertEqual(authenticate_bearer(raw, now=1_000_000).scopes, frozenset({'veevee.read'}))
        self.assertEqual(McpToken.objects.get(pk=row.pk).last_used_at, 1_000_000)
        authenticate_bearer(raw, now=1_030_000)
        self.assertEqual(McpToken.objects.get(pk=row.pk).last_used_at, 1_000_000)
        authenticate_bearer(raw, now=1_060_000)
        self.assertEqual(McpToken.objects.get(pk=row.pk).last_used_at, 1_060_000)

    def test_bearer_endpoint_answers_challenges_with_resource_metadata_and_scope(self):
        self.enable()
        missing = self.client.get('/api/mcp/me')
        self.assertEqual(missing.status_code, 401)
        self.assertEqual(missing['WWW-Authenticate'], f'Bearer resource_metadata="{SITE}/.well-known/oauth-protected-resource/mcp", '
                                                      'scope="veevee.read veevee.generate"')
        invalid = self.client.get('/api/mcp/me', HTTP_AUTHORIZATION='Bearer vv_pat_unknown')
        self.assertEqual(invalid.status_code, 401)
        self.assertIn('error="invalid_token"', invalid['WWW-Authenticate'])
        self.assertIn('resource_metadata=', invalid['WWW-Authenticate'])
        raw, _ = self.issue(scopes=['veevee.generate'])
        under_scoped = self.client.get('/api/mcp/me', HTTP_AUTHORIZATION='Bearer ' + raw)
        self.assertEqual(under_scoped.status_code, 403)
        self.assertEqual(under_scoped['WWW-Authenticate'], f'Bearer resource_metadata="{SITE}/.well-known/oauth-protected-resource/mcp", '
            'scope="veevee.read", error="insufficient_scope", error_description="This call needs the veevee.read scope."')
        raw, _ = self.issue()
        me = self.client.get('/api/mcp/me', HTTP_AUTHORIZATION='Bearer ' + raw)
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()['user']['email'], 'artist@example.invalid')
        UserLimit.objects.filter(user_id=self.user.id, key='mcpEnabled').delete()
        disabled = self.client.get('/api/mcp/me', HTTP_AUTHORIZATION='Bearer ' + raw)
        self.assertEqual((disabled.status_code, disabled.json()['code']), (403, 'MCP_DISABLED'))
        self.assertNotIn('WWW-Authenticate', disabled)

    def test_challenge_quotes_values(self):
        self.assertEqual(challenge('invalid_token', 'bad "token"', 'veevee.read'),
                         f'Bearer resource_metadata="{SITE}/.well-known/oauth-protected-resource/mcp", scope="veevee.read", '
                         'error="invalid_token", error_description="bad \\"token\\""')


class DiscoveryAndRegistrationTests(AgentAccessCase):
    def test_metadata_documents(self):
        server = self.client.get('/api/oauth/authorization-server')
        self.assertEqual(server['Access-Control-Allow-Origin'], '*')
        document = server.json()
        self.assertEqual(document['issuer'], SITE)
        self.assertEqual(document['authorization_endpoint'], SITE + '/oauth/authorize')
        self.assertEqual(document['token_endpoint'], SITE + '/api/oauth/token')
        self.assertEqual(document['code_challenge_methods_supported'], ['S256'])
        self.assertEqual(document['token_endpoint_auth_methods_supported'], ['none'])
        self.assertTrue(document['client_id_metadata_document_supported'])
        self.assertTrue(document['authorization_response_iss_parameter_supported'])
        self.assertNotIn('offline_access', document['scopes_supported'])
        resource = self.client.get('/api/oauth/protected-resource').json()
        self.assertEqual(resource, {'resource': RESOURCE, 'authorization_servers': [SITE], 'resource_name': 'Veevee',
                                    'scopes_supported': ['veevee.read', 'veevee.generate', 'veevee.organize', 'veevee.admin'],
                                    'bearer_methods_supported': ['header']})
        preflight = self.client.options('/api/oauth/token', HTTP_ORIGIN='http://localhost:6274')
        self.assertEqual((preflight.status_code, preflight['Access-Control-Allow-Origin']), (204, '*'))
        with override_settings(PUBLIC_APP_URL=''):
            self.assertEqual(self.client.get('/api/oauth/authorization-server').status_code, 503)

    def test_dynamic_registration_accepts_https_and_loopback_redirects(self):
        for uris in ([LOOPBACK], ['http://localhost:8787/callback'], ['https://claude.ai/api/mcp/auth_callback'],
                     ['https://chatgpt.com/connector_platform_oauth_redirect'], ['https://www.cursor.com/agents/mcp/oauth/callback'],
                     ['http://127.0.0.1:33418'], ['https://vscode.dev/redirect'], ['http://[::1]:5000/cb']):
            with self.subTest(uris=uris):
                response = self.post_json('/api/oauth/register', {'client_name': 'Fixture', 'redirect_uris': uris,
                                          'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code', 'refresh_token']},
                                          HTTP_ORIGIN='http://localhost:6274', HTTP_SEC_FETCH_SITE='cross-site')
                self.assertEqual(response.status_code, 201)
                body = response.json()
                self.assertTrue(body['client_id'].startswith('vvc_'))
                self.assertEqual((body['redirect_uris'], body['token_endpoint_auth_method']), (uris, 'none'))
                self.assertEqual(response['Access-Control-Allow-Origin'], '*')

    def test_dynamic_registration_refuses_unsafe_metadata(self):
        for document in ({'redirect_uris': ['http://example.com/callback']}, {'redirect_uris': ['javascript:alert(1)']},
                         {'redirect_uris': ['http://192.168.1.2/cb']}, {'redirect_uris': ['cursor://anysphere.cursor-mcp/oauth/callback']},
                         {'redirect_uris': ['vscode://vscode.github-authentication/did-authenticate']},
                         {'redirect_uris': ['com.example.app:/cb']}, {'redirect_uris': ['myapp://callback']},
                         {'redirect_uris': [LOOPBACK, 'cursor://anysphere.cursor-mcp/oauth/callback']},
                         {'redirect_uris': ['https://example.com/cb#fragment']}, {'redirect_uris': ['data:text/html,x']},
                         {'redirect_uris': []}, {'redirect_uris': ['https://u:p@example.com/cb']},
                         {'redirect_uris': [LOOPBACK], 'token_endpoint_auth_method': 'client_secret_basic'},
                         {'redirect_uris': [LOOPBACK], 'grant_types': ['client_credentials']},
                         {'redirect_uris': [LOOPBACK], 'response_types': ['token']},
                         {'redirect_uris': [LOOPBACK], 'logo_uri': 'http://example.com/logo.png'}):
            with self.subTest(document=document):
                response = self.post_json('/api/oauth/register', document)
                self.assertEqual(response.status_code, 400)
                self.assertIn(response.json()['error'], ('invalid_redirect_uri', 'invalid_client_metadata'))
        self.assertFalse(McpClient.objects.exists())
        self.assertFalse(McpRateWindow.objects.exists())

    def test_registration_is_rate_limited_per_address_and_unused_clients_expire(self):
        body = {'redirect_uris': [LOOPBACK]}
        for _ in range(20):
            self.assertEqual(self.post_json('/api/oauth/register', body, HTTP_X_REAL_IP='203.0.113.9').status_code, 201)
        limited = self.post_json('/api/oauth/register', body, HTTP_X_REAL_IP='203.0.113.9')
        self.assertEqual(limited.status_code, 429)
        self.assertTrue(int(limited['Retry-After']) > 0)
        self.assertEqual(self.post_json('/api/oauth/register', body, HTTP_X_REAL_IP='203.0.113.10').status_code, 201)
        from .maintenance import purge_expired
        McpClient.objects.update(created_at=1)
        McpClient.objects.filter(pk=McpClient.objects.first().pk).update(last_authorized_at=2)
        self.assertEqual(purge_expired()['clients'], 20)
        self.assertEqual(McpClient.objects.count(), 1)

    def test_client_metadata_documents_from_fixtures(self):
        claude = clients.resolve(CLAUDE_CODE_CIMD, fetch=fixture_fetch, now=1_000)
        self.assertEqual((claude.kind, claude.client_name), ('cimd', 'Claude Code'))
        self.assertTrue(clients.redirect_matches(claude.redirect_uris, 'http://localhost:49152/callback'))
        self.assertFalse(clients.redirect_matches(claude.redirect_uris, 'http://localhost:49152/other'))
        chatgpt = clients.resolve(CHATGPT_CIMD, fetch=fixture_fetch, now=1_000)
        self.assertEqual((chatgpt.client_name, chatgpt.logo_uri), ('ChatGPT', 'https://chatgpt.com/favicon.ico'))
        calls = []
        clients.resolve(CHATGPT_CIMD, fetch=lambda url: calls.append(url), now=1_000 + clients.CIMD_CACHE_MS - 1)
        self.assertEqual(calls, [])
        refreshed = dict(CIMD_FIXTURES[CHATGPT_CIMD], client_name='ChatGPT (renamed)')
        clients.resolve(CHATGPT_CIMD, fetch=lambda url: json.dumps(refreshed).encode(), now=1_000 + clients.CIMD_CACHE_MS + 1)
        self.assertEqual(McpClient.objects.get(client_id=CHATGPT_CIMD).client_name, 'ChatGPT (renamed)')
        for document in ({**CIMD_FIXTURES[CHATGPT_CIMD], 'client_id': 'https://evil.example/client.json'},
                         {**CIMD_FIXTURES[CHATGPT_CIMD], 'token_endpoint_auth_method': 'private_key_jwt'}):
            with self.subTest(document=document), self.assertRaises(clients.ClientError):
                clients.resolve('https://apps.example/client.json', fetch=lambda url, d=document: json.dumps(d).encode())
        with self.assertRaises(clients.ClientError):
            clients.resolve('https://apps.example/broken.json', fetch=lambda url: b'not json')

    def test_metadata_fetch_refuses_private_addresses_redirects_and_oversize_documents(self):
        private = lambda host, port, **kwargs: [(2, 1, 6, '', ('10.0.0.8', 443))]
        with self.assertRaises(clients.ClientError):
            clients.fetch_document('https://apps.example/client.json', resolver=private)
        for url in ('http://apps.example/client.json', 'https://apps.example:8443/client.json', 'https://u:p@apps.example/c.json'):
            with self.subTest(url=url), self.assertRaises(clients.ClientError):
                clients.fetch_document(url, resolver=private)
        public = lambda host, port, **kwargs: [(2, 1, 6, '', ('93.184.215.14', 443))]

        class Response:
            def __init__(self, status, data):
                self.status, self.data = status, data

            def read(self, limit):
                return self.data[:limit]

        def connection_for(status, data):
            class Connection:
                def __init__(self, host, address, timeout):
                    assert (host, address) == ('apps.example', '93.184.215.14')

                def request(self, *args, **kwargs):
                    pass

                def getresponse(self):
                    return Response(status, data)

                def close(self):
                    pass
            return Connection
        self.assertEqual(clients.fetch_document('https://apps.example/client.json', resolver=public,
                                                connection=connection_for(200, b'{}')), b'{}')
        for status, data in ((302, b''), (200, b'x' * (clients.CIMD_MAX_BYTES + 1))):
            with self.subTest(status=status), self.assertRaises(clients.ClientError):
                clients.fetch_document('https://apps.example/client.json', resolver=public, connection=connection_for(status, data))


class AuthorizationFlowTests(AgentAccessCase):
    def setUp(self):
        super().setUp()
        self.enable()
        self.sign_in()
        self.app = self.post_json('/api/oauth/register', {'client_name': 'Inspector', 'redirect_uris': [LOOPBACK]}).json()
        self.verifier, self.challenge = pkce_pair()

    def authorize_params(self, **overrides):
        return {'response_type': 'code', 'client_id': self.app['client_id'], 'redirect_uri': LOOPBACK, 'state': 'opaque-state',
                'code_challenge': self.challenge, 'code_challenge_method': 'S256', 'scope': 'veevee.read veevee.generate',
                'resource': RESOURCE, **overrides}

    def consent(self, *, scopes=('veevee.read', 'veevee.generate'), cap=500, auto=10, **overrides):
        response = self.post_json('/api/oauth/authorize/decision', {'request': self.authorize_params(**overrides), 'approve': True,
                                  'scopes': list(scopes), 'dailyCapCents': cap, 'autoApproveCents': auto})
        self.assertEqual(response.status_code, 200, response.content)
        target = urlsplit(response.json()['redirectTo'])
        query = {key: values[0] for key, values in parse_qs(target.query).items()}
        self.assertEqual((target.scheme + '://' + target.netloc + target.path, query['state'], query['iss']),
                         (LOOPBACK, 'opaque-state', SITE))
        return query['code']

    def token(self, **form):
        self.client.cookies.clear()
        return self.client.post('/api/oauth/token', urlencode({'client_id': self.app['client_id'], **form}),
                                content_type='application/x-www-form-urlencoded', HTTP_ORIGIN='http://localhost:6274')

    def exchange(self, code, verifier=None):
        return self.token(grant_type='authorization_code', code=code, redirect_uri=LOOPBACK,
                          code_verifier=verifier or self.verifier, resource=RESOURCE)

    def test_consent_page_request_describes_the_client_and_choices(self):
        response = self.client.get('/api/oauth/authorize/request?' + urlencode(self.authorize_params(scope='veevee.read veevee.admin')))
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body['client']['name'], 'Inspector')
        self.assertEqual(body['client']['redirectHost'], '127.0.0.1:33418')
        self.assertEqual(body['requestedScopes'], ['veevee.read'])
        self.assertEqual([scope['id'] for scope in body['scopes']], ['veevee.read', 'veevee.generate', 'veevee.organize'])
        self.assertEqual((body['defaults'], body['userDailyCapCents'], body['autoApproveMaxCents'], body['confirmAtCents']),
                         ({'dailyCapCents': 1000, 'autoApproveCents': 25, 'expiresInDays': 90}, 2000, 100, 100))
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/oauth/authorize/request?' + urlencode(self.authorize_params())).status_code, 401)

    def test_pkce_flow_refresh_rotation_and_reuse_detection(self):
        code = self.consent()
        self.assertEqual(self.exchange(code, verifier=pkce_pair()[0]).json()['error'], 'invalid_grant')
        # A failed exchange still consumes the code.
        self.assertEqual(self.exchange(code).json()['error'], 'invalid_grant')
        self.sign_in()
        code = self.consent()
        self.assertEqual(self.token(grant_type='authorization_code', code=code, redirect_uri=LOOPBACK, code_verifier=self.verifier,
                                    resource='https://other.example/mcp').json()['error'], 'invalid_target')
        self.sign_in()
        code = self.consent(resource=RESOURCE + '/')
        issued = self.token(grant_type='authorization_code', code=code, redirect_uri=LOOPBACK, code_verifier=self.verifier,
                            resource=RESOURCE + '/')
        self.assertEqual(issued.status_code, 200)
        self.assertEqual(issued['Cache-Control'], 'no-store')
        self.assertEqual(issued['Access-Control-Allow-Origin'], '*')
        grant = issued.json()
        self.assertEqual((grant['token_type'], grant['expires_in'], grant['scope']), ('Bearer', 3600, 'veevee.read veevee.generate'))
        self.assertTrue(grant['access_token'].startswith('vva_') and grant['refresh_token'].startswith('vvr_'))
        principal = authenticate_bearer('Bearer ' + grant['access_token'])
        self.assertEqual((principal.kind, principal.caps.token_daily_cap_cents, principal.caps.auto_approve_cents), ('oauth', 500, 10))
        me = self.client.get('/api/mcp/me', HTTP_AUTHORIZATION='Bearer ' + grant['access_token'])
        self.assertEqual((me.status_code, me.json()['clientName']), (200, 'Inspector'))
        # Replaying the code revokes everything issued from it.
        replay = self.exchange(code)
        self.assertEqual(replay.json()['error'], 'invalid_grant')
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(grant['access_token'])

        self.sign_in()
        grant = self.exchange(self.consent()).json()
        rotated = self.token(grant_type='refresh_token', refresh_token=grant['refresh_token'])
        self.assertEqual(rotated.status_code, 200)
        fresh = rotated.json()
        self.assertNotEqual(fresh['refresh_token'], grant['refresh_token'])
        family = McpToken.objects.get(token_hash=tokens.digest(fresh['access_token'])).family_id
        self.assertEqual(McpToken.objects.get(token_hash=tokens.digest(grant['access_token'])).family_id, family)
        authenticate_bearer(fresh['access_token'])
        narrowed = self.token(grant_type='refresh_token', refresh_token=fresh['refresh_token'], scope='veevee.read').json()
        self.assertEqual(narrowed['scope'], 'veevee.read')
        widened = self.token(grant_type='refresh_token', refresh_token=narrowed['refresh_token'], scope='veevee.read veevee.organize')
        self.assertEqual(widened.json()['error'], 'invalid_scope')
        # Presenting an already rotated refresh token revokes the whole grant.
        reuse = self.token(grant_type='refresh_token', refresh_token=grant['refresh_token'])
        self.assertEqual((reuse.status_code, reuse.json()['error']), (400, 'invalid_grant'))
        self.assertFalse(McpToken.objects.filter(family_id=family, revoked_at__isnull=True).exists())
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(narrowed['access_token'])
        self.assertEqual(self.token(grant_type='refresh_token', refresh_token=narrowed['refresh_token']).json()['error'], 'invalid_grant')
        self.assertTrue(ActivityLog.objects.filter(action='mcp_token_revoked', detail__reason='refresh_token_reuse').exists())

    def test_authorization_errors(self):
        bad_redirect = self.client.get('/api/oauth/authorize/request?' + urlencode(self.authorize_params(redirect_uri='http://127.0.0.1:1/evil')))
        self.assertEqual(bad_redirect.status_code, 400)
        self.assertNotIn('redirectTo', bad_redirect.json())
        unknown = self.client.get('/api/oauth/authorize/request?' + urlencode(self.authorize_params(client_id='vvc_unknown')))
        self.assertEqual((unknown.status_code, unknown.json()['error']), (400, 'invalid_client'))
        for overrides, error in (({'code_challenge_method': 'plain'}, 'invalid_request'), ({'code_challenge': ''}, 'invalid_request'),
                                 ({'response_type': 'token'}, 'unsupported_response_type'),
                                 ({'resource': 'https://other.example/mcp'}, 'invalid_target')):
            with self.subTest(overrides=overrides):
                response = self.client.get('/api/oauth/authorize/request?' + urlencode(self.authorize_params(**overrides)))
                self.assertEqual(response.json()['error'], error)
                back = parse_qs(urlsplit(response.json()['redirectTo']).query)
                self.assertEqual((back['error'][0], back['state'][0], back['iss'][0]), (error, 'opaque-state', SITE))
        denied = self.post_json('/api/oauth/authorize/decision', {'request': self.authorize_params(), 'approve': False})
        self.assertEqual(parse_qs(urlsplit(denied.json()['redirectTo']).query)['error'], ['access_denied'])
        over_cap = self.post_json('/api/oauth/authorize/decision', {'request': self.authorize_params(), 'approve': True,
                                  'scopes': ['veevee.read'], 'dailyCapCents': 2001, 'autoApproveCents': 25})
        self.assertEqual(over_cap.status_code, 400)
        admin_scope = self.post_json('/api/oauth/authorize/decision', {'request': self.authorize_params(), 'approve': True,
                                     'scopes': ['veevee.admin'], 'dailyCapCents': 100, 'autoApproveCents': 25})
        self.assertEqual(admin_scope.json()['error'], 'invalid_scope')
        UserLimit.objects.filter(user_id=self.user.id, key='mcpEnabled').delete()
        disabled = self.post_json('/api/oauth/authorize/decision', {'request': self.authorize_params(), 'approve': True,
                                  'scopes': ['veevee.read'], 'dailyCapCents': 100, 'autoApproveCents': 25})
        self.assertEqual(disabled.status_code, 403)
        self.assertFalse(McpAuthCode.objects.exists())
        foreign = self.post_json('/api/oauth/authorize/decision', {'request': self.authorize_params(), 'approve': False},
                                 HTTP_ORIGIN='https://hostile.example')
        self.assertEqual(foreign.json(), {'error': 'FORBIDDEN_ORIGIN'})

    def test_code_is_bound_to_client_redirect_expiry_and_account(self):
        code = self.consent()
        other = self.post_json('/api/oauth/register', {'redirect_uris': [LOOPBACK]}).json()
        stolen = self.client.post('/api/oauth/token', urlencode({'client_id': other['client_id'], 'grant_type': 'authorization_code',
                                  'code': code, 'redirect_uri': LOOPBACK, 'code_verifier': self.verifier}),
                                  content_type='application/x-www-form-urlencoded')
        self.assertEqual(stolen.json()['error'], 'invalid_grant')
        self.assertEqual(self.token(grant_type='authorization_code', code=code, redirect_uri='http://127.0.0.1:2/x',
                                    code_verifier=self.verifier).json()['error'], 'invalid_grant')
        self.sign_in()
        code = self.consent()
        McpAuthCode.objects.filter(code_hash=tokens.digest(code)).update(expires_at=1)
        self.assertIn('expired', self.exchange(code).json()['error_description'])
        self.sign_in()
        code = self.consent()
        User.objects.filter(pk=self.user.pk).update(auth_version=9)
        self.assertEqual(self.exchange(code).json()['error'], 'invalid_grant')
        unknown_client = self.client.post('/api/oauth/token', urlencode({'client_id': 'vvc_nobody', 'grant_type': 'authorization_code'}),
                                          content_type='application/x-www-form-urlencoded')
        self.assertEqual((unknown_client.status_code, unknown_client.json()['error']), (401, 'invalid_client'))
        self.assertEqual(self.token(grant_type='password').json()['error'], 'unsupported_grant_type')

    def test_refresh_after_account_change_revokes_the_grant(self):
        grant = self.exchange(self.consent()).json()
        User.objects.filter(pk=self.user.pk).update(auth_version=9)
        self.assertEqual(self.token(grant_type='refresh_token', refresh_token=grant['refresh_token']).json()['error'], 'invalid_grant')
        self.assertFalse(McpToken.objects.filter(revoked_at__isnull=True).exists())

    def test_revocation_endpoint_and_connected_apps(self):
        grant = self.exchange(self.consent()).json()
        self.sign_in()
        listed = self.client.get('/api/mcp/tokens').json()['connections']
        self.assertEqual([(item['clientName'], item['scopes'], item['dailyCapCents'], item['autoApproveCents']) for item in listed],
                         [('Inspector', ['veevee.read', 'veevee.generate'], 500, 10)])
        self.assertEqual(self.client.post('/api/oauth/revoke', urlencode({'token': 'vva_unknown', 'client_id': self.app['client_id']}),
                                          content_type='application/x-www-form-urlencoded').status_code, 200)
        wrong_client = self.client.post('/api/oauth/revoke', urlencode({'token': grant['access_token'], 'client_id': 'vvc_other'}),
                                        content_type='application/x-www-form-urlencoded')
        self.assertEqual(wrong_client.status_code, 401)
        self.client.post('/api/oauth/revoke', urlencode({'token': grant['access_token'], 'client_id': self.app['client_id']}),
                         content_type='application/x-www-form-urlencoded')
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(grant['access_token'])
        fresh = self.token(grant_type='refresh_token', refresh_token=grant['refresh_token']).json()
        authenticate_bearer(fresh['access_token'])
        self.client.post('/api/oauth/revoke', urlencode({'token': fresh['refresh_token'], 'client_id': self.app['client_id'],
                         'token_type_hint': 'refresh_token'}), content_type='application/x-www-form-urlencoded')
        with self.assertRaises(AuthenticationError):
            authenticate_bearer(fresh['access_token'])
        self.sign_in()
        self.assertEqual(self.client.get('/api/mcp/tokens').json()['connections'], [])
        grant = self.exchange(self.consent()).json()
        self.sign_in()
        family = self.client.get('/api/mcp/tokens').json()['connections'][0]['id']
        self.assertEqual(self.client.delete(f'/api/mcp/connections/{family}').status_code, 200)
        self.assertEqual(self.token(grant_type='refresh_token', refresh_token=grant['refresh_token']).json()['error'], 'invalid_grant')

    def test_cimd_client_authorizes_with_its_document(self):
        self.verifier, self.challenge = pkce_pair()
        with patch('apps.mcp_auth.clients.fetch_document', side_effect=fixture_fetch):
            response = self.client.get('/api/oauth/authorize/request?' + urlencode(self.authorize_params(
                client_id=CLAUDE_CODE_CIMD, redirect_uri='http://localhost:51234/callback')))
        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual((response.json()['client']['name'], response.json()['client']['verifiedUrl']), ('Claude Code', CLAUDE_CODE_CIMD))


class ControlsTests(AgentAccessCase):
    def principal(self, *, user_cap=None, token_cap=1000, active=None, auto=25):
        self.enable()
        if user_cap is not None:
            UserLimit.objects.create(user_id=self.user.id, key='mcpDailyCapCents', value=str(user_cap), updated_at=1)
        if active is not None:
            UserLimit.objects.create(user_id=self.user.id, key='mcpActiveJobs', value=str(active), updated_at=1)
        raw, _ = tokens.issue(self.user, 'pat', scopes=['veevee.generate'], daily_cap_cents=token_cap, auto_approve_cents=auto,
                              expires_at=10 ** 13)
        return authenticate_bearer(raw)

    def generation(self, principal, cost, *, status='succeeded', created_at=None, basis='estimated', token_id=None):
        return Generation.objects.create(id=uuid.uuid4(), kind='image', status=status, prompt='p', model='Nano Banana 2.1',
            aspect_ratio='1:1', user_id=self.user.id, cost_cents=cost, cost_basis=basis, created_at=created_at or controls.now_ms(),
            updated_at=1, **{**principal.origin_fields(), **({'mcp_token_id': token_id} if token_id else {})})

    def test_price_decision_boundaries(self):
        principal = self.principal()
        self.assertEqual([controls.price_decision(principal, cost) for cost in (0, 25, 26, 99, 100, 500)],
                         ['submit', 'submit', 'quote', 'quote', 'confirm', 'confirm'])

    def test_confirmation_wins_over_the_highest_auto_approve_amount(self):
        principal = self.principal(auto=100)
        self.assertEqual([controls.price_decision(principal, cost) for cost in (0, 99, 100, 101)],
                         ['submit', 'submit', 'confirm', 'confirm'])

    def test_rate_windows_count_per_grant_and_reset(self):
        principal = self.principal()
        for _ in range(10):
            controls.check_rate(principal, 'paid_minute', now=60_000)
        with self.assertRaises(controls.RateLimited) as refused:
            controls.check_rate(principal, 'paid_minute', now=90_000)
        self.assertEqual(refused.exception.retry_after_seconds, 30)
        self.assertEqual(refused.exception.code, 'RATE_LIMITED')
        controls.check_rate(principal, 'paid_minute', now=120_000)
        self.assertEqual(controls.hit('other', 1, 60, now=60_000).allowed, True)
        from .maintenance import purge_expired
        self.assertEqual(purge_expired(now=10 ** 9)['windows'], 3)

    def test_spend_counts_agent_rows_of_the_last_day_except_unsubmitted_cancellations(self):
        principal = self.principal()
        now = controls.now_ms()
        self.generation(principal, 300)
        self.generation(principal, 200, basis='cancelled_billing_unconfirmed')
        self.generation(principal, 999, basis='cancelled_before_submission')
        self.generation(principal, 400, created_at=now - policy.DAY_MS - 1)
        self.generation(principal, 50, token_id=uuid.uuid4())
        Generation.objects.create(id=uuid.uuid4(), kind='image', status='succeeded', prompt='web', model='m', aspect_ratio='1:1',
                                  user_id=self.user.id, cost_cents=5000, created_at=now, updated_at=1)
        self.assertEqual(controls.spent_cents(self.user.id, now=now), 550)
        self.assertEqual(controls.spent_cents(self.user.id, token_id=principal.token_id, now=now), 500)

    def test_admission_enforces_caps_concurrency_and_paid_rates(self):
        principal = self.principal(user_cap=1000, token_cap=600, active=2)
        with self.assertRaises(RuntimeError):
            controls.admit_paid_submission(principal, 10)
        with transaction.atomic():
            controls.admit_paid_submission(principal, 600)
            self.generation(principal, 600, status='queued')
        with self.assertRaises(controls.BudgetExceeded) as token_cap, transaction.atomic():
            controls.admit_paid_submission(principal, 1)
        self.assertIn('$6.00 daily limit', token_cap.exception.message)
        other = self.principal_for_new_token(token_cap=1000)
        with self.assertRaises(controls.BudgetExceeded) as user_cap, transaction.atomic():
            controls.admit_paid_submission(other, 401)
        self.assertIn('$10.00 daily agent limit ($6.00 used', user_cap.exception.message)
        with transaction.atomic():
            controls.admit_paid_submission(other, 100)
            self.generation(other, 100, status='running')
        with self.assertRaises(controls.ConcurrencyLimit), transaction.atomic():
            controls.admit_paid_submission(other, 1)
        Generation.objects.update(status='succeeded')
        UserLimit.objects.filter(user_id=self.user.id, key='mcpDailyCapCents').update(value='100000')
        free = self.principal_for_new_token(token_cap=100000)
        for _ in range(10):
            with transaction.atomic():
                controls.admit_paid_submission(free, 0, now=1_000_000_020_000)
        with self.assertRaises(controls.RateLimited), transaction.atomic():
            controls.admit_paid_submission(free, 0, now=1_000_000_020_000)

    def principal_for_new_token(self, token_cap):
        raw, _ = tokens.issue(self.user, 'pat', scopes=['veevee.generate'], daily_cap_cents=token_cap, auto_approve_cents=25,
                              expires_at=10 ** 13)
        return authenticate_bearer(raw)

    def test_parallel_submissions_cannot_overshoot_the_daily_cap(self):
        principal = self.principal(user_cap=2000, token_cap=2000, active=8)
        outcomes, barrier = [], threading.Barrier(4)

        def submit():
            try:
                barrier.wait()
                with transaction.atomic():
                    controls.admit_paid_submission(principal, 600)
                    self.generation(principal, 600, status='queued')
                outcomes.append('admitted')
            except controls.BudgetExceeded:
                outcomes.append('refused')
            finally:
                connection.close()
        threads = [threading.Thread(target=submit) for _ in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(sorted(outcomes), ['admitted', 'admitted', 'admitted', 'refused'])
        self.assertEqual(controls.spent_cents(self.user.id), 1800)

    def test_hold_slots_bound_concurrent_waits_and_are_released(self):
        principal = self.principal()
        with controls.hold_slot(principal, now=1000), controls.hold_slot(principal, now=1000), \
                controls.hold_slot(principal, now=1000), controls.hold_slot(principal, now=1000):
            with self.assertRaises(controls.ConcurrencyLimit):
                with controls.hold_slot(principal, now=1000):
                    pass
            with controls.hold_slot(principal, now=1000 + policy.HOLD_TTL_MS + 1):
                pass
        with controls.hold_slot(principal, now=2000) as slot:
            self.assertEqual(slot, 0)


class AdminAccessTests(AgentAccessCase):
    def test_admin_opt_in_limits_and_emergency_revoke(self):
        self.sign_in()
        self.assertEqual(self.post_json('/api/admin/agent-access', {'userId': str(self.user.id), 'enabled': True}).status_code, 403)
        self.sign_in(self.admin)
        self.assertEqual(self.post_json('/api/admin/agent-access', {'userId': str(uuid.uuid4()), 'enabled': True}).status_code, 404)
        self.assertEqual(self.post_json('/api/admin/agent-access', {'userId': str(self.user.id), 'enabled': 'yes'}).status_code, 400)
        self.assertEqual(self.post_json('/api/admin/agent-access', {'userId': str(self.user.id), 'enabled': True}).json()['enabled'], True)
        self.assertTrue(policy.user_limits(self.user.id)['enabled'])
        self.assertEqual(self.post_json('/api/admin/user-limits', {'userId': str(self.user.id), 'key': 'mcpDailyCapCents', 'value': 5000}).status_code, 200)
        self.assertEqual(self.post_json('/api/admin/limits', {'key': 'mcpActiveJobs', 'value': 2}).status_code, 200)
        self.assertEqual(self.post_json('/api/admin/user-limits', {'userId': str(self.user.id), 'key': 'mcpActiveJobs', 'value': 9}).status_code, 400)
        self.assertEqual(policy.user_limits(self.user.id), {'enabled': True, 'dailyCapCents': 5000, 'activeJobs': 2})
        for _ in range(2):
            tokens.issue(self.user, 'pat', scopes=['veevee.read'], daily_cap_cents=100, auto_approve_cents=0, expires_at=10 ** 13)
        user_row = next(row for row in self.client.get('/api/admin/data').json()['users'] if row['id'] == str(self.user.id))
        self.assertEqual(user_row['agentAccess'], {'enabled': True, 'activeGrants': 2})
        self.assertEqual(user_row['limits'], {'mcpDailyCapCents': 5000})
        revoked = self.post_json('/api/admin/agent-access/revoke', {'userId': str(self.user.id)})
        self.assertEqual(revoked.json(), {'ok': True, 'revoked': 2})
        self.assertTrue(ActivityLog.objects.filter(action='admin_mcp_tokens_revoked').exists())
        self.post_json('/api/admin/agent-access', {'userId': str(self.user.id), 'enabled': False})
        self.assertFalse(policy.user_limits(self.user.id)['enabled'])
        settings_response = self.client.get('/api/settings').json()
        self.assertEqual(set(settings_response), {'maxPromptLength', 'maxConcurrentJobs'})

    def test_admin_role_or_status_change_revokes_tokens(self):
        tokens.issue(self.user, 'pat', scopes=['veevee.read'], daily_cap_cents=100, auto_approve_cents=0, expires_at=10 ** 13)
        self.sign_in(self.admin)
        response = self.client.generic('PATCH', '/api/admin/users', json.dumps({'id': str(self.user.id), 'isActive': False}),
                                       content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertFalse(McpToken.objects.filter(revoked_at__isnull=True).exists())

    def test_gateway_allows_the_new_admin_routes_and_oauth_preflights(self):
        from deploy import gateway
        for method, path in (('POST', '/api/admin/agent-access'), ('POST', '/api/admin/agent-access/revoke'),
                             ('OPTIONS', '/api/oauth/token'), ('POST', '/api/oauth/token'), ('GET', '/api/oauth/authorization-server'),
                             ('GET', '/api/mcp/tokens'), ('DELETE', '/api/mcp/tokens/' + str(uuid.uuid4()))):
            self.assertTrue(gateway.allowed(method, path), (method, path))
        self.assertFalse(gateway.allowed('OPTIONS', '/api/mcp/tokens'))
        self.assertFalse(gateway.allowed('GET', '/api/admin/agent-access'))


class MigrationTests(TransactionTestCase):
    def test_fresh_and_upgrade_paths_are_additive(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] not in ('generation', 'mcp_auth')] + [
            ('generation', '0007_explicit_folder_name_rename'), ('mcp_auth', None)]
        identifier = uuid.uuid4()
        try:
            executor.migrate(previous)
            with connection.cursor() as cursor:
                cursor.execute("SELECT to_regclass('public.mcp_tokens')")
                self.assertIsNone(cursor.fetchone()[0])
            old = executor.loader.project_state([node for node in previous if node[1]]).apps.get_model('generation', 'Generation')
            old.objects.create(id=identifier, kind='image', status='succeeded', prompt='legacy', model='fixture', aspect_ratio='1:1',
                               cost_cents=4, created_at=1, updated_at=2)
            executor = MigrationExecutor(connection)
            plan = executor.migration_plan(final)
            self.assertEqual(sorted((migration.app_label, migration.name) for migration, backward in plan),
                             [('generation', '0008_generation_mcp_origin'), ('mcp_auth', '0001_initial')])
            executor.migrate(final)
            row = Generation.objects.get(pk=identifier)
            self.assertEqual((row.created_via, row.mcp_token_id, row.mcp_client_id, row.cost_cents), (None, None, None, 4))
            with connection.cursor() as cursor:
                for table in ('mcp_tokens', 'mcp_clients', 'mcp_auth_codes', 'mcp_rate_windows'):
                    cursor.execute('SELECT to_regclass(%s)', ['public.' + table])
                    self.assertIsNotNone(cursor.fetchone()[0], table)
                cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'generations_mcp_token_created_idx'")
                self.assertIn('WHERE (mcp_token_id IS NOT NULL)', cursor.fetchone()[0])
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
        finally:
            MigrationExecutor(connection).migrate(final)
