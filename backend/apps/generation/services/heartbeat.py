"""One lease heartbeat per worker process, not one per running generation.

Every running generation holds a database lease that must be renewed while its provider call runs. A thread and a
connection per job meant a worker with eight slots held nine connections, and each of them was a separate way to
fail when PostgreSQL ran out of connections (2026-11-24). The pool renews every registered lease with a single
UPDATE on a single connection, so the cost is fixed however many jobs run.

Semantics are those of the per-job heartbeat: a renewal that cannot reach the database is retried, not treated as a
lost lease, because cancelling healthy provider work over a connection error fails a generation that is still
rendering. A renewal that ran and found the row no longer ours cancels that job at once, and a lease that has been
unrenewable for a whole TTL cancels, which is when another worker may legitimately claim the row."""
import logging
import threading
import time

from django.db import connections
from django.db.models import Q

from apps.common.leases import now_ms
from apps.generation.models import Generation

logger = logging.getLogger('veevee.generation')


class _Registration:
    def __init__(self, item_id, owner, cancellation):
        self.item_id, self.owner, self.cancellation = item_id, owner, cancellation
        self.renewed_at = time.monotonic()
        self.active = True


class HeartbeatPool:
    RETRY_SECONDS = 2

    def __init__(self, *, interval=15, ttl_ms=60000, retry=None):
        self.interval, self.ttl_ms = interval, ttl_ms
        self.retry = self.RETRY_SECONDS if retry is None else retry
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._registrations = []
        self._thread = None

    def register(self, item_id, owner, cancellation):
        registration = _Registration(item_id, owner, cancellation)
        with self._lock:
            self._registrations.append(registration)
            if self._thread is None:
                self._thread = threading.Thread(target=self._run, name='generation-lease', daemon=True)
                self._thread.start()
        return registration

    def unregister(self, registration):
        with self._lock:
            registration.active = False
            if registration in self._registrations:
                self._registrations.remove(registration)
        self._wake.set()        # the thread closes its connection as soon as the last lease is gone

    def _renew(self, registrations):
        """Extend every lease we still hold in one statement; returns the registrations that are no longer ours."""
        held = Q()
        for registration in registrations:
            held |= Q(pk=registration.item_id, worker_lease_id=registration.owner)
        rows = Generation.objects.filter(held, status='running')
        if rows.update(worker_lease_until=now_ms() + self.ttl_ms) == len(registrations):
            return []
        still_ours = set(Generation.objects.filter(pk__in=[r.item_id for r in registrations], status='running')
            .values_list('pk', 'worker_lease_id'))
        return [r for r in registrations if (r.item_id, r.owner) not in still_ours]

    def _cancel(self, registration):
        with self._lock:
            if not registration.active:
                return
            registration.active = False
            if registration in self._registrations:
                self._registrations.remove(registration)
        registration.cancellation.cancelled.set()

    def _run(self):
        next_tick = time.monotonic() + self.interval
        try:
            while True:
                self._wake.wait(max(0, next_tick - time.monotonic()))
                self._wake.clear()
                with self._lock:
                    registrations = list(self._registrations)
                    if not registrations:
                        self._thread = None
                        return
                if time.monotonic() < next_tick:
                    continue
                wait = self.interval
                try:
                    lost = self._renew(registrations)
                except Exception as error:
                    connections.close_all()     # reconnect on the next try
                    now = time.monotonic()
                    for registration in registrations:
                        if now - registration.renewed_at >= self.ttl_ms / 1000:
                            logger.error('generation lease could not be renewed for a full TTL error_type=%s', type(error).__name__)
                            self._cancel(registration)
                    wait = self.retry
                else:
                    now = time.monotonic()
                    for registration in registrations:
                        if registration in lost:
                            self._cancel(registration)
                        else:
                            registration.renewed_at = now
                next_tick = time.monotonic() + wait
        except BaseException:
            with self._lock:
                self._thread = None
            raise
        finally:
            connections.close_all()


_shared = HeartbeatPool()


class LeaseHeartbeat:
    """Keeps one generation's lease renewed for the duration of a ``with`` block."""

    def __init__(self, item, owner, cancellation, *, pool=None):
        self.item, self.owner, self.cancellation = item, owner, cancellation
        self.pool = pool or _shared

    def __enter__(self):
        self.registration = self.pool.register(self.item.id, self.owner, self.cancellation)
        return self

    def __exit__(self, *args):
        self.pool.unregister(self.registration)
