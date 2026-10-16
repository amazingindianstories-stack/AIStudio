"""Bounded adaptation of server-terminated request bodies for Django WSGI."""
import json
import tempfile
import uuid
import threading
from urllib.parse import parse_qs

from django.conf import settings


class CapacityClosingIterator:
    def __init__(self, response, capacity):
        self.response, self.capacity, self.closed = response, capacity, False

    def __iter__(self):
        try:
            yield from self.response
        finally:
            self.close()

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            close = getattr(self.response, 'close', None)
            if close:
                close()
        finally:
            self.capacity.release()


def slow_request_application(application, *, slots=2):
    """Reserve capacity through streaming completion/disconnect, before any work.

    Two slow calls per four-thread worker leave capacity for ordinary API work.
    This is process-local admission, not a distributed spend or request budget.
    """
    capacity = threading.BoundedSemaphore(slots)
    def handle(environ, start_response):
        path = environ.get('PATH_INFO', '')
        method = environ.get('REQUEST_METHOD', 'GET')
        slow = (method == 'POST' and path in ('/api/audio/transcribe','/api/generate/upscale',
                    '/api/generate/image','/api/generate/video') or
                method == 'PUT' and (path == '/api/uploads/local' or path.startswith('/api/uploads/') and path.endswith('/local')) or
                method == 'GET' and (path in ('/api/media-grant','/api/generate/upscale/status') or
                    path.startswith('/api/generations/') and path.endswith('/download') or
                    path.startswith('/api/media/') and '1' in parse_qs(environ.get('QUERY_STRING','')).get('inline',[])))
        if not slow:
            return application(environ, start_response)
        if not capacity.acquire(blocking=False):
            payload = b'{"error":"SLOW_REQUEST_CAPACITY_BUSY"}'
            start_response('429 Too Many Requests', [('Content-Type','application/json'),
                ('Content-Length',str(len(payload))),('Cache-Control','no-store'),('Retry-After','1')])
            return [payload]
        try:
            return CapacityClosingIterator(application(environ,start_response),capacity)
        except BaseException:
            capacity.release()
            raise
    return handle


class BodyClosingIterator:
    def __init__(self, response, body):
        self.response, self.body = response, body

    def __iter__(self):
        return iter(self.response)

    def close(self):
        try:
            close = getattr(self.response, 'close', None)
            if close:
                close()
        finally:
            self.body.close()


def terminated_body_application(application):
    """Gunicorn decodes chunked input; Django otherwise treats no length as empty.

    Trust only the WSGI server's termination flag, never a client header. Spool
    within the configured body limit before supplying Django an exact length.
    Fixed-length requests and read-only methods retain the ordinary WSGI path.
    """
    def handle(environ, start_response):
        if (environ.get('CONTENT_LENGTH') or
                environ.get('REQUEST_METHOD', 'GET') in ('GET', 'HEAD', 'OPTIONS') or
                environ.get('wsgi.input_terminated') is not True):
            return application(environ, start_response)
        limit = settings.DATA_UPLOAD_MAX_MEMORY_SIZE
        if limit is None:
            limit = 32 * 1024 * 1024
        body = tempfile.SpooledTemporaryFile(max_size=settings.FILE_UPLOAD_MAX_MEMORY_SIZE, mode='w+b')
        size = 0
        try:
            while True:
                chunk = environ['wsgi.input'].read(min(65536, limit + 1 - size))
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    payload = json.dumps({'error': 'REQUEST_BODY_TOO_LARGE'}).encode()
                    start_response('413 Payload Too Large', [
                        ('Content-Type', 'application/json'), ('Content-Length', str(len(payload))),
                        ('Cache-Control', 'no-store'), ('X-Request-ID', str(uuid.uuid4()))])
                    body.close()
                    return [payload]
                body.write(chunk)
            body.seek(0)
            adapted = dict(environ, **{'wsgi.input': body, 'CONTENT_LENGTH': str(size)})
            return BodyClosingIterator(application(adapted, start_response), body)
        except BaseException:
            body.close()
            raise
    return handle
