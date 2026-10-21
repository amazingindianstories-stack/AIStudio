"""Independent Python generation coordinator: no loopback Next API calls."""
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
import ctypes
import logging
import time
from threading import Event
from uuid import uuid4
from django.db import connections
from apps.common.resilience import recover
from .services.admission import reap_stale_running_images, show_worker_slot_wait
from .services.coordinator import select_due_generations, select_unlabelled_short_slot
from .services.executor import process_generation
from .services.deadline import Cancellation

logger = logging.getLogger('veevee.generation')


def release_freed_memory():
    """Hand freed heap pages back to the OS (glibc only; a no-op elsewhere).

    Jobs decode and base64 multi-megabyte images on several threads; without this the freed pages stay
    resident and RSS ratchets up for the life of the process."""
    try:
        ctypes.CDLL('libc.so.6').malloc_trim(0)
    except (OSError, AttributeError):
        pass


class WorkerCancellation(Cancellation):
    def __init__(self, stop):
        super().__init__()
        self.stop = stop

    def check(self):
        if self.stop.is_set():
            self.cancelled.set()
        super().check()

    def wait(self, milliseconds):
        until = time.monotonic() + milliseconds / 1000
        self.check()
        while time.monotonic() < until:
            self.stop.wait(min(.1, until - time.monotonic(), self.remaining()))
            self.check()


def run_once(*, concurrency=4, limit=25, process=None, stop=None):
    process = process or process_generation
    stop = stop or Event()
    if stop.is_set():
        return {'processed': 0, 'outcomes': {}}
    reap_stale_running_images()
    due = select_due_generations(limit=limit)
    with ThreadPoolExecutor(max_workers=max(1, min(8, int(concurrency)))) as pool:
        results = list(pool.map(lambda item: handle_generation(item, process, stop), due))
    return {'processed': len(results), 'outcomes': {value: results.count(value) for value in set(results)}}


def handle_generation(item, process, stop):
    try:
        if stop.is_set():
            return 'stopped'
        cancellation = WorkerCancellation(stop)
        cancellation.check()
        return process(item.id, owner='python-generation:' + str(uuid4()), signal=cancellation)['kind']
    except Exception:
        # Do not print provider URLs, prompts, credentials or DB parameters.
        logger.error('generation worker operation failed; receipt and lease retained for recovery')
        return 'worker_error'
    finally:
        connections.close_all()
        release_freed_memory()


def run_worker(*, interval=2, concurrency=4, stop=None):
    """Keep only executing work in the pool; refill each slot independently.

    Selection does not claim rows. The executor's database lease remains the
    authority across processes; local exclusions also cover the submit/claim gap.
    A short per-row cooldown preserves the poll/retry interval after a no-op.
    While every slot is busy, each waiting row's queued reason is rechecked at
    most once per five intervals.
    """
    stop = stop or Event()
    interval = max(.1, interval)
    failures = 0
    active, cooldown, labelled = {}, {}, {}
    next_scan = 0
    try:
        with ThreadPoolExecutor(max_workers=max(1, min(8, int(concurrency)))) as pool:
            slots = max(1, min(8, int(concurrency)))
            while not stop.is_set():
                try:
                    now = time.monotonic()
                    completed = False
                    for future in list(active):
                        if future.done():
                            completed = True
                            identifier = active.pop(future)
                            future.result()
                            cooldown[identifier] = now + interval
                    cooldown = {key: until for key, until in cooldown.items() if until > now}
                    labelled = {key: until for key, until in labelled.items() if until > now}
                    if not completed and now < next_scan:
                        if active:
                            wait(active, timeout=min(.1, next_scan - now), return_when=FIRST_COMPLETED)
                        else:
                            stop.wait(next_scan - now)
                        continue
                    next_scan = now + interval
                    reap_stale_running_images()
                    excluded = set(active.values()) | set(cooldown)
                    free = slots - len(active)
                    due = select_due_generations(limit=25, exclude_ids=excluded)
                    for item in due[:free]:
                        if stop.is_set():
                            break
                        future = pool.submit(handle_generation, item, process_generation, stop)
                        active[future] = item.id
                    if len(active) == slots and not stop.is_set():
                        waiting = [item for item in due[free:] if item.id not in labelled]
                        seen = set(active.values()) | set(cooldown) | set(labelled) | {item.id for item in due}
                        for item in waiting + select_unlabelled_short_slot(exclude_ids=seen):
                            show_worker_slot_wait(item)
                            labelled[item.id] = now + 5 * interval
                    failures = 0
                except Exception as error:
                    failures += 1
                    recover(error, failures, stop=stop, logger=logger, name='generation_worker')
                    continue
                if active:
                    # Completion wakes selection immediately; timeout also notices
                    # new arrivals and shutdown while other jobs are still running.
                    wait(active, timeout=min(.1, interval), return_when=FIRST_COMPLETED)
                else:
                    stop.wait(interval)
    finally:
        # ThreadPoolExecutor drains in-flight calls. WorkerCancellation still
        # interrupts cooperative waits; Railway retains its 120-second drain.
        connections.close_all()
