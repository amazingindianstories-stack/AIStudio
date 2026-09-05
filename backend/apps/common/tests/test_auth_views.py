"""View-level tests for auth_views.py — the full login/logout/me/password
flow was verified live against a disposable production user in this
session (created via /api/admin/users, exercised, then deleted; see the
backend/ section of CLAUDE.md), including password-change correctly
bumping auth_version to invalidate the prior session. These pin the
validation/auth-gating contracts deterministically against the test DB.

PilotDomainAuthTests also lives here (not split further by route) — its
own docstring is explicit that it exercises the shared session-cookie
contract at the view layer across several routes, not per-domain
behavior; splitting it by route would just duplicate its setUp."""

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from ..password import hash_password
from ..test_utils import SECRET, _cookie_for, _make_user


def _make_user_with_password(password: str, **overrides):
    hashed = hash_password(password)
    return _make_user(password_hash=hashed["hash"], password_salt=hashed["salt"], **overrides)


@override_settings(AUTH_SECRET=SECRET)
class LoginTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_requires_email_and_password(self):
        resp = self.client.post("/api/auth/login", {"email": "a@b.com"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_wrong_password_rejected(self):
        _make_user_with_password("correct-horse-battery", email="login-test@example.com")
        resp = self.client.post(
            "/api/auth/login", {"email": "login-test@example.com", "password": "wrong"}, format="json"
        )
        self.assertEqual(resp.status_code, 401)

    def test_unknown_email_rejected(self):
        resp = self.client.post(
            "/api/auth/login", {"email": "nobody@example.com", "password": "whatever"}, format="json"
        )
        self.assertEqual(resp.status_code, 401)

    def test_disabled_user_rejected_even_with_correct_password(self):
        _make_user_with_password("correct-horse-battery", email="disabled@example.com", is_active=False)
        resp = self.client.post(
            "/api/auth/login", {"email": "disabled@example.com", "password": "correct-horse-battery"}, format="json"
        )
        self.assertEqual(resp.status_code, 401)

    def test_correct_password_sets_session_cookie(self):
        user = _make_user_with_password("correct-horse-battery", email="works@example.com")
        resp = self.client.post(
            "/api/auth/login", {"email": "works@example.com", "password": "correct-horse-battery"}, format="json"
        )
        self.assertEqual(resp.status_code, 200)
        self.assertTrue(resp.data["ok"])
        self.assertEqual(resp.data["data"]["user"]["id"], str(user.id))
        self.assertIn("veevee_session", resp.cookies)

    def test_email_matching_is_case_and_whitespace_insensitive(self):
        _make_user_with_password("correct-horse-battery", email="case@example.com")
        resp = self.client.post(
            "/api/auth/login", {"email": "  CASE@EXAMPLE.com  ", "password": "correct-horse-battery"}, format="json"
        )
        self.assertEqual(resp.status_code, 200)


@override_settings(AUTH_SECRET=SECRET)
class MeTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_get_without_session_returns_null_user_not_error(self):
        resp = self.client.get("/api/auth/me")
        self.assertEqual(resp.status_code, 200)
        self.assertIsNone(resp.data["data"]["user"])

    def test_get_with_session_returns_user(self):
        user = _make_user()
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.get("/api/auth/me")
        self.assertEqual(resp.data["data"]["user"]["id"], str(user.id))

    def test_patch_without_session_401s(self):
        resp = self.client.patch("/api/auth/me", {"name": "New Name"}, format="json")
        self.assertEqual(resp.status_code, 401)

    def test_patch_updates_name(self):
        user = _make_user(name="Old Name")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch("/api/auth/me", {"name": "New Name"}, format="json")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.data["data"]["user"]["name"], "New Name")

    def test_patch_empty_name_rejected(self):
        user = _make_user()
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch("/api/auth/me", {"name": "   "}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_patch_nothing_changed_rejected(self):
        user = _make_user(name="Same Name")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch("/api/auth/me", {"name": "Same Name"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_patch_name_too_long_rejected(self):
        user = _make_user()
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch("/api/auth/me", {"name": "x" * 81}, format="json")
        self.assertEqual(resp.status_code, 400)


@override_settings(AUTH_SECRET=SECRET)
class PasswordChangeTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_requires_current_password(self):
        user = _make_user_with_password("old-password-123")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch("/api/auth/password", {"newPassword": "new-password-456"}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_wrong_current_password_rejected(self):
        user = _make_user_with_password("old-password-123")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch(
            "/api/auth/password", {"currentPassword": "wrong", "newPassword": "new-password-456"}, format="json"
        )
        self.assertEqual(resp.status_code, 401)

    def test_weak_new_password_rejected(self):
        user = _make_user_with_password("old-password-123")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.patch(
            "/api/auth/password", {"currentPassword": "old-password-123", "newPassword": "short"}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

    def test_correct_change_bumps_auth_version_and_reissues_cookie(self):
        user = _make_user_with_password("old-password-123")
        old_cookie = _cookie_for(str(user.id))
        self.client.cookies["veevee_session"] = old_cookie
        resp = self.client.patch(
            "/api/auth/password",
            {"currentPassword": "old-password-123", "newPassword": "new-password-456"},
            format="json",
        )
        self.assertEqual(resp.status_code, 200)

        user.refresh_from_db()
        self.assertEqual(user.auth_version, 1)

        # The old cookie (auth_version=0) must no longer authenticate.
        stale_client = APIClient()
        stale_client.cookies["veevee_session"] = old_cookie
        stale_resp = stale_client.get("/api/auth/me")
        self.assertIsNone(stale_resp.data["data"]["user"])

    def test_password_route_requires_auth(self):
        resp = self.client.patch(
            "/api/auth/password", {"currentPassword": "x", "newPassword": "y" * 10}, format="json"
        )
        self.assertEqual(resp.status_code, 401)


@override_settings(AUTH_SECRET=SECRET)
class LogoutTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_logout_clears_cookie(self):
        user = _make_user()
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.post("/api/auth/logout")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.cookies["veevee_session"].value, "")

    def test_logout_without_session_still_succeeds(self):
        resp = self.client.post("/api/auth/logout")
        self.assertEqual(resp.status_code, 200)


@override_settings(AUTH_SECRET=SECRET)
class PilotDomainAuthTests(TestCase):
    """Every pilot route must 401 without a session and succeed with one —
    the shared session-cookie contract, exercised here at the view layer
    instead of the pure verifier (see test_session_auth.py)."""

    def setUp(self):
        self.client = APIClient()
        self.user = _make_user()

    def test_users_requires_auth(self):
        resp = self.client.get("/api/users")
        self.assertEqual(resp.status_code, 401)

    def test_users_returns_data_when_authenticated(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get("/api/users")
        self.assertEqual(resp.status_code, 200)
        self.assertEqual(len(resp.data["users"]), 1)

    def test_projects_requires_auth(self):
        resp = self.client.get("/api/projects")
        self.assertEqual(resp.status_code, 401)

    def test_disabled_user_cookie_rejected(self):
        disabled = _make_user(is_active=False)
        self.client.cookies["veevee_session"] = _cookie_for(str(disabled.id))
        resp = self.client.get("/api/projects")
        self.assertEqual(resp.status_code, 401)

    def test_bumped_auth_version_rejects_old_cookie(self):
        user = _make_user(auth_version=5)
        stale_cookie = _cookie_for(str(user.id), ver=0)
        self.client.cookies["veevee_session"] = stale_cookie
        resp = self.client.get("/api/projects")
        self.assertEqual(resp.status_code, 401)

    def test_assets_create_requires_valid_kind(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.post(
            "/api/assets", {"kind": "not-a-real-kind", "name": "X", "images": []}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

    def test_assets_create_requires_name(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.post("/api/assets", {"kind": "prop", "name": "  ", "images": []}, format="json")
        self.assertEqual(resp.status_code, 400)
