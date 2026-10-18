"""Recovery for the long-running worker loops: a failed iteration (e.g. the database restarted) must not end the process."""
import time
from django.db import InterfaceError, OperationalError, close_old_connections, connections

BACKOFF_BASE_S, BACKOFF_MAX_S = .5, 30


def recover(error, failures, *, stop=None, logger, name):
    """Log without parameters, drop dead connections and back off (growing to BACKOFF_MAX_S); ``failures`` counts consecutive failed iterations."""
    logger.error('%s loop iteration failed error_type=%s consecutive=%s', name, type(error).__name__, failures)
    try:
        if isinstance(error, (OperationalError, InterfaceError)):
            connections.close_all()
        else:
            close_old_connections()
    except Exception:
        pass
    delay = min(BACKOFF_MAX_S, BACKOFF_BASE_S * 2 ** min(failures - 1, 10))
    if stop is None:
        time.sleep(delay)
    else:
        stop.wait(delay)
