"""Tests for the pure/validation parts of the agents system. No TS test
files exist for validate-message.js / route-handler.js's parseMessages to
port line-for-line (only orchestrator.test.js-adjacent pure helpers had
coverage upstream), so these are hand-written against the same contracts
read from the TS source."""

import uuid

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from apps.common.test_utils import SECRET, _cookie_for, _make_user

from ..agents import legacy
from ..agents.orchestrator.validate_message import MAX_CONTENT_LEN, MAX_IMAGES, parse_message_body


class ParseMessageBodyTests(TestCase):
    def test_requires_content(self):
        self.assertEqual(parse_message_body({}), {"error": "content is required."})
        self.assertEqual(parse_message_body({"content": "   "}), {"error": "content is required."})

    def test_trims_content(self):
        result = parse_message_body({"content": "  hi  "})
        self.assertEqual(result["content"], "hi")

    def test_rejects_overlong_content(self):
        result = parse_message_body({"content": "x" * (MAX_CONTENT_LEN + 1)})
        self.assertIn("too long", result["error"])

    def test_content_at_cap_accepted(self):
        result = parse_message_body({"content": "x" * MAX_CONTENT_LEN})
        self.assertEqual(len(result["content"]), MAX_CONTENT_LEN)

    def test_images_defaults_to_empty_list(self):
        result = parse_message_body({"content": "hi"})
        self.assertEqual(result["images"], [])

    def test_images_must_be_array(self):
        result = parse_message_body({"content": "hi", "images": "not-an-array"})
        self.assertIn("must be an array", result["error"])

    def test_non_string_images_filtered(self):
        result = parse_message_body({"content": "hi", "images": ["a", 1, None, "b"]})
        self.assertEqual(result["images"], ["a", "b"])

    def test_rejects_too_many_images(self):
        result = parse_message_body({"content": "hi", "images": ["a"] * (MAX_IMAGES + 1)})
        self.assertIn("at most", result["error"])

    def test_non_dict_body_treated_as_empty(self):
        self.assertEqual(parse_message_body("not a dict"), {"error": "content is required."})
        self.assertEqual(parse_message_body(None), {"error": "content is required."})


class ParseMessagesTests(TestCase):
    def test_rejects_non_array(self):
        self.assertIsNone(legacy.parse_messages("nope"))
        self.assertIsNone(legacy.parse_messages(None))

    def test_rejects_empty_array(self):
        self.assertIsNone(legacy.parse_messages([]))

    def test_rejects_too_many_messages(self):
        self.assertIsNone(legacy.parse_messages([{"role": "user", "content": "x"}] * (legacy.MAX_MESSAGES + 1)))

    def test_rejects_invalid_role(self):
        self.assertIsNone(legacy.parse_messages([{"role": "bogus", "content": "x"}]))

    def test_rejects_empty_content(self):
        self.assertIsNone(legacy.parse_messages([{"role": "user", "content": "  "}]))

    def test_accepts_valid_messages_and_truncates(self):
        messages = legacy.parse_messages([
            {"role": "user", "content": "hello"},
            {"role": "assistant", "content": "x" * (legacy.MAX_MESSAGE_LEN + 100)},
        ])
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0], {"role": "user", "content": "hello"})
        self.assertEqual(len(messages[1]["content"]), legacy.MAX_MESSAGE_LEN)


class SystemPromptForRoleTests(TestCase):
    def test_all_three_roles_have_prompts(self):
        for role in ("image", "video", "story"):
            prompt = legacy.system_prompt_for(role)
            self.assertIsInstance(prompt, str)
            self.assertGreater(len(prompt), 0)

    def test_context_folded_into_prompt(self):
        prompt = legacy._with_context("BASE", {"model": "Nano Banana Pro"})
        self.assertIn("BASE", prompt)
        self.assertIn("model: Nano Banana Pro", prompt)

    def test_no_context_returns_prompt_unchanged(self):
        self.assertEqual(legacy._with_context("BASE", None), "BASE")
        self.assertEqual(legacy._with_context("BASE", {}), "BASE")


@override_settings(AUTH_SECRET=SECRET)
class AgentConversationsAuthTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = _make_user()

    def test_list_requires_auth(self):
        resp = self.client.get("/api/agent-conversations?projectId=x&agentKind=image")
        self.assertEqual(resp.status_code, 401)

    def test_list_requires_agent_kind(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get("/api/agent-conversations?projectId=x")
        self.assertEqual(resp.status_code, 400)

    def test_invalid_agent_kind_rejected(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get("/api/agent-conversations?projectId=x&agentKind=bogus")
        self.assertEqual(resp.status_code, 400)

    def test_detail_unknown_conversation_404s(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get(f"/api/agent-conversations/{uuid.uuid4()}")
        self.assertEqual(resp.status_code, 404)

    def test_retired_legacy_agents_route_is_absent(self):
        resp = self.client.post("/api/agents/image", {"messages": []}, format="json")
        self.assertEqual(resp.status_code, 404)
