"""Shared test fixtures for minting a valid session cookie and a throwaway
User row without going through the real login flow. Used across every
app's tests that need an authenticated APIClient (common, projects, assets,
media, generation, canvas, agents, admin_dashboard) — kept here rather than
duplicated per app because apps.common is the one app every other app can
already depend on."""

import base64
import hashlib
import hmac
import json
import time
import uuid

from .models import User

SECRET = "test-secret"


def _cookie_for(user_id: str, ver: int = 0) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"uid": user_id, "ver": ver, "exp": time.time() * 1000 + 60_000}).encode()
    ).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(
        hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return f"{payload}.{sig}"


def _make_user(**overrides) -> User:
    defaults = dict(
        id=uuid.uuid4(),
        email=f"{uuid.uuid4()}@example.com",
        name="Test User",
        role="user",
        is_active=True,
        auth_version=0,
        created_at=int(time.time() * 1000),
    )
    defaults.update(overrides)
    return User.objects.create(**defaults)
