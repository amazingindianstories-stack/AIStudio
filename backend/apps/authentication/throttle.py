"""Layered login throttle over ``login_attempts`` (shared by every API instance; no new service).

Three layers, each a list of tiers (``apps.common.ratelimit``): the account (any address; the original 5 failures per
15 minutes, now with 1 h and 24 h tiers so slow guessing is capped too), the account at one address, and the address
across every account. The address layers need a trusted client address (``apps.common.client_address``); without one only
the account layer applies, so a shared proxy address can never block everyone.

An attempt is reserved (a failure row per layer) before the password is checked and released on success, under a
per-key advisory lock: concurrent guesses across instances cannot all slip past a count read just before any of them is
written. A refused attempt writes nothing, so hammering an account does not lengthen its own lockout. After a success
the address is remembered for 30 days, and from that address the account-wide layer stands down (the account-at-address
and address layers still apply), so someone else guessing at a user's password cannot lock that user out of home.
"""
import hashlib
import logging
import math
import os
import re
import time
import uuid
from django.db import connection, transaction
from apps.common.ratelimit import Tier, evaluate, tiers_from_env
from .models import LoginAttempt

logger = logging.getLogger('veevee.ratelimit')

WINDOW_MS = 15 * 60 * 1000


def maximum_attempts(raw=None):
    if raw is None:
        raw = os.environ.get('LOGIN_MAX_ATTEMPTS')
    if raw is None:
        return 5
    try:
        whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
        text = raw.strip(whitespace)
        if text and not re.fullmatch(r'(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?Infinity)', text):
            return 5
        value = 0.0 if not text else float(int(text, 0)) if text.lower().startswith(('0x','0b','0o')) else float(text)
    except (ValueError, TypeError):
        return 5
    if value == 0:
        return 0
    return math.floor(value) if math.isfinite(value) and value > 0 else 5


MAX_IDENTIFIER_LENGTH = 254

ACCOUNT, PAIR, ADDRESS = 'login_account', 'login_pair', 'login_address'
# Environment override per layer ('limit:seconds,...'; 'off' switches the layer off). The account layer's first tier is
# LOGIN_MAX_ATTEMPTS (default 5; 0 switches the whole login throttle off) unless VEEVEE_RL_LOGIN_ACCOUNT is set.
VARIABLES = {ACCOUNT: 'VEEVEE_RL_LOGIN_ACCOUNT', PAIR: 'VEEVEE_RL_LOGIN_PAIR', ADDRESS: 'VEEVEE_RL_LOGIN_ADDRESS'}
DEFAULTS = {
    ACCOUNT: (Tier(5, 15 * 60), Tier(10, 3600), Tier(20, 86400)),
    PAIR: (Tier(10, 15 * 60), Tier(20, 3600), Tier(40, 86400)),
    ADDRESS: (Tier(50, 15 * 60), Tier(150, 3600), Tier(500, 86400)),
}
KNOWN_TTL_MS = 30 * 24 * 3600 * 1000
# Key namespaces. A submitted email that starts with one is stored under ``acct:`` so it can never collide with a
# key built from an address.
RESERVED_PREFIXES = ('ip:', 'pair:', 'known:', 'acct:')


def identifier(email):
    value = str(email or '').lower().strip()[:MAX_IDENTIFIER_LENGTH]
    return 'acct:' + value if value.startswith(RESERVED_PREFIXES) else value


def address_identifier(address_key):
    return 'ip:' + address_key


def _digest(email, address_key):
    return hashlib.sha256(f'{identifier(email)}|{address_key}'.encode()).hexdigest()[:32]


def pair_identifier(email, address_key):
    return 'pair:' + _digest(email, address_key)


def known_identifier(email, address_key):
    return 'known:' + _digest(email, address_key)


def retry_after(oldest, now):
    return 0 if oldest is None else max(oldest+WINDOW_MS-now,0)


def admits(max_attempts, recent_failure_count):
    return max_attempts <= 0 or recent_failure_count < max_attempts


class Layer:
    def __init__(self, name, key, tiers):
        self.name, self.key, self.tiers = name, key, tiers
        self.horizon_ms = max(tier.window_ms for tier in tiers)


def tiers_for(layer, maximum):
    variable = VARIABLES[layer]
    if layer == ACCOUNT and variable not in os.environ:
        return (Tier(maximum, DEFAULTS[ACCOUNT][0].window),) + DEFAULTS[ACCOUNT][1:]
    return tiers_from_env(variable, DEFAULTS[layer])


def layers_for(email, address_key, maximum):
    if maximum <= 0:
        return []
    candidates = [(ACCOUNT, identifier(email))]
    if address_key:
        candidates += [(PAIR, pair_identifier(email, address_key)), (ADDRESS, address_identifier(address_key))]
    return [Layer(name, key, tiers) for name, key in candidates if (tiers := tiers_for(name, maximum))]


