"""Bounded reconciliation shared by authenticated cron routes and the scheduler."""
import json
import logging
import uuid
from django.db.models import Q
from apps.authentication.models import LoginAttempt
from apps.common import leases
from apps.generation.models import Generation
from apps.generation.services.deadline import Cancellation
from . import depth

logger = logging.getLogger('veevee.maintenance')


def cleanup_login_attempts(now=None):
    now = leases.now_ms() if now is None else now
    deleted = LoginAttempt.objects.filter(created_at__lte=now-15*60*1000).delete()[0]
    logger.info(json.dumps({'event': 'maintenance_cleanup', 'target': 'login_attempts', 'deleted': deleted}))
    return {'ok': True, 'deleted': deleted}


def reconcile_depth(now=None):
    reaped = depth.reap(force=True, now=now)
    logger.info(json.dumps({'event': 'depth_reconciliation', 'reaped': reaped}))
    return {'reaped': reaped}


def select_videos(now):
    # due=true in the source deliberately supersedes the 45-minute stale filter.
    # Magnific upscales and OmniHuman videos are polled and stored only by the
    # leased worker: their masters can take minutes to download, beyond this
    # pass's budget.
    return list(Generation.objects.filter(kind='video', status__in=['queued', 'running'], task_id__isnull=False)
        .exclude(model__startswith='Magnific ').exclude(model__startswith='OmniHuman ')
        .filter(Q(next_poll_at__isnull=True) | Q(next_poll_at__lte=now)).order_by('updated_at', 'created_at', 'id')[:5])


def advance_video(item, *, source, signal):
    from apps.generation.services.poller import advance
    return advance(item, source=source, signal=signal)


def reconcile_videos(*, now=None, deadline_ms=40000, select=None, advance=None):
    now = leases.now_ms() if now is None else now
    counts = dict(ok=True, checked=0, succeeded=0, failed=0, pending=0, pollErrors=0, raced=0)
    owner = str(uuid.uuid4())
    if not leases.claim('lease:video-reconciliation', owner, now=now, ttl_ms=deadline_ms+5000):
        return counts
    signal = Cancellation(deadline_ms)
    try:
        rows = (select or select_videos)(now)
        for item in rows[:5]:
            signal.check()
            counts['checked'] += 1
            try:
                outcome = (advance or advance_video)(item, source='cron', signal=signal)
                signal.check()
            except Exception:
                counts['ok'] = False
                counts['pollErrors'] += 1
                break
            key = {'succeeded': 'succeeded', 'failed': 'failed', 'poll_error': 'pollErrors', 'raced': 'raced'}.get(outcome.get('kind'), 'pending')
            counts[key] += 1
    except Exception:
        counts['ok'] = False
    finally:
        signal.cancelled.set()
        leases.release('lease:video-reconciliation', owner)
    logger.info(json.dumps({'event': 'video_reconciliation', 'version': 1, **counts}))
    return counts
