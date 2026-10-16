"""Small cross-process leases in the existing reserved settings namespace."""
import time
from django.db import connection
from apps.admin_dashboard.models import AppSetting


def now_ms():
    return int(time.time() * 1000)


def claim(key, owner, *, now=None, ttl_ms=30000):
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
    return AppSetting.objects.filter(key=key, value=owner).delete()[0] == 1


def read(key):
    row = AppSetting.objects.filter(key=key).values('value', 'updated_at').first()
    return {'owner': row['value'], 'expiresAt': row['updated_at']} if row else None


def delete_expired(key, *, now=None):
    return AppSetting.objects.filter(key=key, updated_at__lte=now_ms() if now is None else now).delete()[0] == 1
