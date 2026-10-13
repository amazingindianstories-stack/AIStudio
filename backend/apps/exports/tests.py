from uuid import UUID
from django.db import connection, IntegrityError, transaction
from django.test import TransactionTestCase
from .models import MediaExport, MediaExportItem


class ExportPersistenceTests(TransactionTestCase):
    export_id = UUID('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    generation_id = UUID('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')

    def setUp(self):
        self.export = MediaExport.objects.create(id=self.export_id,user_id=self.generation_id,created_at=1,updated_at=2)

    def item(self, **kwargs):
        return MediaExportItem.objects.create(export=self.export,generation_id=self.generation_id,position=0,source_key='fixture/master.mov',filename='दृश्य.mov',**kwargs)

    def test_composite_lookup_frozen_names_and_database_cascade(self):
        self.item()
        row = MediaExportItem.objects.select_related('export').get(pk=(self.export_id,self.generation_id))
        self.assertEqual((row.filename,row.source_key),('दृश्य.mov','fixture/master.mov'))
        self.assertEqual(row.export.status,'draft')
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.item()
        with connection.cursor() as cursor:
            cursor.execute('DELETE FROM media_exports WHERE id=%s',[self.export_id])
        self.assertFalse(MediaExportItem.objects.exists())

    def test_lease_bigint_json_and_warning_defaults_are_independent(self):
        other = MediaExport(id=UUID('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),user_id=self.generation_id,created_at=3,updated_at=4)
        self.export.warnings.append({'code':'fixture_missing','name':'दृश्य'})
        self.export.lease_owner='fixture-worker'
        self.export.lease_until=9007199254740993
        self.export.output_bytes=9007199254740995
        self.export.save()
        self.export.refresh_from_db()
        self.assertEqual(other.warnings,[])
        self.assertEqual(self.export.warnings,[{'code':'fixture_missing','name':'दृश्य'}])
        self.assertEqual((self.export.lease_until,self.export.output_bytes),(9007199254740993,9007199254740995))
        self.assertEqual((self.export.manifest_version,self.export.attempt_count),(1,0))
