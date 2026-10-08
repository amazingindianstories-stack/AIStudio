from django.db import connection
from django.test import TransactionTestCase
from .models import GenerationNaming, NamingCounter, OrganizationIdempotencyKey


class OrganizationPersistenceTests(TransactionTestCase):
    def setUp(self):
        with connection.cursor() as cursor:
            cursor.execute('CREATE TABLE IF NOT EXISTS naming_counters (namespace text PRIMARY KEY,next_sequence bigint NOT NULL DEFAULT 1,updated_at bigint NOT NULL)')
            cursor.execute('CREATE TABLE IF NOT EXISTS generation_naming (generation_id uuid PRIMARY KEY,namespace text NOT NULL,sequence bigint NOT NULL,assigned_at bigint NOT NULL)')
            cursor.execute("CREATE TABLE IF NOT EXISTS organization_idempotency_keys (key text PRIMARY KEY,actor_id text,operation text NOT NULL,fingerprint text NOT NULL,status text NOT NULL DEFAULT 'completed',result jsonb,created_at bigint NOT NULL,expires_at bigint NOT NULL)")
            cursor.execute('TRUNCATE naming_counters,generation_naming,organization_idempotency_keys')

    def test_nonstandard_keys_bigint_and_json_roundtrip(self):
        counter = NamingCounter.objects.create(namespace='global_unsorted',updated_at=0)
        self.assertEqual(NamingCounter.objects.get(pk=counter.pk).next_sequence,1)
        naming = GenerationNaming.objects.create(generation_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',namespace=counter.pk,sequence=9007199254740993,assigned_at=123)
        stored = GenerationNaming.objects.get(pk=naming.pk)
        self.assertEqual(stored.sequence,9007199254740993)
        self.assertEqual(str(stored.generation_id),str(naming.pk))
        payload = {'folder':{'name':'संदर्भ','color':None},'items':[]}
        record = OrganizationIdempotencyKey.objects.create(key='fixture-key',actor_id=None,operation='createFolder',fingerprint='fixture-hash',result=payload,created_at=1,expires_at=2)
        stored = OrganizationIdempotencyKey.objects.get(pk=record.pk)
        self.assertEqual(stored.status,'completed')
        self.assertEqual(stored.result,payload)
        self.assertIsNone(stored.actor_id)
        stored.result = None
        stored.save(update_fields=['result'])
        self.assertIsNone(OrganizationIdempotencyKey.objects.get(pk=record.pk).result)
