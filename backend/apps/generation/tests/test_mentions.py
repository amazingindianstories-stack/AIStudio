"""Port of src/lib/mentions.test.js's cases."""

from django.test import SimpleTestCase

from .. import mentions as m


class VidTagNamespaceTests(SimpleTestCase):
    def test_vidn_is_a_clip_tag_not_asset_slug(self):
        self.assertTrue(m.is_vid_tag("vid1"))
        self.assertTrue(m.is_vid_tag("vid12"))
        self.assertFalse(m.is_img_tag("vid1"))
        self.assertFalse(m.is_vid_tag("img1"))
        self.assertFalse(m.is_vid_tag("video"))
        self.assertFalse(m.is_vid_tag("priya"))

    def test_parse_asset_slugs_no_longer_swallows_vidn(self):
        self.assertEqual(m.parse_asset_slugs("replace the guy in @vid1 with @img1"), [])
        self.assertEqual(m.parse_asset_slugs("@priya in @vid1 doing @img2"), ["priya"])

    def test_clip_and_image_namespaces_dont_collide(self):
        prompt = "put @img1 into the action from @vid2"
        self.assertEqual(m.parse_mention_indices(prompt), [1])
        self.assertEqual(m.parse_video_mention_indices(prompt), [2])

    def test_video_indices_parse_ascending_deduped_case_insensitive(self):
        self.assertEqual(m.parse_video_mention_indices("@vid3 @VID1 @vid3 @Vid2"), [1, 2, 3])

    def test_explicit_vidn_selects_only_that_clip(self):
        clips = ["/a.mp4", "/b.mp4", "/c.mp4"]
        self.assertEqual(m.resolve_video_references("use @vid2 only", clips), ["/b.mp4"])
        self.assertEqual(m.resolve_video_references("@vid3 then @vid1", clips), ["/a.mp4", "/c.mp4"])

    def test_no_tags_sends_every_attached_clip(self):
        clips = ["/a.mp4", "/b.mp4"]
        self.assertEqual(m.resolve_video_references("continue this shot", clips), clips)

    def test_out_of_range_clip_tags_ignored(self):
        clips = ["/a.mp4"]
        self.assertEqual(m.resolve_video_references("use @vid9", clips), ["/a.mp4"])

    def test_no_clips_attached_means_nothing_to_send(self):
        self.assertEqual(m.resolve_video_references("use @vid1", []), [])

    def test_image_resolution_unchanged_by_video_namespace(self):
        uploads = ["data:image/jpeg;base64,A", "data:image/jpeg;base64,B"]
        refs = m.resolve_references("put @img2 into @vid1", uploads)
        self.assertEqual([r["tag"] for r in refs], ["@img2"])

    def test_mixed_tag_kinds_resolve_independently(self):
        prompt = "@priya wearing @img1, moving like @vid1"
        self.assertEqual(m.parse_asset_slugs(prompt), ["priya"])
        self.assertEqual(m.parse_mention_indices(prompt), [1])
        self.assertEqual(m.parse_video_mention_indices(prompt), [1])


class RenumberImgMentionsTests(SimpleTestCase):
    def test_swaps_pair_without_clobbering(self):
        self.assertEqual(
            m.renumber_img_mentions("put @img1 next to @img2", [1, 0]),
            "put @img2 next to @img1",
        )

    def test_move_to_end_shift(self):
        self.assertEqual(
            m.renumber_img_mentions("@img1 @img2 @img3", [2, 0, 1]),
            "@img3 @img1 @img2",
        )

    def test_out_of_range_tags_untouched(self):
        self.assertEqual(
            m.renumber_img_mentions("@img1 and @img5", [1, 0]),
            "@img2 and @img5",
        )

    def test_case_insensitive_input_normalizes_output(self):
        self.assertEqual(m.renumber_img_mentions("@IMG2 stays put", [1, 0]), "@img1 stays put")

    def test_renumbers_every_occurrence(self):
        self.assertEqual(
            m.renumber_img_mentions("@img1 matches @img1 again", [1, 0]),
            "@img2 matches @img2 again",
        )
