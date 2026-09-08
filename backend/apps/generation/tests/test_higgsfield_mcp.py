from django.test import SimpleTestCase

from ..providers import higgsfield_mcp as hf


class ReferenceRoleTests(SimpleTestCase):
    def test_maps_positional_image_tags_within_media_count(self):
        roles = hf.build_ref_roles(
            "Use the exact face and identity from @img1. She crosses the bright hall slowly. "
            "Match the style and palette from @img2. She turns, pauses, smiles, and walks forward. "
            "The scene unfolds at the exact location from @img9.",
            2,
        )
        self.assertEqual(roles, {1: "person", 2: "style"})

    def test_ignores_named_assets_and_returns_none_without_image_tags(self):
        self.assertIsNone(hf.build_ref_roles("Use the style from @moodboard.", 2))
