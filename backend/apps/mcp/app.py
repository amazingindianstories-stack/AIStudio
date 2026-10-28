"""The MCP service's ASGI application: a gate in front of the SDK's stateless Streamable HTTP transport.

``POST /mcp`` only (JSON responses, no sessions, no server-initiated streams, so GET and DELETE answer 405). The gate
refuses a foreign ``Origin`` with 403 (no ``Origin`` is fine), never reads cookies, and authenticates the bearer token
on every request: 401 with the ``WWW-Authenticate`` challenge when it is missing or invalid. An account whose agent
access is off still connects, and every tool call answers ``MCP_DISABLED``. ``x-veevee-maintenance: 1`` comes only
from the Vercel middleware (behind the ingress gateway) and pauses write tools. ``GET /healthz`` is readiness.
"""
import asyncio
import json
import logging
import uuid
from contextlib import asynccontextmanager, suppress
from urllib.parse import urlsplit

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured
from django.db import DatabaseError, connection
from mcp.server.streamable_http_manager import StreamableHTTPSessionManager
from mcp.server.transport_security import TransportSecuritySettings
from starlette.applications import Starlette
from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.routing import Route

from apps.mcp_auth.maintenance import purge_expired
from apps.mcp_auth.principal import AgentAccessDisabled, AuthenticationError, authenticate_bearer
from .runtime import db
from .server import Caller, build_server

logger = logging.getLogger('veevee.mcp')
MCP_PATH, HEALTH_PATH = '/mcp', '/healthz'
MAINTENANCE_HEADER = 'x-veevee-maintenance'
PURGE_INTERVAL_SECONDS = 600
LOOPBACK = ('127.0.0.1', 'localhost', '[::1]')


def site():
    parts = urlsplit(settings.PUBLIC_APP_URL or '')
    return parts if parts.scheme in ('http', 'https') and parts.hostname else None


def allowed_hosts():
    """Host headers we answer: the public site (direct dev access) and loopback (the gateway dials 127.0.0.1)."""
    hosts = [f'{name}:*' for name in LOOPBACK] + list(LOOPBACK)
    if site():
        hosts.append(site().netloc)
    return hosts


def allowed_origins():
    """Browser origins allowed to call: the Veevee site itself, and loopback pages when the site is a local dev one."""
    parts = site()
    if parts is None:
        return []
    origins = [f'{parts.scheme}://{parts.netloc}']
    if parts.hostname in ('127.0.0.1', 'localhost', '::1'):
        origins += [f'http://{name}:*' for name in LOOPBACK]
    return origins


def origin_allowed(origin):
    for allowed in allowed_origins():
        if origin == allowed or (allowed.endswith(':*') and origin.startswith(allowed[:-1]) and origin[len(allowed) - 1:].isdigit()):
            return True
    return False


def refuse(status, error, description, headers=None):
    return JSONResponse({'error': error, 'error_description': description}, status,
                        headers={'Cache-Control': 'no-store', **(headers or {})})


class Gate:
    """Checks every ``/mcp`` request before the SDK transport sees it, and attaches the caller to its state."""

    def __init__(self, transport):
        self.transport = transport

    async def __call__(self, scope, receive, send):
        headers = Headers(scope=scope)
        refused = None
        if scope['method'] != 'POST':
            refused = refuse(405, 'method_not_allowed', 'This MCP server answers POST only (stateless JSON).', {'Allow': 'POST'})
        elif headers.get('origin') and not origin_allowed(headers['origin']):
            refused = refuse(403, 'forbidden_origin', 'Requests from this browser origin are not accepted.')
        if refused is not None:
            return await refused(scope, receive, send)
        principal = None
        try:
            principal = await db(authenticate_bearer, headers.get('authorization'))
        except AuthenticationError as error:
            response = JSONResponse(error.body(), error.status,
                                    headers={'WWW-Authenticate': error.www_authenticate(), 'Cache-Control': 'no-store'})
            return await response(scope, receive, send)
        except AgentAccessDisabled:
            principal = None
        except DatabaseError:
            return await refuse(503, 'temporarily_unavailable', 'Veevee is unavailable; try again shortly.')(scope, receive, send)
        request_id = uuid.uuid4().hex
        found = Caller(principal=principal, request_id=request_id, maintenance=headers.get(MAINTENANCE_HEADER) == '1')
        scope = {**scope, 'headers': [(key, value) for key, value in scope['headers'] if key != b'cookie'],
                 'state': {**scope.get('state', {}), 'veevee': found}}

        async def send_with_id(message):
            if message['type'] == 'http.response.start':
                message = {**message, 'headers': [*message.get('headers', []), (b'x-request-id', request_id.encode()),
                                                  (b'cache-control', b'no-store')]}
            await send(message)
        await self.transport(scope, receive, send_with_id)


def database_ready():
    try:
        with connection.cursor() as cursor:
            cursor.execute('SELECT 1')
            return cursor.fetchone() == (1,)
    except DatabaseError:
        return False


async def health(request):
    ready = await db(database_ready)
    return JSONResponse({'ok': ready, 'django': 'ready', 'database': 'ready' if ready else 'unavailable'},
                        200 if ready else 503, headers={'Cache-Control': 'no-store'})


async def maintenance_loop(interval):
    """Delete expired auth codes, rate windows, old tokens and unused clients (bounded batches)."""
    while True:
        await asyncio.sleep(interval)
        try:
            await db(purge_expired)
        except Exception:
            logger.exception(json.dumps({'event': 'mcp_maintenance_failed'}))


def build_application(*, purge_interval=PURGE_INTERVAL_SECONDS):
    if not settings.VEEVEE_MCP:
        raise ImproperlyConfigured('The MCP service needs VEEVEE_MCP=1')
    security = TransportSecuritySettings(enable_dns_rebinding_protection=True, allowed_hosts=allowed_hosts(),
                                         allowed_origins=allowed_origins())
    manager = StreamableHTTPSessionManager(app=build_server(), json_response=True, stateless=True, security_settings=security)

    @asynccontextmanager
    async def lifespan(app):
        async with manager.run():
            loop = asyncio.create_task(maintenance_loop(purge_interval)) if purge_interval else None
            try:
                yield
            finally:
                if loop is not None:
                    loop.cancel()
                    with suppress(asyncio.CancelledError):
                        await loop
    routes = [Route(MCP_PATH, Gate(manager.handle_request)), Route(HEALTH_PATH, health, methods=['GET'])]
    return Starlette(routes=routes, lifespan=lifespan)
