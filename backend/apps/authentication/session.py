"""Read-compatible current Node session contract; issuer ownership stays Next."""
import base64
import hashlib
import hmac
import json
import math
import time
from django.conf import settings
from .models import User

TTL_MS = 30 * 24 * 60 * 60 * 1000

def encode(raw):
    return base64.urlsafe_b64encode(raw).decode().rstrip('=')

def verify(token, now):
    try:
        payload, signature = token.split('.')
        expected = encode(hmac.new(settings.AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).digest())
        if not hmac.compare_digest(signature, expected):
            return None
        data = json.loads(base64.urlsafe_b64decode(payload + '=' * (-len(payload) % 4)))
        uid, version, expiry = data.get('uid'), data.get('ver'), data.get('exp')
        version = 0 if version is None else version
        if not isinstance(uid, str) or not uid or type(version) is not int or version < 0:
            return None
        if type(expiry) not in (int, float) or not math.isfinite(expiry) or expiry < now:
            return None
        return uid, version, expiry
    except (ValueError, TypeError, UnicodeError, AttributeError):
        return None

def lookup(request):
    now = int(time.time() * 1000)
    session = verify(request.COOKIES.get('veevee_session', ''), now)
    if session is None:
        return None
    uid, version, expiry = session
    try:
        user = User.objects.filter(id=uid, is_active=True, auth_version=version).first()
    except (ValueError, models_validation_error):
        return None
    if user and expiry - now < TTL_MS - 24 * 60 * 60 * 1000:
        # Current getSession renews on authenticated reads. Compatible issuance
        # during qualification is temporary; sole issuer transfers in auth wave.
        payload = encode(json.dumps({'uid': str(user.id), 'ver': user.auth_version, 'exp': now + TTL_MS}, separators=(',', ':')).encode())
        signature = encode(hmac.new(settings.AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).digest())
        request.renewed_session = payload + '.' + signature
    return user

from django.core.exceptions import ValidationError as models_validation_error
