"""OAuth 2.1 authorization server for agent clients: authorization codes with PKCE S256, rotating refresh
tokens with reuse detection, and revocation (RFC 6749, 7636, 7009, 8707, 9207)."""
import base64
import hashlib
import hmac
import re
import secrets
import uuid
from urllib.parse import urlencode, urlsplit, urlunsplit, parse_qsl

from django.db import transaction

from apps.authentication.models import User
from apps.common.leases import now_ms
from apps.common.responses import log_activity
from . import clients, policy, tokens
from .models import McpAuthCode, McpClient, McpToken

CHALLENGE = re.compile(r'^[A-Za-z0-9_-]{43}$')
VERIFIER = re.compile(r'^[A-Za-z0-9._~-]{43,128}$')
MAX_STATE = 2000


class OAuthError(Exception):
    """An OAuth error response: ``redirect`` errors go back to the client, the rest are shown to the user."""

    def __init__(self, error, description, *, status=400, redirect=None):
        super().__init__(description)
        self.error, self.description, self.status, self.redirect = error, description, status, redirect

    def body(self):
        return {'error': self.error, 'error_description': self.description}


def with_query(uri, values):
    parts = urlsplit(uri)
    query = parse_qsl(parts.query, keep_blank_values=True) + [(key, value) for key, value in values.items() if value is not None]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), ''))


def text_param(params, key, limit=MAX_STATE):
    value = params.get(key)
    if value is None or value == '':
        return None
    if not isinstance(value, str) or len(value) > limit:
        raise OAuthError('invalid_request', f'{key} is not valid.')
    return value


def requested_scopes(raw, user):
    allowed = policy.grantable_scopes(user)
    asked = [scope for scope in dict.fromkeys((raw or '').split()) if scope in allowed]
    return asked or [scope for scope in policy.DEFAULT_SCOPES if scope in allowed]


def other_resource(value, expected):
    """True when a client named a resource other than ``expected`` (a trailing slash is the same resource)."""
    return value not in (None, '') and (not isinstance(value, str) or value.rstrip('/') != expected)


def check_resource(value, redirect=None):
    expected = policy.resource()
    if other_resource(value, expected):
        raise OAuthError('invalid_target', f'This server only issues tokens for {expected}.', redirect=redirect)
    return expected


def authorization_request(params, user, *, fetch=None, now=None):
    """Validate an authorization request for the consent page; raises OAuthError."""
    if not policy.issuer():
        raise OAuthError('server_error', 'Agent sign-in is not configured on this server.', status=503)
    try:
        client = clients.resolve(params.get('client_id'), fetch=fetch, now=now)
    except clients.ClientError as error:
        raise OAuthError(error.error, error.description) from error
    redirect_uri = text_param(params, 'redirect_uri', clients.MAX_URI_LENGTH)
    if redirect_uri is None and len(client.redirect_uris) == 1:
        redirect_uri = client.redirect_uris[0]
    if redirect_uri is None or not clients.redirect_matches(client.redirect_uris, redirect_uri):
        raise OAuthError('invalid_request', 'The redirect address does not match this app\'s registration.')
    state = text_param(params, 'state')
    back = lambda error, description: with_query(redirect_uri, {'error': error, 'error_description': description,
                                                                'state': state, 'iss': policy.issuer()})
    if params.get('response_type') != 'code':
        raise OAuthError('unsupported_response_type', 'Only the authorization code flow is supported.',
                         redirect=back('unsupported_response_type', 'response_type must be code'))
    challenge = params.get('code_challenge')
    if params.get('code_challenge_method') != 'S256' or not isinstance(challenge, str) or not CHALLENGE.fullmatch(challenge):
        raise OAuthError('invalid_request', 'A PKCE S256 code challenge is required.',
                         redirect=back('invalid_request', 'PKCE code_challenge with code_challenge_method S256 is required'))
    resource = check_resource(params.get('resource'), back('invalid_target', 'unknown resource'))
    return {'client': client, 'redirect_uri': redirect_uri, 'state': state, 'code_challenge': challenge,
            'resource': resource, 'scopes': requested_scopes(params.get('scope'), user)}


def cap_values(user, daily_cap_cents, auto_approve_cents):
    """Validate a grant's caps against the account: daily cap 1..user cap, auto-approve 0..100 cents."""
    limits = policy.user_limits(user.id)
    if type(daily_cap_cents) is not int or not 1 <= daily_cap_cents <= limits['dailyCapCents']:
        raise OAuthError('invalid_request', f'Choose a daily limit between $0.01 and ${limits["dailyCapCents"] / 100:,.2f}.')
    if type(auto_approve_cents) is not int or not 0 <= auto_approve_cents <= policy.AUTO_APPROVE_MAX:
        raise OAuthError('invalid_request', 'Choose an auto-approve amount between 0 and 100 cents.')
    return daily_cap_cents, auto_approve_cents


