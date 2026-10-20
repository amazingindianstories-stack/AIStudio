"""Bounded provider-media downloads: allowlisted HTTPS, pinned public DNS addresses.

The connection uses the checked IP while TLS verifies the original hostname.
Redirects are revalidated and never forward credentials/cookies.
"""
from .errors import MediaTooLargeError
from apps.integrations.dns import MEDIA_RESOLVER
from apps.generation.providers.request_deadline import SocketDeadline
import http.client
import ipaddress
import socket
import ssl
import tempfile
import time
from contextlib import contextmanager
from urllib.parse import urlsplit, urljoin
from django.conf import settings


class UnsafeMediaURL(ValueError):
    pass


def validated_target(url, allowed_hosts, resolver=socket.getaddrinfo):
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        if parsed.scheme != 'https' or not hostname or parsed.username or parsed.password or parsed.port not in (None,443):
            raise UnsafeMediaURL('Media URL must be HTTPS without credentials or a custom port.')
        host = hostname.rstrip('.').lower().encode('idna').decode()
        allowed = any(host == entry.lower() or (entry.startswith('*.') and host.endswith(entry[1:].lower())
            and host != entry[2:].lower()) for entry in allowed_hosts)
        if not allowed:
            raise UnsafeMediaURL('Media host is not configured for provider downloads.')
        addresses = {entry[4][0] for entry in resolver(host,443,type=socket.SOCK_STREAM)}
        if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise UnsafeMediaURL('Media URLs cannot address private or reserved networks.')
        return host, sorted(addresses)[0], (parsed.path or '/') + ('?'+parsed.query if parsed.query else '')
    except (ValueError, UnicodeError, socket.gaierror) as error:
        if isinstance(error,UnsafeMediaURL):
            raise
        raise UnsafeMediaURL('Invalid provider media URL.') from error


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, hostname, address, timeout):
        super().__init__(hostname,timeout=timeout,context=ssl.create_default_context())
        self.address = address

    def connect(self):
        guard = getattr(self,'deadline_guard',None)
        if guard is not None:
            guard.check()
            self.timeout = min(self.timeout,max(.001,guard.deadline-time.monotonic()))
        raw = socket.create_connection((self.address,443),self.timeout)
        try:
            if guard is not None:
                guard.bind(raw)
                guard.check()
            self.sock = self._context.wrap_socket(raw,server_hostname=self.host)
        except Exception:
            raw.close()
            raise


class SafeMediaFetcher:
    def __init__(self, allowed_hosts, *, max_bytes=512*1024*1024, timeout=30,
                 resolver=socket.getaddrinfo, connection= PinnedHTTPSConnection,
                 total_timeout=270, clock=time.monotonic, dns=None):
        self.allowed_hosts, self.max_bytes, self.timeout = tuple(allowed_hosts), max_bytes, timeout
        self.resolver, self.connection = resolver, connection
        self.total_timeout, self.clock = total_timeout, clock
        self.dns = MEDIA_RESOLVER if dns is None else dns

    def __call__(self,url):
        with self.open_file(url) as (stream, mime):
            return stream.read(), mime

    @contextmanager
    def open_file(self,url,*,max_bytes=None):
        """Spool bounded chunks to disk; caller owns no payload-sized chunk list."""
        limit = self.max_bytes if max_bytes is None else min(self.max_bytes,max_bytes)
        deadline = self.clock() + self.total_timeout
        def remaining():
            budget = deadline - self.clock()
            if budget <= 0:
                raise TimeoutError('Provider media download exceeded its total deadline.')
            return min(self.timeout, budget)
        for _ in range(6):
            def resolve(*args,**kwargs):
                return self.dns.resolve(self.resolver,*args,timeout=remaining(),**kwargs)
            host,address,path = validated_target(url,self.allowed_hosts,resolve)
            connection = self.connection(host,address,remaining())
            guard = None
            try:
                if isinstance(connection,PinnedHTTPSConnection):
                    candidate = SocketDeadline(time.monotonic()+deadline-self.clock())
                    candidate.__enter__()
                    guard = candidate
                    connection.deadline_guard = guard
                    guard.check()
                connection.request('GET',path,headers={'Accept-Encoding':'identity','User-Agent':'Veevee-Media/1'})
                if guard is not None and guard.socket is None and connection.sock is not None:
                    guard.bind(connection.sock)
                    guard.check()
                response = connection.getresponse()
                if response.status in (301,302,303,307,308):
                    location = response.getheader('Location')
                    if not location:
                        raise ValueError('Provider returned a redirect without a destination.')
                    url = urljoin(url,location)
                    continue
                if response.status < 200 or response.status >= 300:
                    raise ValueError(f'Failed to download media ({response.status})')
                declared = response.getheader('Content-Length')
                if declared is not None and not declared.isdigit():
                    raise ValueError('Provider media exceeds the configured download limit.')
                if declared is not None and int(declared) > limit:
                    raise MediaTooLargeError('Provider media exceeds the configured download limit.')
                with tempfile.TemporaryFile(prefix='veevee-provider-media-') as incoming:
                    total = 0
                    while True:
                        budget = remaining()
                        if isinstance(connection, PinnedHTTPSConnection) and connection.sock is not None:
                            connection.sock.settimeout(budget)
                        # read1 performs one buffered/socket read. read(n) can
                        # internally wait forever on a peer trickling bytes.
                        read = response.read1 if isinstance(response,http.client.HTTPResponse) else response.read
                        chunk = read(min(256*1024,limit-total+1))
                        remaining()
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > limit:
                            raise MediaTooLargeError('Provider media exceeds the configured download limit.')
                        incoming.write(chunk)
                    if declared is not None and total != int(declared):
                        raise IOError('Provider media ended before its declared length.')
                    incoming.seek(0)
                    # Network work is complete; do not leave a timer running
                    # while the caller persists or inspects the local spool.
                    if guard is not None:
                        guard.__exit__(None,None,None)
                        guard = None
                    yield incoming,response.getheader('Content-Type') or 'application/octet-stream'
                return
            except Exception:
                if guard is not None and (guard.expired.is_set() or time.monotonic() >= guard.deadline):
                    raise TimeoutError('Provider media download exceeded its total deadline.') from None
                raise
            finally:
                if guard is not None:
                    guard.__exit__(None,None,None)
                connection.close()
        raise ValueError('Too many provider media redirects.')


def get_media_fetcher():
    fetcher = getattr(settings,'VEEVEE_MEDIA_FETCHER',None)
    if fetcher is not None:
        return fetcher
    return SafeMediaFetcher(getattr(settings,'VEEVEE_PROVIDER_MEDIA_HOSTS',()))
