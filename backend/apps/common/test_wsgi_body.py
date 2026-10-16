import io
from unittest.mock import patch
from django.core.handlers.wsgi import WSGIRequest
from django.test import SimpleTestCase, override_settings
from .wsgi import terminated_body_application


class TerminatedBodyTests(SimpleTestCase):
    def environment(self, raw, **extra):
        return {'REQUEST_METHOD': 'POST', 'PATH_INFO': '/api/projects',
            'SERVER_NAME': 'localhost', 'SERVER_PORT': '80', 'wsgi.url_scheme': 'http',
            'CONTENT_TYPE': 'application/json', 'wsgi.input': io.BytesIO(raw),
            'wsgi.input_terminated': True, **extra}

    def test_django_receives_full_json_and_body_is_closed_with_response(self):
        raw = b'{"op":"createProject","name":""}'
        bodies = []
        def downstream(environ, start):
            bodies.append(environ['wsgi.input'])
            request = WSGIRequest(environ)
            self.assertEqual(request.body, raw)
            start('200 OK', [])
            return [b'ok']
        response = terminated_body_application(downstream)(self.environment(raw), lambda *_: None)
        self.assertEqual(list(response), [b'ok'])
        response.close()
        self.assertTrue(bodies[0].closed)

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=64, FILE_UPLOAD_MAX_MEMORY_SIZE=16)
    def test_oversize_stops_at_limit_plus_one_without_downstream_effects(self):
        env = self.environment(b'x' * 1000)
        status = []
        def forbidden(*args):
            self.fail('Oversized body reached Django')
        response = terminated_body_application(forbidden)(env, lambda value, headers: status.append(value))
        self.assertEqual(status, ['413 Payload Too Large'])
        self.assertEqual(env['wsgi.input'].tell(), 65)
        self.assertIn(b'REQUEST_BODY_TOO_LARGE', response[0])

    def test_client_transfer_header_does_not_authorize_unterminated_read(self):
        env = self.environment(b'private', **{'wsgi.input_terminated': False, 'HTTP_TRANSFER_ENCODING': 'chunked'})
        seen = []
        result = terminated_body_application(lambda environ, start: seen.append(environ) or [])(env, lambda *_: None)
        self.assertEqual(result, [])
        self.assertIs(seen[0], env)
        self.assertEqual(env['wsgi.input'].tell(), 0)

    @override_settings(FILE_UPLOAD_MAX_MEMORY_SIZE=16)
    def test_multipart_unknown_length_is_parsed_from_disk_spool(self):
        raw = b'--boundary\r\nContent-Disposition: form-data; name="name"\r\n\r\nArtist\r\n--boundary--\r\n'
        def downstream(environ, start):
            self.assertTrue(environ['wsgi.input']._rolled)
            self.assertEqual(WSGIRequest(environ).POST['name'], 'Artist')
            return []
        response = terminated_body_application(downstream)(self.environment(raw, CONTENT_TYPE='multipart/form-data; boundary=boundary'), lambda *_: None)
        response.close()

    @override_settings(DATA_UPLOAD_MAX_MEMORY_SIZE=64)
    def test_exact_limit_is_accepted(self):
        raw = b'x' * 64
        def downstream(environ, start):
            self.assertEqual(WSGIRequest(environ).body, raw)
            return []
        response = terminated_body_application(downstream)(self.environment(raw), lambda *_: None)
        response.close()

    def test_downstream_invocation_failure_closes_body(self):
        body = io.BytesIO()
        def downstream(*args):
            raise RuntimeError('synthetic downstream failure')
        with patch('apps.common.wsgi.tempfile.SpooledTemporaryFile', return_value=body):
            with self.assertRaisesMessage(RuntimeError, 'synthetic downstream failure'):
                terminated_body_application(downstream)(self.environment(b'input'), lambda *_: None)
        self.assertTrue(body.closed)

    def test_response_close_failure_still_closes_body(self):
        bodies = []
        class BrokenResponse:
            def __iter__(self):
                return iter([])
            def close(self):
                raise RuntimeError('synthetic response close failure')
        def downstream(environ, start):
            bodies.append(environ['wsgi.input'])
            return BrokenResponse()
        response = terminated_body_application(downstream)(self.environment(b'input'), lambda *_: None)
        with self.assertRaisesMessage(RuntimeError, 'synthetic response close failure'):
            response.close()
        self.assertTrue(bodies[0].closed)
