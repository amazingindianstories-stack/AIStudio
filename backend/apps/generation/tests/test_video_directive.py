"""Port of src/lib/video-directive.test.js's cases."""

from django.test import SimpleTestCase

from .. import video_directive as vd


def build(prompt: str, ref_count: int = 1) -> str:
    return vd.build_video_directive(prompt, ref_count, "bracket")


class PromptVerbatimTests(SimpleTestCase):
    def test_prompt_passed_through_verbatim(self):
        prompt = "A woman in a red saree walks through Chowpatty at dusk."
        self.assertIn(prompt, build(prompt))

    def test_no_references_prompt_untouched(self):
        prompt = "Rain on a window, slow push in."
        self.assertEqual(vd.build_video_directive(prompt, 0, "angle"), prompt)


class StyleFollowsReferenceTests(SimpleTestCase):
    def test_style_block_reproduces_reference_medium(self):
        out = build("She turns to face the camera.")
        self.assertRegex(out, r"STYLE — FOLLOW THE REFERENCE")
        self.assertRegex(out, r"anime, cel-shaded, 3D-rendered, illustrated, painterly")
        self.assertRegex(out, r"Do NOT convert the reference image to photorealism")

    def test_photoreal_language_absent_unless_photographic(self):
        stylized = build("She turns to face the camera.")
        self.assertNotRegex(stylized, r"moles, scars and freckles")
        self.assertNotRegex(stylized, r"(?i)do not beautify, smooth, slim or de-age")

        photo = build("Photorealistic 35mm film shot, she turns to camera.")
        self.assertRegex(photo, r"moles, scars and freckles")

    def test_prompt_naming_style_overrides_reference(self):
        out = build("Render as anime: she turns to face the camera.")
        self.assertRegex(out, r"STYLE — THE PROMPT WINS")
        self.assertRegex(out, r"re-render them in the style the prompt names")
        self.assertRegex(out, r"IDENTITY LOCK")


class CameraPrecedenceTests(SimpleTestCase):
    def test_default_framing_dropped_when_prompt_directs_camera(self):
        out = build("Wide establishing shot in deep focus, the crowd fills frame.")
        self.assertRegex(out, r"FRAMING — THE PROMPT WINS")
        self.assertNotRegex(out, r"(?i)keep the referenced subject in sharp focus")

    def test_default_framing_applies_when_prompt_silent(self):
        out = build("She laughs and looks away.")
        self.assertRegex(out, r"FRAMING \(default")
        self.assertRegex(out, r"(?i)keep the referenced subject in sharp focus")

    def test_default_framing_yields_on_its_own(self):
        out = build("She laughs and looks away.")
        self.assertRegex(out, r"apply ONLY where the PROMPT does not specify")


class PrecedenceRuleTests(SimpleTestCase):
    def test_precedence_present_and_trails_prompt(self):
        prompt = "She laughs and looks away."
        out = build(prompt)
        self.assertRegex(out, r"PRECEDENCE: the PROMPT above is authoritative")
        self.assertLess(out.index(prompt), out.index("PRECEDENCE:"))

    def test_precedence_names_dimensions(self):
        out = build("She laughs.")
        self.assertRegex(out, r"style, medium, framing, focus, camera movement, pacing or staging")


class IdentityLockTests(SimpleTestCase):
    def test_identity_lock_retained(self):
        out = build("She walks through the market.")
        self.assertRegex(out, r"IDENTITY LOCK")
        self.assertRegex(out, r"unmistakably the SAME character, never a lookalike")

    def test_multi_reference_gets_tag_mapping_clause(self):
        bracket = vd.build_video_directive("[image 1] greets [image 2].", 2, "bracket")
        self.assertRegex(bracket, r"\[image 1\], \[image 2\]")

        angle = vd.build_video_directive("<<<image_1>>> greets <<<image_2>>>.", 2, "angle")
        self.assertRegex(angle, r"<<<image_1>>>, <<<image_2>>>")

    def test_single_reference_omits_tag_mapping_clause(self):
        self.assertNotRegex(build("She waves.", 1), r"the tags map to")


class DetectorTests(SimpleTestCase):
    def test_has_camera_direction_fires_on_real_vocabulary(self):
        for p in [
            "slow dolly in on her face",
            "rack focus to the background",
            "extreme close-up of the hands",
            "shot on a 35mm lens",
            "low angle, handheld",
            "aerial drone shot over the temple",
            "deep focus wide shot",
        ]:
            self.assertTrue(vd.has_camera_direction(p), p)

    def test_has_camera_direction_ignores_incidental_words(self):
        for p in [
            "a gunshot rings out",
            "she tries to focus on her work",
            "he was shot in the film's opening",
            "the panning of gold in the river",
        ]:
            self.assertFalse(vd.has_camera_direction(p), p)

    def test_has_explicit_style_recognises_named_media(self):
        for p in [
            "in anime style",
            "a watercolour dream sequence",
            "claymation short",
            "cel-shaded action scene",
            "shot on VHS",
            "photorealistic portrait",
        ]:
            self.assertTrue(vd.has_explicit_style(p), p)

    def test_has_explicit_style_quiet_on_ordinary_scene(self):
        self.assertFalse(vd.has_explicit_style("She walks through a crowded market at dusk."))

    def test_camera_direction_ignores_blocking_and_framing(self):
        self.assertFalse(vd.has_camera_direction("he stands blocking the door"))
        self.assertFalse(vd.has_camera_direction("framing the photograph on the wall"))
