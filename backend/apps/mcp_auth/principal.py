"""The identity interface the MCP service calls on every request.

    from apps.mcp_auth.principal import authenticate_bearer, AuthenticationError, AgentAccessDisabled

    try:
        principal = authenticate_bearer(request.headers.get('Authorization'))
        principal.require('veevee.generate')          # InsufficientScope -> HTTP 403
    except AuthenticationError as error:              # HTTP 401 or 403
        return error.status, {'WWW-Authenticate': error.www_authenticate()}, error.body()
    except AgentAccessDisabled as error:              # tool result MCP_DISABLED, not an HTTP error
        ...
    Generation.objects.create(..., **principal.origin_fields())

``authenticate_bearer`` accepts personal access tokens and OAuth access tokens bound to the MCP resource. It
checks, on every call: the hash exists, the token is neither revoked nor expired, the audience is this MCP
resource, the user is active, the user's ``auth_version`` still equals the value at issue (a password, role or
status change ends every token, exactly like cookie sessions), and the per-user ``mcpEnabled`` opt-in.
"""
from dataclasses import dataclass

from apps.common.leases import now_ms
from . import policy
from .models import McpToken
from .tokens import digest


class AuthenticationError(Exception):
    """A missing, invalid or under-scoped bearer token; carries its RFC 6750 / RFC 9728 challenge."""
    status = 401

    def __init__(self, error='invalid_token', description=None, scope=None):
        super().__init__(description or error or 'Authentication required.')
        self.error, self.description = error, description
        self.scope = scope or ' '.join(policy.DEFAULT_SCOPES)

    def www_authenticate(self):
        return challenge(self.error, self.description, self.scope)

    def body(self):
        return {'error': self.error or 'invalid_request',
                'error_description': self.description or 'A Veevee access token is required.'}


class InsufficientScope(AuthenticationError):
    status = 403

    def __init__(self, scope, description=None):
        super().__init__('insufficient_scope', description or f'This call needs the {scope} scope.', scope)


class AgentAccessDisabled(Exception):
    """The account's agent access is switched off (MCP_DISABLED); the token itself stays valid."""
    code = 'MCP_DISABLED'

    def __init__(self):
        super().__init__('Agent access is switched off for this account. Ask a Veevee admin.')


def _quoted(value):
    return '"' + str(value).replace('\\', '\\\\').replace('"', '\\"') + '"'


def challenge(error=None, description=None, scope=None):
    """The ``WWW-Authenticate`` value for 401 and 403 responses, naming the resource metadata and scopes."""
    parts = [f'resource_metadata={_quoted(policy.resource_metadata_url())}']
    if scope:
        parts.append(f'scope={_quoted(scope)}')
    if error:
        parts.append(f'error={_quoted(error)}')
    if description:
        parts.append(f'error_description={_quoted(description)}')
    return 'Bearer ' + ', '.join(parts)


@dataclass(frozen=True)
class McpCaps:
    token_daily_cap_cents: int     # this grant's own daily cap, chosen at consent or token creation
    auto_approve_cents: int        # jobs at or below this price submit without a quote
    user_daily_cap_cents: int      # the account's agent cap across every grant
    active_jobs: int               # queued or running agent jobs allowed at once for the account
    confirm_at_cents: int = policy.CONFIRM_AT_CENTS


@dataclass(frozen=True)
class McpPrincipal:
    user: object
    scopes: frozenset
    token_id: object               # the grant (family) id: stable across refresh rotation; caps and spend use it
    token_row_id: object           # the presented secret's own row
    client_id: object              # McpClient.id for OAuth grants, None for personal access tokens
    client_name: str
    kind: str                      # 'pat' or 'oauth'
    caps: McpCaps

    def has_scope(self, scope):
        return scope in self.scopes

    def require(self, scope):
        if scope not in self.scopes:
            raise InsufficientScope(scope)
        return self

    def origin_fields(self):
        """Keyword arguments that mark a generation row as agent-created by this grant."""
        return {'created_via': 'mcp', 'mcp_token_id': self.token_id, 'mcp_client_id': self.client_id}


def bearer_value(raw):
    """The secret from an ``Authorization`` header value or a bare token; None when absent or malformed."""
    if not isinstance(raw, str):
        return None
    value = raw.strip()
    if ' ' in value:
        scheme, _, value = value.partition(' ')
        if scheme.lower() != 'bearer':
            return None
        value = value.strip()
    return value if value and len(value) <= 256 and value.isascii() and ' ' not in value else None


def authenticate_bearer(raw, *, now=None):
    """Resolve a bearer token to an ``McpPrincipal`` or raise ``AuthenticationError`` / ``AgentAccessDisabled``."""
    secret = bearer_value(raw)
    if secret is None:
        raise AuthenticationError(None if not raw else 'invalid_request',
                                  None if not raw else 'Use an Authorization: Bearer token.')
    now = now_ms() if now is None else now
    row = (McpToken.objects.select_related('user', 'client').filter(token_hash=digest(secret), kind__in=('pat', 'access'))
           .only('id', 'kind', 'scopes', 'resource', 'auth_version_at_issue', 'daily_cap_cents', 'auto_approve_cents',
                 'family_id', 'expires_at', 'revoked_at', 'last_used_at', 'client__id', 'client__client_name',
                 'user__id', 'user__email', 'user__name', 'user__role', 'user__is_active', 'user__auth_version').first())
    expected = policy.resource()
    if (row is None or row.revoked_at is not None or row.expires_at <= now or not expected or row.resource != expected
            or not row.user.is_active or row.user.auth_version != row.auth_version_at_issue):
        hint = 'Create a new token in Veevee Settings, Agent access.' if secret.startswith('vv_pat_') else None
        raise AuthenticationError('invalid_token', ' '.join(filter(None, ['The access token is invalid, expired or revoked.', hint])))
    limits = policy.user_limits(row.user.id)
    if not limits['enabled']:
        raise AgentAccessDisabled()
    if row.last_used_at is None or row.last_used_at <= now - policy.LAST_USED_RESOLUTION_MS:
        McpToken.objects.filter(pk=row.pk).update(last_used_at=now)
    scopes = frozenset(scope for scope in row.scopes if scope in policy.SCOPES and (scope != policy.ADMIN_SCOPE or row.user.role == 'admin'))
    return McpPrincipal(user=row.user, scopes=scopes, token_id=row.family_id, token_row_id=row.id,
        client_id=row.client.id if row.client else None, client_name=row.client.client_name if row.client else 'Personal access token',
        kind='pat' if row.kind == 'pat' else 'oauth',
        caps=McpCaps(token_daily_cap_cents=row.daily_cap_cents, auto_approve_cents=row.auto_approve_cents,
                     user_daily_cap_cents=limits['dailyCapCents'], active_jobs=limits['activeJobs']))


def require_scope(principal, scope):
    return principal.require(scope)
