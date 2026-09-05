"""Port of src/lib/activity.js — append-only admin audit trail. Reading it
(paged/filtered) is apps.admin_dashboard territory; this is just the write
side every mutation route across every app calls."""

import time
import uuid

from .models import ActivityLog


def log_activity(user_id: str | None, action: str, detail=None) -> None:
    """Best-effort — logging must never break the calling request."""
    try:
        ActivityLog.objects.create(
            id=uuid.uuid4(),
            user_id=user_id,
            action=action,
            detail=detail,
            created_at=int(time.time() * 1000),
        )
    except Exception:
        pass
