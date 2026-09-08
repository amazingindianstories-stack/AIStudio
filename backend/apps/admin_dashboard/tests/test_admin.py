"""Port of the parser-half of src/lib/admin-logs.test.js and
admin-activity.test.js (parseAdminLogFilter/parseAdminActivityFilter). The
`*FilterToParams` builders are frontend-only (query-string construction
for the client fetch) and stay in the frontend — not ported here, same
reasoning as history-query.js's historyFilterToParams."""

from unittest.mock import patch

from django.test import SimpleTestCase
from django.test import Client, TestCase, override_settings

from apps.common.test_utils import SECRET, _cookie_for, _make_user
from apps.generation.models import Generation

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

    def test_flagged_filter_is_explicit(self):
        self.assertTrue(_parse_log("flagged=1")["flagged"])
        self.assertNotIn("flagged", _parse_log("flagged=0"))


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

    def test_admin_logs_csv_not_truncated_reports_false_header(self):
        user = _make_user(role="admin")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))
        resp = self.client.get("/api/admin/logs?format=csv")
        self.assertEqual(resp["X-Logs-Truncated"], "False")
        self.assertNotIn("X-Logs-Truncated-At", resp)

    def test_admin_logs_csv_truncation_is_signalled_by_header_not_a_comment_row(self):
        # Regression test: truncation used to be signalled with an appended
        # `# truncated at...` line inside the CSV body itself, which breaks
        # RFC 4180 parsers (Excel, pandas, Sheets) that hit a malformed final
        # row. It must now be header-only, and the body must stay pure CSV —
        # every data line has exactly the same column count as the header.
        from unittest.mock import patch

        user = _make_user(role="admin")
        self.client.cookies["veevee_session"] = _cookie_for(str(user.id))

        fake_row = {
            "id": "x", "createdAt": 0, "userId": None, "kind": "image",
            "model": "m", "status": "succeeded", "costCents": 0, "prompt": "p",
        }
        with patch.object(admin_logs, "MAX_CSV_ROWS", 3), \
             patch.object(admin_logs, "read_admin_logs_for_export", return_value=[fake_row] * 3):
            resp = self.client.get("/api/admin/logs?format=csv")

        self.assertEqual(resp["X-Logs-Truncated"], "True")
        self.assertEqual(resp["X-Logs-Truncated-At"], "3")
        lines = resp.content.decode().splitlines()
        header_cols = len(lines[0].split(","))
        for line in lines[1:]:
            self.assertFalse(line.startswith("#"))
            self.assertEqual(len(line.split(",")), header_cols)

    def test_admin_pricing_requires_admin(self):
        resp = self.client.post("/api/admin/pricing", {"model": "x", "unitCostCents": 1, "unit": "per_image"}, content_type="application/json")
        self.assertEqual(resp.status_code, 403)

    def test_admin_status_requires_admin(self):
        resp = self.client.get("/api/admin/status")
        self.assertEqual(resp.status_code, 403)

    def test_admin_activity_requires_admin(self):
        resp = self.client.get("/api/admin/activity")
        self.assertEqual(resp.status_code, 403)


@override_settings(AUTH_SECRET=SECRET)
class AdminCostParityTests(TestCase):
    def setUp(self):
        self.client = Client()
        self.admin = _make_user(role="admin")
        self.client.cookies["veevee_session"] = _cookie_for(str(self.admin.id))

    def _generation(self, *, status, cost, basis="estimated", flagged=False):
        return Generation.objects.create(
            kind="image", status=status, prompt="audit", model="test", aspect_ratio="1:1",
            user_id=self.admin.id, cost_cents=cost, cost_basis=basis, flagged=flagged,
            flag_reason="review" if flagged else None,
            judge_score={"identity": 42} if flagged else None,
            created_at=1_000 + Generation.objects.count(), updated_at=1_000,
        )

    def test_data_counts_only_succeeded_cost_and_splits_basis(self):
        self._generation(status="succeeded", cost=100, basis="estimated")
        self._generation(status="succeeded", cost=75, basis="reconciled")
        self._generation(status="failed", cost=900, basis="estimated")
        response = self.client.get("/api/admin/data")
        self.assertEqual(response.status_code, 200)
        user = next(row for row in response.json()["users"] if row["id"] == str(self.admin.id))
        self.assertEqual(user["genCount"], 3)
        self.assertEqual(user["costCents"], 175)
        self.assertEqual(user["estimatedCostCents"], 100)
        self.assertEqual(user["reconciledCostCents"], 75)
        self.assertEqual(response.json()["stats"]["totalCostCents"], 175)

    def test_flagged_log_includes_evidence_and_cost_basis(self):
        row = self._generation(status="succeeded", cost=75, basis="reconciled", flagged=True)
        response = self.client.get("/api/admin/logs?flagged=1")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["total"], 1)
        self.assertEqual(payload["rows"][0]["id"], str(row.id))
        self.assertEqual(payload["rows"][0]["costBasis"], "reconciled")
        self.assertEqual(payload["rows"][0]["flagReason"], "review")
        self.assertEqual(payload["rows"][0]["judgeScore"], {"identity": 42})


@override_settings(AUTH_SECRET=SECRET)
class RuntimeAuditContractTests(TestCase):
    def setUp(self):
        self.client = Client()
        admin = _make_user(role="admin")
        self.client.cookies["veevee_session"] = _cookie_for(str(admin.id))

    @patch("apps.admin_dashboard.admin_views.run_kling_validation", return_value={"configured": False})
    @patch("apps.admin_dashboard.admin_views.claim_lease", return_value=True)
    def test_stable_shape_and_unconfigured_kling_results(self, _lease, _kling):
        response = self.client.post("/api/admin/audit/runtime")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-store")
        payload = response.json()
        self.assertEqual(
            [check["id"] for check in payload["checks"]],
            ["MIG-04", "ARCH-03", "QUAL-03", "ARCH-04", "VER-08", "VER-10", "REL-02", "REL-03", "COST-05", "REL-07"],
        )
        self.assertEqual(payload["checks"][3]["status"], "unknown")

    @patch("apps.admin_dashboard.admin_views.claim_lease", return_value=False)
    def test_distributed_cooldown_contract(self, _lease):
        response = self.client.post("/api/admin/audit/runtime")
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response["Retry-After"], "60")
