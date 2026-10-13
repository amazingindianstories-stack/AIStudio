from uuid import UUID
from django.db import IntegrityError, transaction
from django.test import TransactionTestCase
from .models import DepthWorker


class DepthWorkerPersistenceTests(TransactionTestCase):
    def test_stable_worker_identity_and_fencing_state_roundtrip(self):
        worker = DepthWorker.objects.create(id=UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),worker_id='fixture-gpu',last_seen_at=1,created_at=1)
        self.assertEqual((worker.status,worker.protocol_version),('idle',1))
        self.assertIsNone(worker.current_claim_id)
        claim = UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
        DepthWorker.objects.filter(worker_id='fixture-gpu').update(current_claim_id=claim,current_job_id=claim,protocol_version=2,last_seen_at=9007199254740993,status='busy')
        worker.refresh_from_db()
        self.assertEqual((worker.current_claim_id,worker.current_job_id),(claim,claim))
        self.assertEqual(worker.last_seen_at,9007199254740993)
        with self.assertRaises(IntegrityError), transaction.atomic():
            DepthWorker.objects.create(id=UUID('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),worker_id='fixture-gpu',last_seen_at=2,created_at=2)
        self.assertEqual(DepthWorker.objects.count(),1)
