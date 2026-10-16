from django.db import transaction
from django.test import TransactionTestCase
from .models import GenerationNaming, NamingCounter, OrganizationIdempotencyKey


class OrganizationPersistenceTests(TransactionTestCase):
    def test_nonstandard_keys_bigint_and_json_roundtrip(self):
        counter = NamingCounter.objects.create(namespace='global_unsorted',updated_at=0)
        self.assertEqual(NamingCounter.objects.get(pk=counter.pk).next_sequence,1)
        from apps.generation.models import Generation
        # A valid explicit assignment in the same transaction takes precedence
        # over the deferred trigger's automatic assignment for a legacy insert.
        with transaction.atomic():
            generation = Generation.objects.create(
                id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind='image', status='succeeded',
                prompt='Naming fixture', model='fixture', aspect_ratio='1:1', created_at=1, updated_at=1,
            )
            naming = GenerationNaming.objects.create(generation=generation,namespace=counter.pk,sequence=9007199254740993,assigned_at=123)
            counter.next_sequence = 9007199254740994
            counter.save(update_fields=['next_sequence'])
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
