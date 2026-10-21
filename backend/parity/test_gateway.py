"""Frozen route policy and role responses at stable deployment seams.

routes.json was characterized at 0eb5a6e696afe4e17b05b1422fe82a67f6430b62
using test-db.sh, empty JSON bodies, explicit mock providers and same-origin
session clients. Each allow array indexes the paid/export/Magnific bit mask
(4/2/1). Expectations are committed evidence, never recomputed by tests.
Generation delete and move were updated to the admin-only 403 for users.
"""
import json
from pathlib import Path

from django.apps import apps
from django.test import Client, TransactionTestCase
from apps.authentication.session import sign_session
from deploy import gateway

CASES = json.loads(Path(__file__).with_name('routes.json').read_text())


class GatewayParityTests(TransactionTestCase):
    def setUp(self):
        self.clients = {'out': Client(raise_request_exception=False, HTTP_SEC_FETCH_SITE='same-origin')}
        for role in ('user', 'admin'):
            user = apps.get_model('authentication', 'User').objects.create(
                email=f'{role}@example.invalid', name=role, role=role,
                password_hash='fixture', password_salt='fixture', created_at=1)
            client = Client(raise_request_exception=False, HTTP_SEC_FETCH_SITE='same-origin')
            client.cookies['veevee_session'] = sign_session(user)
            self.clients[role] = client

    def test_route_policy_all_switch_combinations(self):
        for case in CASES:
            for switches in range(8):
                flags = tuple(bool(switches & bit) for bit in (4, 2, 1))
                with self.subTest(route=case['path'], method=case['method'], flags=flags):
                    self.assertEqual(gateway.allowed(case['method'], case['path'], *flags),
                                     case['allow'][switches])

    def test_http_status_by_session_role(self):
        # Each case starts with a fresh cookie since logout deliberately clears it.
        tokens = {role: client.cookies['veevee_session'].value for role, client in self.clients.items() if role != 'out'}
        for case in CASES:
            for role, client in self.clients.items():
                if role in tokens:
                    client.cookies['veevee_session'] = tokens[role]
                with self.subTest(route=case['path'], method=case['method'], role=role):
                    response = client.generic(case['method'], case['path'], b'{}', content_type='application/json')
                    self.assertEqual(response.status_code, case['status'][role])

    def test_gateway_handler_status_and_refusal_messages_for_each_role(self):
        import io
        from unittest.mock import patch

        class Socket:
            def __init__(self, request):
                self.request, self.response = io.BytesIO(request), io.BytesIO()
            def makefile(self, *args, **kwargs):
                return self.request
            def sendall(self, data):
                self.response.write(data)
            def settimeout(self, value):
                pass

        tokens = {role: client.cookies['veevee_session'].value for role, client in self.clients.items() if role != 'out'}
        for case in CASES:
            for role, client in self.clients.items():
                for switches in (0, 7):
                    flags = tuple(bool(switches & bit) for bit in (4, 2, 1))
                    with self.subTest(path=case['path'], method=case['method'], role=role, flags=flags):
                        if role in tokens:
                            client.cookies['veevee_session'] = tokens[role]
                        response_body = None
                        class Upstream:
                            sock = Socket(b'')
                            def __init__(self, *args, **kwargs):
                                pass
                            def request(self, method, path, body, headers):
                                nonlocal response_body
                                response = client.generic(method, path, body, content_type='application/json')
                                self.status = response.status_code
                                self.headers = list(response.items())
                                response_body = io.BytesIO(b''.join(response.streaming_content) if response.streaming else response.content)
                                response.close()
                            def getresponse(self):
                                return self
                            def getheader(self, key):
                                return next((v for k, v in self.headers if k.lower() == key.lower()), None)
                            def getheaders(self):
                                return self.headers
                            def read(self, count):
                                return response_body.read(count)
                            def close(self):
                                pass
                        request = (f'{case["method"]} {case["path"]} HTTP/1.0\r\nHost: localhost\r\n'
                                   f'{gateway.HEADER}: {"s" * 64}\r\nContent-Length: 2\r\n\r\n{{}}').encode()
                        sock = Socket(request)
                        with patch.object(gateway.http.client, 'HTTPConnection', Upstream):
                            gateway.handler('s' * 64, *flags)(sock, ('127.0.0.1', 1), None)
                        headers, body = sock.response.getvalue().split(b'\r\n\r\n', 1)
                        status = int(headers.split(b' ', 2)[1])
                        allowed = case['allow'][switches]
                        self.assertEqual(status, 501 if case['method'] == 'OPTIONS' else case['status'][role] if allowed else 403)
                        if not allowed and case['method'] != 'OPTIONS':
                            self.assertIsNone(response_body)
                            if case['method'] != 'HEAD':
                                paid = case['path'].startswith(('/api/generate/', '/api/audio/transcribe')) or (
                                    case['path'].startswith('/api/agent-conversations/') and case['path'].endswith('/messages')
                                    and case['method'] not in ('GET', 'HEAD'))
                                self.assertEqual(json.loads(body), {'error': 'This generation route is not available.' if paid else 'This operation is not available.',
                                    'code': 'PREVIEW_PAID_PROVIDER_DISABLED' if paid else 'PREVIEW_OPERATION_DISABLED'})
