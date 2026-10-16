"""Transaction-scoped receipts shared by folder and generation organization."""
import hashlib
import json
import time
import uuid
from django.db import connection, transaction
from apps.library.models import OrganizationIdempotencyKey

MISSING = object()
TTL_MS = 24 * 60 * 60 * 1000

class OrganizationError(Exception):
    def __init__(self, code, message, status=400):
        super().__init__(message)
        self.code, self.status = code, status


def now_ms():
    return int(time.time() * 1000)


def canonical(value):
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, dict):
        # JS enumerates integer property names first, then insertion order.
        keys = sorted(value, key=lambda k: k.encode('utf-16-be', errors='surrogatepass'))
        indices = sorted([k for k in keys if k.isascii() and k.isdigit() and str(int(k)) == k and int(k) < 4294967295], key=int)
        return {k: canonical(value[k]) for k in indices + [k for k in keys if k not in indices] if value[k] is not MISSING}
    if isinstance(value, list):
        return [None if v is MISSING else canonical(v) for v in value]
    if isinstance(value, float) and value.is_integer():
        return int(value)
    return value


def fingerprint(payload):
    raw = json.dumps(canonical(payload), ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def acquire_scope_locks(*keys):
    with connection.cursor() as cursor:
        for key in sorted(set(filter(None, keys))):
            cursor.execute('SELECT pg_advisory_xact_lock(hashtext(%s))', [key])


def execute(operation, payload, mutation, *, actor_id=None, idempotency_key=None):
    with transaction.atomic():
        key = str(idempotency_key).strip() if idempotency_key else ''
        if not key:
            return mutation()
        acquire_scope_locks('idempotency:' + key)
        now, digest = now_ms(), fingerprint(payload)
        actor = str(actor_id) if actor_id is not None else None
        existing = OrganizationIdempotencyKey.objects.filter(pk=key).first()
        if existing and not (0 < existing.expires_at <= now):
            if existing.actor_id != actor:
                raise OrganizationError('IDEMPOTENCY_ACTOR_MISMATCH', 'Idempotency key reuse across different actors.', 409)
            if existing.operation != operation:
                raise OrganizationError('IDEMPOTENCY_OPERATION_MISMATCH', f'Idempotency key reuse across different operations: expected "{existing.operation}", got "{operation}".', 409)
            if existing.fingerprint != digest:
                raise OrganizationError('IDEMPOTENCY_PAYLOAD_MISMATCH', 'Idempotency key reuse with different payload.', 409)
            if existing.status == 'completed':
                return existing.result
        result = mutation()
        OrganizationIdempotencyKey.objects.update_or_create(pk=key, defaults={
            'actor_id': actor, 'operation': operation, 'fingerprint': digest,
            'status': 'completed', 'result': result, 'created_at': now, 'expires_at': now + TTL_MS})
        return result


def clean_expired(now=None):
    return OrganizationIdempotencyKey.objects.filter(expires_at__gt=0, expires_at__lte=now_ms() if now is None else now).delete()[0]
