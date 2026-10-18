"""Independent Python generation coordinator: no loopback Next API calls."""
from concurrent.futures import ThreadPoolExecutor
import ctypes
import logging
import time
from threading import Event
from uuid import uuid4
from django.db import connections
from apps.common.resilience import recover
from .services.admission import reap_stale_running_images
from .services.coordinator import select_due_generations
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


def run_once(*, concurrency=2, limit=25, process=None, stop=None):
    process = process or process_generation
    stop = stop or Event()
    if stop.is_set():
        return {'processed': 0, 'outcomes': {}}
    reap_stale_running_images()
    due = select_due_generations(limit=limit)
    def handle(item):
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
    with ThreadPoolExecutor(max_workers=max(1, min(10, int(concurrency)))) as pool:
        results = list(pool.map(handle, due))
    return {'processed': len(results), 'outcomes': {value: results.count(value) for value in set(results)}}


def run_worker(*, interval=2, concurrency=2, stop=None):
    stop = stop or Event()
    failures = 0
    while not stop.is_set():
        try:
            run_once(concurrency=concurrency, stop=stop)
            failures = 0
        except Exception as error:      # reap, select or a dropped connection: survive, reconnect, try again
            failures += 1
            recover(error, failures, stop=stop, logger=logger, name='generation_worker')
            continue
        stop.wait(max(.1, interval))
