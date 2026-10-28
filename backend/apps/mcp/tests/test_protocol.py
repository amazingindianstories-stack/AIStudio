"""The MCP foundation: both protocol eras, authentication, scopes, kill switches, maintenance, logging and audit."""
import json
import time
from unittest.mock import patch

from django.core.exceptions import ImproperlyConfigured
from django.test import override_settings

from apps.admin_dashboard.models import AppSetting
from apps.common.models import ActivityLog
from apps.mcp import runtime
from apps.mcp.app import build_application
from apps.mcp.registry import REGISTRY, ToolResult, obj, register
from apps.mcp.server import INSTRUCTIONS
from apps.mcp.tools.account import OUTPUT as ACCOUNT_OUTPUT
from apps.mcp_auth import policy
from .support import ERAS, SITE, McpCase, initialize_body

ECHO_OUTPUT = obj({'echo': {'type': 'string'}}, ('echo',))


def read_tools():
    return scoped('veevee.read')


def scoped(*scopes, admin=False):
    return sorted(name for name, spec in REGISTRY.items() if spec.scope in scopes and (admin or not spec.admin_only))


def fake_tools():
    """Test-only tools in each scope; registered inside ``patch.dict(REGISTRY)`` so they never leak."""
    async def echo(call):
        call.record.update(generationId='g-1', costCents=6)
        return ToolResult({'echo': call.arguments.get('text', '')}, 'Echoed.', outcome='completed')
    for name, scope, read_only in (('fake_paid', 'veevee.generate', False), ('fake_organize', 'veevee.organize', False),
                                   ('fake_admin', 'veevee.admin', True)):
        register(name=name, title=name, description='Test tool.', scope=scope, read_only=read_only,
                 input_schema=obj({'text': {'type': 'string', 'maxLength': 5}}), output_schema=ECHO_OUTPUT)(echo)


