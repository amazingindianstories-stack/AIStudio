"""The Agents tab's principal: an in-process ``McpPrincipal`` (kind ``'agent'``) backed by an ``agent_grants`` row.

    grant = ensure_grant(user_id)              # the user's live grant, issued on first use
    principal = agent_principal(grant.id)      # AgentGrantInvalid when revoked, stale or the user is inactive
    ...
    principal = recheck(principal)             # before every step: the same checks, with current limits
    done = await server.dispatch(principal, name, arguments, ...)

A grant has no secret, so it can never authenticate over HTTP (``authenticate_bearer`` reads only MCP tokens). Its id
is the principal's ``token_id``: spend, rates and audit rows key on it exactly as on an MCP grant, and generations it
creates carry ``created_via='agent'`` and ``mcp_token_id=<grant id>``. Agent grants hold the read, generate and organize
scopes, never admin, whatever the user's role. A password, role or status change (``auth_version``) ends the grant, as
does ``revoke_grant`` (every "revoke all agent access" path); the next run the user starts gets a new one.

The per-user ``mcpEnabled`` opt-in gates MCP tokens only; the Agents tab's own switch (``agentsEnabled``) is checked by
its caller.
"""
from django.db import connection, transaction

from apps.authentication.models import User
from apps.common.leases import now_ms
from apps.mcp_auth import policy
from apps.mcp_auth.principal import McpCaps, McpPrincipal
from .models import AgentGrant

AGENT_SCOPES = ('veevee.read', 'veevee.generate', 'veevee.organize')
CLIENT_NAME = 'Veevee Agents tab'
USER_FIELDS = ('id', 'email', 'name', 'role', 'is_active', 'auth_version')


class AgentGrantInvalid(Exception):
    """The grant is revoked or stale, or its user is inactive or gone: the run must stop."""


def _lock(user_id):
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ['agent-grant:' + str(user_id)])


def _user(user_id):
    return User.objects.filter(pk=user_id).only(*USER_FIELDS).first()


def ensure_grant(user_id, *, now=None):
    """The user's live grant, issuing one when there is none or the live one predates the user's ``auth_version``."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        _lock(user_id)
        user = _user(user_id)
        if user is None or not user.is_active:
            raise AgentGrantInvalid('This account is not active.')
        live = AgentGrant.objects.filter(user_id=user.id, revoked_at__isnull=True).first()
        if live is not None and live.auth_version_at_issue == user.auth_version:
            return live
        if live is not None:
            AgentGrant.objects.filter(pk=live.pk).update(revoked_at=now)
        return AgentGrant.objects.create(user_id=user.id, scopes=list(AGENT_SCOPES), daily_cap_cents=policy.TOKEN_DAILY_CAP_DEFAULT,
                                         auto_approve_cents=policy.AUTO_APPROVE_DEFAULT, auth_version_at_issue=user.auth_version,
                                         created_at=now)


def agent_principal(grant_id):
    """The principal for a grant, re-reading the grant, the user and the user's agent limits; ``AgentGrantInvalid``
    when the grant is revoked or stale or the user is inactive."""
    grant = AgentGrant.objects.filter(pk=grant_id).first()
    user = _user(grant.user_id) if grant is not None else None
    if (grant is None or grant.revoked_at is not None or user is None or not user.is_active
            or user.auth_version != grant.auth_version_at_issue):
        raise AgentGrantInvalid('Agent access for this chat has ended. Start a new run.')
    limits = policy.user_limits(user.id)
    return McpPrincipal(
        user=user, scopes=frozenset(scope for scope in grant.scopes if scope in AGENT_SCOPES), token_id=grant.id,
        token_row_id=grant.id, client_id=None, client_name=CLIENT_NAME, kind='agent',
        caps=McpCaps(token_daily_cap_cents=grant.daily_cap_cents,
                     auto_approve_cents=min(grant.auto_approve_cents, policy.AUTO_APPROVE_MAX),
                     user_daily_cap_cents=limits['dailyCapCents'], active_jobs=limits['activeJobs']))


def recheck(principal):
    """Run before every step: a fresh principal for the same grant, or ``AgentGrantInvalid``."""
    if principal.kind != 'agent':
        raise AgentGrantInvalid('Not an Agents tab principal.')
    return agent_principal(principal.token_id)


def revoke_grant(user_id, *, grant_id=None, actor_id=None, now=None):
    """Revoke the user's live grant (only when it is ``grant_id``, if given); runs using it stop at their next step.
    Returns how many grants were revoked."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        _lock(user_id)
        live = AgentGrant.objects.filter(user_id=user_id, revoked_at__isnull=True)
        if grant_id is not None:
            live = live.filter(pk=grant_id)
        return live.update(revoked_at=now, revoked_by=actor_id)
