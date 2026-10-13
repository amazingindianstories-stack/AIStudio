"""Per-request socket ownership across TLS, upload, headers and body.

DNS caller waits are bounded; unresolved work retains one of four capacity slots.
Late connections are rejected before request transmission. No global connection class or retry policy is changed.
"""
import socket
import queue
import threading
import time
from .transport import ProviderError


class BoundedResolver:
    def __init__(self, slots=4, lookup=None):
        self.capacity = threading.BoundedSemaphore(slots)
        self.lookup = lookup

    def resolve(self, host, port, guard):
        guard.check()
        if not self.capacity.acquire(blocking=False):
            raise ProviderError('Provider DNS capacity busy.', code='dns_capacity_busy', may_have_submitted=False)
        result = queue.Queue(maxsize=1)
        def work():
            try:
                result.put((True,(self.lookup or socket.getaddrinfo)(host,port,type=socket.SOCK_STREAM)))
            except BaseException as error:
                result.put((False,error))
            finally:
                self.capacity.release()  # actual completion, never caller timeout
        thread = threading.Thread(target=work,name='provider-dns',daemon=True)
        try:
            thread.start()
        except BaseException:
            self.capacity.release()
            raise
        try:
            succeeded,value = result.get(timeout=max(.001,guard.deadline-time.monotonic()))
        except queue.Empty:
            raise ProviderError('Provider DNS deadline exceeded.',code='request_deadline',may_have_submitted=False) from None
        guard.check()
        if not succeeded:
            raise value
        return value


RESOLVER = BoundedResolver()


def connect_socket(connection, guard):
    addresses = RESOLVER.resolve(connection._dns_host,connection.port,guard)
    last = None
    for family,kind,protocol,_,address in addresses:
        guard.check()
        source = socket.socket(family,kind,protocol)
        try:
            guard.bind(source)
            source.settimeout(max(.001,min(connection.timeout,guard.deadline-time.monotonic())))
            for option in connection.socket_options or []:
                source.setsockopt(*option)
            if connection.source_address:
                source.bind(connection.source_address)
            source.connect(address)
            guard.check()
            return source
        except ProviderError:
            source.close()
            raise
        except OSError as error:
            source.close()
            last = error
    if last is not None:
        raise last
    raise OSError('Provider DNS returned no usable addresses.')


class SocketDeadline:
    def __init__(self, deadline):
        self.deadline = deadline
        self.expired = threading.Event()
        self.lock = threading.Lock()
        self.socket = None
        self.timer = threading.Timer(max(0, deadline-time.monotonic()), self.expire)
        self.timer.daemon = True

    def check(self):
        if self.expired.is_set() or time.monotonic() >= self.deadline:
            raise ProviderError('Provider request deadline exceeded.', code='request_deadline')

    def bind(self, source):
        # dup keeps a handle after TLS wraps/detaches the original socket.
        owned = source.dup()
        with self.lock:
            if self.socket is not None:
                self.socket.close()
            self.socket = owned
            expired = self.expired.is_set() or time.monotonic() >= self.deadline
        if expired:
            self.expire()
            self.check()

    def expire(self):
        with self.lock:
            self.expired.set()
            if self.socket is not None:
                try:
                    self.socket.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass

    def __enter__(self):
        self.timer.start()
        return self

    def __exit__(self, *_):
        self.timer.cancel()
        self.timer.join()
        with self.lock:
            if self.socket is not None:
                self.socket.close()
                self.socket = None


def deadline_adapter(guard):
    from requests.adapters import HTTPAdapter
    from urllib3.connection import HTTPSConnection
    from urllib3.connectionpool import HTTPSConnectionPool

    class Connection(HTTPSConnection):
        def _new_conn(self):
            guard.check()
            source = connect_socket(self,guard)
            try:
                guard.bind(source)
                guard.check()
                source.settimeout(min(self.timeout, max(.001,guard.deadline-time.monotonic())))
                return source
            except BaseException:
                source.close()
                raise

    class Pool(HTTPSConnectionPool):
        ConnectionCls = Connection

    class Adapter(HTTPAdapter):
        def init_poolmanager(self, *args, **kwargs):
            super().init_poolmanager(*args, **kwargs)
            # PoolManager's default dictionary is shared; copy before mutation.
            self.poolmanager.pool_classes_by_scheme = dict(self.poolmanager.pool_classes_by_scheme)
            self.poolmanager.pool_classes_by_scheme['https'] = Pool

    return Adapter(max_retries=0)
