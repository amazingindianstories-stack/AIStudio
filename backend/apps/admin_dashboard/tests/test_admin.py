"""Port of the parser-half of src/lib/admin-logs.test.js and
admin-activity.test.js (parseAdminLogFilter/parseAdminActivityFilter). The
`*FilterToParams` builders are frontend-only (query-string construction
for the client fetch) and stay in the frontend — not ported here, same
reasoning as history-query.js's historyFilterToParams."""

from django.test import SimpleTestCase
from django.test import Client, TestCase, override_settings

from apps.common.test_utils import SECRET, _cookie_for, _make_user

from .. import admin_activity, admin_logs

UUID = "6a0b7185-f565-4eb2-9d30-63e0bae8e963"


def _parse_log(qs: str) -> dict:
    from django.http import QueryDict

    return admin_logs.parse_admin_log_filter(QueryDict(qs))


def _parse_activity(qs: str) -> dict:
    from django.http import QueryDict

    return admin_activity.parse_admin_activity_filter(QueryDict(qs))


class ParseAdminLogFilterTests(SimpleTestCase):
    def test_empty_querystring_is_empty_filter(self):
        self.assertEqual(_parse_log(""), {})

    def test_recognised_filters_are_read(self):
        self.assertEqual(
            _parse_log(f"userId={UUID}&kind=video&model=Seedance%202.0&status=failed&q=cat"),
            {"userId": UUID, "kind": "video", "model": "Seedance 2.0", "status": "failed", "q": "cat"},
        )

    def test_non_uuid_userid_dropped(self):
        self.assertEqual(_parse_log("userId=../../etc/passwd"), {})
        self.assertEqual(_parse_log("userId=1 OR 1=1"), {})

    def test_only_image_and_video_accepted_as_kind(self):
        self.assertEqual(_parse_log("kind=image").get("kind"), "image")
        self.assertEqual(_parse_log("kind=video").get("kind"), "video")
        self.assertIsNone(_parse_log("kind=audio").get("kind"))
        self.assertIsNone(_parse_log("kind=").get("kind"))

    def test_status_restricted_to_real_statuses(self):
        for s in ("queued", "running", "succeeded", "failed"):
            self.assertEqual(_parse_log(f"status={s}").get("status"), s)
        self.assertIsNone(_parse_log("status=deleted").get("status"))

    def test_search_trimmed_and_length_capped(self):
        self.assertEqual(_parse_log("q=%20%20hello%20%20").get("q"), "hello")
        self.assertEqual(len(_parse_log("q=" + "a" * 500).get("q")), admin_logs.MAX_LOG_QUERY_LENGTH)
        self.assertIsNone(_parse_log("q=%20%20").get("q"))


class ParseAdminActivityFilterTests(SimpleTestCase):
    def test_empty_querystring_is_empty_filter(self):
        self.assertEqual(_parse_activity(""), {})

    def test_recognised_filters_are_read(self):
        self.assertEqual(_parse_activity(f"action=login&userId={UUID}"), {"action": "login", "userId": UUID})

    def test_non_uuid_userid_dropped(self):
        self.assertEqual(_parse_activity("userId=not-a-uuid"), {})
        self.assertEqual(_parse_activity("userId=1 OR 1=1"), {})

    def test_unknown_action_kept_not_whitelisted(self):
        self.assertEqual(_parse_activity("action=some_future_action").get("action"), "some_future_action")

    def test_action_length_capped(self):
        long = "x" * (admin_activity.MAX_ACTION_LENGTH + 50)
        self.assertEqual(len(_parse_activity(f"action={long}").get("action")), admin_activity.MAX_ACTION_LENGTH)

    def test_blank_or_whitespace_action_dropped(self):
        self.assertIsNone(_parse_activity("action=").get("action"))
        self.assertIsNone(_parse_activity("action=%20%20").get("action"))

    def test_action_trimmed(self):
        self.assertEqual(_parse_activity("action=%20login%20").get("action"), "login")

    def test_unrelated_params_ignored(self):
        self.assertEqual(_parse_activity("cursor=123.abc&limit=500&format=csv"), {})


@override_settings(AUTH_SECRET=SECRET)
class AdminRouteAuthTests(TestCase):
    """403-not-401 gating (adminOrNull's contract) verified live against
    production in this session (see the backend/ section of CLAUDE.md);
    this pins it deterministically, including the plain-Django-view CSV
    export path which bypasses DRF's authentication machinery entirely."""

    def setUp(self):
        self.client = Client()

    def test_admin_data_unauthenticated_is_403_not_401(self):
        resp = self.client.get("/api/admin/data")
        self.assertEqual(resp.status_code, 403)

    def test_admin_data_non_admin_is_403(self):
        user = _make_user(role="user")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.get("/api/admin/data")
        self.assertEqual(resp.status_code, 403)

    def test_admin_data_admin_gets_200(self):
        user = _make_user(role="admin")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.get("/api/admin/data")
        self.assertEqual(resp.status_code, 200)

    def test_admin_logs_plain_view_unauthenticated_is_403(self):
        resp = self.client.get("/api/admin/logs")
        self.assertEqual(resp.status_code, 403)

    def test_admin_logs_csv_format_param_does_not_404_under_drf_negotiation(self):
        # Regression test for the real bug found in this session: DRF's
        # content negotiation intercepts a bare `?format=` query param and
        # 404s before the view runs, unless the view is a plain Django
        # view (see admin_logs_view's docstring).
        user = _make_user(role="admin")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.get("/api/admin/logs?format=csv")
        self.assertEqual(resp.status_code, 200)
        self.assertIn("text/csv", resp["Content-Type"])

    def test_admin_pricing_requires_admin(self):
        resp = self.client.post("/api/admin/pricing", {"model": "x", "unitCostCents": 1, "unit": "per_image"}, content_type="application/json")
        self.assertEqual(resp.status_code, 403)

    def test_admin_status_requires_admin(self):
        resp = self.client.get("/api/admin/status")
        self.assertEqual(resp.status_code, 403)

    def test_admin_activity_requires_admin(self):
        resp = self.client.get("/api/admin/activity")
        self.assertEqual(resp.status_code, 403)
