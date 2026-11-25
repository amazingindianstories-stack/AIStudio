"""Tiered address limits for the OAuth endpoints, and the blocked-attempt counters every rate limit reports.

Counters live in ``mcp_rate_windows`` next to the limits themselves (fixed hourly windows, kept a week), so every
API instance writes the same rows and the admin status check (``apps.admin_dashboard.status``) reads one place.
Counting is best effort: a failed write never turns into a failed login or token request.
"""
import hashlib
import json
import logging

from django.db.models import Sum

from apps.common.client_address import address_key, trusted_address
from apps.common.leases import now_ms
from . import controls
from .models import McpRateWindow

logger = logging.getLogger('veevee.ratelimit')

EVENT_PREFIX = 'rl:evt:'
EVENT_WINDOW_SECONDS = 3600
EVENT_RETENTION_SECONDS = 8 * 24 * 3600


def record_event(name, *, now=None):
    try:
        controls.hit(EVENT_PREFIX + name, 2**62, EVENT_WINDOW_SECONDS, now=now, retain_seconds=EVENT_RETENTION_SECONDS)
    except Exception:
        logger.exception('rate-limit counter write failed')


def count_address(surface, request):
    """Count whether the gateway vouched for this request's client address (the admin status check reads it back)."""
    record_event(f'address:{"trusted" if trusted_address(request) else "untrusted"}:{surface}')


def observe_address(surface, request, *, count=True):
    """The address bucket key for ``request`` (None while untrusted or off), counting whether the gateway vouched for it.

    A caller that must stay write-free for malformed requests passes ``count=False`` and calls ``count_address`` later.
    """
    key = address_key(request)
    if count:
        count_address(surface, request)
    return key


def subject_hash(subject, length):
    return hashlib.sha256(subject.encode()).hexdigest()[:length]


def first_in_window(layer, subject, window_seconds, *, now=None):
    """True for the first refusal of ``subject`` in each ``window_seconds`` window, so a lockout logs once, not per request."""
    try:
        return controls.hit(f'rl:lock:{layer}:{subject_hash(subject, 24)}', 1, window_seconds, now=now).count == 1
    except Exception:
        logger.exception('rate-limit lockout marker failed')
        return False


def log_lockout(layer, subject, tier):
    """One structured line when a limit starts refusing someone; a hash of the subject, never an address or email."""
    logger.warning(json.dumps({'event': 'rate_limit_lockout', 'layer': layer, 'subject': subject_hash(subject, 12),
                               'limit': tier.limit, 'windowSeconds': tier.window}))


def hit_tiers(layer, subject, tiers, *, now=None):
    """Count one request against each tier of an address layer, shortest first, and return the refusal or None.

    A request refused by a short tier is not counted against the longer ones, so a blocked caller cannot extend its
    own long lockout. Returns ``(tier, retry_after_seconds)`` for the first tier that refuses.
    """
    for tier in tiers:
        rate = controls.hit(f'{layer}:{subject}:{tier.window}', tier.limit, tier.window, now=now)
        if not rate.allowed:
            record_event(f'blocked:{layer}', now=now)
            if rate.count == tier.limit + 1:
                log_lockout(layer, subject, tier)
            return tier, rate.retry_after_seconds
    return None


def event_totals(*, now=None):
    """``{name: (this_hour, last_24_hours)}`` for every counter, over the hourly windows the counters write."""
    now = now_ms() if now is None else now
    width = EVENT_WINDOW_SECONDS * 1000
    current = now - now % width
    totals = {}
    rows = (McpRateWindow.objects.filter(bucket__startswith=EVENT_PREFIX, window_start__gte=current - 23 * width)
            .values('bucket', 'window_start').annotate(total=Sum('count')))
    for row in rows:
        name = row['bucket'][len(EVENT_PREFIX):]
        this_hour, day = totals.get(name, (0, 0))
        totals[name] = (this_hour + (row['total'] if row['window_start'] == current else 0), day + row['total'])
    return totals
