from unittest.mock import patch

from django.test import TestCase

from ..login_throttle import WINDOW_MS, check_login_throttle, cleanup_expired_login_attempts, record_login_failure
from ..models import LoginAttempt


class LoginThrottleTests(TestCase):
    @patch.dict("os.environ", {"LOGIN_MAX_ATTEMPTS": "2"})
    def test_blocks_at_limit_and_reports_retry(self):
        now = 2_000_000_000_000
        record_login_failure(" USER@example.com ", now=now - 1000)
        record_login_failure("user@example.com", now=now - 500)
        result = check_login_throttle("USER@EXAMPLE.COM", now=now)
        self.assertFalse(result["allowed"])
        self.assertEqual(result["retryAfterMs"], WINDOW_MS - 1000)

    @patch.dict("os.environ", {"LOGIN_MAX_ATTEMPTS": "0"})
    def test_zero_disables_gate(self):
        self.assertTrue(check_login_throttle("user@example.com")["allowed"])

    def test_cleanup_is_idempotent(self):
        now = 2_000_000_000_000
        LoginAttempt.objects.create(identifier="old", created_at=now - WINDOW_MS)
        LoginAttempt.objects.create(identifier="new", created_at=now - WINDOW_MS + 1)
        self.assertEqual(cleanup_expired_login_attempts(now), 1)
        self.assertEqual(cleanup_expired_login_attempts(now), 0)
