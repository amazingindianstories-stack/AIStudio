"""Bounded HTTP JSON transport with explicit credentials and no implicit retry."""
from dataclasses import dataclass, field
import json
import socket
import threading
import time
from urllib.parse import urlsplit

from .errors import ProviderError


@dataclass
class HttpResult:
    status: int
    body: bytes
    headers: dict = field(default_factory=dict)

    @property
    def ok(self):
        return 200 <= self.status < 300

    @property
    def text(self):
        return self.body.decode('utf-8', errors='replace')

    def json(self):
        return json.loads(self.body)


class HttpTransport:
    def __init__(self, *, allowed_hosts, timeout=60, max_response_bytes=32 * 1024 * 1024):
        self.allowed_hosts = frozenset(allowed_hosts)
        self.timeout = timeout
        self.max_response_bytes = max_response_bytes

    def request(self, method, url, *, headers=None, body=None, raw_body=None, signal=None):
        import requests
        parsed = urlsplit(url)
        if parsed.scheme != 'https' or parsed.hostname not in self.allowed_hosts or parsed.username or parsed.password:
            raise ProviderError('Provider endpoint is not an approved HTTPS host.', code='invalid_provider_endpoint')
        if signal:
            signal.check()
        timeout = min(self.timeout, signal.remaining()) if signal else self.timeout
        if raw_body is not None and body is not None:
            raise ValueError('body and raw_body are mutually exclusive')
        content = {'data': raw_body} if raw_body is not None else {'json': body}
        deadline = time.monotonic() + timeout
        # No retries on ambiguous POST failure and no redirect credential leak.
        # Session.trust_env=False also avoids checkout proxy/.netrc credentials.
        from .request_deadline import SocketDeadline, deadline_adapter
        with SocketDeadline(deadline) as guard:
            try:
                with requests.Session() as session:
                    session.trust_env = False
                    session.mount('https://', deadline_adapter(guard))
                    with session.request(method, url, headers=headers, **content,
                            allow_redirects=False, timeout=(min(10, timeout), timeout), stream=True) as response:
                        guard.check()
                        result = HttpResult(response.status_code,
                            self._read_body(response, deadline, signal), dict(response.headers))
                        guard.check()
                        return result
            except Exception as error:
                if guard.expired.is_set() or time.monotonic() >= deadline:
                    raise ProviderError('Provider request deadline exceeded.', code='request_deadline',
                        may_have_submitted=getattr(error,'may_have_submitted',True)) from error
                raise

    def _read_body(self, response, deadline, signal=None):
        # requests/urllib3 can buffer a trickling body inside iter_content. A
        # deadline check between yielded chunks alone cannot interrupt that read.
        # Each Session handles one request: shutdown cannot affect a pooled user.
        expired = threading.Event()
        raw_socket = getattr(getattr(getattr(getattr(response.raw, '_fp', None),
            'fp', None), 'raw', None), '_sock', None)
        if raw_socket is None and not response.raw.closed:
            raise ProviderError('Provider response deadline cannot be enforced.',
                code='response_deadline_unavailable')
        def expire():
            expired.set()
            if raw_socket is not None:
                try:
                    raw_socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            expire()
            raise ProviderError('Provider response deadline exceeded.', code='response_deadline')
        timer = threading.Timer(remaining, expire)
        timer.daemon = True
        timer.start()
        chunks, total = [], 0
        try:
            for chunk in response.iter_content(65536):
                if expired.is_set() or time.monotonic() >= deadline:
                    raise ProviderError('Provider response deadline exceeded.', code='response_deadline')
                if signal:
                    signal.check()
                total += len(chunk)
                if total > self.max_response_bytes:
                    raise ProviderError('Provider response exceeds the configured limit.', code='response_too_large')
                chunks.append(chunk)
            if expired.is_set() or time.monotonic() >= deadline:
                raise ProviderError('Provider response deadline exceeded.', code='response_deadline')
            return b''.join(chunks)
        except Exception as error:
            if expired.is_set():
                raise ProviderError('Provider response deadline exceeded.', code='response_deadline') from error
            raise
        finally:
            timer.cancel()
            timer.join()


def required_key(env, key, message=None):
    value = env.get(key)
    if not value or value == '[SENSITIVE]':
        raise ProviderError(message or f'{key} is not set.', code='missing_configuration')
    return value
