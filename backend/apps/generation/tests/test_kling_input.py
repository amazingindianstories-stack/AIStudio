"""Port of src/lib/kling-input.test.js's cases."""

from django.test import SimpleTestCase

from .. import kling_input as ki

MODEL = "Kling Image 3.0"


def img(data="AAAA"):
    return {"mimeType": "image/png", "data": data}


def group(**over):
    base = {"tag": "@img1", "header": "@img1 — REFERENCE:", "images": [img()]}
    base.update(over)
    return base


def assembled(**over):
    base = {"instruction": "a red bicycle", "groups": []}
    base.update(over)
    return base


class ReferenceSelectionTests(SimpleTestCase):
    def test_text_to_image_no_reference(self):
        out = ki.build_kling_input(assembled(), MODEL)
        self.assertIsNone(out["reference"])
        self.assertEqual(out["prompt"], "a red bicycle")

    def test_saved_slug_asset_reaches_kling(self):
        out = ki.build_kling_input(
            assembled(
                instruction="a cinematic board of @shiv",
                groups=[group(tag="@shiv", images=[img("SHIV")], identity=True)],
            ),
            MODEL,
        )
        self.assertEqual(out["reference"]["data"], "SHIV")

    def test_groups_with_no_images_dont_count(self):
        out = ki.build_kling_input(
            assembled(groups=[group(images=[]), group(images=[img("REAL")])]), MODEL
        )
        self.assertEqual(out["reference"]["data"], "REAL")

    def test_identity_tiles_never_sent_instead_of_reference(self):
        out = ki.build_kling_input(
            assembled(groups=[group(images=[img("FULL")], tiles=[img("CROP")], identity=True)]), MODEL
        )
        self.assertEqual(out["reference"]["data"], "FULL")


class ReferenceLimitTests(SimpleTestCase):
    def test_two_groups_rejected(self):
        with self.assertRaisesRegex(ValueError, "resolved to 2"):
            ki.build_kling_input(assembled(groups=[group(tag="@priya"), group(tag="@img1")]), MODEL)

    def test_two_images_in_one_group_rejected(self):
        with self.assertRaisesRegex(ValueError, "resolved to 2"):
            ki.build_kling_input(assembled(groups=[group(images=[img(), img()])]), MODEL)

    def test_error_names_tags_and_way_forward(self):
        try:
            ki.build_kling_input(assembled(groups=[group(tag="@priya"), group(tag="@img1")]), MODEL)
            self.fail("expected a raise")
        except ValueError as e:
            msg = str(e)
            self.assertRegex(msg, r"@priya, @img1")
            self.assertRegex(msg, r"Nano Banana Pro")
            self.assertRegex(msg, r"Kling Image 3\.0")


class TagRewritingTests(SimpleTestCase):
    def test_resolved_tag_becomes_plain_language(self):
        out = ki.build_kling_input(
            assembled(instruction="@priya on a beach", groups=[group(tag="@priya")]), MODEL
        )
        self.assertRegex(out["prompt"], r"the reference image on a beach")
        self.assertNotIn("@priya", out["prompt"])

    def test_every_occurrence_rewritten(self):
        out = ki.build_kling_input(
            assembled(instruction="@img1 sitting, then @img1 standing, then @IMG1 again", groups=[group()]),
            MODEL,
        )
        self.assertNotRegex(out["prompt"], r"(?i)@img1")

    def test_compound_word_keeps_rest_of_word(self):
        out = ki.build_kling_input(
            assembled(instruction="an @img1-inspired palette", groups=[group()]), MODEL
        )
        self.assertRegex(out["prompt"], r"the reference image-inspired palette")

    def test_untagged_prompt_with_reference_left_alone(self):
        out = ki.build_kling_input(
            assembled(instruction="a woman on a beach", groups=[group(tag="SUBJECT")]), MODEL
        )
        self.assertRegex(out["prompt"], r"a woman on a beach")

    def test_dangling_imgn_resolves_to_the_one_reference(self):
        out = ki.build_kling_input(
            assembled(instruction="@img1 and @img2 for lighting", groups=[group()]), MODEL
        )
        self.assertNotRegex(out["prompt"], r"@img\d")
        self.assertRegex(out["prompt"], r"for lighting")

    def test_tagged_prompt_no_reference_is_loud_error(self):
        with self.assertRaisesRegex(ValueError, "tags @img1 but no reference image is attached"):
            ki.build_kling_input(assembled(instruction="use @img1 for lighting"), MODEL)

    def test_unresolved_slug_loses_syntax_keeps_word(self):
        out = ki.build_kling_input(assembled(instruction="a board of @shiv"), MODEL)
        self.assertEqual(out["prompt"], "a board of shiv")

    def test_midword_at_treated_as_tag(self):
        out = ki.build_kling_input(assembled(instruction="sign reading a@b.com"), MODEL)
        self.assertEqual(out["prompt"], "sign reading ab.com")


