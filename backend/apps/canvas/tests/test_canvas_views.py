"""Auth/validation tests for canvas_views.py — the happy-path CRUD and the
validate_canvas_state round trip were verified live against production
(see the backend/ section of CLAUDE.md); this pins the parts a live smoke
test doesn't cover deterministically."""

import uuid

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common.test_utils import SECRET, _cookie_for, _make_user
from apps.projects.models import Project

from ..models import CanvasBoard


@override_settings(AUTH_SECRET=SECRET)
class CanvasBoardsAuthTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = _make_user()

    def test_list_requires_auth(self):
        resp = self.client.get("/api/canvas-boards?projectId=x")
        self.assertEqual(resp.status_code, 401)

    def test_list_requires_project_id(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get("/api/canvas-boards")
        self.assertEqual(resp.status_code, 400)

    def test_create_requires_name(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.post(
            "/api/canvas-boards", {"op": "createBoard", "projectId": "x", "name": "  "}, format="json"
        )
        self.assertEqual(resp.status_code, 400)

    def test_rename_unknown_board_404s(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.post(
            "/api/canvas-boards", {"op": "renameBoard", "id": str(uuid.uuid4()), "name": "x"}, format="json"
        )
        self.assertEqual(resp.status_code, 404)

    def test_unknown_op_400s(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.post("/api/canvas-boards", {"op": "bogus"}, format="json")
        self.assertEqual(resp.status_code, 400)


@override_settings(AUTH_SECRET=SECRET)
class CanvasBoardDetailAuthTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = _make_user()
        import time

        now = int(time.time() * 1000)
        self.project = Project.objects.create(id=uuid.uuid4(), name="P", created_at=now, updated_at=now)
        self.board = CanvasBoard.objects.create(
            id=uuid.uuid4(), project_id=self.project.id, name="B",
            data={"version": 1, "viewport": {"x": 0, "y": 0, "zoom": 1}, "nodes": [], "connectors": []},
            created_at=now, updated_at=now,
        )

    def test_get_requires_auth(self):
        resp = self.client.get(f"/api/canvas-boards/{self.board.id}")
        self.assertEqual(resp.status_code, 401)

    def test_put_rejects_non_dict_data(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.put(f"/api/canvas-boards/{self.board.id}", {"data": [1, 2, 3]}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_put_missing_data_key_rejected(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.put(f"/api/canvas-boards/{self.board.id}", {}, format="json")
        self.assertEqual(resp.status_code, 400)

    def test_get_unknown_board_404s(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get(f"/api/canvas-boards/{uuid.uuid4()}")
        self.assertEqual(resp.status_code, 404)
