"""Bound caller DNS waits without creating unlimited abandoned resolver work."""
import queue
import threading
import time


class MediaDNSCapacityError(RuntimeError):
    pass


class BoundedMediaResolver:
    def __init__(self, slots=4):
        self.capacity = threading.BoundedSemaphore(slots)

    def resolve(self, lookup, *args, timeout, **kwargs):
        deadline = time.monotonic() + timeout
        if not self.capacity.acquire(blocking=False):
            raise MediaDNSCapacityError('Provider media DNS capacity busy.')
        result = queue.Queue(maxsize=1)

        def work():
            try:
                value = (True,lookup(*args,**kwargs))
            except BaseException as error:
                value = (False,error)
            try:
                result.put(value)
            finally:
                self.capacity.release()  # actual completion, not caller timeout

        try:
            thread = threading.Thread(target=work,name='media-dns',daemon=True)
            thread.start()
        except BaseException:
            self.capacity.release()
            raise
        try:
            succeeded,value = result.get(timeout=max(.001,deadline-time.monotonic()))
        except queue.Empty:
            raise TimeoutError('Provider media DNS deadline exceeded.') from None
        if not succeeded:
            raise value
        return value


MEDIA_RESOLVER = BoundedMediaResolver()