class ProtocolTests(McpCase):
    def test_initialize_and_discover_carry_the_instructions_on_both_eras(self):
        response = self.post(initialize_body('2025-06-18'), {'authorization': f'Bearer {self.token()}'})
        self.assertEqual(response.status_code, 200)
        result = response.json()['result']
        self.assertEqual((result['protocolVersion'], result['serverInfo']['name'], result['instructions']),
                         ('2025-06-18', 'veevee', INSTRUCTIONS))
        self.assertIn('tools', result['capabilities'])
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertRegex(response.headers['x-request-id'], '^[0-9a-f]{32}$')

        async def discover(client):
            return client.protocol_version, client.instructions
        self.assertEqual(self.with_client(self.token(), 'legacy', discover), ('2025-11-25', INSTRUCTIONS))
        # 'auto' probes server/discover (a pinned modern client skips it), which carries the same instructions.
        self.assertEqual(self.with_client(self.token(), 'auto', discover), ('2026-07-28', INSTRUCTIONS))
        self.assertNotIn('\u2014', INSTRUCTIONS)

    def test_get_account_on_both_eras(self):
        raw = self.token(name='Studio laptop', cap=700, auto_approve=10)
        for mode in ERAS:
            result = self.call(raw, 'get_account', mode=mode)
            self.assert_structured(result, ACCOUNT_OUTPUT)
            account = result.structured_content
            self.assertEqual(account['user'], {'id': str(self.user.id), 'name': 'Artist', 'role': 'user'})
            self.assertEqual(account['token']['name'], 'Studio laptop')
            self.assertEqual(account['token']['scopes'], ['veevee.generate', 'veevee.read'])
            self.assertEqual(account['spend'], {'todayCents': 0, 'dailyCapCents': 2000, 'tokenTodayCents': 0, 'tokenCapCents': 700})
            self.assertEqual((account['autoApproveCents'], account['confirmAboveCents'], account['maxActiveJobs']), (10, 100, 4))
            self.assertTrue(result.content[0].text.startswith('Connected as Artist; agent spending $0.00 of $20.00'))

    def test_tools_list_is_filtered_by_scope_and_admin_role(self):
        with patch.dict(REGISTRY):
            read, paid = read_tools(), scoped('veevee.read', 'veevee.generate')
            organized, admin = scoped('veevee.read', 'veevee.generate', 'veevee.organize'), scoped(*policy.SCOPES, admin=True)
            fake_tools()
            for mode in ERAS:
                self.assertEqual(sorted(self.tool_names(self.token(scopes=('veevee.read',)), mode)), read)
                self.assertEqual(sorted(self.tool_names(self.token(), mode)), sorted(paid + ['fake_paid']))
                everything = ('veevee.read', 'veevee.generate', 'veevee.organize', 'veevee.admin')
                # The admin scope is dropped for a non-admin even when the token row lists it.
                self.assertEqual(sorted(self.tool_names(self.token(scopes=everything), mode)), sorted(organized + ['fake_organize', 'fake_paid']))
                self.assertEqual(sorted(self.tool_names(self.token(self.admin, scopes=everything), mode)),
                                 sorted(admin + ['fake_admin', 'fake_organize', 'fake_paid']))

    def test_tool_definitions_carry_titles_schemas_and_explicit_annotations(self):
        async def use(client):
            return (await client.list_tools()).tools
        tool, = [tool for tool in self.with_client(self.token(), 'legacy', use) if tool.name == 'get_account']
        self.assertEqual((tool.name, tool.title), ('get_account', 'Account and limits'))
        self.assertEqual(tool.output_schema, ACCOUNT_OUTPUT)
        self.assertEqual(tool.input_schema['additionalProperties'], False)
        hints = tool.annotations
        self.assertEqual((hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint, hints.open_world_hint),
                         (True, False, True, False))

    def test_scopes_are_rechecked_on_every_call(self):
        with patch.dict(REGISTRY):
            fake_tools()
            reader = self.token(scopes=('veevee.read',))
            for mode in ERAS:
                error = self.assert_tool_error(self.call(reader, 'fake_paid', mode=mode), 'INSUFFICIENT_SCOPE')
                self.assertIn('veevee.generate', error['message'])
            everything = ('veevee.read', 'veevee.generate', 'veevee.organize', 'veevee.admin')
            self.assert_tool_error(self.call(self.token(scopes=everything), 'fake_admin'), 'INSUFFICIENT_SCOPE')
            self.assertEqual(self.call(self.token(self.admin, scopes=everything), 'fake_admin').structured_content, {'echo': ''})

    def test_unknown_tools_and_invalid_arguments(self):
        body = {'jsonrpc': '2.0', 'id': 7, 'method': 'tools/call', 'params': {'name': 'delete_everything', 'arguments': {}}}
        response = self.post(body, {'authorization': f'Bearer {self.token()}', 'mcp-protocol-version': '2025-11-25'})
        error = response.json()['error']
        self.assertEqual(error['code'], -32602)
        self.assertIn('Unknown tool: delete_everything', error['message'])
        with patch.dict(REGISTRY):
            fake_tools()
            error = self.assert_tool_error(self.call(self.token(), 'fake_paid', {'text': 'far too long'}), 'INVALID_INPUT')
            self.assertTrue(error['message'].startswith('text: '), error)
            error = self.assert_tool_error(self.call(self.token(), 'fake_paid', {'txt': 'x'}), 'INVALID_INPUT')
            self.assertIn("'txt' was unexpected", error['message'])


