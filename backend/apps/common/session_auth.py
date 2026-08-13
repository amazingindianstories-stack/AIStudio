"""Port of src/lib/auth.js's stateless HMAC session cookie. As of task #9
(auth cutover) Django is a full issuer, not just a verifier — but Next.js
remains a second, equally valid issuer for as long as `src/app/api` still
serves any traffic (the strangler-fig migration is domain-by-domain; see
the backend/ section of CLAUDE.md), so the cookie name, payload shape, and
HMAC algorithm here must stay byte-for-byte identical to the TypeScript
version for as long as both apps mint sessions. If you touch one side,
touch both.

TS reference (payload before signing):
    b64url(JSON.stringify({ uid, ver, exp }))
    sig = HMAC-SHA256(payload).base64url()
    token = f"{payload}.{sig}"
"""

import base64
import hashlib
import hmac
import json
import time

from django.conf import settings
from rest_framework.authentication import BaseAuthentication
from rest_framework.permissions import BasePermission

from .models import User

SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
_SESSION_TTL_MS = 1000 * SESSION_MAX_AGE_SECONDS
# Rolling renewal: a request against a session older than this reissues the
# cookie, resetting the 30-day clock — see SessionRenewalMiddleware. Without
# this the 30 days count from LOGIN, not last use. Throttled (not renewed on
# every request) so an active user gets at most one re-sign per day.
SESSION_RENEW_AFTER_MS = 1000 * 60 * 60 * 24  # 1 day


def _b64url_decode(value: str) -> bytes:
    padded = value + "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def sign_session(user_id: str, auth_version: int) -> str:
    payload = _b64url_encode(
        json.dumps({"uid": user_id, "ver": auth_version, "exp": time.time() * 1000 + _SESSION_TTL_MS}).encode("utf-8")
    )
    sig = _b64url_encode(hmac.new(settings.AUTH_SECRET.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest())
    return f"{payload}.{sig}"


def should_renew_session(exp: float, now: float | None = None) -> bool:
    now = now if now is not None else time.time() * 1000
    return exp - now < _SESSION_TTL_MS - SESSION_RENEW_AFTER_MS


def session_cookie_kwargs() -> dict:
    """Single source of truth for the cookie's flags — login, password-
    change re-issue, and the renewal middleware all use this, so a maxAge
    or flag fix made once can't drift out of sync between them.

    `samesite` defaults to "Lax", matching auth.js's current behavior,
    even though Django is now a full issuer — deliberately NOT switched to
    "None" here. CLAUDE.md flags this exact tradeoff as "needs revisiting
    once Next.js stops being the cookie issuer"; Lax still works today
    because the frontend is not yet actually deployed cross-origin against
    this backend (task #11). Override via DJANGO_SESSION_COOKIE_SAMESITE
    ("None" requires secure=True, which DEBUG mode can't satisfy over
    plain HTTP — set DJANGO_DEBUG=0 or accept Chrome/Firefox rejecting the
    cookie locally) once the real cross-origin cutover happens."""
    import os

    samesite = os.environ.get("DJANGO_SESSION_COOKIE_SAMESITE", "Lax")
    return {
        "httponly": True,
        "samesite": samesite,
        "secure": not settings.DEBUG or samesite == "None",
        "path": "/",
        "max_age": SESSION_MAX_AGE_SECONDS,
    }


def verify_session_token(token: str) -> dict | None:
    """Mirrors verifySessionToken() in src/lib/auth.js exactly, including
    the auth_version-less legacy-cookie fallback (`ver ?? 0`)."""
    parts = token.split(".")
    if len(parts) != 2:
        return None
    payload, sig = parts
    if not payload or not sig:
        return None

    expected_sig = _b64url_encode(
        hmac.new(settings.AUTH_SECRET.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest()
    )
    if not hmac.compare_digest(sig, expected_sig):
        return None

    try:
        raw = _b64url_decode(payload)
        data = json.loads(raw)
    except (ValueError, UnicodeDecodeError):
        return None

    uid = data.get("uid")
    ver = data.get("ver")
    exp = data.get("exp")
    ver = 0 if ver is None else ver

    if not isinstance(uid, str) or not uid:
        return None
    if not isinstance(ver, int) or isinstance(ver, bool) or ver < 0:
        return None
    if not isinstance(exp, (int, float)) or isinstance(exp, bool):
        return None
    now_ms = time.time() * 1000
    if exp < now_ms:
        return None

    return {"user_id": uid, "auth_version": ver, "exp": exp}


class LuminaSessionAuthentication(BaseAuthentication):
    """DRF authentication backend reading the veevee_session cookie.

    Equivalent to getSession() in auth.js: verify the HMAC, then confirm the
    user still exists, is active, and the auth_version still matches (so a
    disabled user or a forced logout — auth_version bump — takes effect
    immediately, not just when the token naturally expires).
    """

    def authenticate(self, request):
        token = request.COOKIES.get(settings.LUMINA_SESSION_COOKIE)
        if not token:
            return None

        session = verify_session_token(token)
        if session is None:
            return None

        try:
            user = User.objects.get(pk=session["user_id"])
        except User.DoesNotExist:
            return None

        if not user.is_active or user.auth_version != session["auth_version"]:
            return None

        return (user, None)

    def authenticate_header(self, request):
        return "Cookie"


class IsAdminUser(BasePermission):
    """Mirrors requireAdmin(): role == 'admin', not Django's is_staff."""

    def has_permission(self, request, view):
        return bool(request.user and request.user.is_authenticated and request.user.role == "admin")
