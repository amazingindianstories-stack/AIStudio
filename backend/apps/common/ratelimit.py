"""Tiered rate-limit policy shared by the login throttle and the OAuth endpoints.

A layer is a list of tiers, ``limit:window_seconds`` pairs such as ``5:900,10:3600,20:86400``: no more than
``limit`` events in any trailing ``window``. Short tiers stop bursts, long tiers stop slow guessing, so the
penalty grows with persistence instead of being one hard wall. Each layer reads its tiers from an environment
variable at call time (a tuning change needs a restart, not a deploy): unset uses the default, ``off`` (or an
empty value) switches the layer off, and a malformed value is logged once and falls back to the default.
"""
import json
import logging
import os
from functools import lru_cache
from typing import NamedTuple

logger = logging.getLogger('veevee.ratelimit')

MAX_TIERS = 6
MAX_LIMIT = 1_000_000
MAX_WINDOW_SECONDS = 7 * 24 * 3600


class Tier(NamedTuple):
    limit: int
    window: int  # seconds

    @property
    def window_ms(self):
        return self.window * 1000


def parse_tiers(raw):
    """Tiers (shortest window first) from ``limit:window,...``; raises ValueError when malformed."""
    tiers = []
    for part in raw.split(','):
        limit, separator, window = part.strip().partition(':')
        if not separator or not limit.strip().isdigit() or not window.strip().isdigit():
            raise ValueError(f'expected limit:seconds, got {part.strip()!r}')
        tier = Tier(int(limit), int(window))
        if not 1 <= tier.limit <= MAX_LIMIT or not 1 <= tier.window <= MAX_WINDOW_SECONDS:
            raise ValueError(f'out of range: {part.strip()!r}')
        tiers.append(tier)
    if not tiers or len(tiers) > MAX_TIERS or len({tier.window for tier in tiers}) != len(tiers):
        raise ValueError('need 1 to 6 tiers with distinct windows')
    return tuple(sorted(tiers, key=lambda tier: tier.window))


@lru_cache(maxsize=64)
def _resolve(name, raw, default):
    text = raw.strip()
    if text == '' or text.lower() == 'off':
        return ()
    try:
        return parse_tiers(text)
    except ValueError as error:
        logger.error(json.dumps({'event': 'ratelimit_config_invalid', 'setting': name, 'reason': str(error), 'using': 'default'}))
        return default


def tiers_from_env(name, default, env=None):
    """The tiers a layer enforces: the environment value, else ``default``; ``()`` when switched off."""
    raw = (os.environ if env is None else env).get(name)
    return default if raw is None else _resolve(name, raw, default)


def evaluate(timestamps, tiers, now):
    """``(wait_ms, tier)``: how long until another event would be admitted, and the tier that holds it longest.

    ``timestamps`` are the ms times of the events already counted, ascending. For each tier whose window holds
    ``limit`` or more of them, the event waits until enough of the oldest expire to leave ``limit - 1``; every
    tier must clear, so the longest wait wins. Exact, so a Retry-After header is never a guess. ``(0, None)``
    means admitted.
    """
    wait, blocking = 0, None
    for tier in tiers:
        inside = [stamp for stamp in timestamps if stamp > now - tier.window_ms]
        if len(inside) >= tier.limit:
            until = inside[len(inside) - tier.limit] + tier.window_ms - now
            if until > wait:
                wait, blocking = until, tier
    return wait, blocking
