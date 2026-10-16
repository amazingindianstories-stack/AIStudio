import math
import os
import re
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
        whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
        text = raw.strip(whitespace)
        if text and not re.fullmatch(r'(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?|[+-]?Infinity)', text):
            return 5
        value = 0.0 if not text else float(int(text, 0)) if text.lower().startswith(('0x','0b','0o')) else float(text)
    except (ValueError, TypeError):
        return 5
    if value == 0:
        return 0
    return math.floor(value) if math.isfinite(value) and value > 0 else 5


def identifier(email):
    return str(email or '').lower().strip()


def retry_after(oldest, now):
    return 0 if oldest is None else max(oldest+WINDOW_MS-now,0)


def admits(max_attempts, recent_failure_count):
    return max_attempts <= 0 or recent_failure_count < max_attempts


def check(email, *, now=None, max_attempts=None):
    maximum = maximum_attempts() if max_attempts is None else max_attempts
    if maximum <= 0:
        return {'allowed':True,'retryAfterMs':0}
    now = int(time.time()*1000) if now is None else now
    key=identifier(email)
    LoginAttempt.objects.filter(identifier=key,created_at__lte=now-WINDOW_MS).delete()
    rows=list(LoginAttempt.objects.filter(identifier=key,created_at__gt=now-WINDOW_MS).values_list('created_at',flat=True))
    allowed=admits(maximum,len(rows))
    return {'allowed':allowed,'retryAfterMs':0 if allowed else retry_after(min(rows),now)}


def record_failure(email, *, now=None):
    LoginAttempt.objects.create(id=uuid.uuid4(),identifier=identifier(email),
                                created_at=int(time.time()*1000) if now is None else now)