class HttpGateTests(McpCase):
    def test_missing_or_invalid_tokens_get_the_challenge(self):
        for headers in ({}, {'authorization': 'Bearer vv_pat_unknown'}, {'authorization': 'Basic abc'},
                        {'cookie': 'veevee_session=anything'}):
            response = self.post(initialize_body(), headers)
            self.assertEqual(response.status_code, 401, headers)
            challenge = response.headers['www-authenticate']
            self.assertTrue(challenge.startswith('Bearer resource_metadata="https://veevee.test/.well-known/oauth-protected-resource/mcp"'))
            self.assertIn('scope="veevee.read veevee.generate"', challenge)
        self.assertIn('Settings, Agent access', self.post(initialize_body(), {'authorization': 'Bearer vv_pat_unknown'}).json()['error_description'])

    def test_revoked_and_expired_tokens_are_refused(self):
        from apps.mcp_auth.models import McpToken
        raw = self.token()
        McpToken.objects.update(revoked_at=1)
        self.assertEqual(self.post(initialize_body(), {'authorization': f'Bearer {raw}'}).status_code, 401)

    def test_origins(self):
        raw = self.token()
        for origin, status in (('https://evil.example', 403), ('https://veevee.test.evil.example', 403), ('null', 403),
                               ('http://localhost:6274', 403), (SITE, 200), (None, 200)):
            headers = {'authorization': f'Bearer {raw}', **({'origin': origin} if origin else {})}
            self.assertEqual(self.post(initialize_body(), headers).status_code, status, origin)
        # A foreign origin is refused before authentication.
        self.assertEqual(self.post(initialize_body(), {'origin': 'https://evil.example'}).status_code, 403)

    @override_settings(PUBLIC_APP_URL='http://localhost:3000')
    def test_local_development_accepts_loopback_pages(self):
        raw = self.token()
        for origin, status in (('http://localhost:6274', 200), ('http://127.0.0.1:3000', 200), ('http://localhost:x', 403),
                               ('https://evil.example', 403)):
            self.assertEqual(self.post(initialize_body(), {'authorization': f'Bearer {raw}', 'origin': origin}).status_code, status, origin)

    def test_only_post_is_served(self):
        for method in ('GET', 'DELETE', 'PUT'):
            response = self.post(None, {'authorization': f'Bearer {self.token()}'}, method=method)
            self.assertEqual((response.status_code, response.headers['allow']), (405, 'POST'), method)

    def test_foreign_hosts_are_refused(self):
        response = self.post(initialize_body(), {'authorization': f'Bearer {self.token()}', 'host': 'attacker.example'})
        self.assertEqual(response.status_code, 421)

    def test_health(self):
        async def go(app):
            import httpx2
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url='http://127.0.0.1:18082') as http:
                return await http.get('/healthz')
        response = self.run_async(go)
        self.assertEqual((response.status_code, response.json()), (200, {'ok': True, 'django': 'ready', 'database': 'ready'}))

    @override_settings(VEEVEE_MCP=False)
    def test_the_service_refuses_to_start_without_its_switch(self):
        with self.assertRaises(ImproperlyConfigured):
            build_application()


class SwitchTests(McpCase):
    def test_an_account_with_agent_access_off_sees_read_tools_and_every_call_says_why(self):
        raw = self.token()
        policy.set_enabled(self.user.id, False, 2)
        with patch.dict(REGISTRY):
            read = read_tools()
            fake_tools()
            for mode in ERAS:
                self.assertEqual(sorted(self.tool_names(raw, mode)), read)
                for tool in ('get_account', 'fake_paid'):
                    self.assertIn('switched off for this account', self.assert_tool_error(self.call(raw, tool, mode=mode), 'MCP_DISABLED')['message'])

    def test_maintenance_pauses_write_tools_only(self):
        raw = self.token()
        maintenance = {'x-veevee-maintenance': '1'}
        with patch.dict(REGISTRY):
            fake_tools()
            for mode in ERAS:
                self.assert_tool_error(self.call(raw, 'fake_paid', mode=mode, headers=maintenance), 'MAINTENANCE')
                self.assertFalse(self.call(raw, 'get_account', mode=mode, headers=maintenance).is_error)
            self.assertFalse(self.call(raw, 'fake_paid', headers={'x-veevee-maintenance': '0'}).is_error)

    def test_the_admin_switch_refuses_write_tools_on_the_next_call(self):
        raw = self.token()
        with patch.dict(REGISTRY):
            fake_tools()
            self.assertFalse(self.call(raw, 'fake_paid').is_error)
            AppSetting.objects.create(key=runtime.ADMIN_SWITCH, value='false', updated_at=1)
            self.assertIn('switched off in Veevee', self.assert_tool_error(self.call(raw, 'fake_paid'), 'MCP_DISABLED')['message'])
            self.assertFalse(self.call(raw, 'get_account').is_error)
            AppSetting.objects.filter(key=runtime.ADMIN_SWITCH).update(value='true')
            self.assertFalse(self.call(raw, 'fake_paid').is_error)

    def test_the_per_token_call_rate_applies(self):
        raw = self.token()
        now = int(time.time() * 1000)
        # Mid-window, so the fixed one-minute window cannot roll over between the three calls.
        with patch.dict(policy.RATE_LIMITS, {'calls': (2, 60)}), patch('apps.mcp_auth.controls.now_ms', return_value=now - now % 60000 + 30000):
            self.assertFalse(self.call(raw, 'get_account').is_error)
            self.assertFalse(self.call(raw, 'get_account').is_error)
            error = self.assert_tool_error(self.call(raw, 'get_account'), 'RATE_LIMITED')
            self.assertGreaterEqual(error['retryAfterSeconds'], 1)


