"""Direct port of src/lib/shot-spec.test.js's cases, kept 1:1 with that
file so the two can be diffed test-by-test. This is the one module in the
migration where the risk of a subtle regex-translation bug is highest —
every test here should have a recognizable twin in the TS file."""

import re

from django.test import SimpleTestCase

from .. import shot_spec as ss

BASELINE_PROMPT = (
    "THIS EXACT FACE and identity from @img1(image_1). She stands near a DJ booth in the corner of the "
    "nightclub from @img3(image_3), Speaker stacks behind her. She wears the exact outfit from "
    "@img2(image_2). Black onyx drop earrings and a delicate black choker. Red haze, silhouettes of "
    "dancers around her. Cinematic nightlife photography. @img1"
)


class ParseRefRolesTests(SimpleTestCase):
    def test_baseline_prompt_maps_roles(self):
        roles = ss.parse_ref_roles(BASELINE_PROMPT)
        self.assertEqual(roles.get("@img1"), "person")
        self.assertEqual(roles.get("@img2"), "outfit")
        self.assertEqual(roles.get("@img3"), "location")
        self.assertEqual(len(roles), 3)

    def test_tag_with_no_nearby_keyword_omitted(self):
        prompt = "A wide shot including @img4 somewhere in frame, nothing else to say."
        roles = ss.parse_ref_roles(prompt)
        self.assertNotIn("@img4", roles)

    def test_case_insensitive_keyword_matching(self):
        roles = ss.parse_ref_roles("She wears the exact OUTFIT from @img2.")
        self.assertEqual(roles.get("@img2"), "outfit")

    def test_case_insensitive_tag_matching(self):
        roles = ss.parse_ref_roles("She wears the outfit from @IMG2.")
        self.assertEqual(roles.get("@img2"), "outfit")

    def test_keyword_far_outside_window_does_not_bind(self):
        prompt = (
            "The outfit discussion happened earlier at length in a totally unrelated conversation about "
            "something else entirely. Now consider @img5 purely as a generic element with absolutely "
            "nothing describing what role it plays here at all in this sentence."
        )
        roles = ss.parse_ref_roles(prompt)
        self.assertNotIn("@img5", roles)

    def test_keyword_just_inside_window_binds(self):
        prompt = "The location for this shot is exactly @img6, nothing more to add."
        roles = ss.parse_ref_roles(prompt)
        self.assertEqual(roles.get("@img6"), "location")


class HasExplicitRefRoleTests(SimpleTestCase):
    def test_distinguishes_direct_binding_from_nearby_context(self):
        self.assertTrue(ss.has_explicit_ref_role("Use @img1 as the exact location.", "@img1", "location"))
        self.assertTrue(ss.has_explicit_ref_role("Use the school from @img1.", "@img1", "location"))
        self.assertTrue(ss.has_explicit_ref_role("Use the exact face from @img1.", "@img1", "person"))
        self.assertFalse(
            ss.has_explicit_ref_role("@img1 looking down in a school hallway.", "@img1", "location")
        )


class BuildShotInstructionTests(SimpleTestCase):
    def test_contains_raw_prompt_verbatim(self):
        result = ss.build_shot_instruction(BASELINE_PROMPT, None, "1:1")
        self.assertIn(BASELINE_PROMPT, result)

    def test_contains_raw_prompt_verbatim_with_adversarial_chars(self):
        raw_prompt = 'A "quoted" prompt with\nnewlines,\ttabs, and emoji \U0001f3ac — kept literal.'
        result = ss.build_shot_instruction(raw_prompt, None, "1:1")
        self.assertIn(raw_prompt, result)

    def test_scene_appears_exactly_once(self):
        result = ss.build_shot_instruction(
            "A simple scene description.",
            "REFERENCES:\n@img1 = the exact face/identity of the subject.",
            "16:9",
        )
        self.assertEqual(len(re.findall(r"SCENE:", result)), 1)

    def test_includes_legend_when_provided(self):
        legend = "REFERENCES:\n@img1 = the exact face/identity of the subject."
        result = ss.build_shot_instruction("A scene.", legend, "1:1")
        self.assertIn(legend, result)

    def test_omits_legend_content_when_none(self):
        result = ss.build_shot_instruction("A scene.", None, "1:1")
        self.assertNotIn("REFERENCES:", result)

    def test_includes_avoid_block_with_negative_coda(self):
        result = ss.build_shot_instruction("A woman in a scene.", None, "1:1")
        self.assertIn(f"AVOID: {ss.NEGATIVE_CODA}", result)

    def test_includes_framing_coda_for_wide_ar(self):
        with_coda = ss.build_framing_coda("21:9")
        self.assertIsNotNone(with_coda)
        result = ss.build_shot_instruction("A woman in a scene.", None, "21:9")
        self.assertIn(with_coda, result)

    def test_no_framing_coda_for_square_ar(self):
        result = ss.build_shot_instruction("A scene.", None, "1:1")
        self.assertNotIn("FRAMING", result)


