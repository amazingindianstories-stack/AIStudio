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

    def test_cancellation_interrupts_a_blocked_response_without_waiting_thirty_minutes(self):
        from apps.generation.services.deadline import Cancellation, QueueExecutionDeadlineError
        from apps.integrations.request_deadline import SocketDeadline
        response, thread, _ = self.response(b'x' * 100, .02)
        signal = Cancellation()
        transport = HttpTransport(allowed_hosts=[])
        raw_socket = response.raw._fp.fp.raw._sock
        cancel = threading.Timer(.05, signal.cancelled.set)
        start = time.monotonic()
        cancel.start()
        try:
            with self.assertRaises(QueueExecutionDeadlineError):
                with response, SocketDeadline(signal.deadline, signal=signal) as guard:
                    guard.bind(raw_socket)
                    try:
                        transport._read_body(response, signal.deadline, signal)
                    finally:
                        signal.check()
        finally:
            cancel.join()
        self.assertLess(time.monotonic() - start, .7)

    def test_transport_uses_remaining_job_budget_for_slow_started_post(self):
        from apps.generation.services.deadline import Cancellation
        clock = [0.0]
        with patch('time.monotonic', side_effect=lambda: clock[0]), patch('requests.Session') as factory:
            signal = Cancellation()
            session = factory.return_value.__enter__.return_value
            response = session.request.return_value.__enter__.return_value
            response.status_code, response.headers = 200, {}
            def read(*args):
                clock[0] = 300
                return b'master'
            transport = HttpTransport(allowed_hosts=['fixture.invalid'], timeout=60)
            with patch.object(transport, '_read_body', side_effect=read):
                result = transport.request('POST', 'https://fixture.invalid/paid', signal=signal)
            self.assertEqual(result.body, b'master')
            self.assertEqual(session.request.call_args.kwargs['timeout'], (1800, 1800))
            session.request.assert_called_once()
