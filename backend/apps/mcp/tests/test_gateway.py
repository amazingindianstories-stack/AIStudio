"""The deployed request path: the ingress gateway in mcp mode in front of the MCP app served by a real uvicorn."""
import asyncio
import http.client
import importlib.util
import json
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

import httpx2
import uvicorn
from mcp import Client
from mcp.client.streamable_http import streamable_http_client

from apps.mcp.app import build_application
from .support import ERAS, McpCase, initialize_body

spec = importlib.util.spec_from_file_location('veevee_mcp_gateway', Path(__file__).resolve().parents[3] / 'deploy' / 'gateway.py')
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
SECRET = 'mcp-gateway-test-ingress-' + 'x' * 48


class GatewayPathTests(McpCase):
    def setUp(self):
        super().setUp()
        server = uvicorn.Server(uvicorn.Config(build_application(purge_interval=0), host='127.0.0.1', port=0,
                                               lifespan='on', log_level='warning', access_log=False))
        thread = threading.Thread(target=server.run, daemon=True)
        thread.start()
        deadline = time.monotonic() + 10
        while not server.started:
            self.assertLess(time.monotonic(), deadline, 'uvicorn did not start')
            time.sleep(0.02)
        self.addCleanup(thread.join, 10)
        self.addCleanup(setattr, server, 'should_exit', True)
        upstream = server.servers[0].sockets[0].getsockname()[1]
        gate = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler(SECRET, mode='mcp'))
        gate.daemon_threads = True
        threading.Thread(target=gate.serve_forever, daemon=True).start()
        self.addCleanup(gate.server_close)
        self.addCleanup(gate.shutdown)
        self.port = gate.server_address[1]
        # The gateway always dials the MCP service on 127.0.0.1:18082; send that to this test's uvicorn instead.
        real = http.client.HTTPConnection
        self.direct = real
        patcher = patch.object(http.client, 'HTTPConnection',
                               lambda host, port, *args, **kwargs: real(host, upstream if port == 18082 else port, *args, **kwargs))
        patcher.start()
        self.addCleanup(patcher.stop)

    def raw(self, method, path, headers=None, body=None):
        connection = self.direct('127.0.0.1', self.port, timeout=30)
        try:
            data = json.dumps(body).encode() if body is not None else None
            connection.request(method, path, body=data, headers={'Content-Type': 'application/json',
                                                                'Accept': 'application/json, text/event-stream', **(headers or {})})
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def test_both_eras_work_through_the_gateway(self):
        raw = self.token()

        async def session(mode):
            headers = {gateway.HEADER: SECRET, 'authorization': f'Bearer {raw}'}
            async with httpx2.AsyncClient(headers=headers, timeout=30) as http:
                async with Client(streamable_http_client(f'http://127.0.0.1:{self.port}/mcp', http_client=http), mode=mode) as client:
                    names = [tool.name for tool in (await client.list_tools()).tools]
                    return names, await client.call_tool('get_account', {})
        for mode in ERAS:
            names, result = asyncio.run(session(mode))
            self.assertIn('get_account', names)
            self.assertFalse(result.is_error, result.content)
            self.assertEqual(result.structured_content['user']['name'], 'Artist')

    def test_the_gateway_refuses_everything_else(self):
        token = {'authorization': f'Bearer {self.token()}'}
        status, _, _ = self.raw('POST', '/mcp', token, initialize_body())
        self.assertEqual(status, 403, 'no ingress header')
        for method, path in (('POST', '/api/history'), ('GET', '/healthz'), ('POST', '/mcp/x'), ('PUT', '/mcp')):
            status, _, body = self.raw(method, path, {gateway.HEADER: SECRET, **token}, {})
            self.assertEqual(status, 403, (method, path))
            self.assertEqual(json.loads(body)['code'], 'PREVIEW_OPERATION_DISABLED')

    def test_challenges_and_405_pass_through(self):
        status, headers, _ = self.raw('POST', '/mcp', {gateway.HEADER: SECRET}, initialize_body())
        self.assertEqual(status, 401)
        self.assertIn('resource_metadata=', headers['WWW-Authenticate'])
        status, headers, _ = self.raw('GET', '/mcp', {gateway.HEADER: SECRET, 'authorization': f'Bearer {self.token()}'})
        self.assertEqual((status, headers['Allow'], headers['Cache-Control']), (405, 'POST', 'no-store'))

    def test_readiness_checks_the_mcp_service(self):
        status, headers, body = self.raw('GET', '/__g4_readiness')
        self.assertEqual((status, json.loads(body), headers['Cache-Control']), (200, {'ok': True}, 'no-store'))
