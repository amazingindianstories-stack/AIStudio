"""Shared fixtures for MCP tests: users, tokens and an in-process client speaking either protocol era.

The service runs its ORM work on executor threads, so these tests use ``TransactionTestCase`` (committed rows are
visible to those threads) with ``CONN_MAX_AGE`` 0 (each thread's connection closes after every call).
"""
import asyncio
import json
import logging
import uuid
from unittest.mock import patch

import httpx2
from django.db import connections
from django.test import TransactionTestCase, override_settings
from jsonschema import Draft202012Validator
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from apps.authentication.models import User
from apps.authentication.password import hash_password
from apps.mcp_auth import policy, tokens
from apps.mcp import runtime
from apps.mcp.app import build_application

SITE = 'https://veevee.test'
BASE = 'http://127.0.0.1:18082'
URL = BASE + '/mcp'
QUOTE_SECRET = 'mcp-test-quote-secret-' + 'q' * 32
ERAS = ('legacy', '2026-07-28')                    # the 2025 initialize handshake and the 2026-07-28 envelope
ACCEPT = {'accept': 'application/json, text/event-stream'}


@override_settings(PUBLIC_APP_URL=SITE, VEEVEE_BROWSER_ORIGINS=(SITE,), VEEVEE_MCP=True, MCP_QUOTE_SECRET=QUOTE_SECRET)
class McpCase(TransactionTestCase):
    def setUp(self):
        database = connections.settings['default']
        max_age = database['CONN_MAX_AGE']
        database['CONN_MAX_AGE'] = 0
        self.addCleanup(database.__setitem__, 'CONN_MAX_AGE', max_age)
        runtime.forget_switch()
        self.addCleanup(runtime.forget_switch)
        quiet = patch.object(logging.getLogger('veevee.mcp'), 'handlers', [logging.NullHandler()])
        quiet.start()
        self.addCleanup(quiet.stop)
        self.user = self.make_user('artist@example.invalid', 'Artist', 'user')
        self.admin = self.make_user('admin@example.invalid', 'Admin', 'admin')

    def make_user(self, email, name, role, *, enabled=True):
        credentials = hash_password('fixture-password')
        user = User.objects.create(id=uuid.uuid4(), email=email, name=name, role=role, password_hash=credentials['hash'],
                                   password_salt=credentials['salt'], created_at=1, is_active=True, auth_version=0)
        if enabled:
            policy.set_enabled(user.id, True, 1)
        return user

    def token(self, user=None, scopes=('veevee.read', 'veevee.generate'), *, cap=1000, auto_approve=25, name='Test token'):
        raw, _ = tokens.issue(user or self.user, 'pat', scopes=scopes, daily_cap_cents=cap, auto_approve_cents=auto_approve,
                              expires_at=10 ** 13, name=name)
        return raw

    def run_async(self, coroutine_function, *args):
        async def run():
            app = build_application(purge_interval=0)
            async with app.router.lifespan_context(app):
                return await coroutine_function(app, *args)
        return asyncio.run(run())

    def with_client(self, raw, mode, use, headers=None):
        """Run ``use(client)`` with an SDK client connected through the real ASGI app in the given protocol era."""
        async def go(app):
            auth = {'authorization': f'Bearer {raw}'} if raw else {}
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=BASE, headers={**auth, **(headers or {})}) as http:
                async with Client(streamable_http_client(URL, http_client=http), mode=mode) as client:
                    return await use(client)
        return self.run_async(go)

    def post(self, body, headers=None, method='POST'):
        """One raw HTTP request to /mcp; returns the httpx2 response."""
        async def go(app):
            async with httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url=BASE) as http:
                return await http.request(method, '/mcp', content=json.dumps(body).encode() if body is not None else None,
                                          headers={**ACCEPT, 'content-type': 'application/json', **(headers or {})})
        return self.run_async(go)

    def call(self, raw, name, arguments=None, mode='legacy', headers=None):
        return self.with_client(raw, mode, lambda client: client.call_tool(name, arguments or {}), headers)

    def tool_names(self, raw, mode='legacy'):
        async def use(client):
            return [tool.name for tool in (await client.list_tools()).tools]
        return self.with_client(raw, mode, use)

    def assert_structured(self, result, schema):
        self.assertFalse(result.is_error, result.content)
        errors = list(Draft202012Validator(schema).iter_errors(result.structured_content))
        self.assertEqual(errors, [], result.structured_content)
        text = result.content[0].text
        self.assertEqual(json.loads(text.split('\n\n', 1)[1]), result.structured_content)

    def assert_tool_error(self, result, code):
        self.assertTrue(result.is_error, result.content)
        self.assertEqual(result.structured_content['code'], code, result.structured_content)
        return result.structured_content


def initialize_body(version='2025-11-25'):
    return {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize',
            'params': {'protocolVersion': version, 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}}}
