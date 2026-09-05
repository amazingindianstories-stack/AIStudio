"""Port of src/lib/providers/kling.test.js's cases (buildKlingPayload,
klingSpec, isKlingModel, nearestKlingAspectRatio). Pure — no network."""

from django.test import SimpleTestCase

from ..providers import kling as k

REF = {"mimeType": "image/png", "data": "AAAA"}


def build(model="Kling Image 3.0", prompt="a red bicycle", aspect_ratio=None, resolution=None, references=None):
    return k.build_kling_payload(model, prompt, aspect_ratio, resolution, references)


class ModelLookupTests(SimpleTestCase):
    def test_display_names_map_to_wire_ids(self):
        self.assertEqual(k.kling_spec("Kling Image 3.0")["modelName"], "kling-v3")
        self.assertEqual(k.kling_spec("Kling Image 2.1")["modelName"], "kling-v2-1")

    def test_lookup_case_and_whitespace_insensitive(self):
        self.assertEqual(k.kling_spec("  kling image 3.0  ")["modelName"], "kling-v3")

    def test_is_kling_model_matches_only_kling(self):
        self.assertTrue(k.is_kling_model("Kling Image 3.0"))
        self.assertTrue(k.is_kling_model("kling image 2.1"))
        self.assertFalse(k.is_kling_model("Nano Banana Pro"))
        self.assertFalse(k.is_kling_model("Seedance 2.0"))
        self.assertFalse(k.is_kling_model("Sparkling Image"))


class BuildKlingPayloadTests(SimpleTestCase):
    def test_text_to_image_body_exact_fields(self):
        p = build(aspect_ratio="16:9", resolution="2K")
        self.assertEqual(p, {
            "model_name": "kling-v3", "prompt": "a red bicycle", "n": 1,
            "aspect_ratio": "16:9", "resolution": "2k",
        })

    def test_resolution_lowercased(self):
        self.assertEqual(build(resolution="1K")["resolution"], "1k")
        self.assertEqual(build(resolution="2K")["resolution"], "2k")

    def test_defaults_1k_and_1_1(self):
        p = build()
        self.assertEqual(p["resolution"], "1k")
        self.assertEqual(p["aspect_ratio"], "1:1")

    def test_negative_prompt_never_sent(self):
        self.assertNotIn("negative_prompt", build())
        self.assertNotIn("negative_prompt", build(references=[REF]))

    def test_v1_only_fidelity_knobs_never_sent(self):
        p = build(references=[REF])
        for key in ("image_reference", "image_fidelity", "human_fidelity", "element_list"):
            self.assertNotIn(key, p)

    def test_reference_sets_bare_base64_image(self):
        p = build(references=[REF])
        self.assertEqual(p["image"], "AAAA")
        self.assertFalse(p["image"].startswith("data:"))

    def test_image_absent_not_empty_for_text_to_image(self):
        self.assertNotIn("image", build())

    def test_n_always_1(self):
        self.assertEqual(build()["n"], 1)

    def test_second_reference_rejected(self):
        with self.assertRaisesRegex(ValueError, "accepts one reference image; 2 were provided"):
            build(references=[REF, REF])

    def test_multi_reference_error_names_way_forward(self):
        with self.assertRaisesRegex(ValueError, "Nano Banana Pro"):
            build(references=[REF, REF])

    def test_4k_rejected_for_both_models(self):
        for m in k.KLING_MODELS:
            with self.assertRaisesRegex(ValueError, r"4K is Kling Image 3\.0 Omni only"):
                build(model=m["display"], resolution="4K")

    def test_21_does_2k_in_t2i_but_not_from_a_reference(self):
        """Measured from our own history, not read from a doc: four 2K
        text-to-image rows on Kling Image 2.1 succeeded 2026-07-30 (refs=0),
        while 2K WITH a reference returned `400 code 1201: resolution value
        '2k' is not supported` on 2026-08-17. Every success had no reference;
        both failures had one. So the restriction is reference-conditional,
        NOT model-wide — model-wide would break a configuration that
        provably worked."""
        self.assertEqual(
            build(model="Kling Image 2.1", resolution="2K")["resolution"], "2k"
        )
        with self.assertRaisesRegex(ValueError, r"cannot render 2K from a reference image"):
            build(model="Kling Image 2.1", resolution="2K", references=[REF])

    def test_30_does_2k_with_a_reference(self):
        p = build(model="Kling Image 3.0", resolution="2K", references=[REF])
        self.assertEqual(p["resolution"], "2k")
        self.assertEqual(p["image"], "AAAA")

    def test_picker_never_offers_a_resolution_the_provider_rejects(self):
        """resolutions_for_model (the picker) and KLING_MODELS (the provider's
        gate) are two lists that must not drift — the 2K-on-2.1 failure was
        exactly that drift."""
        from ..config import resolutions_for_model

        for m in k.KLING_MODELS:
            self.assertEqual(
                resolutions_for_model(m["display"], "image", False),
                m["resolutions"],
                m["display"],
            )
            # Whatever the picker offers once a reference is attached must
            # actually build — that is now part of the answer.
            for r in resolutions_for_model(m["display"], "image", True):
                build(model=m["display"], resolution=r, references=[REF])

    def test_overlength_prompt_rejected_with_both_numbers(self):
        with self.assertRaisesRegex(ValueError, "up to 2500 characters; this one is 2501"):
            build(prompt="x" * (k.KLING_PROMPT_MAX + 1))

    def test_prompt_exactly_at_cap_accepted(self):
        p = build(prompt="x" * k.KLING_PROMPT_MAX)
        self.assertEqual(len(p["prompt"]), k.KLING_PROMPT_MAX)

    def test_empty_or_whitespace_prompt_rejected(self):
        with self.assertRaisesRegex(ValueError, "Prompt is required"):
            build(prompt="")
        with self.assertRaisesRegex(ValueError, "Prompt is required"):
            build(prompt="   ")

    def test_prompt_trimmed(self):
        self.assertEqual(build(prompt="  hi  ")["prompt"], "hi")

    def test_unsupported_aspect_ratio_rejected(self):
        with self.assertRaisesRegex(ValueError, "3:2, 2:3, 21:9"):
            build(aspect_ratio="5:1")

    def test_every_aspect_ratio_in_spec_accepted(self):
        for m in k.KLING_MODELS:
            for ar in m["aspectRatios"]:
                p = build(model=m["display"], aspect_ratio=ar)
                self.assertEqual(p["aspect_ratio"], ar, f"{m['display']} {ar}")

    def test_unknown_model_rejected(self):
        with self.assertRaisesRegex(ValueError, "Kling Image 3.0"):
            build(model="Kling Image 9.9")