def is_known(email, address_key, now):
    return LoginAttempt.objects.filter(identifier=known_identifier(email, address_key), created_at__gt=now-KNOWN_TTL_MS).exists()


def admit(email, *, now=None, max_attempts=None, address_key=None):
    """Reserve an attempt, or refuse it.

    Returns ``{'allowed', 'retryAfterMs', 'layer', 'reservation'}``; pass the dict to ``succeeded`` when the password
    is right. A reservation left in place is the recorded failure.
    """
    maximum = maximum_attempts() if max_attempts is None else max_attempts
    now = int(time.time()*1000) if now is None else now
    layers = layers_for(email, address_key, maximum)
    if not layers:
        return {'allowed': True, 'retryAfterMs': 0, 'layer': None, 'reservation': []}
    known = bool(address_key) and layers[0].name == ACCOUNT and is_known(email, address_key, now)
    mine = [(layer, uuid.uuid4()) for layer in layers]
    wait, blocker = 0, None
    with transaction.atomic():
        # One attempt per key at a time across every API instance: without it, concurrent guesses (each a slow password
        # check) would all read the same count and all be admitted. Keys are locked in sorted order, so no deadlock.
        with connection.cursor() as cursor:
            for key in sorted({layer.key for layer in layers}):
                cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ['veevee-login:' + key])
        LoginAttempt.objects.bulk_create([LoginAttempt(id=identity, identifier=layer.key, created_at=now) for layer, identity in mine])
        for layer, identity in mine:
            if known and layer.name == ACCOUNT:
                continue
            stamps = LoginAttempt.objects.filter(identifier=layer.key, created_at__gt=now-layer.horizon_ms).exclude(id=identity)
            layer_wait, tier = evaluate(sorted(stamps.values_list('created_at', flat=True)), layer.tiers, now)
            if layer_wait > wait:
                wait, blocker = layer_wait, (layer, tier)
        if blocker is not None:
            LoginAttempt.objects.filter(id__in=[identity for _, identity in mine]).delete()
    reservation = [identity for _, identity in mine]
    if blocker is None:
        return {'allowed': True, 'retryAfterMs': 0, 'layer': None, 'reservation': reservation}
    layer, tier = blocker
    _report_block(layer, tier, now)
    return {'allowed': False, 'retryAfterMs': wait, 'layer': layer.name, 'reservation': []}


def _report_block(layer, tier, now):
    from apps.mcp_auth import ratelimits
    ratelimits.record_event('blocked:' + layer.name, now=now)
    if ratelimits.first_in_window(layer.name, layer.key, tier.window, now=now):
        ratelimits.log_lockout(layer.name, layer.key, tier)


def succeeded(attempt, email, *, now=None, address_key=None):
    """The password was right: the reservation was not a failure, the pair's failures are forgiven, the address is known."""
    now = int(time.time()*1000) if now is None else now
    try:
        with transaction.atomic():
            if attempt['reservation']:
                LoginAttempt.objects.filter(id__in=attempt['reservation']).delete()
            if address_key:
                LoginAttempt.objects.filter(identifier__in=[pair_identifier(email, address_key), known_identifier(email, address_key)]).delete()
                LoginAttempt.objects.create(id=uuid.uuid4(), identifier=known_identifier(email, address_key), created_at=now)
    except Exception:
        logger.exception('login throttle release failed')


def record_failure(email, *, now=None, address_key=None):
    """Count one failure against every layer without checking (an attempt that bypassed ``admit``)."""
    created_at = int(time.time()*1000) if now is None else now
    keys = [identifier(email)] + ([pair_identifier(email, address_key), address_identifier(address_key)] if address_key else [])
    LoginAttempt.objects.bulk_create([LoginAttempt(id=uuid.uuid4(), identifier=key, created_at=created_at) for key in keys])


def cleanup(now):
    """Delete rows past their usefulness; returns the count.

    Failure rows are only read inside the longest configured tier window (kept an hour past it); known-address rows
    last 30 days. Keyed to the configured tiers, so a longer window set by environment keeps its rows.
    """
    maximum = maximum_attempts()
    horizon = max((tier.window_ms for name in VARIABLES for tier in tiers_for(name, maximum or 1)), default=0)
    deleted = LoginAttempt.objects.filter(created_at__lte=now-horizon-3600*1000).exclude(identifier__startswith='known:').delete()[0]
    deleted += LoginAttempt.objects.filter(created_at__lte=now-KNOWN_TTL_MS, identifier__startswith='known:').delete()[0]
    return deleted
