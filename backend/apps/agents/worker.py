"""The agent worker (``python -m deploy.entrypoint agent``): claims runnable Agents tab runs and advances each one on a
pool thread with ``apps.agents.runner.advance``.

    run_worker(interval=1, concurrency=4, stop=stop)

A run is advanced only while this process holds two leases (``apps.common.leases``): the run's own
(``lease:agent:run:<id>``) and one of the global slots (``lease:agent:slot:<n>``), so every agent worker replica together
advances at most the admin's ``agentMaxConcurrentRuns`` runs, and never more than ``GLOBAL_SLOTS``. The loop renews
both every ``HEARTBEAT_MS`` and stamps the run's ``last_heartbeat_at``; a lease that could not be renewed is lost, and the runner stops at its next step boundary.
The agent worker runs as the API role without a lease prefix, so the scheduler, which has one, never reads these
leases: it re-queues a ``running`` run whose heartbeat is older than ``STALE_MS`` (``reconcile_stale_runs``), and the
run's lease has expired by then.

Runnable runs: queued (new, approved, or re-queued), waiting for jobs (rechecked every tick), paused at a limit once
``resume_after`` has passed, and any waiting run whose cancel was requested.
"""
import logging
import time
import uuid
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from threading import Event

from django.db import connections
from django.db.models import Q

from apps.common import leases
from apps.common.resilience import recover
from . import limits
from .models import AgentRun

logger = logging.getLogger('veevee.agents')
LEASE_MS = 60_000
HEARTBEAT_MS = 15_000
STALE_MS = LEASE_MS
GLOBAL_SLOTS = 8
MAX_SLOTS = 8
NO_PROGRESS = frozenset(('unclaimed', 'worker_error', 'stopped', 'waiting'))


def run_key(run_id):
    return f'lease:agent:run:{run_id}'


def slot_key(index):
    return f'lease:agent:slot:{index}'


@dataclass
class RunLease:
    """The two leases one run is advanced under. ``lost`` is set once a renewal fails; the runner checks it at every
    step boundary and stops."""
    run_id: object
    owner: str
    slot: str
    renewed_at: int = 0
    lost: Event = field(default_factory=Event)

    @property
    def held(self):
        return not self.lost.is_set()

    def renew(self, *, now=None):
        now = leases.now_ms() if now is None else now
        if self.lost.is_set():
            return False
        if not (leases.renew(run_key(self.run_id), self.owner, now=now, ttl_ms=LEASE_MS)
                and leases.renew(self.slot, self.owner, now=now, ttl_ms=LEASE_MS)):
            self.lost.set()
            return False
        AgentRun.objects.filter(pk=self.run_id).update(last_heartbeat_at=now)
        self.renewed_at = now
        return True

    def release(self):
        leases.release(run_key(self.run_id), self.owner)
        leases.release(self.slot, self.owner)


def claim(run_id, *, now=None, owner=None):
    """A ``RunLease`` for the run, or None when another worker holds it or every global slot is taken (the run stays as
    it is). Only the first ``agentMaxConcurrentRuns`` slots, read at each claim, are claimed."""
    now = leases.now_ms() if now is None else now
    owner = owner or 'agent-worker:' + str(uuid.uuid4())
    slots = min(GLOBAL_SLOTS, limits.global_limits()['agentMaxConcurrentRuns'])
    slot = next((slot_key(index) for index in range(slots)
                 if leases.claim(slot_key(index), owner, now=now, ttl_ms=LEASE_MS)), None)
    if slot is None:
        return None
    if not leases.claim(run_key(run_id), owner, now=now, ttl_ms=LEASE_MS):
        leases.release(slot, owner)
        return None
    AgentRun.objects.filter(pk=run_id).update(last_heartbeat_at=now)
    return RunLease(run_id=run_id, owner=owner, slot=slot, renewed_at=now)


def runnable(*, now=None, limit=MAX_SLOTS, exclude=()):
    """Ids of the runs a worker should advance now, least recently touched first."""
    now = leases.now_ms() if now is None else now
    due = (Q(status='queued') | Q(status='waiting_jobs')
           | Q(status__in=('waiting_approval', 'paused_limit'), cancel_requested_at__isnull=False)
           | Q(status='paused_limit', resume_after__lte=now))
    return list(AgentRun.objects.filter(due).exclude(pk__in=list(exclude)).order_by('updated_at', 'id')
                .values_list('id', flat=True)[:max(0, limit)])