def granted_scopes(user, scopes):
    allowed = policy.grantable_scopes(user)
    if not isinstance(scopes, list) or not scopes or not all(isinstance(scope, str) and scope in allowed for scope in scopes):
        raise OAuthError('invalid_scope', 'Choose at least one permission.')
    return [scope for scope in policy.SCOPES if scope in scopes]


def decide(params, user, *, approve, scopes=None, daily_cap_cents=None, auto_approve_cents=None, fetch=None, now=None):
    """Record the user's decision; returns the client redirect URL carrying a code or ``access_denied``."""
    now = now_ms() if now is None else now
    request = authorization_request(params, user, fetch=fetch, now=now)
    reply = lambda values: with_query(request['redirect_uri'], {**values, 'state': request['state'], 'iss': policy.issuer()})
    if not approve:
        return reply({'error': 'access_denied', 'error_description': 'The user declined access'})
    if not policy.user_limits(user.id)['enabled']:
        raise OAuthError('access_denied', 'Agent access is switched off for your account. Ask a Veevee admin.', status=403)
    scopes = granted_scopes(user, scopes)
    daily_cap_cents, auto_approve_cents = cap_values(user, daily_cap_cents, auto_approve_cents)
    code = secrets.token_urlsafe(32)
    client = request['client']
    with transaction.atomic():
        McpAuthCode.objects.create(id=uuid.uuid4(), code_hash=tokens.digest(code), client=client, user_id=user.id,
            redirect_uri=request['redirect_uri'], code_challenge=request['code_challenge'], scopes=scopes,
            resource=request['resource'], auth_version_at_issue=user.auth_version, daily_cap_cents=daily_cap_cents,
            auto_approve_cents=auto_approve_cents, created_at=now, expires_at=now + policy.CODE_TTL_MS)
        McpClient.objects.filter(pk=client.pk).update(last_authorized_at=now)
    log_activity(user.id, 'mcp_consent_granted', {'clientId': str(client.id), 'clientName': client.client_name,
        'scopes': scopes, 'dailyCapCents': daily_cap_cents, 'autoApproveCents': auto_approve_cents})
    return reply({'code': code})


def pkce_matches(verifier, challenge):
    if not isinstance(verifier, str) or not VERIFIER.fullmatch(verifier):
        return False
    computed = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).decode().rstrip('=')
    return hmac.compare_digest(computed, challenge)


def token_client(form):
    client = clients.known(form.get('client_id'))
    if client is None:
        raise OAuthError('invalid_client', 'Unknown client_id.', status=401)
    return client


def issue_pair(user, client, *, scopes, daily_cap_cents, auto_approve_cents, family_id, now):
    access, _ = tokens.issue(user, 'access', client=client, scopes=scopes, daily_cap_cents=daily_cap_cents,
        auto_approve_cents=auto_approve_cents, expires_at=now + policy.ACCESS_TTL_MS, family_id=family_id, now=now)
    refresh, _ = tokens.issue(user, 'refresh', client=client, scopes=scopes, daily_cap_cents=daily_cap_cents,
        auto_approve_cents=auto_approve_cents, expires_at=now + policy.REFRESH_TTL_MS, family_id=family_id, now=now)
    return {'access_token': access, 'token_type': 'Bearer', 'expires_in': policy.ACCESS_TTL_MS // 1000,
            'refresh_token': refresh, 'scope': ' '.join(scopes)}


