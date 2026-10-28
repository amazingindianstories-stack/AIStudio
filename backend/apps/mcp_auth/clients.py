"""OAuth client identification: Client ID Metadata Documents (CIMD) and Dynamic Client Registration (DCR).

Only public clients exist (``token_endpoint_auth_method: none``); PKCE S256 protects every code. Redirect URIs
are https or loopback http on any port (Claude Code, Cursor, VS Code). Private-use native schemes are refused:
no in-scope client documents one for MCP OAuth, and a client without a verified redirect uses a personal access token.
"""
import ipaddress
import json
import secrets
import socket
import time
import uuid
from urllib.parse import urlsplit

from apps.common.leases import now_ms
from apps.integrations.dns import BoundedMediaResolver
from apps.integrations.remote import PinnedHTTPSConnection
from .models import McpClient

CIMD_MAX_BYTES = 5 * 1024
CIMD_TIMEOUT_SECONDS = 5
CIMD_CACHE_MS = 60 * 60 * 1000
UNUSED_DCR_TTL_MS = 24 * 60 * 60 * 1000
MAX_REDIRECT_URIS = 10
MAX_URI_LENGTH = 2000
LOOPBACK_HOSTS = ('127.0.0.1', 'localhost', '[::1]', '::1')
CIMD_DNS = BoundedMediaResolver(slots=2)


class ClientError(ValueError):
    """An unusable client or registration; ``error`` is the OAuth error code."""

    def __init__(self, error, description):
        super().__init__(description)
        self.error, self.description = error, description


def valid_redirect_uri(value):
    if not isinstance(value, str) or not value or len(value) > MAX_URI_LENGTH or any(ord(char) <= 32 or ord(char) == 127 for char in value):
        return False
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError:
        return False
    if parsed.fragment or parsed.username or parsed.password:
        return False
    scheme = parsed.scheme.lower()
    if scheme == 'https':
        return bool(parsed.hostname)
    if scheme == 'http':
        return parsed.hostname in LOOPBACK_HOSTS and (port is None or 0 < port < 65536)
    return False


def redirect_matches(registered, supplied):
    """Exact match, except that a loopback http redirect may use any port (RFC 8252 section 7.3)."""
    if supplied in registered:
        return True
    try:
        candidate = urlsplit(supplied)
        if candidate.scheme != 'http' or candidate.hostname not in LOOPBACK_HOSTS:
            return False
        for entry in registered:
            known = urlsplit(entry)
            if (known.scheme, known.hostname, known.path, known.query) == (candidate.scheme, candidate.hostname, candidate.path, candidate.query):
                return True
    except ValueError:
        return False
    return False


def optional_https(value, field):
    if value in (None, ''):
        return None
    if not isinstance(value, str) or len(value) > MAX_URI_LENGTH or urlsplit(value).scheme != 'https' or not urlsplit(value).hostname:
        raise ClientError('invalid_client_metadata', f'{field} must be an https URL.')
    return value


def clean_metadata(document, *, cimd_url=None):
    """Validate the client metadata both registration paths share; return model field values."""
    if not isinstance(document, dict):
        raise ClientError('invalid_client_metadata', 'Client metadata must be a JSON object.')
    uris = document.get('redirect_uris')
    if not isinstance(uris, list) or not 1 <= len(uris) <= MAX_REDIRECT_URIS or not all(valid_redirect_uri(uri) for uri in uris):
        raise ClientError('invalid_redirect_uri', 'Provide 1 to 10 redirect URIs: https or loopback http.')
    method = document.get('token_endpoint_auth_method', 'none')
    if method != 'none':
        raise ClientError('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none").')
    grants = document.get('grant_types', ['authorization_code'])
    if not isinstance(grants, list) or not set(grants) <= {'authorization_code', 'refresh_token'} or 'authorization_code' not in grants:
        raise ClientError('invalid_client_metadata', 'Supported grant types are authorization_code and refresh_token.')
    responses = document.get('response_types', ['code'])
    if responses != ['code']:
        raise ClientError('invalid_client_metadata', 'The only supported response type is code.')
    name = document.get('client_name')
    if name is not None and not isinstance(name, str):
        raise ClientError('invalid_client_metadata', 'client_name must be text.')
    name = ' '.join((name or '').split())[:100]
    fallback = urlsplit(cimd_url).hostname if cimd_url else 'Unnamed app'
    return {'client_name': name or fallback, 'redirect_uris': list(dict.fromkeys(uris)),
            'client_uri': optional_https(document.get('client_uri'), 'client_uri'),
            'logo_uri': optional_https(document.get('logo_uri'), 'logo_uri')}


