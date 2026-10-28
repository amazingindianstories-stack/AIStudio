import uuid
from django.db import connection
from django.test import TestCase, TransactionTestCase, override_settings
from apps.generation.models import Generation
from apps.library.models import OrganizationIdempotencyKey
from .models import MediaExport, MediaExportItem
from . import admission, services

API = {'VEEVEE_EXPORT_ADMISSION': True, 'VEEVEE_RUNTIME_COMPONENT': 'api'}
WORKER = {'VEEVEE_EXPORT_ADMISSION': True, 'VEEVEE_RUNTIME_COMPONENT': 'export'}


class ApiAdmissionTests(TransactionTestCase):
    def test_api_admits_only_exports_it_created(self):
        with override_settings(**API):
            actor = uuid.uuid4()
            created = services.create_export(actor, now=1000)
            receipt = OrganizationIdempotencyKey.objects.get(pk=admission.marker_key(created['id']))
            self.assertEqual(receipt.result, {'id': created['id']})
            self.assertEqual((receipt.actor_id, receipt.operation, receipt.status, receipt.created_at, receipt.expires_at),
                             (str(actor), admission.OPERATION, 'completed', 1000, 0))
            # Admitted export passes the guard and reaches normal validation.
            try:
                services.append_items(created['id'], actor, [])
            except services.ExportError as error:
                self.assertNotEqual(error.args[0], 'EXPORT_NOT_FOUND')
            # An export without a receipt (e.g. pre-cutover history) is invisible.
            legacy = MediaExport.objects.create(user_id=actor, status='draft', created_at=1, updated_at=1)
            for call in (lambda: services.append_items(str(legacy.id), actor, []), lambda: services.finalize_export(str(legacy.id), actor)):
                with self.assertRaises(services.ExportError) as hidden:
                    call()
                self.assertEqual(hidden.exception.args[0], 'EXPORT_NOT_FOUND')
            # Another actor cannot use someone else's admission.
            with self.assertRaises(services.ExportError) as other:
                services.finalize_export(created['id'], uuid.uuid4())
            self.assertEqual(other.exception.args[0], 'EXPORT_NOT_FOUND')

    def test_the_mcp_service_admits_the_exports_it_creates_like_the_api(self):
        with override_settings(**{**API, 'VEEVEE_RUNTIME_COMPONENT': 'mcp'}):
            self.assertTrue(admission.api_enabled())
            actor = uuid.uuid4()
            created = services.create_export(actor, now=1000)
            self.assertTrue(admission.admitted(created['id'], actor))
            legacy = MediaExport.objects.create(user_id=actor, status='draft', created_at=1, updated_at=1)
            with self.assertRaises(services.ExportError) as hidden:
                services.finalize_export(str(legacy.id), actor)
            self.assertEqual(hidden.exception.args[0], 'EXPORT_NOT_FOUND')

    def test_other_components_and_the_flag_off_neither_record_nor_check_receipts(self):
        for flags in ({**API, 'VEEVEE_EXPORT_ADMISSION': False}, {**WORKER, 'VEEVEE_RUNTIME_COMPONENT': 'generation'},
                      {**API, 'VEEVEE_RUNTIME_COMPONENT': None}):
            with self.subTest(flags=flags), override_settings(**flags):
                actor = uuid.uuid4()
                created = services.create_export(actor, now=1000)
                self.assertFalse(OrganizationIdempotencyKey.objects.filter(pk=admission.marker_key(created['id'])).exists())
                with self.assertRaises(services.ExportError) as invalid:
                    services.append_items(created['id'], actor, [])
                self.assertEqual(invalid.exception.args[0], 'INVALID_EXPORT_ITEMS')
                with self.assertRaises(services.ExportError) as empty:
                    services.finalize_export(created['id'], actor)
                self.assertEqual(empty.exception.args[0], 'EXPORT_NOT_FINALIZABLE')

    def test_full_admitted_export_reaches_the_queue(self):
        with override_settings(**API):
            actor = uuid.uuid4()
            row = Generation.objects.create(kind='image', status='completed', prompt='p', model='m', aspect_ratio='1:1',
                                            url='/api/media/generated/source.png', created_at=1, updated_at=1)
            created = services.create_export(actor, now=1000)
            self.assertEqual(services.append_items(created['id'], actor, [str(row.id)], 2000)['accepted'], 1)
            self.assertEqual(services.finalize_export(created['id'], actor, 3000).status, 'queued')


class WorkerAdmissionTests(TestCase):
    """The export worker reads receipts through a view; PostgreSQL DDL rolls back with the test transaction."""

    def setUp(self):
        with connection.cursor() as cursor:
            cursor.execute('CREATE SCHEMA goal4_preview_worker_holds')
            cursor.execute("CREATE VIEW goal4_preview_worker_holds.new_export_registrations AS "
                           "SELECT key, actor_id, result, fingerprint FROM organization_idempotency_keys WHERE operation = %s",
                           [admission.OPERATION])
        self.actor = uuid.uuid4()
        self.admitted = self.export()
        admission.record(str(self.admitted.id), self.actor, 1)
        self.legacy = self.export()
        self.forged = self.export()
        OrganizationIdempotencyKey.objects.create(key=admission.marker_key(self.forged.id), actor_id=str(self.actor),
            operation=admission.OPERATION, fingerprint='0' * 64, status='completed', result={'id': str(self.forged.id)},
            created_at=1, expires_at=0)
        self.other_actor = self.export()
        admission.record(str(self.other_actor.id), uuid.uuid4(), 1)
        self.all = {self.admitted.id, self.legacy.id, self.forged.id, self.other_actor.id}

    def export(self):
        job = MediaExport.objects.create(user_id=self.actor, status='queued', total_items=1, created_at=1, updated_at=1)
        MediaExportItem.objects.create(export=job, generation_id=uuid.uuid4(), position=1, source_key='generated/a.png', filename='a.png')
        return job

    def test_worker_sees_only_admitted_exports_and_their_items(self):
        with override_settings(**WORKER):
            self.assertEqual(set(MediaExport.objects.values_list('id', flat=True)), {self.admitted.id})
            self.assertEqual(set(MediaExport._default_manager.values_list('id', flat=True)), {self.admitted.id})
            self.assertEqual(set(MediaExportItem.objects.values_list('export_id', flat=True)), {self.admitted.id})
            claimed = services.claim_export('worker-1', now=10)
            self.assertEqual(claimed.id, self.admitted.id)
            self.assertIsNone(services.claim_export('worker-2', now=10))

    def test_related_and_base_managers_stay_unfiltered(self):
        with override_settings(**WORKER):
            self.assertEqual(set(MediaExport._base_manager.values_list('id', flat=True)), self.all)
            self.assertEqual(set(MediaExportItem._base_manager.values_list('export_id', flat=True)), self.all)
            self.assertEqual(self.legacy.mediaexportitem_set.count(), 1)
            item = MediaExportItem._base_manager.get(export_id=self.legacy.id)
            self.assertEqual(item.export.id, self.legacy.id)

    def test_only_the_export_component_with_the_flag_filters(self):
        for flags in ({**WORKER, 'VEEVEE_EXPORT_ADMISSION': False}, {**WORKER, 'VEEVEE_RUNTIME_COMPONENT': 'scheduler'},
                      API, {**WORKER, 'VEEVEE_RUNTIME_COMPONENT': None}):
            with self.subTest(flags=flags), override_settings(**flags):
                self.assertEqual(set(MediaExport.objects.values_list('id', flat=True)), self.all)
                self.assertEqual(set(MediaExportItem.objects.values_list('export_id', flat=True)), self.all)
