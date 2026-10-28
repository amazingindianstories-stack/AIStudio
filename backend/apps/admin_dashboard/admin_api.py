"""Administrative mutations; existing physical identity and limits are retained."""
import hmac
import math
import os
import secrets
from django.db import IntegrityError, transaction
from django.db.models import F
from apps.authentication.models import User
from apps.authentication.password import hash_password, validate_password
from apps.authentication.session import lookup
from apps.common.responses import log_activity, public_user
from apps.common.leases import now_ms
from apps.canvas.views import body, property_of, truthy, node_route as canvas_route, reply, failure
from apps.canvas.serialization import JS_WHITESPACE, js_json
from apps.generation.history_parameters import UUID_TEXT
from apps.generation.watermark import number_value
from .models import AppSetting, Pricing, UserLimit
from .views import GLOBAL_ONLY, LIMITS

COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c']
LABELS = {'maxPromptLength': 'max prompt length', 'maxConcurrentJobs': 'max concurrent jobs', 'seedanceConcurrency': 'Seedance tasks per model',
          'mcpDailyCapCents': 'agent daily limit', 'mcpActiveJobs': 'agent active jobs'}
MISSING = object()


def node_route(methods):
    # The source owns ?format=csv; DRF must not treat it as renderer selection.
    from rest_framework.negotiation import DefaultContentNegotiation
    class QueryFormatIsBusinessInput(DefaultContentNegotiation):
        def filter_renderers(self, renderers, format):
            return renderers
    def decorate(handler):
        view = canvas_route(methods)(handler)
        view.cls.content_negotiation_class = QueryFormatIsBusinessInput
        return view
    return decorate


def admin(request):
    user = lookup(request)
    return user if user and user.role == 'admin' else None


def admin_gate(request):
    """(admin, None) for an admin session, else (None, response): 401 without a session, 403 for a non-admin."""
    user = lookup(request)
    if user is None: return None, reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    if user.role != 'admin': return None, reply(request, {'error': 'FORBIDDEN'}, 403)
    return user, None


def text(value):
    if value is None: return 'null'
    if value is True: return 'true'
    if value is False: return 'false'
    if isinstance(value, str): return value
    if isinstance(value, list): return ','.join('' if item is None else text(item) for item in value)
    if isinstance(value, dict): return '[object Object]'
    return js_json(value)


def trimmed(value):
    return text(value if truthy(value) else '').strip(JS_WHITESPACE)


def number(value):
    if value is MISSING: return math.nan
    if value is None: return 0
    if value is True: return 1
    if value is False: return 0
    if isinstance(value, (int, float)): return value
    raw = text(value).strip(JS_WHITESPACE)
    if raw in ('Infinity', '+Infinity'): return math.inf
    if raw == '-Infinity': return -math.inf
    return number_value(raw)


def rounded(value):
    return math.floor(value + .5) if math.isfinite(value) else value


def allowed(value, key):
    _, minimum, maximum = LIMITS[key]
    return type(value) in (int, float) and math.isfinite(value) and value >= minimum and (maximum is None or value <= maximum)


def safe_user(user):
    return {**public_user(user), 'isActive': user.is_active, 'createdAt': user.created_at}


