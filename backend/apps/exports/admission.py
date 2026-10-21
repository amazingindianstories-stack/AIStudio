"""Durable export admission (ported from the production launcher overlay).

With ``VEEVEE_EXPORT_ADMISSION`` on, the API records an admission receipt for
every export it creates and refuses to append to or finalize an export without
one; the export worker only sees exports with a valid receipt (read through the
``goal4_preview_worker_holds.new_export_registrations`` view available to the
worker role). Exports created before the Green cutover are never processed.
"""
import hashlib
import json
import uuid
from types import SimpleNamespace
from django.conf import settings
from django.db import connection
from django.db.models import Q
from apps.library.models import OrganizationIdempotencyKey as Receipt

PREFIX = 'g4preview:new-export:'
OPERATION = 'GOAL4_PREVIEW_NEW_EXPORT_ONLY'


def marker_key(identifier):
    return PREFIX + str(uuid.UUID(str(identifier)))


def fingerprint(identifier, actor):
    return hashlib.sha256((identifier + '\n' + actor).encode()).hexdigest()


def enabled(component):
    return bool(getattr(settings, 'VEEVEE_EXPORT_ADMISSION', False)) and getattr(settings, 'VEEVEE_RUNTIME_COMPONENT', None) == component


def api_enabled():
    return enabled('api')


def worker_enabled():
    return enabled('export')


def record(export_id, user_id, now):
    """Store the receipt for an export the API just created, inside the creating transaction."""
    identifier, actor = str(uuid.UUID(export_id)), str(user_id)
    Receipt.objects.create(key=marker_key(identifier), actor_id=actor, operation=OPERATION,
        fingerprint=fingerprint(identifier, actor), status='completed', result={'id': identifier},
        created_at=now, expires_at=0)


def admitted(identifier, actor):
    key = marker_key(identifier)
    receipt = Receipt.objects.filter(operation=OPERATION, status='completed', expires_at=0).filter(pk=key, actor_id=str(actor)).first()
    expected = fingerprint(str(uuid.UUID(str(identifier))), str(actor))
    return bool(receipt and receipt.fingerprint == expected and receipt.result == {'id': str(uuid.UUID(str(identifier)))})


def registered_receipts():
    with connection.cursor() as cursor:
        cursor.execute('SELECT key,actor_id,result,fingerprint FROM goal4_preview_worker_holds.new_export_registrations')
        while rows := cursor.fetchmany(1000):
            for key, actor, result, digest in rows:
                # Django's PostgreSQL raw cursor uses a no-op JSON loader.
                if isinstance(result, str):
                    try:
                        result = json.loads(result)
                    except (ValueError, TypeError):
                        continue
                yield SimpleNamespace(key=key, actor_id=actor, result=result, fingerprint=digest)


def registered_exports():
    """The export worker's filter: exactly the exports with a valid receipt in the registrations view."""
    eligible = Q(pk__in=[])
    for receipt in registered_receipts():
        try:
            identifier = str(uuid.UUID(receipt.key.removeprefix(PREFIX)))
            actor = str(uuid.UUID(receipt.actor_id))
        except (ValueError, TypeError, AttributeError):
            continue
        if receipt.key != marker_key(identifier) or receipt.result != {'id': identifier} or receipt.fingerprint != fingerprint(identifier, actor):
            continue
        eligible |= Q(pk=identifier, user_id=actor)
    return eligible
