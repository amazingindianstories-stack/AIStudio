"""Small value formats shared by every tool result."""
from datetime import datetime, timezone

from apps.mcp_auth.controls import dollars

__all__ = ['dollars', 'iso']


def iso(milliseconds):
    """Epoch milliseconds as an ISO-8601 UTC time with second precision, e.g. 2026-10-31T09:12:44Z."""
    if milliseconds is None:
        return None
    return datetime.fromtimestamp(int(milliseconds) / 1000, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')