@node_route(['POST', 'PATCH', 'DELETE'])
def user_mutations(request):
    actor, refused = admin_gate(request)
    if refused: return refused
    try:
        if request.method == 'DELETE':
            identifiers = request.query_params.getlist('id')
            identifier = identifiers[0] if identifiers else None
            if not identifier: return reply(request, {'error': 'Missing id.'}, 400)
            if identifier == str(actor.id): return reply(request, {'error': "You can't delete your own account."}, 400)
            target = User.objects.filter(pk=identifier).first() if UUID_TEXT.fullmatch(identifier) else None
            if target is None: return reply(request, {'error': 'User not found.'}, 404)
            target.delete()
            from apps.media.avatars import delete_avatar_image
            delete_avatar_image(target.avatar_url)
            log_activity(actor.id, 'admin_user_deleted', {'targetUserId': identifier, 'email': target.email})
            return reply(request, {'ok': True})
        data = body(request)
        if data is None: raise TypeError('Null request')
        data = data if isinstance(data, dict) else {}
        if request.method == 'POST':
            email = trimmed(data.get('email')).lower()
            name = trimmed(data.get('name')) or email.split('@')[0]
            role = 'admin' if data.get('role') == 'admin' else 'user'
            if not email: return reply(request, {'error': 'Email is required.'}, 400)
            error = validate_password(data.get('password'))
            if error: return reply(request, {'error': error}, 400)
            duplicate = {'error': 'A user with that email already exists.'}
            if User.objects.filter(email=email).exists(): return reply(request, duplicate, 409)
            credentials = hash_password(data['password'])
            try:
                with transaction.atomic():
                    target = User.objects.create(email=email, name=name, role=role, color=secrets.choice(COLORS),
                        password_hash=credentials['hash'], password_salt=credentials['salt'],
                        avatar_url=None, is_active=True, auth_version=0, created_at=now_ms())
            except IntegrityError as error:
                if getattr(error.__cause__, 'sqlstate', None) == '23505': return reply(request, duplicate, 409)
                raise
            log_activity(actor.id, 'admin_user_created', {'targetUserId': str(target.id), 'email': target.email, 'role': target.role})
            return reply(request, {'user': safe_user(target)})
        identifier = data.get('id') if isinstance(data.get('id'), str) else ''
        if not identifier: return reply(request, {'error': 'Missing id.'}, 400)
        target = User.objects.filter(pk=identifier).first() if UUID_TEXT.fullmatch(identifier) else None
        if target is None: return reply(request, {'error': 'User not found.'}, 404)
        if 'role' in data and data['role'] not in ('admin', 'user'): return reply(request, {'error': 'Invalid role.'}, 400)
        if 'isActive' in data and type(data['isActive']) is not bool: return reply(request, {'error': 'Invalid account status.'}, 400)
        if identifier == str(actor.id):
            if data.get('role') == 'user': return reply(request, {'error': "You can't demote your own account."}, 400)
            if data.get('isActive') is False: return reply(request, {'error': "You can't disable your own account."}, 400)
            if 'password' in data: return reply(request, {'error': 'Change your own password from Account settings.'}, 400)
        if 'password' in data:
            error = validate_password(data['password'])
            if error: return reply(request, {'error': error}, 400)
        values, changed, revoke = {}, [], False
        if isinstance(data.get('name'), str):
            name = data['name'].strip(JS_WHITESPACE)
            if not name: return reply(request, {'error': 'Name cannot be empty.'}, 400)
            if name != target.name: values['name'] = name; changed.append('name')
        for source, field in [('role', 'role'), ('isActive', 'is_active')]:
            if source in data and data[source] != getattr(target, field):
                values[field] = data[source]; changed.append(source); revoke = True
        if 'password' in data:
            credentials = hash_password(data['password'])
            values.update(password_hash=credentials['hash'], password_salt=credentials['salt'])
            changed.append('password'); revoke = True
        if not changed: return reply(request, {'error': 'Nothing to update.'}, 400)
        if revoke: values['auth_version'] = F('auth_version') + 1
        if not User.objects.filter(pk=target.pk).update(**values): return reply(request, {'error': 'User not found.'}, 404)
        if revoke:
            from apps.mcp_auth.tokens import revoke_all_for_user
            revoke_all_for_user(target.pk)
        target.refresh_from_db()
        action = 'admin_password_reset' if changed == ['password'] else ('admin_user_enabled' if target.is_active else 'admin_user_disabled') if changed == ['isActive'] else 'admin_user_updated'
        log_activity(actor.id, action, {'targetUserId': str(target.id), 'changedFields': changed})
        return reply(request, {'user': safe_user(target)})
    except Exception:
        return failure()


