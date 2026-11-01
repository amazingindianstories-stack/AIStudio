"""Workspace settings: name and logo, feature activation, public beta opt-in and announcements.

Stored as `workspace.*` rows in the existing settings table. Admin means `role == 'admin'`,
the same check every other admin route makes. Any signed-in user may read the resolved view.
"""
import json
import re
import uuid
from apps.authentication.session import lookup
from apps.common.leases import now_ms
from apps.common.responses import log_activity
from apps.canvas.views import body, property_of, reply, failure
from .admin_api import admin_gate, node_route
from .models import AppSetting

NAME_KEY, LOGO_KEY, BETA_KEY = 'workspace.name', 'workspace.logoUrl', 'workspace.betaOptIn'
FEATURES_KEY, ANNOUNCEMENTS_KEY = 'workspace.features', 'workspace.announcements'
DEFAULT_NAME = 'Veevee'
MAX_NAME, MAX_URL, MAX_ANNOUNCEMENTS, MAX_TEXT = 80, 2000, 20, 500
# Features an admin can switch. `beta` ones also need the public beta opt-in.
FEATURES = [
    {'id': 'board_ai', 'label': 'Board AI jobs', 'beta': False},
    {'id': 'magnific_upscale', 'label': 'Magnific upscaling', 'beta': False},
    {'id': 'kling_images', 'label': 'Kling images', 'beta': True},
    {'id': 'agent_access', 'label': 'Agent (MCP) access', 'beta': True},
]
FEATURE_IDS = {feature['id'] for feature in FEATURES}
MODES = ('all', 'none', 'users')
PRIORITIES = ('info', 'important', 'critical')
UUID = re.compile(r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')


class Invalid(Exception):
    pass


def stored(key, default):
    row = AppSetting.objects.filter(key=key).values_list('value', flat=True).first()
    if row is None: return default
    try: return json.loads(row)
    except ValueError: return default


def save(key, value):
    AppSetting.objects.update_or_create(key=key, defaults={'value': json.dumps(value), 'updated_at': now_ms()})


def clean_text(value, limit, field, required=False):
    if value is None: value = ''
    if not isinstance(value, str): raise Invalid(f'{field} must be text.')
    value = value.strip()
    if required and not value: raise Invalid(f'{field} is required.')
    if len(value) > limit: raise Invalid(f'{field} is too long.')
    return value


def clean_url(value, field):
    value = clean_text(value, MAX_URL, field)
    if value and not (value.startswith('https://') or (value.startswith('/') and not value.startswith('//'))):
        raise Invalid(f'{field} must be an https address or a path on this site.')
    return value


def clean_users(value):
    if value is None: return []
    if not isinstance(value, list) or len(value) > 500: raise Invalid('userIds must be a list.')
    out = []
    for item in value:
        if not isinstance(item, str) or not UUID.match(item.lower()): raise Invalid('userIds must be user ids.')
        if item.lower() not in out: out.append(item.lower())
    return out


def clean_features(value):
    if not isinstance(value, dict): raise Invalid('features must be an object.')
    current = stored(FEATURES_KEY, {})
    for feature_id, rule in value.items():
        if feature_id not in FEATURE_IDS: raise Invalid('Unknown feature.')
        if not isinstance(rule, dict) or rule.get('mode') not in MODES: raise Invalid('Invalid feature mode.')
        current[feature_id] = {'mode': rule['mode'], 'userIds': clean_users(rule.get('userIds')) if rule['mode'] == 'users' else []}
    return current


def optional_time(value, field):
    if value is None: return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or value < 0 or value != int(value):
        raise Invalid(f'{field} must be a time.')
    return int(value)


def clean_announcements(value):
    if not isinstance(value, list) or len(value) > MAX_ANNOUNCEMENTS: raise Invalid('announcements must be a short list.')
    out = []
    for item in value:
        if not isinstance(item, dict): raise Invalid('Invalid announcement.')
        priority = item.get('priority', 'info')
        audience = item.get('audience', 'all')
        if priority not in PRIORITIES or audience not in ('all', 'users'): raise Invalid('Invalid announcement.')
        starts, ends = optional_time(item.get('startsAt'), 'startsAt'), optional_time(item.get('endsAt'), 'endsAt')
        if starts is not None and ends is not None and ends <= starts: raise Invalid('An announcement must end after it starts.')
        link = clean_url(item.get('ctaUrl'), 'ctaUrl')
        identifier = item.get('id') if isinstance(item.get('id'), str) and item.get('id') else str(uuid.uuid4())
        out.append({'id': identifier[:64], 'title': clean_text(item.get('title'), 120, 'title', True),
                    'body': clean_text(item.get('body'), MAX_TEXT, 'body'), 'ctaLabel': clean_text(item.get('ctaLabel'), 60, 'ctaLabel') if link else '',
                    'ctaUrl': link, 'priority': priority, 'audience': audience,
                    'userIds': clean_users(item.get('userIds')) if audience == 'users' else [], 'startsAt': starts, 'endsAt': ends})
    return out


def config():
    features = stored(FEATURES_KEY, {})
    return {'name': stored(NAME_KEY, DEFAULT_NAME), 'logoUrl': stored(LOGO_KEY, ''), 'betaOptIn': stored(BETA_KEY, False) is True,
            'features': {feature['id']: features.get(feature['id'], {'mode': 'all', 'userIds': []}) for feature in FEATURES},
            'announcements': stored(ANNOUNCEMENTS_KEY, [])}


def feature_enabled(feature_id, user_id, settings=None):
    """Server-side check for call sites; unknown features are never enabled."""
    settings = settings or config()
    rule = settings['features'].get(feature_id)
    meta = next((f for f in FEATURES if f['id'] == feature_id), None)
    if rule is None or meta is None: return False
    if meta['beta'] and not settings['betaOptIn']: return False
    if rule['mode'] == 'all': return True
    return rule['mode'] == 'users' and str(user_id).lower() in rule['userIds']


def active_announcements(items, user_id, now):
    shown = [a for a in items if (a['startsAt'] is None or a['startsAt'] <= now) and (a['endsAt'] is None or now < a['endsAt'])
             and (a['audience'] == 'all' or str(user_id).lower() in a['userIds'])]
    shown.sort(key=lambda a: PRIORITIES.index(a['priority']), reverse=True)
    return [{k: a[k] for k in ('id', 'title', 'body', 'ctaLabel', 'ctaUrl', 'priority')} for a in shown]


@node_route(['GET'])
def workspace_view(request):
    user = lookup(request)
    if user is None: return reply(request, {'error': 'UNAUTHENTICATED'}, 401)
    try:
        settings = config()
        return reply(request, {'name': settings['name'], 'logoUrl': settings['logoUrl'],
                               'features': {f['id']: feature_enabled(f['id'], user.id, settings) for f in FEATURES},
                               'announcements': active_announcements(settings['announcements'], user.id, now_ms())})
    except Exception: return failure()


@node_route(['GET', 'POST'])
def workspace_admin(request):
    actor, refused = admin_gate(request)
    if refused: return refused
    try:
        if request.method == 'GET': return reply(request, {**config(), 'registry': FEATURES})
        data = body(request)
        changed = []
        try:
            updates = []
            if 'name' in data: updates.append((NAME_KEY, clean_text(property_of(data, 'name'), MAX_NAME, 'name', True), 'name'))
            if 'logoUrl' in data: updates.append((LOGO_KEY, clean_url(property_of(data, 'logoUrl'), 'logoUrl'), 'logoUrl'))
            if 'betaOptIn' in data:
                if not isinstance(data['betaOptIn'], bool): raise Invalid('betaOptIn must be true or false.')
                updates.append((BETA_KEY, data['betaOptIn'], 'betaOptIn'))
            if 'features' in data: updates.append((FEATURES_KEY, clean_features(data['features']), 'features'))
            if 'announcements' in data: updates.append((ANNOUNCEMENTS_KEY, clean_announcements(data['announcements']), 'announcements'))
        except Invalid as problem:
            return reply(request, {'error': str(problem)}, 400)
        if not updates: return reply(request, {'error': 'Nothing to update.'}, 400)
        for key, value, label in updates:
            save(key, value)
            changed.append(label)
        log_activity(actor.id, 'admin_workspace_updated', {'changed': changed})
        return reply(request, {**config(), 'registry': FEATURES})
    except Exception: return failure()