def reconcile_stale_runs(*, now=None):
    """The scheduler's resume pass: a ``running`` run whose worker stopped heartbeating goes back to ``queued``, and the
    next worker that claims it resumes from its journal (``apps.agents.runner``)."""
    now = leases.now_ms() if now is None else now
    stale = Q(last_heartbeat_at__isnull=True) | Q(last_heartbeat_at__lt=now - STALE_MS)
    requeued = AgentRun.objects.filter(stale, status='running').update(status='queued', updated_at=now)
    return {'ok': True, 'requeued': requeued}


def default_process(run_id, lease, stop):
    from .runner import advance
    return advance(run_id, lease=lease, stop=stop)


def handle_run(run_id, process, stop, *, now=None):
    """Claim, advance and release one run; returns the runner's outcome, or why nothing ran."""
    if stop.is_set():
        return 'stopped'
    lease = None
    try:
        lease = claim(run_id, now=now)
        if lease is None:
            return 'unclaimed'
        return process(run_id, lease, stop)
    except Exception as error:
        try:
            vanished = not AgentRun.objects.filter(pk=run_id).exists()
        except Exception:
            vanished = False
        if vanished:
            return 'finished'
        # Never print prompts, tool arguments, provider bodies or credentials.
        logger.error('agent worker run failed error_type=%s; the run resumes from its journal', type(error).__name__)
        return 'worker_error'
    finally:
        if lease is not None:
            try:
                lease.release()
            except Exception:
                logger.error('agent worker lease release failed; the lease expires')
        connections.close_all()


def heartbeat(active, *, now=None):
    """Renew every held lease whose last renewal is ``HEARTBEAT_MS`` old."""
    now = leases.now_ms() if now is None else now
    for lease in list(active):
        if lease is not None and lease.held and now - lease.renewed_at >= HEARTBEAT_MS:
            lease.renew(now=now)


def run_once(*, concurrency=4, process=None, stop=None):
    """One pass for ``--once`` and tests: advance up to ``concurrency`` runnable runs, then return their outcomes."""
    process = process or default_process
    stop = stop or Event()
    slots = max(1, min(MAX_SLOTS, int(concurrency)))
    with ThreadPoolExecutor(max_workers=slots) as pool:
        results = list(pool.map(lambda run_id: handle_run(run_id, process, stop), runnable(limit=slots)))
    return {'processed': len(results), 'outcomes': {value: results.count(value) for value in set(results)}}


class _Tracked:
    """A run on a pool thread, and the lease it is advanced under once claimed (for the heartbeat)."""

    def __init__(self):
        self.lease = None


def run_worker(*, interval=1, concurrency=4, stop=None, process=None):
    """Keep up to ``concurrency`` runs advancing; refill each slot as a run yields (waiting, finished or stopped)."""
    process = process or default_process
    stop = stop or Event()
    interval = max(.1, interval)
    slots = max(1, min(MAX_SLOTS, int(concurrency)))
    failures, active, cooldown, next_scan = 0, {}, {}, 0

    def tracked_process(tracked):
        def run(run_id, lease, stop):
            tracked.lease = lease
            return process(run_id, lease, stop)
        return run

    try:
        with ThreadPoolExecutor(max_workers=slots) as pool:
            while not stop.is_set():
                try:
                    now = time.monotonic()
                    progressed = False
                    for future in list(active):
                        if future.done():
                            run_id, _ = active.pop(future)
                            advanced = future.result() not in NO_PROGRESS
                            progressed |= advanced
                            cooldown[run_id] = now + interval
                    cooldown = {key: until for key, until in cooldown.items() if until > now}
                    heartbeat([tracked.lease for _, tracked in active.values()])
                    if not progressed and now < next_scan:
                        if active:
                            wait(active, timeout=min(.1, next_scan - now), return_when=FIRST_COMPLETED)
                        else:
                            stop.wait(next_scan - now)
                        continue
                    next_scan = now + interval
                    busy = {run_id for run_id, _ in active.values()} | set(cooldown)
                    for run_id in runnable(limit=slots - len(active), exclude=busy):
                        if stop.is_set():
                            break
                        tracked = _Tracked()
                        active[pool.submit(handle_run, run_id, tracked_process(tracked), stop)] = (run_id, tracked)
                    failures = 0
                except Exception as error:
                    failures += 1
                    recover(error, failures, stop=stop, logger=logger, name='agent_worker')
                    continue
                if active:
                    wait(active, timeout=min(.1, interval), return_when=FIRST_COMPLETED)
                else:
                    stop.wait(interval)
    finally:
        connections.close_all()
