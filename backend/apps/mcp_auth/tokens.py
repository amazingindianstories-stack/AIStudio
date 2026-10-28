"""Opaque bearer secrets: 256 random bits behind a scannable prefix, stored only as SHA-256."""
import hashlib
import secrets
import uuid

from django.db import transaction
from django.db.models import Q

from apps.common.leases import now_ms
from . import policy
from .models import McpToken

PREFIXES = {'pat': 'vv_pat_', 'access': 'vva_', 'refresh': 'vvr_'}


def digest(raw):
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()


def mint(kind):
    return PREFIXES[kind] + secrets.token_urlsafe(32)


def hint(kind, raw):
    return PREFIXES[kind] + '…' + raw[-4:]


def issue(user, kind, *, scopes, daily_cap_cents, auto_approve_cents, expires_at, family_id=None, client=None, name=None, now=None):
    """Create one token row and return (raw secret, row). The raw secret is never stored.

    Without ``family_id`` the token is its own grant (a personal access token).
    """
    now = now_ms() if now is None else now
    raw = mint(kind)
    identifier = uuid.uuid4()
    row = McpToken.objects.create(id=identifier, user_id=user.id, client=client, kind=kind, token_hash=digest(raw),
        hint=hint(kind, raw), name=name, scopes=list(scopes), resource=policy.resource(), auth_version_at_issue=user.auth_version,
        daily_cap_cents=daily_cap_cents, auto_approve_cents=auto_approve_cents, family_id=family_id or identifier,
        created_at=now, expires_at=expires_at)
    return raw, row


def live(now):
    return Q(revoked_at__isnull=True, expires_at__gt=now)


def revoke_family(family_id, *, now=None):
    now = now_ms() if now is None else now
    return McpToken.objects.filter(family_id=family_id, revoked_at__isnull=True).update(revoked_at=now)


def revoke_all_for_user(user_id, *, now=None):
    """Revoke every personal access token and OAuth grant a user holds (password, role or status change, admin)."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        return McpToken.objects.filter(user_id=user_id, revoked_at__isnull=True).update(revoked_at=now)