class BuildFramingCodaTests(SimpleTestCase):
    def test_non_null_for_wide_ars(self):
        self.assertIsNotNone(ss.build_framing_coda("21:9"))
        self.assertIsNotNone(ss.build_framing_coda("16:9"))

    def test_null_for_square_portrait_ars(self):
        self.assertIsNone(ss.build_framing_coda("1:1"))
        self.assertIsNone(ss.build_framing_coda("9:16"))
        self.assertIsNone(ss.build_framing_coda("3:4"))

    def test_video_medium_non_null_for_wide_ars(self):
        self.assertIsNotNone(ss.build_framing_coda("16:9", "video"))
        self.assertIsNotNone(ss.build_framing_coda("21:9", "video"))

    def test_video_medium_still_null_for_square_portrait(self):
        self.assertIsNone(ss.build_framing_coda("1:1", "video"))
        self.assertIsNone(ss.build_framing_coda("9:16", "video"))
        self.assertIsNone(ss.build_framing_coda("3:4", "video"))

    def test_video_medium_uses_motion_language(self):
        video_coda = ss.build_framing_coda("16:9", "video")
        self.assertIsNotNone(video_coda)
        self.assertRegex(video_coda, r"(?i)\b(frame|frames|motion|camera|shot)\b")

    def test_default_medium_byte_identical_to_image(self):
        no_medium = ss.build_framing_coda("16:9")
        explicit_image = ss.build_framing_coda("16:9", "image")
        self.assertEqual(no_medium, explicit_image)
        self.assertIsNotNone(no_medium)
        self.assertRegex(no_medium, r"(?i)hero")


class RoleHeaderTests(SimpleTestCase):
    def test_outfit_role_avoids_person_language(self):
        header = ss.role_header("@img2", "outfit", 1)
        self.assertRegex(header, r"(?i)outfit")
        self.assertIn("@img2", header)
        self.assertNotRegex(header, r"(?i)\b(face|identity|jawline|cheekbone|hairline|eyebrow)\b")

    def test_person_role_uses_identity_language(self):
        header = ss.role_header("@img1", "person", 2)
        self.assertRegex(header, r"(?i)\b(person|identity|face)\b")
        self.assertIn("@img1", header)

    def test_reflects_image_count(self):
        single = ss.role_header("@img1", "person", 1)
        multi = ss.role_header("@img1", "person", 3)
        self.assertIn("1", single)
        self.assertIn("3", multi)
        self.assertNotEqual(single, multi)


class BuildReferenceLegendTests(SimpleTestCase):
    def test_empty_list_returns_none(self):
        self.assertIsNone(ss.build_reference_legend([]))

    def test_mentions_every_tag(self):
        legend = ss.build_reference_legend(
            [
                {"tag": "@img1", "role": "person", "isPerson": True},
                {"tag": "@img2", "role": "outfit", "isPerson": False},
                {"tag": "@img3", "role": "location", "isPerson": False},
            ]
        )
        self.assertIsNotNone(legend)
        for tag in ("@img1", "@img2", "@img3"):
            self.assertIn(tag, legend)


class VideoAvoidBlockTests(SimpleTestCase):
    def test_video_avoid_mentions_temporal_artifacts(self):
        result = ss.build_shot_instruction("A scene.", None, "1:1", medium="video")
        self.assertRegex(result, r"(?i)(drift.{0,30}frame|frame.{0,30}drift|flicker|morph)")

    def test_default_medium_output_unchanged(self):
        result = ss.build_shot_instruction("A woman in a scene.", None, "1:1")
        self.assertIn(f"AVOID: {ss.NEGATIVE_CODA}", result)


