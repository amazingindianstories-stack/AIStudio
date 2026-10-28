"""HTTP endpoints for agent access: OAuth metadata, registration, consent, tokens, revocation, personal
access tokens, connected apps and the admin opt-in.

Machine endpoints (metadata, register, token, revoke) never read cookies and answer CORS for browser-based
clients. Consent, personal access tokens and connected apps are cookie-authenticated, same-origin browser
calls. Bearer tokens are accepted only by ``/api/mcp/me`` here; the MCP service uses ``principal``.
"""
import hashlib
import json
from urllib.parse import urlsplit

from django.db.models import Max, Min, Sum
from django.http import HttpResponse, JsonResponse

from apps.authentication.models import User
from apps.authentication.session import lookup
from apps.common.leases import now_ms
from apps.common.responses import log_activity
from apps.generation.history_parameters import UUID_TEXT
from . import clients, controls, oauth, policy, tokens
from .models import McpToken
from .principal import AgentAccessDisabled, AuthenticationError, authenticate_bearer

MAX_JSON = 64 * 1024
MAX_ACTIVE_PATS = 20
CORS = {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, MCP-Protocol-Version', 'Access-Control-Max-Age': '600'}


def respond(payload, status=200, headers=None):
    response = JsonResponse(payload, status=status, json_dumps_params={'separators': (',', ':')})
    response['Cache-Control'] = 'no-store'
    for key, value in (headers or {}).items():
        response[key] = value
    return response


def empty(status, headers=None):
    response = HttpResponse(status=status)
    del response['Content-Type']
    for key, value in (headers or {}).items():
        response[key] = value
    return response


def methods(*request_method_list, cors=False):
    # ``request_method_list`` matches django.views.decorators.http so route inventories can read it.
    def decorate(handler):
        def view(request, *args, **kwargs):
            if cors and request.method == 'OPTIONS':
                return empty(204, {**CORS, 'Allow': ', '.join(request_method_list + ('OPTIONS',))})
            if request.method not in request_method_list and not (request.method == 'HEAD' and 'GET' in request_method_list):
                return empty(405, {'Allow': ', '.join(request_method_list)})
            response = handler(request, *args, **kwargs)
            if cors:
                for key, value in CORS.items():
                    response[key] = value
            return response
        view.__name__ = handler.__name__
        return view
    return decorate


def read_json(request):
    try:
        declared = int(request.META.get('CONTENT_LENGTH') or 0)
    except (TypeError, ValueError):
        return None
    if declared > MAX_JSON:
        return None
    raw = request.read(MAX_JSON + 1)
    if len(raw) > MAX_JSON:
        return None
    try:
        value = json.loads(raw or b'{}')
    except (ValueError, UnicodeError):
        return None
    return value if isinstance(value, dict) else None


def read_form(request):
    """Token and revocation requests: application/x-www-form-urlencoded (JSON also accepted)."""
    if (request.content_type or '').startswith('application/json'):
        return read_json(request) or {}
    try:
        return {key: request.POST.get(key) for key in request.POST}
    except Exception:
        return {}


def client_ip(request):
    forwarded = request.headers.get('X-Real-IP') or (request.headers.get('X-Forwarded-For') or '').split(',')[0]
    return forwarded.strip() or request.META.get('REMOTE_ADDR', '')


def session_user(request):
    user = lookup(request)
    if user is not None:
        getattr(request, '_request', request).validated_actor_id = str(user.id)
    return user


def unauthenticated():
    return respond({'error': 'UNAUTHENTICATED'}, 401)


def oauth_failure(error):
    return respond(error.body(), error.status, {'Pragma': 'no-cache'})


def unconfigured():
    return respond({'error': 'server_error', 'error_description': 'Agent sign-in is not configured on this server.'}, 503)


# --- Discovery ---------------------------------------------------------------------------------------

def authorization_server_document():
    base = policy.issuer()
    return {'issuer': base, 'authorization_endpoint': base + '/oauth/authorize', 'token_endpoint': base + '/api/oauth/token',
            'registration_endpoint': base + '/api/oauth/register', 'revocation_endpoint': base + '/api/oauth/revoke',
            'response_types_supported': ['code'], 'response_modes_supported': ['query'],
            'grant_types_supported': ['authorization_code', 'refresh_token'], 'code_challenge_methods_supported': ['S256'],
            'token_endpoint_auth_methods_supported': ['none'], 'revocation_endpoint_auth_methods_supported': ['none'],
            'scopes_supported': list(policy.SCOPES), 'client_id_metadata_document_supported': True,
            'authorization_response_iss_parameter_supported': True}


def protected_resource_document():
    return {'resource': policy.resource(), 'authorization_servers': [policy.issuer()], 'scopes_supported': list(policy.SCOPES),
            'bearer_methods_supported': ['header'], 'resource_name': 'Veevee'}


@methods('GET', cors=True)
def authorization_server_metadata(request):
    return respond(authorization_server_document()) if policy.issuer() else unconfigured()


@methods('GET', cors=True)
def protected_resource_metadata(request):
    return respond(protected_resource_document()) if policy.issuer() else unconfigured()


# --- Machine endpoints -------------------------------------------------------------------------------

@methods('POST', cors=True)
def register(request):
    if not policy.issuer():
        return unconfigured()
    document = read_json(request)
    if document is None:
        return respond({'error': 'invalid_client_metadata', 'error_description': 'Send the client metadata as a JSON object.'}, 400)
    try:
        clients.clean_metadata(document)
    except clients.ClientError as error:
        return respond({'error': error.error, 'error_description': error.description}, 400)
    limit, window = policy.RATE_LIMITS['register']
    address = hashlib.sha256(client_ip(request).encode()).hexdigest()[:32]
    rate = controls.hit('register:' + address, limit, window)
    if not rate.allowed:
        return respond({'error': 'slow_down', 'error_description': 'Too many registrations from this address.'}, 429,
                       {'Retry-After': str(rate.retry_after_seconds)})
    from .maintenance import purge_unused_clients
    purge_unused_clients()
    client = clients.register(document)
    log_activity(None, 'mcp_client_registered', {'clientId': str(client.id), 'clientName': client.client_name})
    return respond({'client_id': client.client_id, 'client_id_issued_at': client.created_at // 1000, 'client_name': client.client_name,
                    'redirect_uris': client.redirect_uris, 'token_endpoint_auth_method': 'none',
                    'grant_types': ['authorization_code', 'refresh_token'], 'response_types': ['code'],
                    **({'client_uri': client.client_uri} if client.client_uri else {}),
                    **({'logo_uri': client.logo_uri} if client.logo_uri else {})}, 201)


@methods('POST', cors=True)
def token(request):
    if not policy.issuer():
        return unconfigured()
    form = read_form(request)
    client = clients.known(form.get('client_id'))
    if client is None:
        return oauth_failure(oauth.OAuthError('invalid_client', 'Unknown client_id.', status=401))
    limit, window = policy.RATE_LIMITS['token']
    rate = controls.hit(f'token:{client.id}', limit, window)
    if not rate.allowed:
        return respond({'error': 'slow_down', 'error_description': 'Too many token requests.'}, 429, {'Retry-After': str(rate.retry_after_seconds)})
    grant = form.get('grant_type')
    try:
        if grant == 'authorization_code':
            payload = oauth.exchange_code(form)
        elif grant == 'refresh_token':
            payload = oauth.refresh(form)
        else:
            raise oauth.OAuthError('unsupported_grant_type', 'Use authorization_code or refresh_token.')
    except oauth.OAuthError as error:
        return oauth_failure(error)
    return respond(payload, 200, {'Pragma': 'no-cache'})


@methods('POST', cors=True)
def revoke(request):
    try:
        oauth.revoke(read_form(request))
    except oauth.OAuthError as error:
        return oauth_failure(error)
    return respond({})


# --- Consent (cookie session) ------------------------------------------------------------------------

def client_summary(client, redirect_uri):
    target = urlsplit(redirect_uri)
    return {'name': client.client_name, 'clientId': client.client_id, 'kind': client.kind, 'uri': client.client_uri,
            'logoUri': client.logo_uri, 'redirectUri': redirect_uri,
            'redirectHost': target.netloc or target.scheme + ':', 'verifiedUrl': client.client_id if client.kind == 'cimd' else None}


def consent_options(user):
    limits = policy.user_limits(user.id)
    return {'enabled': limits['enabled'], 'userDailyCapCents': limits['dailyCapCents'],
            'defaults': {'dailyCapCents': min(policy.TOKEN_DAILY_CAP_DEFAULT, limits['dailyCapCents']),
                         'autoApproveCents': policy.AUTO_APPROVE_DEFAULT, 'expiresInDays': policy.PAT_DEFAULT_DAYS},
            'autoApproveMaxCents': policy.AUTO_APPROVE_MAX, 'confirmAtCents': policy.CONFIRM_AT_CENTS,
            'maxExpiresInDays': policy.PAT_MAX_DAYS, 'resource': policy.resource(),
            'scopes': [{'id': scope, 'description': policy.SCOPES[scope]} for scope in policy.grantable_scopes(user)]}


def request_params(source):
    keys = ('response_type', 'client_id', 'redirect_uri', 'state', 'scope', 'code_challenge', 'code_challenge_method', 'resource')
    return {key: source.get(key) for key in keys if isinstance(source.get(key), str)}


@methods('GET')
def authorize_request(request):
    user = session_user(request)
    if user is None:
        return unauthenticated()
    try:
        details = oauth.authorization_request(request_params(request.GET), user)
    except oauth.OAuthError as error:
        return respond({**error.body(), **({'redirectTo': error.redirect} if error.redirect else {})}, error.status)
    return respond({'client': client_summary(details['client'], details['redirect_uri']), 'requestedScopes': details['scopes'],
                    'user': {'name': user.name, 'email': user.email}, **consent_options(user)})


@methods('POST')
def authorize_decision(request):
    user = session_user(request)
    if user is None:
        return unauthenticated()
    data = read_json(request)
    if data is None or not isinstance(data.get('request'), dict) or type(data.get('approve')) is not bool:
        return respond({'error': 'invalid_request', 'error_description': 'Send the authorization request and a decision.'}, 400)
    try:
        target = oauth.decide(request_params(data['request']), user, approve=data['approve'], scopes=data.get('scopes'),
                              daily_cap_cents=data.get('dailyCapCents'), auto_approve_cents=data.get('autoApproveCents'))
    except oauth.OAuthError as error:
        return respond({**error.body(), **({'redirectTo': error.redirect} if error.redirect else {})}, error.status)
    return respond({'redirectTo': target})


# --- Personal access tokens and connected apps (cookie session) --------------------------------------

def spend_by_grant(user_id, now):
    from apps.generation.models import Generation
    rows = (Generation.objects.filter(user_id=user_id, created_via='mcp', created_at__gt=now - policy.DAY_MS)
            .exclude(cost_basis=controls.FREE_COST_BASIS).values('mcp_token_id').annotate(total=Sum('cost_cents')))
    return {str(row['mcp_token_id']): row['total'] or 0 for row in rows}


def access_overview(user):
    now = now_ms()
    spend = spend_by_grant(user.id, now)
    pats = McpToken.objects.filter(tokens.live(now), user_id=user.id, kind='pat').order_by('-created_at')
    families = (McpToken.objects.filter(user_id=user.id, kind__in=('access', 'refresh')).values('family_id')
                .annotate(connected=Min('created_at'), used=Max('last_used_at')))
    usage = {row['family_id']: row for row in families}
    grants = (McpToken.objects.filter(tokens.live(now), user_id=user.id, kind='refresh', rotated_at__isnull=True)
              .select_related('client').order_by('-created_at'))
    return {
        'access': {**consent_options(user), 'spentTodayCents': sum(spend.values())},
        'tokens': [{'id': str(row.id), 'name': row.name, 'hint': row.hint, 'scopes': row.scopes, 'dailyCapCents': row.daily_cap_cents,
                    'autoApproveCents': row.auto_approve_cents, 'createdAt': row.created_at, 'expiresAt': row.expires_at,
                    'lastUsedAt': row.last_used_at, 'spentTodayCents': spend.get(str(row.family_id), 0)} for row in pats],
        'connections': [{'id': str(row.family_id), 'clientName': row.client.client_name, 'clientUri': row.client.client_uri,
                         'logoUri': row.client.logo_uri, 'clientKind': row.client.kind, 'scopes': row.scopes,
                         'dailyCapCents': row.daily_cap_cents, 'autoApproveCents': row.auto_approve_cents,
                         'connectedAt': usage[row.family_id]['connected'], 'lastUsedAt': usage[row.family_id]['used'],
                         'spentTodayCents': spend.get(str(row.family_id), 0)} for row in grants],
    }


def personal_token_values(user, data):
    name = data.get('name')
    if not isinstance(name, str) or not ' '.join(name.split()) or len(' '.join(name.split())) > 60:
        raise oauth.OAuthError('invalid_request', 'Give the token a name of up to 60 characters.')
    days = data.get('expiresInDays', policy.PAT_DEFAULT_DAYS)
    if type(days) is not int or not 1 <= days <= policy.PAT_MAX_DAYS:
        raise oauth.OAuthError('invalid_request', f'Choose an expiry between 1 and {policy.PAT_MAX_DAYS} days.')
    scopes = oauth.granted_scopes(user, data.get('scopes'))
    cap, auto = oauth.cap_values(user, data.get('dailyCapCents'), data.get('autoApproveCents'))
    return ' '.join(name.split()), days, scopes, cap, auto


@methods('GET', 'POST')
def personal_tokens(request):
    user = session_user(request)
    if user is None:
        return unauthenticated()
    if request.method in ('GET', 'HEAD'):
        return respond(access_overview(user))
    if not policy.user_limits(user.id)['enabled']:
        return respond({'error': 'Agent access is switched off for your account. Ask a Veevee admin.', 'code': 'MCP_DISABLED'}, 403)
    data = read_json(request)
    if data is None:
        return respond({'error': 'Send the token settings as JSON.'}, 400)
    try:
        name, days, scopes, cap, auto = personal_token_values(user, data)
    except oauth.OAuthError as error:
        return respond({'error': error.description}, 400)
    now = now_ms()
    if McpToken.objects.filter(tokens.live(now), user_id=user.id, kind='pat').count() >= MAX_ACTIVE_PATS:
        return respond({'error': f'You already have {MAX_ACTIVE_PATS} active tokens. Revoke one first.'}, 409)
    raw, row = tokens.issue(user, 'pat', name=name, scopes=scopes, daily_cap_cents=cap, auto_approve_cents=auto,
                            expires_at=now + days * policy.DAY_MS, now=now)
    log_activity(user.id, 'mcp_token_issued', {'tokenId': str(row.id), 'kind': 'pat', 'name': name, 'scopes': scopes,
                                               'dailyCapCents': cap, 'autoApproveCents': auto, 'expiresInDays': days})
    return respond({'token': raw, **access_overview(user)}, 201)


def revoke_owned(request, identifier, kinds):
    user = session_user(request)
    if user is None:
        return unauthenticated()
    if not UUID_TEXT.fullmatch(identifier):
        return respond({'error': 'Not found.'}, 404)
    revoked = McpToken.objects.filter(user_id=user.id, family_id=identifier, kind__in=kinds, revoked_at__isnull=True).update(revoked_at=now_ms())
    if not revoked:
        return respond({'error': 'Not found.'}, 404)
    log_activity(user.id, 'mcp_token_revoked', {'tokenId': identifier, 'reason': 'user', 'kind': 'pat' if kinds == ('pat',) else 'oauth'})
    return respond(access_overview(user))


@methods('DELETE')
def personal_token(request, identifier):
    return revoke_owned(request, str(identifier), ('pat',))


@methods('DELETE')
def connection(request, identifier):
    return revoke_owned(request, str(identifier), ('access', 'refresh'))


# --- Bearer self-check -------------------------------------------------------------------------------

@methods('GET')
def bearer_me(request):
    """Who a bearer token acts as; needs veevee.read. Answers the same 401/403 challenges the MCP service uses."""
    try:
        principal = authenticate_bearer(request.headers.get('Authorization')).require('veevee.read')
    except AuthenticationError as error:
        return respond(error.body(), error.status, {'WWW-Authenticate': error.www_authenticate()})
    except AgentAccessDisabled as error:
        return respond({'error': str(error), 'code': error.code}, 403)
    getattr(request, '_request', request).validated_actor_id = str(principal.user.id)
    caps = principal.caps
    return respond({'user': {'id': str(principal.user.id), 'name': principal.user.name, 'email': principal.user.email},
                    'scopes': sorted(principal.scopes), 'tokenId': str(principal.token_id), 'kind': principal.kind,
                    'clientName': principal.client_name, 'caps': {'tokenDailyCapCents': caps.token_daily_cap_cents,
                    'autoApproveCents': caps.auto_approve_cents, 'userDailyCapCents': caps.user_daily_cap_cents,
                    'activeJobs': caps.active_jobs, 'confirmAtCents': caps.confirm_at_cents}})


# --- Admin -------------------------------------------------------------------------------------------

def admin_target(request):
    actor = session_user(request)
    if actor is None:
        return None, None, unauthenticated()
    if actor.role != 'admin':
        return None, None, respond({'error': 'FORBIDDEN'}, 403)
    data = read_json(request)
    identifier = data.get('userId') if data else None
    if not isinstance(identifier, str) or not UUID_TEXT.fullmatch(identifier) or not User.objects.filter(pk=identifier).exists():
        return None, None, respond({'error': 'User not found.'}, 404)
    return actor, data, None


@methods('POST')
def admin_access(request):
    actor, data, refused = admin_target(request)
    if refused:
        return refused
    if type(data.get('enabled')) is not bool:
        return respond({'error': 'enabled must be true or false.'}, 400)
    policy.set_enabled(data['userId'], data['enabled'], now_ms())
    log_activity(actor.id, 'admin_mcp_access_updated', {'targetUserId': data['userId'], 'enabled': data['enabled']})
    return respond({'ok': True, 'enabled': data['enabled']})


@methods('POST')
def admin_revoke_all(request):
    actor, data, refused = admin_target(request)
    if refused:
        return refused
    revoked = tokens.revoke_all_for_user(data['userId'])
    log_activity(actor.id, 'admin_mcp_tokens_revoked', {'targetUserId': data['userId'], 'revoked': revoked})
    return respond({'ok': True, 'revoked': revoked})


def admin_summary():
    """Per-user agent access for the admin Users table: opt-in and live grant counts."""
    from apps.admin_dashboard.models import UserLimit
    now = now_ms()
    enabled = {str(user_id) for user_id in UserLimit.objects.filter(key=policy.ENABLED_LIMIT, value='true').values_list('user_id', flat=True)}
    grants = {}
    for user_id, family_id in (McpToken.objects.filter(tokens.live(now), kind__in=('pat', 'refresh'))
                               .exclude(kind='refresh', rotated_at__isnull=False).values_list('user_id', 'family_id')):
        grants.setdefault(str(user_id), set()).add(family_id)
    return {'enabled': enabled, 'grants': {user_id: len(families) for user_id, families in grants.items()}}
