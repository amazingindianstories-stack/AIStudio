"""Bounded cleanup of expired agent-auth rows. Registration calls ``purge_unused_clients`` opportunistically;
the MCP service's maintenance loop (or ``manage.py purge_mcp_auth``) calls ``purge_expired``."""
from django.db.models import Exists, OuterRef

from apps.common.leases import now_ms
from . import policy
from .clients import UNUSED_DCR_TTL_MS
from .models import McpAuthCode, McpClient, McpRateWindow, McpToken

BATCH = 500
TOKEN_RETENTION_MS = 30 * policy.DAY_MS


def _delete(queryset):
    ids = list(queryset.values_list('pk', flat=True)[:BATCH])
    return queryset.model.objects.filter(pk__in=ids).delete()[0] if ids else 0


def purge_unused_clients(*, now=None):
    """Dynamically registered clients that never completed an authorization within a day."""
    now = now_ms() if now is None else now
    unused = (McpClient.objects.filter(kind='dcr', last_authorized_at__isnull=True, created_at__lt=now - UNUSED_DCR_TTL_MS)
              .exclude(Exists(McpAuthCode.objects.filter(client_id=OuterRef('pk'))))
              .exclude(Exists(McpToken.objects.filter(client_id=OuterRef('pk')))))
    return _delete(unused)


def purge_expired(*, now=None):
    now = now_ms() if now is None else now
    return {
        'clients': purge_unused_clients(now=now),
        'codes': _delete(McpAuthCode.objects.filter(expires_at__lt=now - policy.DAY_MS)),
        'windows': _delete(McpRateWindow.objects.filter(expires_at__lt=now)),
        'tokens': _delete(McpToken.objects.filter(expires_at__lt=now - TOKEN_RETENTION_MS)),
    }
