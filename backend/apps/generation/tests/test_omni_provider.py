"""Port of src/lib/providers/omni.test.js's cases. createOmniVideoTask/
getOmniVideoStatus (real network functions) are not exercised here, same
as the TS suite — those need scripts/probe-omni.js."""

import unittest.mock as mock

from django.test import SimpleTestCase

from ..providers import omni as o


class IsOmniModelTests(SimpleTestCase):
    def test_matches_case_insensitively(self):
        self.assertTrue(o.is_omni_model("Gemini Omni Flash"))
        self.assertTrue(o.is_omni_model("gemini omni flash"))
        self.assertFalse(o.is_omni_model("Higgsfield Seedance 2.0"))


class AssertGoogleHostTests(SimpleTestCase):
    def test_allows_googleapis_and_subdomains(self):
        o.assert_google_host("https://generativelanguage.googleapis.com/v1beta/files/x")
        o.assert_google_host("https://googleapis.com/x")

    def test_throws_on_non_google_host(self):
        with self.assertRaisesRegex(ValueError, "Refusing to attach Omni credentials"):
            o.assert_google_host("https://example.com/video.mp4")


class BuildOmniEndpointTests(SimpleTestCase):
    def test_genlang_path_needs_no_project(self):
        self.assertEqual(o.build_omni_endpoint(False), "https://generativelanguage.googleapis.com/v1beta/interactions")

    def test_vertex_path_requires_project_id(self):
        with self.assertRaisesRegex(ValueError, "requires a GCP project"):
            o.build_omni_endpoint(True)

    def test_vertex_path_builds_url(self):
        self.assertEqual(
            o.build_omni_endpoint(True, "my-proj"),
            "https://aiplatform.googleapis.com/v1beta1/projects/my-proj/locations/global/interactions",
        )


class BuildOmniPayloadTests(SimpleTestCase):
    def test_throws_on_unsupported_aspect_ratio(self):
        with self.assertRaisesRegex(ValueError, r"only supports 16:9/9:16"):
            o.build_omni_payload([], "1:1", 4)

    def test_accepts_16_9_and_9_16_no_task_or_delivery_fields(self):
        payload = o.build_omni_payload([], "16:9", 4)
        self.assertEqual(payload["response_format"]["type"], "video")
        self.assertEqual(payload["response_format"]["aspect_ratio"], "16:9")
        self.assertTrue(payload["background"])
        self.assertNotIn("task", payload)
        self.assertNotIn("delivery", payload)

    def test_formats_duration_as_protobuf_duration_string(self):
        payload = o.build_omni_payload([], "16:9", 6)
        self.assertEqual(payload["response_format"]["duration"], "6s")


class MapOmniStatusTests(SimpleTestCase):
    def test_completed_to_succeeded(self):
        self.assertEqual(o.map_omni_status("completed"), "succeeded")

    def test_in_progress_to_running(self):
        self.assertEqual(o.map_omni_status("in_progress"), "running")

    def test_terminal_failure_statuses(self):
        for s in ("failed", "cancelled", "incomplete", "budget_exceeded", "requires_action"):
            self.assertEqual(o.map_omni_status(s), "failed", s)

    def test_unrecognized_status_falls_back_to_running(self):
        self.assertEqual(o.map_omni_status("some_future_status"), "running")
        self.assertEqual(o.map_omni_status(None), "running")

    def test_input_blocked_400_is_terminal(self):
        result = o.terminal_omni_status_http_error(
            400,
            '{"error":{"message":"Input blocked: The prompt could not be processed.","code":"invalid_request"}}',
        )
        self.assertEqual(result, {
            "status": "failed",
            "error": "Input blocked: The prompt could not be processed.",
            "moderationBlocked": True,
        })

    def test_retryable_http_errors_remain_transient(self):
        for status_code in (401, 403, 408, 425, 429, 500, 502, 503):
            self.assertIsNone(o.terminal_omni_status_http_error(status_code, "temporary"), status_code)

    def test_empty_400_is_still_terminal(self):
        self.assertEqual(o.terminal_omni_status_http_error(400, ""), {
            "status": "failed",
            "error": "Omni status error (400).",
            "moderationBlocked": False,
        })


class ExtractOmniVideoTests(SimpleTestCase):
    def test_reads_inline_base64_from_steps_content(self):
        data = {
            "steps": [
                {"type": "thought", "signature": "..."},
                {"type": "model_output", "content": [{"type": "video", "mime_type": "video/mp4", "data": "QUJD"}]},
            ]
        }
        result = o.extract_omni_video(data)
        self.assertEqual(result["base64"], "QUJD")
        self.assertEqual(result["mimeType"], "video/mp4")

    def test_throws_loudly_when_no_video_data_or_uri(self):
        with self.assertRaisesRegex(RuntimeError, "returned no video"):
            o.extract_omni_video({"steps": []})

    def test_downloads_output_video_uri_on_google_host_with_api_key(self):
        data = {"output_video": {"uri": "https://generativelanguage.googleapis.com/v1beta/files/x:download"}}

        fake_response = mock.Mock()
        fake_response.ok = True
        fake_response.content = b"video-bytes"
        fake_response.headers = {"content-type": "video/mp4"}

        with mock.patch("apps.generation.providers.omni.requests.get", return_value=fake_response) as mocked:
            result = o.extract_omni_video(data, {"apiKey": "test-key"})
            called_url = mocked.call_args[0][0]
            called_headers = mocked.call_args[1]["headers"]
        self.assertEqual(called_url, "https://generativelanguage.googleapis.com/v1beta/files/x:download")
        self.assertEqual(called_headers.get("x-goog-api-key"), "test-key")
        self.assertEqual(result["mimeType"], "video/mp4")

    def test_refuses_non_google_uri_zero_fetch_calls(self):
        data = {"output_video": {"uri": "https://example.com/video.mp4"}}
        with mock.patch("apps.generation.providers.omni.requests.get") as mocked:
            with self.assertRaisesRegex(ValueError, "Refusing to attach Omni credentials"):
                o.extract_omni_video(data)
            mocked.assert_not_called()
