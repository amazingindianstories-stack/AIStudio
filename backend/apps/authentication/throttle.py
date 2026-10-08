import math
import os
import time
import uuid
from .models import LoginAttempt

WINDOW_MS = 15 * 60 * 1000


def maximum_attempts(raw=None):
    if raw is None:
        raw = os.environ.get('LOGIN_MAX_ATTEMPTS')
    if raw is None:
        return 5
    try:
        text = raw.strip()
        value = 0.0 if not text else float(int(text, 0)) if text.lower().startswith(('0x','0b','0o')) else float(text)
    except (ValueError, TypeError):
        return 5
    if value == 0:
        return 0
    return math.floor(value) if math.isfinite(value) and value > 0 else 5


def identifier(email):
    return str(email or '').lower().strip()


def check(email, *, now=None, max_attempts=None):
    maximum = maximum_attempts() if max_attempts is None else max_attempts
    if maximum <= 0:
        return {'allowed':True,'retryAfterMs':0}
    now = int(time.time()*1000) if now is None else now
    key=identifier(email)
    LoginAttempt.objects.filter(identifier=key,created_at__lte=now-WINDOW_MS).delete()
    rows=list(LoginAttempt.objects.filter(identifier=key,created_at__gt=now-WINDOW_MS).values_list('created_at',flat=True))
    allowed=len(rows)<maximum
    return {'allowed':allowed,'retryAfterMs':0 if allowed else max(min(rows)+WINDOW_MS-now,0)}


def record_failure(email, *, now=None):
    LoginAttempt.objects.create(id=uuid.uuid4(),identifier=identifier(email),
                                created_at=int(time.time()*1000) if now is None else now)
