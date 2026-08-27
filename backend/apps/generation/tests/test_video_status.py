"""Regression test for the video status transient-poll-error fix.

Ported alongside the src/app/api/generate/video/status/route.js fix: a
transient poll error (network blip, provider 502/503) must never make this
view claim status "failed" — the frontend's pollVideo() treats any terminal
status as the end of polling and has no way to distinguish "the render really
failed" from "the poll request itself failed". See generation_views.py's
video_status for the full reasoning; keep this test and the TS-side test in
sync if the contract changes.
"""

import time
import uuid
from unittest.mock import patch

from django.test import TestCase
from rest_framework.test import APIClient

from ..models import Generation


def _make_running_video(**overrides) -> Generation:
    now = int(time.time() * 1000)
    defaults = dict(
        id=uuid.uuid4(),
        kind="video",
        status="running",
        prompt="test prompt",
        model="Seedance 2.0",
        aspect_ratio="16:9",
        task_id="task-123",
        created_at=now,
        updated_at=now,
    )
    defaults.update(overrides)
    return Generation.objects.create(**defaults)


class VideoStatusTransientErrorTests(TestCase):
    def setUp(self):
        self.client = APIClient()

    def test_transient_poll_error_does_not_report_failed(self):
        gen = _make_running_video()

        with patch(
            "apps.generation.generation_views.seedance_provider.get_video_task",
            side_effect=RuntimeError("ECONNRESET"),
        ):
            resp = self.client.get(f"/api/generate/video/status?id={gen.id}")

        self.assertEqual(resp.status_code, 502)
        body = resp.json()
        # No "id" key is the load-bearing part of the fix: pollVideo() on the
        # frontend only evaluates the terminal-status check inside
        # `if (item?.id)`, so a body without one falls through to its retry
        # timer instead of being treated as a finished (failed) job.
        self.assertNotIn("id", body)
        self.assertNotIn("status", body)
        self.assertTrue(body.get("transientError"))

    def test_transient_poll_error_leaves_db_row_running(self):
        gen = _make_running_video()

        with patch(
            "apps.generation.generation_views.seedance_provider.get_video_task",
            side_effect=RuntimeError("ECONNRESET"),
        ):
            self.client.get(f"/api/generate/video/status?id={gen.id}")

        gen.refresh_from_db()
        self.assertEqual(gen.status, "running")

    def test_omni_input_block_is_persisted_once_and_returns_200(self):
        gen = _make_running_video(model="Gemini Omni Flash")
        with patch(
            "apps.generation.generation_views.omni_provider.get_omni_video_status",
            return_value={
                "status": "failed",
                "error": "Input blocked: The prompt could not be processed.",
                "moderationBlocked": True,
            },
        ):
            resp = self.client.get(f"/api/generate/video/status?id={gen.id}")

        self.assertEqual(resp.status_code, 200)
        self.assertEqual(resp.json()["status"], "failed")
        gen.refresh_from_db()
        self.assertEqual(gen.status, "failed")
        self.assertTrue(gen.moderation_blocked)