class ReferenceRuleHeaderTests(SimpleTestCase):
    def test_person_reference_gets_identity_rule(self):
        out = ki.build_kling_input(assembled(groups=[group(identity=True)]), MODEL)
        self.assertRegex(out["prompt"], r"^REFERENCE IMAGE — reproduce this exact person")
        self.assertRegex(out["prompt"], r"never a lookalike")

    def test_non_person_reference_gets_subject_rule(self):
        out = ki.build_kling_input(assembled(groups=[group(identity=False)]), MODEL)
        self.assertRegex(out["prompt"], r"^REFERENCE IMAGE — reproduce exactly what this shows")
        self.assertNotRegex(out["prompt"], r"bone structure")

    def test_text_to_image_no_reference_header(self):
        out = ki.build_kling_input(assembled(), MODEL)
        self.assertNotIn("REFERENCE IMAGE", out["prompt"])

    def test_header_suppressed_when_shot_spec_supplies_legend(self):
        out = ki.build_kling_input(
            assembled(
                shotInstruction="REFERENCES:\n@img1 = the exact visual style to match.\n\nSCENE: a rooftop",
                groups=[group(identity=False)],
            ),
            MODEL,
        )
        self.assertNotIn("REFERENCE IMAGE —", out["prompt"])
        self.assertRegex(out["prompt"], r"the exact visual style to match")
        self.assertRegex(out["prompt"], r"^REFERENCES:")

    def test_header_short_enough_for_budget(self):
        out = ki.build_kling_input(assembled(instruction="x", groups=[group(identity=True)]), MODEL)
        self.assertLess(len(out["prompt"]), 450, f"header is {len(out['prompt'])} chars")


class ShotSpecPrecedenceTests(SimpleTestCase):
    def test_shot_instruction_wins_over_raw_prompt(self):
        out = ki.build_kling_input(assembled(instruction="raw", shotInstruction="SCENE: structured"), MODEL)
        self.assertRegex(out["prompt"], r"SCENE: structured")
        self.assertNotIn("raw", out["prompt"])

    def test_shot_instruction_never_rewrapped(self):
        out = ki.build_kling_input(assembled(instruction="raw", shotInstruction="SCENE: structured"), MODEL)
        import re

        self.assertEqual(len(re.findall(r"SCENE:", out["prompt"])), 1)

    def test_tags_inside_shot_instruction_rewritten(self):
        out = ki.build_kling_input(
            assembled(
                instruction="raw",
                shotInstruction="LEGEND: @priya\nSCENE: @priya on a beach",
                groups=[group(tag="@priya")],
            ),
            MODEL,
        )
        self.assertNotIn("@priya", out["prompt"])


class RepeatedCallsTests(SimpleTestCase):
    def test_repeated_calls_give_identical_results(self):
        def make_input():
            return assembled(instruction="@img1 and @img2 and @shiv", groups=[group()])

        first = ki.build_kling_input(make_input(), MODEL)["prompt"]
        for i in range(3):
            self.assertEqual(ki.build_kling_input(make_input(), MODEL)["prompt"], first, f"call {i + 2} differed")
