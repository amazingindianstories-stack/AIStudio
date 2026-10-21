"""Small cross-process leases in the existing reserved settings namespace."""
import time
from django.conf import settings
from django.db import connection
from apps.admin_dashboard.models import AppSetting


def now_ms():
    return int(time.time() * 1000)


def namespaced(key):
    """Green workers hold leases under a private prefix (VEEVEE_LEASE_PREFIX, validated in settings)."""
    if settings.VEEVEE_RUNTIME_COMPONENT not in ('generation', 'export', 'scheduler') or not settings.VEEVEE_LEASE_PREFIX:
        return key
    if not isinstance(key, str) or not key.startswith('lease:'):
        raise ValueError('Invalid lease key')
    return settings.VEEVEE_LEASE_PREFIX + key[len('lease:'):]


def claim(key, owner, *, now=None, ttl_ms=30000):
    key = namespaced(key)
    if not key.startswith('lease:'):
        raise ValueError('Distributed lease keys must start with lease:')
    if not owner:
        raise ValueError('Distributed lease owner is required')
    now = now_ms() if now is None else now
    with connection.cursor() as cursor:
        cursor.execute('''INSERT INTO settings (key, value, updated_at) VALUES (%s, %s, %s)
            ON CONFLICT (key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
            WHERE settings.updated_at <= %s RETURNING key''', [key, owner, now + ttl_ms, now])
        return cursor.fetchone() is not None


def release(key, owner):
    key = namespaced(key)
    return AppSetting.objects.filter(key=key, value=owner).delete()[0] == 1


def read(key):
    key = namespaced(key)
    row = AppSetting.objects.filter(key=key).values('value', 'updated_at').first()
    return {'owner': row['value'], 'expiresAt': row['updated_at']} if row else None


def delete_expired(key, *, now=None):
    key = namespaced(key)
    return AppSetting.objects.filter(key=key, updated_at__lte=now_ms() if now is None else now).delete()[0] == 1
