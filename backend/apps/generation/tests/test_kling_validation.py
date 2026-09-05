from unittest.mock import patch

from django.test import SimpleTestCase

from ..kling_validation import run_kling_validation, summarize_matrix


class KlingValidationTests(SimpleTestCase):
    @patch.dict("os.environ", {}, clear=True)
    def test_unconfigured_is_unknown_without_network(self):
        self.assertEqual(run_kling_validation(), {"configured": False})

    @patch.dict("os.environ", {"KLING_API": "test"})
    def test_invalid_n_matrix_proves_no_task_and_expected_capabilities(self):
        def call(path, method="GET", body=None):
            if method == "GET":
                return {"status": 200, "json": {"code": 0, "data": {"tasks": []}}}
            if body["model_name"] == "kling-v2-1" and body.get("resolution") == "2k" and "image" in body:
                message = "resolution is not supported"
            else:
                message = "n must be 1"
            return {"status": 400, "json": {"code": 1201, "message": message}}

        result = run_kling_validation(call=call)
        self.assertTrue(result["authenticated"])
        self.assertTrue(result["requestSafetyPass"])
        self.assertTrue(result["taskListStable"])
        self.assertTrue(result["noTaskCreated"])
        summary = summarize_matrix(result["matrix"])
        self.assertEqual(summary["routingPassed"], summary["routingTotal"])
        self.assertEqual(summary["resolutionPassed"], summary["resolutionTotal"])
