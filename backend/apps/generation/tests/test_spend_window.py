"""Port of src/lib/spend-window.test.js's cases."""

from django.test import SimpleTestCase

from .. import spend_window as sw


class AdmitsTests(SimpleTestCase):
    def test_lets_job_through_when_window_has_room(self):
        self.assertTrue(sw.admits(window_cents=40, job_cents=50, limit_cents=150, window_busy=True))

    def test_holds_job_that_would_cross_budget(self):
        self.assertFalse(sw.admits(window_cents=130, job_cents=50, limit_cents=150, window_busy=True))

    def test_landing_exactly_on_budget_is_allowed(self):
        self.assertTrue(sw.admits(window_cents=40, job_cents=50, limit_cents=150, window_busy=True))

    def test_empty_window_always_admits(self):
        self.assertTrue(sw.admits(window_cents=0, job_cents=5000, limit_cents=150, window_busy=False))

    def test_busy_window_still_holds_over_budget_job(self):
        self.assertFalse(sw.admits(window_cents=10, job_cents=5000, limit_cents=150, window_busy=True))

    def test_limit_of_zero_disables_gate(self):
        self.assertTrue(sw.admits(window_cents=99999, job_cents=99999, limit_cents=0, window_busy=True))


class SpendLimitCentsTests(SimpleTestCase):
    def test_falls_back_to_default_when_unset_or_junk(self):
        self.assertEqual(sw.spend_limit_cents({}), sw.DEFAULT_SPEND_LIMIT_CENTS)
        self.assertEqual(sw.spend_limit_cents({"GEMINI_SPEND_LIMIT_CENTS": "abc"}), sw.DEFAULT_SPEND_LIMIT_CENTS)
        self.assertEqual(sw.spend_limit_cents({"GEMINI_SPEND_LIMIT_CENTS": "-5"}), sw.DEFAULT_SPEND_LIMIT_CENTS)

    def test_honours_explicit_value_including_zero_opt_out(self):
        self.assertEqual(sw.spend_limit_cents({"GEMINI_SPEND_LIMIT_CENTS": "19000"}), 19000)
        self.assertEqual(sw.spend_limit_cents({"GEMINI_SPEND_LIMIT_CENTS": "0"}), 0)


class BestOfMultiplierTests(SimpleTestCase):
    def test_mirrors_route_clamp(self):
        self.assertEqual(sw.best_of_multiplier({}), 2)
        self.assertEqual(sw.best_of_multiplier({"FACE_BEST_OF": "1"}), 1)
        self.assertEqual(sw.best_of_multiplier({"FACE_BEST_OF": "4"}), 4)
        self.assertEqual(sw.best_of_multiplier({"FACE_BEST_OF": "9"}), 4)
        self.assertEqual(sw.best_of_multiplier({"FACE_BEST_OF": "0"}), 2)


class HoldRetryAfterMsTests(SimpleTestCase):
    def test_waits_until_oldest_row_leaves_window(self):
        now = 1_000_000
        oldest = now - 4 * 60 * 1000
        self.assertEqual(sw.hold_retry_after_ms(oldest, now), 6 * 60 * 1000)

    def test_floors_at_5s(self):
        now = 1_000_000
        self.assertEqual(sw.hold_retry_after_ms(now - sw.SPEND_WINDOW_MS + 10, now), 5_000)
        self.assertEqual(sw.hold_retry_after_ms(now - sw.SPEND_WINDOW_MS - 60_000, now), 5_000)

    def test_caps_at_window_length(self):
        now = 1_000_000
        self.assertEqual(sw.hold_retry_after_ms(now + 60 * 60 * 1000, now), sw.SPEND_WINDOW_MS)

    def test_defaults_to_5s_when_window_empty(self):
        self.assertEqual(sw.hold_retry_after_ms(None, 1_000_000), 5_000)
