"""Port of src/lib/omni-input.test.js's cases."""

from django.test import SimpleTestCase

from .. import omni_input as oi


def text_parts(parts):
    return [p["text"] for p in parts if p["type"] == "text"]


def image_count(parts):
    return len([p for p in parts if p["type"] == "image"])


def make_image(tag):
    return {"mimeType": "image/png", "data": f"{tag}-data"}


class OmniInputTests(SimpleTestCase):
    def test_max_images_equals_14(self):
        self.assertEqual(oi.OMNI_MAX_IMAGES, 14)

    def test_no_groups_falls_back_to_raw_instruction(self):
        assembled = {"instruction": "A dog runs in a field.", "groups": []}
        parts = oi.build_omni_input(assembled)
        texts = text_parts(parts)
        self.assertIn("A dog runs in a field.", texts)
        self.assertFalse(any(t.startswith("SCENE:") for t in texts))

    def test_with_groups_wraps_in_scene_prefix(self):
        assembled = {
            "instruction": "They dance.",
            "groups": [{"tag": "@img1", "header": "@img1 — REFERENCE:", "images": [make_image("a")]}],
        }
        parts = oi.build_omni_input(assembled)
        self.assertIn("SCENE: They dance.", text_parts(parts))

    def test_shot_instruction_used_verbatim_not_rewrapped(self):
        assembled = {
            "instruction": "raw prompt",
            "shotInstruction": "SCENE: raw prompt\n\nAVOID: something",
            "groups": [{"tag": "@img1", "header": "hdr", "images": [make_image("a")]}],
        }
        parts = oi.build_omni_input(assembled)
        texts = text_parts(parts)
        self.assertIn("SCENE: raw prompt\n\nAVOID: something", texts)
        self.assertEqual(len([t for t in texts if t.startswith("SCENE:")]), 1)

    def test_group_header_precedes_its_images(self):
        assembled = {
            "instruction": "x",
            "groups": [{"tag": "@img1", "header": "HEADER-1", "images": [make_image("a"), make_image("b")]}],
        }
        parts = oi.build_omni_input(assembled)
        header_idx = next(i for i, p in enumerate(parts) if p["type"] == "text" and p["text"] == "HEADER-1")
        first_image_idx = next(i for i, p in enumerate(parts) if p["type"] == "image")
        self.assertGreater(first_image_idx, header_idx)
        self.assertEqual(image_count(parts), 2)

    def test_throws_loudly_when_images_exceed_max(self):
        images = [make_image(f"img{i}") for i in range(oi.OMNI_MAX_IMAGES + 1)]
        assembled = {"instruction": "x", "groups": [{"tag": "@img1", "header": "hdr", "images": images}]}
        with self.assertRaisesRegex(ValueError, "Too many reference images"):
            oi.build_omni_input(assembled)

    def test_identity_tiles_yield_first_when_budget_tight(self):
        user_images = [make_image(f"u{i}") for i in range(oi.OMNI_MAX_IMAGES)]
        tiles = [make_image("tile1"), make_image("tile2")]
        assembled = {
            "instruction": "x",
            "groups": [{"tag": "@img1", "header": "hdr", "images": user_images, "identity": True, "tiles": tiles}],
        }
        parts = oi.build_omni_input(assembled)
        self.assertEqual(image_count(parts), oi.OMNI_MAX_IMAGES)

    def test_identity_tiles_included_when_budget_allows(self):
        user_images = [make_image("u1")]
        tiles = [make_image("tile1"), make_image("tile2")]
        assembled = {
            "instruction": "x",
            "groups": [{"tag": "@img1", "header": "hdr", "images": user_images, "identity": True, "tiles": tiles}],
        }
        parts = oi.build_omni_input(assembled)
        self.assertEqual(image_count(parts), 3)

    def test_final_check_present_when_identity_group(self):
        assembled = {
            "instruction": "x",
            "groups": [{"tag": "@img1", "header": "hdr", "images": [make_image("a")], "identity": True}],
        }
        parts = oi.build_omni_input(assembled)
        final_check = next((t for t in text_parts(parts) if t.startswith("FINAL CHECK")), None)
        self.assertIsNotNone(final_check)
        self.assertRegex(final_check, r"(?i)every frame of the video")

    def test_no_final_check_when_no_identity_group(self):
        assembled = {
            "instruction": "x",
            "groups": [{"tag": "@img1", "header": "hdr", "images": [make_image("a")], "identity": False}],
        }
        parts = oi.build_omni_input(assembled)
        self.assertFalse(any(t.startswith("FINAL CHECK") for t in text_parts(parts)))
