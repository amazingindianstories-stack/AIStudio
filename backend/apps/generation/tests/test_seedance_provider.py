"""Hand-written tests for the pure parts of providers/seedance.py — no
seedance.test.js exists on the TS side to port, unlike kling/gemini."""

from django.test import SimpleTestCase

from .. import config
from ..providers import seedance as sd


class ReferenceImageLimitTests(SimpleTestCase):
    def test_caps_match_modelark_api(self):
        self.assertEqual(config.max_reference_images_for_video_model("Seedance 2.0"), 9)
        self.assertEqual(config.max_reference_images_for_video_model("Seedance 2.0 Mini"), 9)
        self.assertEqual(config.max_reference_images_for_video_model("Higgsfield Seedance 2.0"), 9)
        self.assertEqual(config.max_reference_images_for_video_model("Seedance 2.5"), 30)
        self.assertIsNone(config.max_reference_images_for_video_model("Gemini Omni Flash"))

    def test_tenth_seedance_20_reference_is_rejected_before_network(self):
        with self.assertRaises(sd.SeedanceError) as caught:
            sd.create_video_task(
                "A shot",
                model_display="Seedance 2.0",
                references=[{"dataUrl": "data:image/jpeg;base64,AA=="}] * 10,
            )
        self.assertEqual(caught.exception.code, "too_many_reference_images")
        self.assertEqual(caught.exception.status, 400)


class PickModelTests(SimpleTestCase):
    def test_2_5_checked_before_mini_fast_lite(self):
        self.assertEqual(sd._pick_model("Seedance 2.5"), sd._model_25())

    def test_mini_fast_lite_routes_to_fast_sku(self):
        self.assertEqual(sd._pick_model("Seedance 2.0 Mini"), sd._fast_model())
        self.assertEqual(sd._pick_model("Seedance Fast"), sd._fast_model())

    def test_default_is_standard(self):
        self.assertEqual(sd._pick_model("Seedance 2.0"), sd._standard_model())
        self.assertEqual(sd._pick_model(None), sd._standard_model())


class TagsToImageRefsTests(SimpleTestCase):
    def test_img_tags_become_bracket_form(self):
        self.assertEqual(sd._tags_to_image_refs("use @img1 and @img2"), "use [image 1] and [image 2]")

    def test_vid_tags_become_bracket_form(self):
        self.assertEqual(sd._tags_to_image_refs("continue @vid1"), "continue [video 1]")

    def test_case_insensitive(self):
        self.assertEqual(sd._tags_to_image_refs("@IMG3"), "[image 3]")


class IsModerationMessageTests(SimpleTestCase):
    def test_detects_moderation_keywords(self):
        self.assertTrue(sd.is_moderation_message("SensitiveContent detected"))
        self.assertTrue(sd.is_moderation_message("privacy violation: real person"))
        self.assertTrue(sd.is_moderation_message("portrait flagged"))

    def test_false_for_unrelated_errors(self):
        self.assertFalse(sd.is_moderation_message("InvalidParameter.TaskTypeConstraint"))
        self.assertFalse(sd.is_moderation_message(""))


class CreateVideoTaskBodyShapeTests(SimpleTestCase):
    """Exercises the request-body assembly by monkeypatching requests.post,
    mirroring how kling.test.js pins buildKlingPayload without hitting the
    network."""

    def test_edit_task_forces_adaptive_ratio_and_duration_minus_one(self):
        import unittest.mock as mock

        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None):
            captured["body"] = json
            resp = mock.Mock()
            resp.ok = True
            resp.json.return_value = {"id": "task123"}
            return resp

        with mock.patch.dict("os.environ", {"ARK_API_KEY": "test-key"}):
            with mock.patch("apps.generation.providers.seedance.requests.post", side_effect=fake_post):
                task_id = sd.create_video_task(
                    prompt="do the edit", task_mode="edit", ratio="16:9", duration=10,
                )
        self.assertEqual(task_id, "task123")
        self.assertEqual(captured["body"]["ratio"], "adaptive")
        self.assertEqual(captured["body"]["duration"], -1)
        self.assertTrue(captured["body"]["content"][0]["text"].startswith(sd.EDIT_TRIGGER))

    def test_extend_task_keeps_requested_duration(self):
        import unittest.mock as mock

        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None):
            captured["body"] = json
            resp = mock.Mock()
            resp.ok = True
            resp.json.return_value = {"id": "task456"}
            return resp

        with mock.patch.dict("os.environ", {"ARK_API_KEY": "test-key"}):
            with mock.patch("apps.generation.providers.seedance.requests.post", side_effect=fake_post):
                sd.create_video_task(prompt="continue it", task_mode="extend", duration=12)
        self.assertEqual(captured["body"]["ratio"], "adaptive")
        self.assertEqual(captured["body"]["duration"], 12)

    def test_generate_task_defaults_audio_false(self):
        import unittest.mock as mock

        captured = {}

        def fake_post(url, headers=None, json=None, timeout=None):
            captured["body"] = json
            resp = mock.Mock()
            resp.ok = True
            resp.json.return_value = {"id": "task789"}
            return resp

        with mock.patch.dict("os.environ", {"ARK_API_KEY": "test-key"}):
            with mock.patch("apps.generation.providers.seedance.requests.post", side_effect=fake_post):
                sd.create_video_task(prompt="a scene")
        self.assertEqual(captured["body"]["generate_audio"], False)
