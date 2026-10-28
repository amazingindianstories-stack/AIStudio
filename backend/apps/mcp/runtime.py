"""Process plumbing for the MCP service: the bounded ORM executor and the switches read on every call."""
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from asgiref.sync import sync_to_async
from django.db import close_old_connections

DB_THREADS = 8                      # at most 8 database connections for the whole service
EXECUTOR = ThreadPoolExecutor(max_workers=DB_THREADS, thread_name_prefix='mcp-db')
ADMIN_SWITCH = 'mcpEnabled'         # AppSetting: 'false' refuses every write tool (MCP_DISABLED)
SWITCH_TTL_SECONDS = 5.0

_switch_lock = threading.Lock()
_switch = {'enabled': True, 'expires': 0.0}


def _with_fresh_connection(func):
    def run(*args, **kwargs):
        close_old_connections()
        try:
            return func(*args, **kwargs)
        finally:
            close_old_connections()
    return run


async def db(func, *args, **kwargs):
    """Run ORM work on the bounded executor, never on the event loop; a waiting call holds no thread."""
    return await sync_to_async(_with_fresh_connection(func), thread_sensitive=False, executor=EXECUTOR)(*args, **kwargs)


def admin_switch_on(*, clock=time.monotonic):
    """The admin kill switch for agent writes, read from the settings table at most every 5 seconds."""
    from apps.admin_dashboard.models import AppSetting
    now = clock()
    with _switch_lock:
        if now < _switch['expires']:
            return _switch['enabled']
    enabled = AppSetting.objects.filter(key=ADMIN_SWITCH).values_list('value', flat=True).first() != 'false'
    with _switch_lock:
        _switch.update(enabled=enabled, expires=now + SWITCH_TTL_SECONDS)
    return enabled


def forget_switch():
    with _switch_lock:
        _switch['expires'] = 0.0
