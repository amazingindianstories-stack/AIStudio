"""Exercise first adoption and later real DDL against PostgreSQL."""

from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db import connection
from django.db.migrations.recorder import MigrationRecorder
from django.test import TransactionTestCase, override_settings

from apps.common.management.commands.schema_preflight import LOCAL_LABELS


@override_settings(MIGRATION_MODULES={})
class SchemaPreflightTests(TransactionTestCase):
    def test_adoption_leaves_new_migration_pending_and_startup_can_apply_it(self):
        recorder = MigrationRecorder(connection)
        recorder.migration_qs.filter(app__in=LOCAL_LABELS).delete()
        with connection.cursor() as cursor:
            cursor.execute("ALTER TABLE generations DROP COLUMN production_metadata")
            cursor.execute("ALTER TABLE generations DROP COLUMN reference_audios")
        try:
            call_command("schema_preflight", adopt=True, stdout=StringIO())
            applied = recorder.applied_migrations()
            self.assertIn(("generation", "0007_adopt_current_schema"), applied)
            self.assertNotIn(("generation", "0008_generation_production_metadata"), applied)
            # This is the exact API startup order. Pending DDL must not block it.
            call_command("schema_preflight", require_adopted=True, stdout=StringIO())
            call_command("migrate", "generation", interactive=False, stdout=StringIO())
            call_command("schema_preflight", require_adopted=True, stdout=StringIO())
            with connection.cursor() as cursor:
                cursor.execute("""SELECT column_default, is_nullable FROM information_schema.columns
                    WHERE table_schema = current_schema() AND table_name = 'generations'
                    AND column_name = 'production_metadata'""")
                default, nullable = cursor.fetchone()
            self.assertEqual(default, "'{}'::jsonb")
            self.assertEqual(nullable, "NO")
            call_command("schema_preflight", adopt=True, stdout=StringIO())
        finally:
            with connection.cursor() as cursor:
                cursor.execute("ALTER TABLE generations ADD COLUMN IF NOT EXISTS production_metadata jsonb NOT NULL DEFAULT '{}'::jsonb")
            with connection.cursor() as cursor:
                cursor.execute("ALTER TABLE generations ADD COLUMN IF NOT EXISTS reference_audios jsonb")
            recorder.migration_qs.filter(app__in=LOCAL_LABELS).delete()

    def test_unadopted_catalog_is_not_allowed_to_start(self):
        with self.assertRaisesMessage(CommandError, "Legacy migrations are not adopted"):
            call_command("schema_preflight", require_adopted=True, stdout=StringIO())

    def test_drift_does_not_record_adoption(self):
        with connection.cursor() as cursor:
            cursor.execute("ALTER TABLE generations ADD COLUMN unexpected_release_column text")
        try:
            with self.assertRaisesMessage(CommandError, "unexpected columns unexpected_release_column"):
                call_command("schema_preflight", adopt=True, stdout=StringIO())
            self.assertFalse(MigrationRecorder(connection).migration_qs.filter(app__in=LOCAL_LABELS).exists())
        finally:
            with connection.cursor() as cursor:
                cursor.execute("ALTER TABLE generations DROP COLUMN unexpected_release_column")

    def test_current_production_columns_are_audited_and_adopted(self):
        call_command("schema_preflight", adopt=True, stdout=StringIO())
        applied = MigrationRecorder(connection).applied_migrations()
        self.assertIn(("generation", "0008_generation_production_metadata"), applied)
        self.assertIn(("generation", "0009_generation_reference_audios"), applied)
        call_command("schema_preflight", require_adopted=True, stdout=StringIO())
        call_command("migrate", "generation", interactive=False, stdout=StringIO())
        MigrationRecorder(connection).migration_qs.filter(app__in=LOCAL_LABELS).delete()
