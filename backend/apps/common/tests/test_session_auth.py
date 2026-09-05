import base64
import hashlib
import hmac
import json
import time

from django.test import TestCase, override_settings

from ..session_auth import session_cookie_kwargs, should_renew_session, sign_session, verify_session_token

SECRET = "test-secret"


def _mint(uid, ver, exp_ms, *, omit_ver=False, secret=SECRET):
    """Reference implementation of src/lib/auth.js's signSession(), used to
    generate fixtures independently of verify_session_token so a bug shared
    by both sides can't hide the test."""
    data = {"uid": uid, "exp": exp_ms}
    if not omit_ver:
        data["ver"] = ver
    payload = base64.urlsafe_b64encode(json.dumps(data).encode()).decode().rstrip("=")
    sig = base64.urlsafe_b64encode(
        hmac.new(secret.encode(), payload.encode(), hashlib.sha256).digest()
    ).decode().rstrip("=")
    return f"{payload}.{sig}"


@override_settings(AUTH_SECRET=SECRET)
class VerifySessionTokenTests(TestCase):
    def test_valid_token_verifies(self):
        token = _mint("user-1", 2, time.time() * 1000 + 60_000)
        session = verify_session_token(token)
        self.assertEqual(session, {"user_id": "user-1", "auth_version": 2, "exp": session["exp"]})

    def test_legacy_token_without_ver_defaults_to_zero(self):
        """Cookies issued before session versioning had no `ver` field —
        auth.js treats that as auth_version 0 so old sessions stay valid."""
        token = _mint("user-1", None, time.time() * 1000 + 60_000, omit_ver=True)
        session = verify_session_token(token)
        self.assertEqual(session["auth_version"], 0)

    def test_expired_token_rejected(self):
        token = _mint("user-1", 0, time.time() * 1000 - 1)
        self.assertIsNone(verify_session_token(token))

    def test_tampered_signature_rejected(self):
        token = _mint("user-1", 0, time.time() * 1000 + 60_000)
        payload, _sig = token.split(".")
        tampered = f"{payload}.notarealsignature"
        self.assertIsNone(verify_session_token(tampered))

    def test_wrong_secret_rejected(self):
        token = _mint("user-1", 0, time.time() * 1000 + 60_000, secret="a-different-secret")
        self.assertIsNone(verify_session_token(token))

    def test_malformed_token_rejected(self):
        self.assertIsNone(verify_session_token("not-a-valid-token"))
        self.assertIsNone(verify_session_token(""))
        self.assertIsNone(verify_session_token("a.b.c"))

    def test_boolean_ver_rejected(self):
        """Python's bool is an int subclass — isinstance(True, int) is True —
        so this must be checked explicitly or a JSON `true`/`false` for `ver`
        would silently pass as auth_version 1/0."""
        payload = base64.urlsafe_b64encode(
            json.dumps({"uid": "user-1", "ver": True, "exp": time.time() * 1000 + 60_000}).encode()
        ).decode().rstrip("=")
        sig = base64.urlsafe_b64encode(
            hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).digest()
        ).decode().rstrip("=")
        self.assertIsNone(verify_session_token(f"{payload}.{sig}"))


@override_settings(AUTH_SECRET=SECRET)
class SignSessionTests(TestCase):
    """sign_session is the task #9 addition — Django as a full issuer, not
    just a verifier. Bidirectional interop with the real TS
    signSession/verifySessionToken was verified live in this session (see
    the backend/ section of CLAUDE.md): a Django-minted token was checked
    against Node's actual verifySessionToken algorithm and vice versa."""

    def test_sign_then_verify_round_trips(self):
        token = sign_session("user-42", 3)
        session = verify_session_token(token)
        self.assertEqual(session["user_id"], "user-42")
        self.assertEqual(session["auth_version"], 3)

    def test_signed_token_is_not_yet_expired(self):
        token = sign_session("user-1", 0)
        session = verify_session_token(token)
        self.assertGreater(session["exp"], time.time() * 1000)

    def test_different_secret_cannot_verify(self):
        token = sign_session("user-1", 0)
        with override_settings(AUTH_SECRET="a-different-secret"):
            self.assertIsNone(verify_session_token(token))


class ShouldRenewSessionTests(TestCase):
    def test_fresh_session_not_renewed(self):
        now = 1_000_000_000_000
        exp = now + 29 * 24 * 60 * 60 * 1000  # 29 days left of a 30-day session
        self.assertFalse(should_renew_session(exp, now))

    def test_stale_session_renewed(self):
        now = 1_000_000_000_000
        exp = now + 12 * 60 * 60 * 1000  # 12 hours left — session is ~29.5 days old
        self.assertTrue(should_renew_session(exp, now))

    def test_boundary_at_renew_after_threshold(self):
        # The boundary is TTL - RENEW_AFTER = 30 days - 1 day = 29 days of
        # remaining life: less than that renews, at-or-more does not.
        now = 1_000_000_000_000
        twenty_nine_days_ms = 29 * 24 * 60 * 60 * 1000
        just_inside = now + twenty_nine_days_ms - 1
        just_outside = now + twenty_nine_days_ms + 1
        self.assertTrue(should_renew_session(just_inside, now))
        self.assertFalse(should_renew_session(just_outside, now))


class SessionCookieKwargsTests(TestCase):
    def test_cross_origin_cookie_is_host_only_none_and_secure(self):
        kwargs = session_cookie_kwargs()
        self.assertEqual(kwargs["samesite"], "None")
        self.assertTrue(kwargs["secure"])
        self.assertTrue(kwargs["httponly"])
        self.assertEqual(kwargs["path"], "/")
        self.assertNotIn("domain", kwargs)
        self.assertEqual(kwargs["max_age"], 60 * 60 * 24 * 30)