class ZeroCastPolicyTests(SimpleTestCase):
    def test_empty_school_environment_framing_and_policy(self):
        raw_prompt = "An empty school hallway at dawn, camera looking down from the upper landing."
        instruction = ss.build_shot_instruction(raw_prompt, None, "16:9")
        cast_policy = ss.build_cast_policy(raw_prompt)

        self.assertIn(raw_prompt, instruction)
        self.assertIn(f"AVOID: {ss.ENVIRONMENT_NEGATIVE_CODA}", instruction)
        self.assertRegex(instruction, r"(?i)explicitly requested setting and objects")
        self.assertNotRegex(
            instruction, r"(?i)subject filling|small or distant subject|plasticky skin|duplicated limbs|warped anatomy"
        )
        self.assertEqual(cast_policy, f"{ss.ZERO_CAST_POLICY}\n{ss.VIEWPOINT_POLICY}")

    def test_bare_looking_up_is_camera_direction(self):
        raw_prompt = "An empty classroom, looking up toward the ceiling."
        self.assertFalse(ss.has_visible_people(raw_prompt))
        self.assertEqual(ss.build_cast_policy(raw_prompt), f"{ss.ZERO_CAST_POLICY}\n{ss.VIEWPOINT_POLICY}")

    def test_negated_human_nouns_remain_zero_cast(self):
        raw_prompt = "No students or staff in the school hallway; high-angle view looking down."
        self.assertFalse(ss.has_visible_people(raw_prompt))
        self.assertEqual(ss.build_cast_policy(raw_prompt), f"{ss.ZERO_CAST_POLICY}\n{ss.VIEWPOINT_POLICY}")

    def test_human_labelled_furniture_does_not_invent_owner(self):
        raw_prompt = "An empty classroom with a teacher's desk, student lockers, and rows of chairs."
        self.assertFalse(ss.has_visible_people(raw_prompt))
        self.assertEqual(ss.build_cast_policy(raw_prompt), ss.ZERO_CAST_POLICY)

    def test_positive_person_controls_keep_actions(self):
        for raw_prompt in [
            "A teacher looking down at an open book in the classroom.",
            "Students looking up at the school clock.",
            "Naisha looking down at a book.",
        ]:
            self.assertTrue(ss.has_visible_people(raw_prompt), raw_prompt)
            self.assertIsNone(ss.build_cast_policy(raw_prompt), raw_prompt)
            instruction = ss.build_shot_instruction(raw_prompt, None, "16:9")
            self.assertIn(f"AVOID: {ss.NEGATIVE_CODA}", instruction, raw_prompt)
            self.assertRegex(instruction, r"(?i)hero composition")

    def test_person_reference_shot_instruction_byte_identical(self):
        raw_prompt = "THIS EXACT FACE from @priya. She is looking down at a book."
        legend = (
            "REFERENCES:\n@priya = the exact face/identity of the subject — must be reproduced with "
            "photographic fidelity, never a lookalike."
        )
        actual = ss.build_shot_instruction(raw_prompt, legend, "16:9", has_person_reference=True)
        expected = (
            "REFERENCES:\n@priya = the exact face/identity of the subject — must be reproduced with "
            "photographic fidelity, never a lookalike.\n\n"
            "SCENE: THIS EXACT FACE from @priya. She is looking down at a book.\n\n"
            "FRAMING: keep the subject large and prominent in the frame — a hero composition within the "
            "wide field, the subject filling roughly half to two-thirds of the frame height and placed in "
            "the frame's power zone, never small or distant; background and environment stay supporting, "
            "in sharp focus but not competing with the subject for size.\n"
            "AVOID: blur or softness on the subject, smeared or plasticky skin, washed-out or muddy color "
            "cast, loss of background/environment detail, a small or distant subject, extra or duplicated "
            "limbs, warped anatomy."
        )
        self.assertEqual(actual, expected)
        self.assertIsNone(ss.build_cast_policy(raw_prompt, True))


class PersonRuleWordingTests(SimpleTestCase):
    def test_no_unconditional_photographic_fidelity(self):
        rule = ss.role_rule("person")
        self.assertNotRegex(rule, r"with photographic fidelity")
        self.assertRegex(rule, r"exact fidelity to the reference")

    def test_instructs_keeping_reference_medium(self):
        rule = ss.role_rule("person")
        self.assertRegex(rule, r"SAME medium and rendering style as the reference")
        self.assertRegex(rule, r"never add realism the reference does not have")

    def test_skin_texture_conditional_on_photographic(self):
        rule = ss.role_rule("person")
        self.assertRegex(rule, r"where the reference is photographic, also keep real skin tone and texture")

    def test_idealized_anchored_to_reference(self):
        self.assertRegex(ss.role_rule("person"), r"idealized relative to the reference")

    def test_every_measured_identity_anchor_survives(self):
        rule = ss.role_rule("person")
        for anchor in [
            "bone structure", "jawline", "cheekbones", "hairline",
            "eye shape/size/spacing and color", "eyebrows", "nose", "lips", "ears",
            "facial hair", "hairstyle", "body build", "apparent age", "never a lookalike",
        ]:
            self.assertIn(anchor, rule, f"identity anchor lost from person rule: {anchor}")

    def test_non_person_roles_untouched(self):
        self.assertRegex(ss.role_rule("outfit"), r"reproduce this exact outfit")
        self.assertRegex(ss.role_rule("location"), r"reproduce this exact place")
        self.assertRegex(ss.role_rule("prop"), r"reproduce this exact object")
