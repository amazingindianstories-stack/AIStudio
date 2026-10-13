"""Cooperative provider cancellation; persistence stays outside timed work."""
import queue
import threading
import time

QUEUE_EXECUTION_DEADLINE_MS = 270000
WORK_CAPACITY = threading.BoundedSemaphore(2)


class QueueExecutionCapacityError(RuntimeError):
    code = "queue_execution_capacity_busy"

    def __init__(self):
        super().__init__("Media read capacity busy. Please retry shortly.")


class QueueExecutionDeadlineError(TimeoutError):
    code = 'queue_execution_deadline'

    def __init__(self, timeout_ms=QUEUE_EXECUTION_DEADLINE_MS):
        import math
        super().__init__(f'Generation exceeded the {math.ceil(timeout_ms / 1000)}-second internal deadline.')


class Cancellation:
    def __init__(self, timeout_ms=QUEUE_EXECUTION_DEADLINE_MS):
        self.timeout_ms = timeout_ms
        self.deadline = time.monotonic() + timeout_ms / 1000
        self.cancelled = threading.Event()

    def check(self):
        if self.cancelled.is_set() or time.monotonic() >= self.deadline:
            raise QueueExecutionDeadlineError(self.timeout_ms)

    def remaining(self):
        self.check()
        return max(.001, self.deadline - time.monotonic())

    def wait(self, milliseconds):
        self.check()
        self.cancelled.wait(min(milliseconds / 1000, self.remaining()))
        self.check()


def with_queue_execution_deadline(work, timeout_ms=QUEUE_EXECUTION_DEADLINE_MS, *, _capacity=None):
    """Run provider-only work; late results never reach persistence callbacks.

    All adapters also bound connect/read timeouts to Cancellation.remaining().
    The daemon is a final guard against an injected or broken provider ignoring
    cancellation. work must never write generation state or charge a second job.
    """
    signal = Cancellation(timeout_ms)
    capacity = WORK_CAPACITY if _capacity is None else _capacity
    if not capacity.acquire(blocking=False):
        raise QueueExecutionCapacityError()
    outcome = queue.Queue(maxsize=1)
    def run():
        try:
            result = (True, work(signal))
        except BaseException as error:
            result = (False, error)
        try:
            outcome.put(result)
        finally:
            capacity.release()  # actual completion, not caller timeout
    try:
        thread = threading.Thread(target=run, name='generation-provider', daemon=True)
        thread.start()
    except BaseException:
        capacity.release()
        signal.cancelled.set()
        raise
    try:
        succeeded, value = outcome.get(timeout=signal.remaining())
        signal.check()
        if not succeeded:
            raise value
        return value
    except queue.Empty:
        raise QueueExecutionDeadlineError(timeout_ms) from None
    finally:
        signal.cancelled.set()


def settle_queue_execution(*, work, on_success, on_failure, timeout_ms=QUEUE_EXECUTION_DEADLINE_MS):
    try:
        result = with_queue_execution_deadline(work, timeout_ms)
    except Exception as error:
        return on_failure(error)
    return on_success(result)
