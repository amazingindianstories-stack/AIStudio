"""Agent (MCP) access policy: scopes, lifetimes, owner-approved spending defaults and per-user limits.

Owner decisions (2026-10-28): agent access is an admin opt-in per user and off by default; $20 per user per
day, $10 default per token, confirmation for jobs of $1 or more; jobs at or below a per-token auto-approve
amount (25 cents by default, 0 to 100) submit without a quote. Amounts are estimator cents, the same unit as
generation cost_cents.
"""
from django.conf import settings

SCOPES = {
    'veevee.read': 'See the Veevee library, models and your usage',
    'veevee.generate': 'Create images and videos that cost money, within the daily limit you set',
    'veevee.organize': 'Favourite, file and rename items in the shared library, and make ZIP exports',
    'veevee.admin': 'Read admin reports and revoke agent tokens (admins only)',
}
ADMIN_SCOPE = 'veevee.admin'
DEFAULT_SCOPES = ('veevee.read', 'veevee.generate')

ACCESS_TTL_MS = 60 * 60 * 1000
REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000
CODE_TTL_MS = 2 * 60 * 1000
PAT_DEFAULT_DAYS, PAT_MAX_DAYS = 90, 365
DAY_MS = 24 * 60 * 60 * 1000
LAST_USED_RESOLUTION_MS = 60 * 1000

TOKEN_DAILY_CAP_DEFAULT = 1000
AUTO_APPROVE_DEFAULT, AUTO_APPROVE_MAX = 25, 100
CONFIRM_AT_CENTS = 100

# Per-user limits, stored like every other user limit (admin_dashboard UserLimit / AppSetting rows). The two
# numeric ones are registered, with their defaults, in admin_dashboard.views.LIMITS; the opt-in is per user only.
ENABLED_LIMIT = 'mcpEnabled'
DAILY_CAP_LIMIT = 'mcpDailyCapCents'
ACTIVE_JOBS_LIMIT = 'mcpActiveJobs'

# Fixed-window rate limits: name -> (limit, window seconds).
RATE_LIMITS = {
    'calls': (120, 60),            # every tool call, per token
    'paid_minute': (10, 60),       # paid submissions, per token
    'paid_day': (200, 86400),      # paid submissions, per token
    'uploads': (30, 3600),         # uploads and imports, per token
    'register': (20, 3600),        # dynamic client registrations, per client IP
    'token': (60, 60),             # token endpoint, per client and client IP
}
HOLDS_PER_TOKEN = 4                # concurrent waiting calls per token
HOLD_TTL_MS = 90 * 1000


def issuer():
    """The authorization server and site origin, e.g. https://veevee.ai (empty when unconfigured)."""
    return getattr(settings, 'PUBLIC_APP_URL', '').rstrip('/')


def resource():
    """The protected MCP resource every token is bound to, e.g. https://veevee.ai/mcp."""
    base = issuer()
    return base + '/mcp' if base else ''


def resource_metadata_url():
    base = issuer()
    return base + '/.well-known/oauth-protected-resource/mcp' if base else ''


def grantable_scopes(user):
    return [scope for scope in SCOPES if scope != ADMIN_SCOPE or user.role == 'admin']


def user_limits(user_id):
    """The effective agent limits for one user: per-user rows override global settings."""
    from apps.admin_dashboard.models import AppSetting, UserLimit
    from apps.admin_dashboard.views import LIMITS, parse
    keys = (DAILY_CAP_LIMIT, ACTIVE_JOBS_LIMIT)
    globals_ = dict(AppSetting.objects.filter(key__in=keys).values_list('key', 'value'))
    rows = dict(UserLimit.objects.filter(user_id=user_id, key__in=keys + (ENABLED_LIMIT,)).values_list('key', 'value'))
    return {
        'enabled': rows.get(ENABLED_LIMIT) == 'true',
        'dailyCapCents': parse(rows.get(DAILY_CAP_LIMIT, globals_.get(DAILY_CAP_LIMIT)), LIMITS[DAILY_CAP_LIMIT]),
        'activeJobs': parse(rows.get(ACTIVE_JOBS_LIMIT, globals_.get(ACTIVE_JOBS_LIMIT)), LIMITS[ACTIVE_JOBS_LIMIT]),
    }


def set_enabled(user_id, enabled, now):
    from apps.admin_dashboard.models import UserLimit
    if enabled:
        UserLimit.objects.update_or_create(user_id=user_id, key=ENABLED_LIMIT, defaults={'value': 'true', 'updated_at': now})
    else:
        UserLimit.objects.filter(user_id=user_id, key=ENABLED_LIMIT).delete()
