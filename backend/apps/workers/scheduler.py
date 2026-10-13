"""UTC maintenance schedule; database slot leases deduplicate scheduler replicas.

Slot ownership is at-most-once dispatch, not an exactly-once external side-effect
promise. Recovery and archive deletion are idempotent; generation polling has
its own claim fencing. A crashed slot is retried by the next scheduled slot.
"""
import logging
import uuid
from apps.common import leases
from . import maintenance

logger = logging.getLogger('veevee.maintenance')


def cleanup_exports():
    from apps.exports.services import cleanup_expired_archives
    from apps.media.storage import get_storage
    return cleanup_expired_archives(get_storage())


def tick(*, now=None, handlers=None):
    now = leases.now_ms() if now is None else now
    handlers = handlers or {'depth': maintenance.reconcile_depth, 'video': maintenance.reconcile_videos,
                            'login': maintenance.cleanup_login_attempts, 'exports': cleanup_exports}
    # Every process startup sweeps its current slot, even after the exact cron
    # minute. Daily slots start at 03:17 UTC; other slots align to the epoch.
    periods = {'depth': (60000, 0), 'video': (900000, 0), 'exports': (900000, 0),
               'login': (86400000, (3*60+17)*60000)}
    results = {}
    for name, (period, offset) in periods.items():
        # Stable keys prevent an unbounded accumulation of per-slot settings.
        # Expiry is the next aligned slot; a second replica in this slot loses.
        owner = str(uuid.uuid4())
        if leases.claim(f'lease:scheduler:{name}', owner, now=now, ttl_ms=period-(now-offset)%period):
            try:
                results[name] = handlers[name]()
            except Exception:
                logger.exception('Maintenance task failed: %s', name)
                results[name] = {'ok': False}
    return results


def run(*, stop, interval=1):
    while not stop.is_set():
        tick()
        stop.wait(interval)