def exchange_code(form, *, now=None):
    """grant_type=authorization_code. A code works once; a replay revokes the grant it was first exchanged for."""
    now = now_ms() if now is None else now
    client = token_client(form)
    code = form.get('code')
    if not isinstance(code, str) or not code:
        raise OAuthError('invalid_request', 'code is required.')
    # Refusals are decided inside the transaction but raised after it commits, so a consumed code and a
    # replay revocation persist.
    refusal, response = None, None
    with transaction.atomic():
        row = McpAuthCode.objects.select_for_update().filter(code_hash=tokens.digest(code)).first()
        if row is None or row.client_id != client.id:
            refusal = OAuthError('invalid_grant', 'The authorization code is invalid.')
        elif row.used_at is not None:
            if row.family_id:
                tokens.revoke_family(row.family_id, now=now)
            refusal = OAuthError('invalid_grant', 'The authorization code was already used.')
        else:
            McpAuthCode.objects.filter(pk=row.pk).update(used_at=now)
            user = User.objects.filter(pk=row.user_id, is_active=True, auth_version=row.auth_version_at_issue).first()
            if row.expires_at <= now:
                refusal = OAuthError('invalid_grant', 'The authorization code expired. Start the connection again.')
            elif form.get('redirect_uri', row.redirect_uri) != row.redirect_uri:
                refusal = OAuthError('invalid_grant', 'redirect_uri does not match the authorization request.')
            elif not pkce_matches(form.get('code_verifier'), row.code_challenge):
                refusal = OAuthError('invalid_grant', 'The PKCE code verifier does not match.')
            elif other_resource(form.get('resource'), row.resource):
                refusal = OAuthError('invalid_target', f'This code was issued for {row.resource}.')
            elif user is None:
                refusal = OAuthError('invalid_grant', 'The account changed since this code was issued.')
            else:
                family_id = uuid.uuid4()
                McpAuthCode.objects.filter(pk=row.pk).update(family_id=family_id)
                response = issue_pair(user, client, scopes=row.scopes, daily_cap_cents=row.daily_cap_cents,
                                      auto_approve_cents=row.auto_approve_cents, family_id=family_id, now=now)
    if refusal:
        raise refusal
    log_activity(user.id, 'mcp_token_issued', {'clientId': str(client.id), 'clientName': client.client_name,
                                               'tokenId': str(family_id), 'kind': 'oauth', 'scopes': row.scopes})
    return response


def refresh(form, *, now=None):
    """grant_type=refresh_token with rotation; presenting a rotated token revokes its whole grant."""
    now = now_ms() if now is None else now
    client = token_client(form)
    raw = form.get('refresh_token')
    if not isinstance(raw, str) or not raw:
        raise OAuthError('invalid_request', 'refresh_token is required.')
    refusal, response, reused = None, None, None
    with transaction.atomic():
        row = McpToken.objects.select_for_update().filter(token_hash=tokens.digest(raw), kind='refresh').first()
        if row is None or row.client_id != client.id:
            refusal = OAuthError('invalid_grant', 'The refresh token is invalid.')
        elif row.rotated_at is not None:
            reused = tokens.revoke_family(row.family_id, now=now)
            refusal = OAuthError('invalid_grant', 'This refresh token was already used, so the connection was revoked. Connect the app again.')
        elif row.revoked_at is not None or row.expires_at <= now:
            refusal = OAuthError('invalid_grant', 'The refresh token expired or was revoked. Connect the app again.')
        elif other_resource(form.get('resource'), row.resource):
            refusal = OAuthError('invalid_target', f'This grant is for {row.resource}.')
        else:
            user = User.objects.filter(pk=row.user_id, is_active=True, auth_version=row.auth_version_at_issue).first()
            asked = list(dict.fromkeys(str(form.get('scope') or '').split()))
            if user is None:
                tokens.revoke_family(row.family_id, now=now)
                refusal = OAuthError('invalid_grant', 'The account changed since this app connected. Connect it again.')
            elif not set(asked) <= set(row.scopes):
                refusal = OAuthError('invalid_scope', 'A refresh cannot add permissions.')
            else:
                scopes = [scope for scope in row.scopes if scope in asked] if asked else row.scopes
                McpToken.objects.filter(pk=row.pk).update(rotated_at=now)
                response = issue_pair(user, client, scopes=scopes, daily_cap_cents=row.daily_cap_cents,
                                      auto_approve_cents=row.auto_approve_cents, family_id=row.family_id, now=now)
    if reused is not None:
        log_activity(row.user_id, 'mcp_token_revoked', {'tokenId': str(row.family_id), 'reason': 'refresh_token_reuse', 'revoked': reused})
    if refusal:
        raise refusal
    return response


def revoke(form, *, now=None):
    """RFC 7009: always succeeds for unknown tokens. A refresh token or PAT ends its whole grant."""
    now = now_ms() if now is None else now
    raw = form.get('token')
    if not isinstance(raw, str) or not raw:
        raise OAuthError('invalid_request', 'token is required.')
    row = McpToken.objects.filter(token_hash=tokens.digest(raw)).select_related('client').first()
    if row is None or row.revoked_at is not None:
        return
    if row.client is not None and form.get('client_id') != row.client.client_id:
        raise OAuthError('invalid_client', 'This token belongs to a different client.', status=401)
    if row.kind == 'access':
        McpToken.objects.filter(pk=row.pk, revoked_at__isnull=True).update(revoked_at=now)
    else:
        tokens.revoke_family(row.family_id, now=now)
    log_activity(row.user_id, 'mcp_token_revoked', {'tokenId': str(row.family_id), 'reason': 'revocation_endpoint', 'kind': row.kind})
