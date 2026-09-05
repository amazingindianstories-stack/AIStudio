import base64
import tempfile

from django.test import SimpleTestCase

from ..best_of_spool import bounded_best_of, generate_and_spool_candidates, read_spooled_base64


class BestOfSpoolTests(SimpleTestCase):
    def test_resolution_caps(self):
        self.assertEqual(bounded_best_of(4, "1K"), 4)
        self.assertEqual(bounded_best_of(4, "2K"), 3)
        self.assertEqual(bounded_best_of(4, "4K"), 2)

    def test_partial_success_is_spooled_in_order(self):
        def generate(i):
            if i == 1:
                raise RuntimeError("candidate failed")
            return {"base64": base64.b64encode(f"candidate-{i}".encode()).decode(), "mimeType": "image/png"}

        with tempfile.TemporaryDirectory(prefix="best-of-test-") as directory:
            candidates, errors = generate_and_spool_candidates(3, directory, generate)
            self.assertEqual(len(candidates), 2)
            self.assertEqual(len(errors), 1)
            self.assertEqual(base64.b64decode(read_spooled_base64(candidates[1])).decode(), "candidate-2")