def register(document, *, now=None):
    """Dynamic Client Registration (RFC 7591); returns the new client row."""
    now = now_ms() if now is None else now
    values = clean_metadata(document)
    return McpClient.objects.create(id=uuid.uuid4(), client_id='vvc_' + secrets.token_urlsafe(24), kind='dcr', created_at=now, **values)


def is_cimd_url(client_id):
    try:
        parsed = urlsplit(client_id)
    except ValueError:
        return False
    return parsed.scheme == 'https' and bool(parsed.hostname) and parsed.path not in ('', '/')


def fetch_document(url, *, resolver=socket.getaddrinfo, connection=PinnedHTTPSConnection):
    """GET a client metadata document: https only, public addresses pinned, no redirects, 5 KB, 5 s."""
    parsed = urlsplit(url)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.port not in (None, 443) or parsed.fragment:
        raise ClientError('invalid_client', 'The client ID must be an https URL without credentials or a custom port.')
    host = parsed.hostname.rstrip('.').lower().encode('idna').decode()
    deadline = time.monotonic() + CIMD_TIMEOUT_SECONDS
    try:
        addresses = {entry[4][0] for entry in CIMD_DNS.resolve(resolver, host, 443, type=socket.SOCK_STREAM, timeout=CIMD_TIMEOUT_SECONDS)}
    except (OSError, TimeoutError, RuntimeError, UnicodeError) as error:
        raise ClientError('invalid_client', 'The client metadata document could not be reached.') from error
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ClientError('invalid_client', 'The client metadata document must be on a public address.')
    remaining = max(.1, deadline - time.monotonic())
    client = connection(host, sorted(addresses)[0], remaining)
    try:
        client.request('GET', (parsed.path or '/') + ('?' + parsed.query if parsed.query else ''),
                       headers={'Accept': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'Veevee-OAuth/1'})
        response = client.getresponse()
        if response.status != 200:
            raise ClientError('invalid_client', f'The client metadata document answered {response.status}.')
        data = response.read(CIMD_MAX_BYTES + 1)
    except (OSError, TimeoutError, ValueError) as error:
        if isinstance(error, ClientError):
            raise
        raise ClientError('invalid_client', 'The client metadata document could not be read.') from error
    finally:
        client.close()
    if len(data) > CIMD_MAX_BYTES:
        raise ClientError('invalid_client', 'The client metadata document is larger than 5 KB.')
    return data


def cimd_client(url, *, fetch=None, now=None):
    """The client for a metadata-document URL, fetched and validated at most once an hour."""
    now = now_ms() if now is None else now
    fetch = fetch or fetch_document
    cached = McpClient.objects.filter(client_id=url, kind='cimd').first()
    if cached and cached.fetched_at and cached.fetched_at > now - CIMD_CACHE_MS:
        return cached
    try:
        document = json.loads(fetch(url))
    except (ValueError, UnicodeError) as error:
        raise ClientError('invalid_client', 'The client metadata document is not valid JSON.') from error
    if not isinstance(document, dict) or document.get('client_id') != url:
        raise ClientError('invalid_client', 'The client metadata document must name its own URL as client_id.')
    values = clean_metadata(document, cimd_url=url)
    client, _ = McpClient.objects.update_or_create(client_id=url, defaults={**values, 'kind': 'cimd', 'fetched_at': now},
                                                   create_defaults={**values, 'id': uuid.uuid4(), 'kind': 'cimd', 'fetched_at': now, 'created_at': now})
    return client


def resolve(client_id, *, fetch=None, now=None):
    """The registered or metadata-document client for an authorization or token request."""
    if not isinstance(client_id, str) or not client_id or len(client_id) > MAX_URI_LENGTH:
        raise ClientError('invalid_client', 'client_id is required.')
    if is_cimd_url(client_id):
        return cimd_client(client_id, fetch=fetch, now=now)
    client = McpClient.objects.filter(client_id=client_id, kind='dcr').first()
    if client is None:
        raise ClientError('invalid_client', 'This app is not registered with Veevee. Reconnect it to register again.')
    return client


def known(client_id):
    """The stored client for a token request: no network fetch at the token or revocation endpoint."""
    if not isinstance(client_id, str) or not client_id:
        return None
    return McpClient.objects.filter(client_id=client_id).first()
