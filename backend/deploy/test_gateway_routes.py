"""Production gateway: the route table under production flags, and admin routes reaching Django through it."""
import http.client
import importlib.util
import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from wsgiref.simple_server import WSGIRequestHandler, make_server

from django.db import connections
from django.test import SimpleTestCase, TransactionTestCase, override_settings

spec = importlib.util.spec_from_file_location('veevee_gateway_routes', Path(__file__).with_name('gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
PRODUCTION = {'paid_initial_routes': True, 'new_exports': True, 'magnific_upscale': True}
SECRET = 'gateway-test-ingress-' + 'x' * 48


class ProductionRouteTableTests(SimpleTestCase):
    def test_route_table_under_the_production_flags(self):
        table = [
            # Opened: audio transcription, agent voice notes, admin mutations and the read-only dependency status.
            ('POST', '/api/audio/transcribe', True),
            ('POST', f'/api/agent-conversations/{ID}/transcribe', True), ('GET', f'/api/agent-conversations/{ID}/transcribe', True),
            ('POST', '/api/admin/users', True), ('PATCH', '/api/admin/users', True), ('DELETE', '/api/admin/users', True),
            ('POST', '/api/admin/pricing', True), ('POST', '/api/admin/limits', True), ('POST', '/api/admin/user-limits', True),
            ('GET', '/api/admin/status', True), ('HEAD', '/api/admin/status', True),
            # Read-only provider error log (Django requires an admin session); nothing writes through it.
            ('GET', '/api/admin/errors', True), ('HEAD', '/api/admin/errors', True),
            ('POST', '/api/admin/errors', False), ('DELETE', '/api/admin/errors', False), ('GET', '/api/admin/errors/x', False),
            # Unchanged admin reads and portrait settings.
            ('GET', '/api/admin/data', True), ('GET', '/api/admin/logs', True), ('GET', '/api/admin/activity', True),
            ('GET', '/api/admin/portrait-settings', True), ('POST', '/api/admin/portrait-settings', True),
            # Admin workspace, template usage and board logs (BE-003); workspace is POST-only for writes.
            ('GET', '/api/admin/workspace', True), ('POST', '/api/admin/workspace', True), ('DELETE', '/api/admin/workspace', False),
            ('GET', '/api/admin/template-usage', True), ('GET', '/api/admin/content-log', True), ('GET', '/api/admin/ai-log', True),
            ('POST', '/api/admin/content-log', False), ('POST', '/api/admin/ai-log', False), ('POST', '/api/admin/template-usage', False),
            # Legacy upload routes stay refused at the gateway (BE-006); the resumable /api/uploads/init path is the contract.
            ('POST', '/api/uploads/presign', False), ('PUT', '/api/uploads/local', False),
            # Unchanged agent conversation routes (listing, detail, attach).
            ('GET', '/api/agent-conversations', True), ('POST', '/api/agent-conversations', True),
            ('GET', f'/api/agent-conversations/{ID}', True), ('PATCH', f'/api/agent-conversations/{ID}/messages/{ID}', True),
            # Still closed: fixture-writing audit, Higgsfield credential seeding, retired schema endpoint, machine ingress.
            ('POST', '/api/admin/audit/runtime', False), ('GET', '/api/admin/audit/runtime', False),
            ('POST', '/api/admin/set-token', False), ('POST', '/api/admin/migrate-schema', False),
            ('POST', '/api/webhooks/seedance', False), ('POST', '/api/queue/execute', False),
            ('GET', '/api/cron/login-attempts', False), ('GET', '/api/cron/video-reconciliation', False),
            ('POST', '/api/worker/exports/access', False), ('GET', '/api/generate/upscale/status', False),
            # Only the methods the dashboard uses open; nothing else under the same paths.
            ('GET', '/api/admin/users', False), ('PUT', '/api/admin/users', False), ('GET', '/api/admin/pricing', False),
            ('DELETE', '/api/admin/limits', False), ('PATCH', '/api/admin/user-limits', False), ('POST', '/api/admin/status', False),
            ('DELETE', '/api/admin/status', False), ('POST', '/api/admin/users/x', False), ('POST', '/api/admin/other', False),
            ('GET', '/api/audio/transcribe', False), ('PUT', '/api/audio/transcribe', False), ('POST', '/api/audio/transcribe/x', False),
            ('POST', f'/api/agent-conversations/{ID}/messages/extra', True),  # attach-style path: Django answers 405 for POST
            # Agent runs: start/message, the event feed, quote answers and cancel.
            ('POST', f'/api/agent-conversations/{ID}/runs', True), ('GET', f'/api/agent-conversations/{ID}/runs', True),
            ('GET', f'/api/agent-conversations/{ID}/runs/{ID}/events', True),
            ('POST', f'/api/agent-conversations/{ID}/runs/{ID}/approve', True),
            ('POST', f'/api/agent-conversations/{ID}/runs/{ID}/decline', True),
            ('POST', f'/api/agent-conversations/{ID}/runs/{ID}/cancel', True),
            ('PUT', f'/api/agent-conversations/{ID}/runs', False), ('DELETE', f'/api/agent-conversations/{ID}/runs/{ID}/approve', False),
            ('POST', '/api/agent-conversations/not-a-conversation-id/runs', False),
            ('POST', f'/api/agent-conversations/{ID}/runs/not-a-run-id/approve', False),
            ('POST', f'/api/agent-conversations/{ID}/runs/', False),
        ]
        for method, path, expected in table:
            self.assertIs(gateway.allowed(method, path, **PRODUCTION), expected, (method, path))

    def test_every_admin_route_has_a_gateway_decision(self):
        from apps.admin_dashboard import urls as admin_urls
        from apps.assets import urls as asset_urls
        from apps.mcp_auth import urls as mcp_urls
        closed = {'/api/admin/audit/runtime', '/api/admin/set-token', '/api/admin/migrate-schema'}
        opened = set(gateway.ADMIN_READ_PATHS) | set(gateway.ADMIN_MUTATIONS) | {'/api/admin/portrait-settings'}
        routes = {'/' + str(entry.pattern) for module in (admin_urls, asset_urls, mcp_urls)
                  for entry in module.urlpatterns if str(entry.pattern).startswith('api/admin/')}
        self.assertTrue(routes)
        self.assertEqual(routes - opened - closed, set(), 'new admin route without a gateway decision')
        for route in closed:
            self.assertFalse(any(gateway.allowed(method, route, **PRODUCTION) for method in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')), route)

    def test_encoded_paths_cannot_bypass_closed_routes(self):
        closed = [('POST', '/api/admin/audit/runtime'), ('GET', '/api/admin/audit/runtime'), ('POST', '/api/admin/set-token'),
                  ('POST', '/api/admin/migrate-schema'), ('POST', '/api/webhooks/seedance'), ('POST', '/api/queue/execute'),
                  ('POST', '/api/worker/exports/access'), ('GET', '/api/generate/upscale/status'),
                  ('POST', '/api/generate/image'), ('POST', '/api/generate/upscale'), ('POST', '/api/audio/transcribe'),
                  ('POST', '/api/history/exports'), ('POST', '/api/uploads/presign'), ('PUT', '/api/uploads/local'),
                  ('POST', f'/api/agent-conversations/{ID}/runs'), ('POST', f'/api/agent-conversations/{ID}/runs/{ID}/approve'),
                  ('POST', f'/api/agent-conversations/{ID}/transcribe'), ('POST', f'/api/canvas-boards/{ID}/captions'),
                  ('POST', f'/api/canvas-boards/{ID}/ai-jobs'), ('POST', f'/api/canvas-boards/{ID}/talktracks/{ID}/transcript')]
        server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler(SECRET))  # every flag off
        server.daemon_threads = True
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        port = serve(server)
        for method, path in closed:
            head, rest = path[len('/api/'):][0], path[len('/api/') + 1:]
            variants = [f'/api/%{ord(head):02x}{rest}', f'/api/%{ord(head):02X}{rest}', f'/api/%25{ord(head):02x}{rest}',
                        '/api/' + head + rest.replace('/', '%2f', 1), path.replace('/api/', '/api//', 1), path + '%00',
                        path.replace('/api/', '/api/./', 1), path.replace('/api/', '/api/x/../', 1), path + '/.']
            for variant in variants:
                connection = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
                try:
                    connection.request(method, variant, headers={gateway.HEADER: SECRET})
                    status = connection.getresponse().status
                finally:
                    connection.close()
                self.assertIn(status, (400, 403), (method, variant, status))

    def test_encoded_open_routes_still_reach_upstream_with_the_original_path(self):
        seen = []

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                seen.append(self.path)
                self.send_response(200)
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'ok')
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler(SECRET))
        for running in (upstream, server):
            running.daemon_threads = True
            self.addCleanup(running.server_close)
            self.addCleanup(running.shutdown)
        up_port, port = serve(upstream), serve(server)
        real = http.client.HTTPConnection

        def connection(host, target, *args, **kwargs):
            return real(host, up_port if target == 18080 else target, *args, **kwargs)
        with patch.object(http.client, 'HTTPConnection', connection):
            for path in ('/api/media/uploads/a%20b.png', '/api/%6dedia/x.png', '/api/admin/work%73pace'):
                conn = real('127.0.0.1', port, timeout=10)
                try:
                    conn.request('GET', path, headers={gateway.HEADER: SECRET})
                    self.assertEqual(conn.getresponse().status, 200, path)
                finally:
                    conn.close()
        self.assertEqual(seen, ['/api/media/uploads/a%20b.png', '/api/%6dedia/x.png', '/api/admin/work%73pace'])

    def test_only_media_derivatives_are_pinned(self):
        upstream_cache = {
            '/api/media/thumbs/512/canvas/b/a.png.webp': 'private, max-age=31536000, immutable',
            '/api/media/canvas/b/a.png?inline=1': 'private, no-store',
            '/api/media/canvas/b/odd.png': 'public, max-age=31536000, immutable',
        }

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header('Cache-Control', upstream_cache[self.path])
                self.send_header('Content-Length', '2')
                self.end_headers()
                self.wfile.write(b'ok')
        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler(SECRET))
        for running in (upstream, server):
            running.daemon_threads = True
            self.addCleanup(running.server_close)
            self.addCleanup(running.shutdown)
        up_port, port = serve(upstream), serve(server)
        real = http.client.HTTPConnection

        def connection(host, target, *args, **kwargs):
            return real(host, up_port if target == 18080 else target, *args, **kwargs)
        seen = {}
        with patch.object(http.client, 'HTTPConnection', connection):
            for path in upstream_cache:
                conn = real('127.0.0.1', port, timeout=10)
                try:
                    conn.request('GET', path, headers={gateway.HEADER: SECRET})
                    response = conn.getresponse()
                    response.read()
                    seen[path] = response.getheader('Cache-Control')
                finally:
                    conn.close()
        self.assertEqual(seen, {
            '/api/media/thumbs/512/canvas/b/a.png.webp': 'private, max-age=31536000, immutable',
            '/api/media/canvas/b/a.png?inline=1': 'no-store',
            '/api/media/canvas/b/odd.png': 'no-store',
        })

    def test_provider_routes_need_paid_routes_but_admin_routes_do_not(self):
        for path in ('/api/audio/transcribe', f'/api/agent-conversations/{ID}/transcribe', f'/api/agent-conversations/{ID}/runs',
                     f'/api/agent-conversations/{ID}/runs/{ID}/approve'):
            self.assertFalse(gateway.allowed('POST', path, False, True, True), path)
        # The voice caps are a read: open without paid routes.
        self.assertTrue(gateway.allowed('GET', f'/api/agent-conversations/{ID}/transcribe', False, True, True))
        # Reading a run, declining a quote and stopping a run never pay.
        self.assertTrue(gateway.allowed('GET', f'/api/agent-conversations/{ID}/runs/{ID}/events'))
        for action in ('decline', 'cancel'):
            self.assertTrue(gateway.allowed('POST', f'/api/agent-conversations/{ID}/runs/{ID}/{action}'), action)
        for method, path in (('POST', '/api/admin/users'), ('POST', '/api/admin/limits'), ('GET', '/api/admin/status')):
            self.assertTrue(gateway.allowed(method, path), (method, path))
        self.assertFalse(gateway.allowed('POST', '/api/admin/audit/runtime', **PRODUCTION))

    def test_uppercase_agent_paid_routes_are_still_paid_routes(self):
        conversation, run = f'/api/agent-conversations/{ID}', f'/api/agent-conversations/{ID}/runs/{ID}'
        for path in (f'{conversation}/RUNS', f'{run}/APPROVE',
                     f'{conversation.upper()}/runs',
                     f'/api/agent-conversations/{ID.upper()}/runs/{ID.upper()}/approve'):
            with self.subTest(path=path):
                self.assertFalse(gateway.allowed('POST', path, False, True, True))
                self.assertTrue(gateway.agent_paid('POST', path), 'refused as a paid route')
                self.assertTrue(gateway.allowed('POST', path, **PRODUCTION))
        for action in ('decline', 'CANCEL'):
            self.assertTrue(gateway.allowed('POST', f'{run}/{action}'), action)
            self.assertFalse(gateway.agent_paid('POST', f'{run}/{action}'), action)

    def test_long_running_posts_wait_longer_for_response_headers(self):
        self.assertEqual(gateway.upstream_wait('POST', '/api/generate/image'), 120)
        self.assertEqual(gateway.upstream_wait('POST', '/api/generate/video'), 120)
        # Transcription answers its own 504 after 120 s, so the gateway waits a little longer.
        self.assertEqual(gateway.upstream_wait('POST', '/api/audio/transcribe'), 125)
        self.assertEqual(gateway.upstream_wait('POST', f'/api/agent-conversations/{ID}/transcribe'), 120)
        for method, path in (('GET', '/api/audio/transcribe'), ('POST', '/api/admin/users'), ('POST', '/api/generate/upscale'),
                             ('GET', '/api/history')):
            self.assertEqual(gateway.upstream_wait(method, path), 25, (method, path))

    def test_board_captions_and_talktrack_transcripts_are_paid_transcriptions(self):
        board = f'/api/canvas-boards/{ID}'
        for path in (f'{board}/captions', f'{board}/captions/', f'{board.upper()}/CAPTIONS',
                     f'{board}/talktracks/{ID}/transcript', f'{board}/talktracks/{ID}/transcript/'):
            with self.subTest(path=path):
                self.assertFalse(gateway.allowed('POST', path, False, True, True))
                self.assertTrue(gateway.allowed('POST', path, **PRODUCTION))
                self.assertEqual(gateway.upstream_wait('POST', path), gateway.upstream_wait('POST', '/api/audio/transcribe'))
        # The quote and the VTT are reads, open without the paid routes and on the default wait.
        for path in (f'{board}/captions', f'{board}/captions/vtt'):
            with self.subTest(path=path):
                self.assertTrue(gateway.allowed('GET', path))
                self.assertEqual(gateway.upstream_wait('GET', path), 25)


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


