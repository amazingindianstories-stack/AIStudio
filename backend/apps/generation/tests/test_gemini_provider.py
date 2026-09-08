"""Port of src/lib/providers/gemini.test.js's retryDelayMs cases."""

import json

from django.test import SimpleTestCase

from ..providers import gemini as g


def resource_exhausted(retry_delay: str | None = None) -> str:
    details = [{"@type": "type.googleapis.com/google.rpc.QuotaFailure", "violations": []}]
    if retry_delay:
        details.append({"@type": "type.googleapis.com/google.rpc.RetryInfo", "retryDelay": retry_delay})
    return json.dumps({
        "error": {
            "code": 429,
            "message": "You exceeded your spend-based rate limit.",
            "status": "RESOURCE_EXHAUSTED",
            "details": details,
        }
    })


class RetryDelayMsTests(SimpleTestCase):
    def test_reads_retry_delay_and_converts_to_ms(self):
        self.assertEqual(g.retry_delay_ms(resource_exhausted("31s")), 31_000)

    def test_accepts_fractional_duration_strings(self):
        self.assertEqual(g.retry_delay_ms(resource_exhausted("1.5s")), 1_500)

    def test_clamps_0s_hint_up(self):
        self.assertEqual(g.retry_delay_ms(resource_exhausted("0s")), 1_000)

    def test_clamps_absurd_hint_down(self):
        self.assertEqual(g.retry_delay_ms(resource_exhausted("3600s")), 60_000)

    def test_returns_none_when_no_retry_info(self):
        self.assertIsNone(g.retry_delay_ms(resource_exhausted()))

    def test_returns_none_on_non_json_body(self):
        self.assertIsNone(g.retry_delay_ms("<html>502 Bad Gateway</html>"))

    def test_returns_none_when_details_not_a_list(self):
        self.assertIsNone(g.retry_delay_ms(json.dumps({"error": {"details": "nope"}})))

    def test_ignores_malformed_or_missing_retry_delay(self):
        self.assertIsNone(g.retry_delay_ms(resource_exhausted("soon")))
        self.assertIsNone(
            g.retry_delay_ms(
                json.dumps({"error": {"details": [{"@type": "type.googleapis.com/google.rpc.RetryInfo"}]}})
            )
        )