class NearestKlingAspectRatioTests(SimpleTestCase):
    def test_exact_ratios_map_to_themselves(self):
        self.assertEqual(k.nearest_kling_aspect_ratio(1024, 1024), "1:1")
        self.assertEqual(k.nearest_kling_aspect_ratio(1920, 1080), "16:9")
        self.assertEqual(k.nearest_kling_aspect_ratio(1080, 1920), "9:16")
        self.assertEqual(k.nearest_kling_aspect_ratio(1200, 900), "4:3")
        self.assertEqual(k.nearest_kling_aspect_ratio(900, 1200), "3:4")
        self.assertEqual(k.nearest_kling_aspect_ratio(1500, 1000), "3:2")
        self.assertEqual(k.nearest_kling_aspect_ratio(1000, 1500), "2:3")
        self.assertEqual(k.nearest_kling_aspect_ratio(2100, 900), "21:9")

    def test_real_measured_outputs_map_correctly(self):
        self.assertEqual(k.nearest_kling_aspect_ratio(2720, 1536), "16:9")
        self.assertEqual(k.nearest_kling_aspect_ratio(1168, 864), "4:3")

    def test_distance_is_multiplicative(self):
        self.assertEqual(k.nearest_kling_aspect_ratio(1000, 750), "4:3")
        self.assertEqual(k.nearest_kling_aspect_ratio(750, 1000), "3:4")
        self.assertEqual(k.nearest_kling_aspect_ratio(1000, 667), "3:2")
        self.assertEqual(k.nearest_kling_aspect_ratio(667, 1000), "2:3")

    def test_degenerate_dimensions_return_none(self):
        self.assertIsNone(k.nearest_kling_aspect_ratio(0, 100))
        self.assertIsNone(k.nearest_kling_aspect_ratio(100, 0))
