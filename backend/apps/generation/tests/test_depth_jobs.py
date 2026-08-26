import time
import uuid

from django.test import TestCase

from .. import depth_jobs_service as jobs
from ..models import DepthWorker, Generation


def make_job(**overrides):
    now = int(time.time() * 1000)
    values = {
        "id": uuid.uuid4(), "kind": "depth", "status": "queued",
        "prompt": "depth", "model": "Video Depth Anything",
        "aspect_ratio": "16:9", "resolution": "vitb",
        "reference_videos": ["references/input.mp4"],
        "created_at": now, "updated_at": now,
    }
    values.update(overrides)
    return Generation.objects.create(**values)


class DepthClaimFencingTests(TestCase):
    def test_claim_assigns_unique_fencing_id(self):
        make_job()
        first = jobs.claim_next_depth_job("worker-a")
        self.assertIsNotNone(first["claimId"])

        Generation.objects.filter(id=first["id"]).update(status="queued")
        second = jobs.claim_next_depth_job("worker-b")
        self.assertNotEqual(first["claimId"], second["claimId"])

    def test_stale_claim_cannot_progress_or_complete_reassigned_job(self):
        row = make_job()
        first = jobs.claim_next_depth_job("worker-a")
        old = int(time.time() * 1000) - jobs.CLAIM_GRACE_MS - 1
        Generation.objects.filter(id=row.id).update(updated_at=old)
        self.assertEqual(jobs.reap_stale_depth_jobs(force=True), 1)

        second = jobs.claim_next_depth_job("worker-b")
        self.assertFalse(jobs.report_depth_progress(str(row.id), first["claimId"], 90, "late"))
        self.assertFalse(jobs.complete_depth_job(str(row.id), first["claimId"], ok=True, url="/wrong"))

        row.refresh_from_db()
        self.assertEqual(row.status, "running")
        self.assertEqual(str(row.depth_claim_id), second["claimId"])
        self.assertIsNone(row.url)

    def test_matching_fresh_heartbeat_prevents_reap(self):
        row = make_job()
        claim = jobs.claim_next_depth_job("worker-a")
        now = int(time.time() * 1000)
        Generation.objects.filter(id=row.id).update(updated_at=now - jobs.CLAIM_GRACE_MS - 1)
        DepthWorker.objects.create(
            worker_id="worker-a", status="busy", current_job_id=row.id,
            current_claim_id=claim["claimId"], last_seen_at=now, created_at=now,
        )

        self.assertEqual(jobs.reap_stale_depth_jobs(force=True, now=now), 0)
        row.refresh_from_db()
        self.assertEqual(row.status, "running")

    def test_third_worker_loss_fails_instead_of_looping(self):
        row = make_job(depth_reap_attempts=2)
        jobs.claim_next_depth_job("worker-a")
        now = int(time.time() * 1000)
        Generation.objects.filter(id=row.id).update(updated_at=now - jobs.CLAIM_GRACE_MS - 1)

        self.assertEqual(jobs.reap_stale_depth_jobs(force=True, now=now), 1)
        row.refresh_from_db()
        self.assertEqual(row.status, "failed")
        self.assertEqual(row.depth_reap_attempts, 3)
        self.assertIsNone(row.depth_claim_id)
