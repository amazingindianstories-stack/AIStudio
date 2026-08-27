from django.test import SimpleTestCase, TestCase

from apps.generation.models import DepthWorker, Generation

from .. import status_checks as status


class GenerationIndexHealthTests(SimpleTestCase):
    def test_missing_and_invalid_indexes_are_reported(self):
        rows = [
            (name, name != "generations_queue_idx")
            for name in status.EXPECTED_GENERATION_INDEX_NAMES[1:]
        ]
        result = status.evaluate_generation_indexes(rows)
        self.assertEqual(result["status"], "error")
        self.assertIn("missing: generations_created_at_idx", result["detail"])
        self.assertIn("invalid: generations_queue_idx", result["detail"])

    def test_status_registry_contains_both_generation_checks(self):
        self.assertEqual(len(status.CHECKS), 10)
        ids = [check["id"] for check in status.CHECKS]
        self.assertIn("generation-indexes", ids)
        self.assertIn("stuck-generations", ids)


class StuckGenerationHealthTests(TestCase):
    now = 1_900_000_000_000

    def make_generation(self, kind, updated_at, **overrides):
        values = {
            "kind": kind,
            "status": "running",
            "prompt": "health fixture",
            "model": "health-fixture",
            "aspect_ratio": "1:1",
            "created_at": updated_at,
            "updated_at": updated_at,
        }
        values.update(overrides)
        return Generation.objects.create(**values)

    def test_thresholds_and_fresh_depth_worker(self):
        stale_image = self.make_generation("image", self.now - status.STUCK_IMAGE_MS - 1)
        self.make_generation("image", self.now - status.STUCK_IMAGE_MS + 1)
        stale_video = self.make_generation("video", self.now - status.STUCK_VIDEO_MS - 1)
        self.make_generation("video", self.now - status.STUCK_VIDEO_MS + 1)
        stale_depth = self.make_generation("depth", self.now - status.STUCK_DEPTH_GRACE_MS - 1)
        healthy_depth = self.make_generation(
            "depth",
            self.now - status.STUCK_DEPTH_GRACE_MS - 1,
        )
        DepthWorker.objects.create(
            worker_id="healthy-worker",
            status="busy",
            current_job_id=healthy_depth.id,
            last_seen_at=self.now - status.DEPTH_WORKER_STALE_MS + 1,
            created_at=self.now,
        )
        self.make_generation("depth", self.now - status.STUCK_DEPTH_GRACE_MS + 1)
        self.make_generation(
            "image", self.now - status.STUCK_IMAGE_MS - 1, status="complete"
        )

        result = status.check_stuck_generations(now_ms=self.now)
        self.assertEqual(result["status"], "error")
        self.assertTrue(result["detail"].startswith("3 stuck — depth: 1"))
        for row in (stale_image, stale_video, stale_depth, healthy_depth):
            self.assertNotIn(str(row.id), result["detail"])
