"""Regression tests for queue/execute's admission-control fix.

Ported alongside the same fix in src/app/api/queue/execute/route.js: this
route used to have no admission control of its own — it trusted the client
to only call it once /api/queue/status (get_queue_position) reported
position 0. A direct POST could skip that check entirely, bypassing both the
MAX_CONCURRENT cap and the Gemini spend-window gate. Now queue_execute calls
get_queue_position() itself before locking/running anything.

This module needs real Postgres (get_queue_position's _queue_snapshot uses
ILIKE and other Postgres-only SQL — see CLAUDE.md's "Running the Django
suite" note); it is expected to fail with a raw-SQL-shaped error under
SQLite, same as the rest of the queue/history machinery.
"""

import os
import time
import uuid
from unittest.mock import patch

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common.test_utils import SECRET, _cookie_for, _make_user

from ..models import Generation


def _make_generation(**overrides) -> Generation:
    now = int(time.time() * 1000)
    defaults = dict(
        id=uuid.uuid4(), kind="image", status="queued", prompt="test prompt",
        model="Nano Banana Pro", aspect_ratio="1:1", cost_cents=0,
        created_at=now, updated_at=now,
    )
    defaults.update(overrides)
    return Generation.objects.create(**defaults)


@override_settings(AUTH_SECRET=SECRET)
class QueueExecuteAdmissionTests(TestCase):
    """MAX_CONCURRENT["image"] is 2 — two already-"running" image rows fill
    the cap, so a third queued image is not actually at position 0 yet."""

    def setUp(self):
        self.client = APIClient()
        self.owner = _make_user(role="user")
        self.client.cookies["veevee_session"] = _cookie_for(str(self.owner.id))

    def test_execute_holds_a_job_that_is_not_actually_at_position_zero(self):
        _make_generation(status="running", kind="image")
        _make_generation(status="running", kind="image")
        queued = _make_generation(status="queued", kind="image", user_id=self.owner.id)

        resp = self.client.post(
            "/api/queue/execute", {"id": str(queued.id)}, format="json"
        )

        self.assertEqual(resp.status_code, 200)
        body = resp.json()
        self.assertTrue(body.get("notAdmitted"))
        self.assertGreater(body.get("position", 0), 0)
        # Not locked — a held job must not transition to "running" just
        # because execute was called on it prematurely.
        queued.refresh_from_db()
        self.assertEqual(queued.status, "queued")

    def test_execute_proceeds_past_the_gate_when_actually_admitted(self):
        # No competing running rows — cap has room, so position is 0 and the
        # route must move past the admission check into lock_job() and
        # actually run the (mocked, no real provider call) generation.
        queued = _make_generation(status="queued", kind="image", user_id=self.owner.id)

        with patch.dict(os.environ, {"MOCK_GENERATION": "1"}):
            resp = self.client.post(
                "/api/queue/execute", {"id": str(queued.id)}, format="json"
            )

        body = resp.json() if resp.content else {}
        self.assertNotIn("notAdmitted", body)
        self.assertEqual(body.get("status"), "succeeded")
        queued.refresh_from_db()
        self.assertEqual(queued.status, "succeeded")

    def test_execute_on_someone_elses_job_is_no_longer_forbidden(self):
        # Regression test for the ownership-gate-broke-orphan-adoption bug:
        # a teammate driving another user's stale queued job (see
        # adoptOrphanedJobs in store.js) must not get a bare 403 — the real
        # protection is admission control, not ownership. Deliberately not
        # admitted here (cap filled) so this exercises the gate without
        # reaching any real provider code.
        _make_generation(status="running", kind="image")
        _make_generation(status="running", kind="image")
        other_owner = _make_user(role="user")
        queued = _make_generation(status="queued", kind="image", user_id=other_owner.id)

        resp = self.client.post(
            "/api/queue/execute", {"id": str(queued.id)}, format="json"
        )

        self.assertNotEqual(resp.status_code, 403)
        self.assertTrue(resp.json().get("notAdmitted"))

    def test_execute_missing_job_is_404(self):
        resp = self.client.post(
            "/api/queue/execute", {"id": str(uuid.uuid4())}, format="json"
        )
        self.assertEqual(resp.status_code, 404)
