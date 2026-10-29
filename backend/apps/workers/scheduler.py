"""UTC maintenance schedule; database slot leases deduplicate scheduler replicas.

Slot ownership is at-most-once dispatch, not an exactly-once external side-effect
promise. Recovery and archive deletion are idempotent; generation polling has
its own claim fencing. A crashed slot is retried by the next scheduled slot.
"""
import logging
import uuid
from apps.common import leases
from apps.common.resilience import recover
from . import maintenance

logger = logging.getLogger('veevee.maintenance')


def cleanup_exports():
    from apps.exports.services import cleanup_expired_archives
    from apps.media.storage import get_storage
    return cleanup_expired_archives(get_storage())


def maintain_portraits():
    """Expire unused managed portraits, release stale pins, reconcile uncertain rows."""
    from apps.assets.managed_pool import janitor
    return janitor()


def process_portrait_uploads():
    """Register Gallery uploads first come first served (a few per pass) and finish pending portrait deletes."""
    from apps.assets.managed_pool import process_uploads
    return process_uploads()


def prune_board_saves():
    from apps.canvas.services import prune_board_saves as prune
    return prune()


def default_handlers():
    from django.conf import settings
    handlers = {'depth': maintenance.reconcile_depth, 'video': maintenance.reconcile_videos,
                'login': maintenance.cleanup_login_attempts, 'exports': cleanup_exports,
                'board_saves': prune_board_saves}
    if getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False):
        handlers['portraits'] = maintain_portraits
        handlers['portrait_uploads'] = process_portrait_uploads
    return handlers


def tick(*, now=None, handlers=None):
    now = leases.now_ms() if now is None else now
    handlers = handlers or default_handlers()
    # Every process startup sweeps its current slot, even after the exact cron
    # minute. Daily slots start at 03:17 UTC; other slots align to the epoch.
    periods = {'depth': (60000, 0), 'video': (900000, 0), 'exports': (900000, 0),
               'login': (86400000, (3*60+17)*60000), 'board_saves': (86400000, (3*60+17)*60000),
               'portraits': (60000, 0), 'portrait_uploads': (3000, 0)}
    results = {}
    for name, (period, offset) in periods.items():
        if name not in handlers:
            continue
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
    failures = 0
    while not stop.is_set():
        try:
            tick()
            failures = 0
        except Exception as error:      # lease claim or a dropped connection: survive, reconnect, try again
            failures += 1
            recover(error, failures, stop=stop, logger=logger, name='scheduler')
            continue
        stop.wait(interval)
