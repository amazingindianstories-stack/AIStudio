from uuid import UUID
from django.db import connection, IntegrityError, transaction
from django.test import TransactionTestCase
from .models import DepthWorker


class DepthWorkerPersistenceTests(TransactionTestCase):
    def setUp(self):
        # Disposable current-schema fixture; no external GPU worker is started.
        with connection.cursor() as cursor:
            cursor.execute("CREATE TABLE IF NOT EXISTS depth_workers (id uuid PRIMARY KEY,worker_id text NOT NULL UNIQUE,label text,device text,status text NOT NULL DEFAULT 'idle',current_job_id uuid,current_claim_id uuid,protocol_version integer NOT NULL DEFAULT 1,ram_limit_mb integer,ram_used_mb integer,last_seen_at bigint NOT NULL,created_at bigint NOT NULL)")
            cursor.execute('TRUNCATE depth_workers')

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