class ObservabilityTests(McpCase):
    def test_one_json_log_line_per_call_and_an_audit_row_for_writes_only(self):
        raw = self.token()
        with patch.dict(REGISTRY):
            fake_tools()
            with self.assertLogs('veevee.mcp', 'INFO') as logs:
                self.call(raw, 'get_account', mode='2026-07-28')
                self.call(raw, 'fake_paid', {'text': 'fox'})
                self.call(raw, 'fake_paid', {'text': 'far too long'})
        lines = [json.loads(record.getMessage()) for record in logs.records]
        self.assertEqual([(line['tool'], line['outcome']) for line in lines],
                         [('get_account', 'ok'), ('fake_paid', 'completed'), ('fake_paid', 'INVALID_INPUT')])
        self.assertEqual(lines[0]['protocol_version'], '2026-07-28')
        self.assertEqual(lines[1]['protocol_version'], '2025-11-25')
        self.assertEqual((lines[1]['generation_id'], lines[1]['cost_cents'], lines[1]['user_id']), ('g-1', 6, str(self.user.id)))
        self.assertEqual(set(lines[0]), {'event', 'request_id', 'token_id', 'client_id', 'user_id', 'protocol_version', 'tool',
                                         'duration_ms', 'outcome', 'generation_id', 'cost_cents'})
        everything = ' '.join(record.getMessage() for record in logs.records)
        self.assertNotIn(raw, everything)
        self.assertNotIn('fox', everything)
        audits = list(ActivityLog.objects.filter(action='mcp_tool_call').order_by('created_at').values_list('detail', flat=True))
        self.assertEqual([(row['tool'], row['outcome']) for row in audits], [('fake_paid', 'completed'), ('fake_paid', 'INVALID_INPUT')])
        self.assertEqual((audits[0]['generationId'], audits[0]['costCents']), ('g-1', 6))
        self.assertNotIn('fox', json.dumps(audits))
        self.assertNotIn(raw, json.dumps(audits))

    def test_unexpected_failures_become_a_safe_tool_error(self):
        async def broken(call):
            raise RuntimeError('provider secret detail')
        with patch.dict(REGISTRY):
            register(name='fake_broken', title='Broken', description='Test.', scope='veevee.read', read_only=True,
                     input_schema=obj({}), output_schema=ECHO_OUTPUT)(broken)
            with self.assertLogs('veevee.mcp', 'INFO') as logs:
                error = self.assert_tool_error(self.call(self.token(), 'fake_broken'), 'INTERNAL_ERROR')
        self.assertNotIn('secret', error['message'])
        self.assertEqual(json.loads(logs.records[-1].getMessage())['outcome'], 'INTERNAL_ERROR')
