import unittest

from depth_protocol import PROTOCOL_VERSION, claim_payload, claimed_payload, heartbeat_payload, transfer_url


class DepthProtocolTest(unittest.TestCase):
    def test_claim_advertises_v2(self):
        self.assertEqual(claim_payload("worker-a"), {
            "workerId": "worker-a", "protocolVersion": PROTOCOL_VERSION,
        })

    def test_fenced_payload_echoes_claim(self):
        self.assertEqual(claimed_payload("job-a", "claim-a", percent=25), {
            "jobId": "job-a", "claimId": "claim-a", "percent": 25,
        })

    def test_legacy_payload_omits_claim(self):
        self.assertEqual(claimed_payload("job-a", None, ok=False), {
            "jobId": "job-a", "ok": False,
        })

    def test_heartbeat_always_advertises_protocol(self):
        self.assertEqual(heartbeat_payload("worker-a", "claim-a", status="busy"), {
            "workerId": "worker-a", "protocolVersion": PROTOCOL_VERSION,
            "currentClaimId": "claim-a", "status": "busy",
        })


class TransferUrlTests(unittest.TestCase):
    def test_absolute_urls_are_unchanged_and_local_paths_resolve(self):
        signed = "https://storage.googleapis.com/bucket/depth-output/x.mp4?X-Goog-Signature=abc"
        self.assertEqual(transfer_url("https://veevee.ai", signed), signed)
        self.assertEqual(transfer_url("http://localhost:3000/", "/api/uploads/local?t=a.b"), "http://localhost:3000/api/uploads/local?t=a.b")


if __name__ == "__main__":
    unittest.main()
