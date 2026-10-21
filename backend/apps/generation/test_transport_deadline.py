"""Offline socket-level provider response deadline and cleanup qualification."""
import http.client
import socket
import threading
import time
from unittest.mock import patch, Mock
import requests
import urllib3
from django.test import SimpleTestCase
from apps.integrations.transport import HttpTransport, ProviderError


class ProviderResponseDeadlineTests(SimpleTestCase):
    def response(self, payload, delay):
        left, right = socket.socketpair()
        left.settimeout(1)
        right.sendall(f'HTTP/1.1 200 OK\r\nContent-Length: {len(payload)}\r\n\r\n'.encode())
        disconnected = threading.Event()
        def send():
            try:
                for byte in payload:
                    right.sendall(bytes([byte]))
                    time.sleep(delay)
            except OSError:
                disconnected.set()
            finally:
                right.close()
        thread = threading.Thread(target=send)
        thread.start()
        raw = http.client.HTTPResponse(left)
        raw.begin()
        left.close()  # HTTPResponse owns the remaining file reference.
        response = requests.Response()
        response.status_code = 200
        response.raw = urllib3.response.HTTPResponse(body=raw, preload_content=False)
        self.addCleanup(left.close)
        self.addCleanup(response.close)
        self.addCleanup(lambda: thread.join(2))
        return response, thread, disconnected

    def test_trickle_deadline_interrupts_buffered_read_without_late_result(self):
        response, thread, disconnected = self.response(b'x'*100, .02)
        transport = HttpTransport(allowed_hosts=['fixture.invalid'])
        start = time.monotonic()
        with self.assertRaises(ProviderError) as failure:
            with response:
                transport._read_body(response, start+.12)
        self.assertEqual(failure.exception.code, 'response_deadline')
        self.assertTrue(failure.exception.may_have_submitted)
        self.assertLess(time.monotonic()-start, .7)
        thread.join(1)
        self.assertFalse(thread.is_alive())
        self.assertTrue(disconnected.is_set())

    def test_success_and_size_limit_cancel_watchdog(self):
        response, thread, _ = self.response(b'{"ok":true}', 0)
        with patch('apps.integrations.transport.threading.Timer', wraps=threading.Timer) as timer:
            result = HttpTransport(allowed_hosts=[])._read_body(response,time.monotonic()+1)
        self.assertEqual(result,b'{"ok":true}')
        self.assertEqual(timer.call_count,1)
        response, thread, _ = self.response(b'x'*20, 0)
        with self.assertRaises(ProviderError) as failure:
            HttpTransport(allowed_hosts=[],max_response_bytes=10)._read_body(response,time.monotonic()+1)
        self.assertEqual(failure.exception.code,'response_too_large')

    def test_paid_request_deadline_never_retries_and_closes_response(self):
        response, thread, disconnected = self.response(b'x'*100,.02)
        with patch('requests.Session') as factory:
            session = factory.return_value.__enter__.return_value
            session.request.return_value = response
            with self.assertRaises(ProviderError) as failure:
                HttpTransport(allowed_hosts=['fixture.invalid'],timeout=.12).request(
                    'POST','https://fixture.invalid/paid',body={'prompt':'fixture'})
            self.assertIn(failure.exception.code,('response_deadline','request_deadline'))
            session.request.assert_called_once()
            self.assertFalse(session.trust_env)
            self.assertFalse(session.request.call_args.kwargs['allow_redirects'])
        self.assertTrue(response.raw.closed)
        thread.join(1)
        self.assertFalse(thread.is_alive())

    def test_missing_live_socket_fails_closed_before_body_and_timer(self):
        response=Mock()
        response.raw=Mock(closed=False,_fp=None)
        with patch('apps.integrations.transport.threading.Timer') as timer:
            with self.assertRaises(ProviderError) as failure:
                HttpTransport(allowed_hosts=[])._read_body(response,time.monotonic()+1)
        self.assertEqual(failure.exception.code,'response_deadline_unavailable')
        response.iter_content.assert_not_called()
        timer.assert_not_called()