def serve(server):
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server.server_address[1]


class GatewayThroughDjangoTests(TransactionTestCase):
    """The real gateway handler in front of Django: Django's admin gate answers once the gateway lets a route through."""

    def setUp(self):
        from apps.authentication.models import User
        from apps.authentication.password import hash_password
        from apps.authentication.session import sign_session
        credentials = hash_password('fixture-password')
        self.users = {}
        for role in ('admin', 'user'):
            user = User.objects.create(id=uuid.uuid4(), email=f'{role}@example.invalid', name=role.title(), role=role,
                                       password_hash=credentials['hash'], password_salt=credentials['salt'], created_at=1,
                                       is_active=True, auth_version=0)
            self.users[role] = (user, sign_session(user))
        from django.core.handlers.wsgi import WSGIHandler
        django = WSGIHandler()

        def application(environ, start_response):
            try:
                return list(django(environ, start_response))
            finally:
                connections.close_all()  # the test database must not keep this thread's connection
        upstream_server = make_server('127.0.0.1', 0, application, handler_class=QuietHandler)
        server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler(SECRET, **PRODUCTION))
        server.daemon_threads = True
        for running in (upstream_server, server):
            self.addCleanup(running.server_close)
            self.addCleanup(running.shutdown)
        upstream, self.port = serve(upstream_server), serve(server)
        # The gateway always dials gunicorn on 127.0.0.1:18080; send that to the in-process Django server instead.
        real = http.client.HTTPConnection

        def connection(host, port, *args, **kwargs):
            return real(host, upstream if port == 18080 else port, *args, **kwargs)
        patcher = patch.object(http.client, 'HTTPConnection', connection)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.direct = real

    def call(self, method, path, role=None, body=None):
        headers = {gateway.HEADER: SECRET, 'Sec-Fetch-Site': 'same-origin'}
        if role:
            headers['Cookie'] = 'veevee_session=' + self.users[role][1]
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers['Content-Type'] = 'application/json'
        connection = self.direct('127.0.0.1', self.port, timeout=30)
        try:
            connection.request(method, path, body=data, headers=headers)
            response = connection.getresponse()
            raw = response.read()
        finally:
            connection.close()
        return response.status, (json.loads(raw) if raw[:1] in (b'{', b'[') else raw)

    def test_admin_routes_answer_401_without_a_session_and_403_for_a_non_admin(self):
        member = str(self.users['user'][0].id)
        routes = [('POST', '/api/admin/users', {'email': 'new@example.invalid', 'password': 'fixture-password'}),
                  ('PATCH', '/api/admin/users', {'id': member, 'name': 'Renamed'}), ('DELETE', f'/api/admin/users?id={member}', None),
                  ('POST', '/api/admin/pricing', {'model': 'Nano Banana Pro', 'unitCostCents': 15, 'unit': 'per_image'}),
                  ('POST', '/api/admin/limits', {'key': 'maxConcurrentJobs', 'value': 3}),
                  ('POST', '/api/admin/user-limits', {'userId': member, 'key': 'maxConcurrentJobs', 'value': 2}),
                  ('GET', '/api/admin/status', None), ('GET', '/api/admin/data', None)]
        for method, path, body in routes:
            with self.subTest(method=method, path=path):
                self.assertEqual(self.call(method, path, None, body), (401, {'error': 'UNAUTHENTICATED'}))
                self.assertEqual(self.call(method, path, 'user', body), (403, {'error': 'FORBIDDEN'}))

    def test_an_admin_can_change_users_limits_and_pricing_through_the_gateway(self):
        from apps.admin_dashboard.models import AppSetting, Pricing, UserLimit
        from apps.authentication.models import User
        status, created = self.call('POST', '/api/admin/users', 'admin', {'email': 'new@example.invalid', 'password': 'fixture-password', 'name': 'New'})
        self.assertEqual(status, 200, created)
        status, updated = self.call('PATCH', '/api/admin/users', 'admin', {'id': created['user']['id'], 'name': 'Renamed'})
        self.assertEqual((status, updated['user']['name']), (200, 'Renamed'))
        self.assertEqual(self.call('POST', '/api/admin/limits', 'admin', {'key': 'maxConcurrentJobs', 'value': 3}), (200, {'ok': True}))
        self.assertEqual(AppSetting.objects.get(key='maxConcurrentJobs').value, '3')
        self.assertEqual(self.call('POST', '/api/admin/user-limits', 'admin', {'userId': created['user']['id'], 'key': 'maxConcurrentJobs', 'value': 2}),
                         (200, {'ok': True}))
        self.assertEqual(UserLimit.objects.get(user_id=created['user']['id'], key='maxConcurrentJobs').value, '2')
        self.assertEqual(self.call('POST', '/api/admin/pricing', 'admin', {'model': 'Nano Banana Pro', 'unitCostCents': 15, 'unit': 'per_image'}),
                         (200, {'ok': True}))
        self.assertEqual(Pricing.objects.get(model='Nano Banana Pro').unit_cost_cents, 15)
        self.assertEqual(self.call('DELETE', f'/api/admin/users?id={created["user"]["id"]}', 'admin'), (200, {'ok': True}))
        self.assertFalse(User.objects.filter(email='new@example.invalid').exists())

    def test_the_dashboard_shows_what_the_gateway_refuses_as_off(self):
        # Behind the deployed entrypoint (component "api") the gateway's own table decides; elsewhere nothing is in between.
        with override_settings(VEEVEE_RUNTIME_COMPONENT='api'):
            status, data = self.call('GET', '/api/admin/data', 'admin')
        self.assertEqual((status, data['operations']), (200, {'runtimeAudit': False, 'higgsfieldToken': False}))
        status, data = self.call('GET', '/api/admin/data', 'admin')
        self.assertEqual((status, data['operations']), (200, {'runtimeAudit': True, 'higgsfieldToken': True}))

    def test_closed_admin_routes_are_refused_by_the_gateway_even_for_an_admin(self):
        disabled = (403, {'error': 'This operation is not available.', 'code': 'PREVIEW_OPERATION_DISABLED'})
        for path in ('/api/admin/audit/runtime', '/api/admin/set-token', '/api/admin/migrate-schema'):
            self.assertEqual(self.call('POST', path, 'admin', {}), disabled, path)

    def test_opened_provider_routes_reach_django(self):
        # Without a session Django itself answers (the gateway no longer refuses with PREVIEW_PAID_PROVIDER_DISABLED).
        self.assertEqual(self.call('POST', '/api/audio/transcribe', None, {}), (401, {'error': 'UNAUTHENTICATED'}))
        self.assertEqual(self.call('POST', f'/api/agent-conversations/{ID}/runs', 'user', {'content': 'x'}),
                         (403, {'error': 'Agents are turned off.', 'code': 'AGENTS_DISABLED'}))
        self.assertEqual(self.call('POST', f'/api/agent-conversations/{ID}/runs', 'admin', {'content': 'x'}),
                         (404, {'error': 'Conversation not found.'}))