@node_route(['POST'])
def pricing_mutation(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    try:
        data = body(request)
        model = trimmed(property_of(data, 'model'))
        value = rounded(number(data.get('unitCostCents', MISSING) if isinstance(data, dict) else MISSING))
        if not math.isnan(value): value = max(0, value)
        unit = property_of(data, 'unit')
        if unit not in ('per_image', 'per_second', 'per_million_tokens', 'per_1000_images', 'per_1000_frames'):
            return reply(request, {'error': 'Invalid pricing unit.'}, 400)
        if not model or not math.isfinite(value): return reply(request, {'error': 'Invalid pricing.'}, 400)
        Pricing.objects.update_or_create(model=model, defaults={'unit_cost_cents': value, 'unit': unit})
        return reply(request, {'ok': True})
    except Exception: return failure()


@node_route(['POST'])
def global_limit_mutation(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    try:
        data = body(request)
        key = property_of(data, 'key')
        if not isinstance(key, str) or key not in LIMITS: return reply(request, {'error': 'Unknown limit.'}, 400)
        value = rounded(number(data.get('value', MISSING)))
        if not allowed(value, key): return reply(request, {'error': f'Invalid {LABELS[key]}.'}, 400)
        AppSetting.objects.update_or_create(key=key, defaults={'value': text(value), 'updated_at': now_ms()})
        return reply(request, {'ok': True})
    except Exception: return failure()


@node_route(['POST'])
def user_limit_mutation(request):
    actor, refused = admin_gate(request)
    if refused: return refused
    try:
        data = body(request)
        identifier, key = property_of(data, 'userId'), property_of(data, 'key')
        if not isinstance(identifier, str) or not identifier or not isinstance(key, str) or key not in LIMITS or key in GLOBAL_ONLY:
            return reply(request, {'error': 'userId and a valid key are required.'}, 400)
        raw = data.get('value', MISSING)
        if raw is not None and not allowed(raw, key): return reply(request, {'error': f'Invalid {LABELS[key]}.'}, 400)
        if not UUID_TEXT.fullmatch(identifier) or not User.objects.filter(pk=identifier).exists(): return reply(request, {'error': 'User not found.'}, 404)
        value = None if raw is None else rounded(raw)
        if value is None: UserLimit.objects.filter(user_id=identifier, key=key).delete()
        else: UserLimit.objects.update_or_create(user_id=identifier, key=key, defaults={'value': text(value), 'updated_at': now_ms()})
        log_activity(actor.id, 'admin_user_limit_updated', {'targetUserId': identifier, 'key': key, 'value': value})
        return reply(request, {'ok': True})
    except Exception: return failure()


@node_route(['POST'])
def token_mutation(request):
    actor = admin(request)
    expected, supplied = os.environ.get('SET_TOKEN_SECRET'), request.headers.get('x-setup-secret')
    secret_ok = bool(expected and supplied and hmac.compare_digest(expected.encode(), supplied.encode()))
    if actor is None and not secret_ok: return reply(request, {'error': 'FORBIDDEN'}, 403)
    try:
        data = body(request)
        fields = ('access_token', 'refresh_token', 'client_id')
        if not isinstance(data, dict) or not all(isinstance(data.get(key), str) and data[key] for key in fields):
            return reply(request, {'error': 'Body must be the hf:login token JSON (access_token, refresh_token, client_id).'}, 400)
        token = {key: data[key] for key in fields}
        token.update(expires_in=data['expires_in'] if type(data.get('expires_in')) in (int, float) else 86399,
                     obtained_at=data['obtained_at'] if type(data.get('obtained_at')) in (int, float) else now_ms())
        from apps.media.storage import get_storage
        get_storage().write_private_buffer(js_json(token).encode(), 'settings/higgsfield-mcp-token.json', 'application/json')
        log_activity(actor.id if actor else None, 'set_higgsfield_token', {'via': 'admin-session' if actor else 'setup-secret'})
        return reply(request, {'ok': True})
    except Exception: return failure()


@node_route(['POST'])
def retired_schema_migration(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    return reply(request, {'error': 'SCHEMA_MIGRATION_ENDPOINT_RETIRED'}, 410)
