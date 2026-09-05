import os
import time

from .models import LoginAttempt


WINDOW_MS = 15 * 60 * 1000


def _now_ms():
    return int(time.time() * 1000)


def _identifier(value):
    return str(value or "").lower().strip()


def max_attempts():
    raw = os.environ.get("LOGIN_MAX_ATTEMPTS")
    if raw == "0":
        return 0
    try:
        value = int(raw) if raw is not None else 5
        return value if value > 0 else 5
    except ValueError:
        return 5


def check_login_throttle(email, now=None):
    limit = max_attempts()
    if limit == 0:
        return {"allowed": True, "retryAfterMs": 0}
    now = _now_ms() if now is None else now
    cutoff = now - WINDOW_MS
    identifier = _identifier(email)
    LoginAttempt.objects.filter(identifier=identifier, created_at__lte=cutoff).delete()
    attempts = list(
        LoginAttempt.objects.filter(identifier=identifier, created_at__gt=cutoff)
        .order_by("created_at")
        .values_list("created_at", flat=True)
    )
    allowed = len(attempts) < limit
    retry = 0 if allowed or not attempts else max(attempts[0] + WINDOW_MS - now, 0)
    return {"allowed": allowed, "retryAfterMs": retry}


def record_login_failure(email, now=None):
    LoginAttempt.objects.create(identifier=_identifier(email), created_at=_now_ms() if now is None else now)


def cleanup_expired_login_attempts(now=None):
    now = _now_ms() if now is None else now
    deleted, _ = LoginAttempt.objects.filter(created_at__lte=now - WINDOW_MS).delete()
    return deleted
