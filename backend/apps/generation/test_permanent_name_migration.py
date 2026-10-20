"""Upgrade rehearsal with legacy missing naming, nested folders and frozen exports."""
import io
import json
from uuid import uuid4
from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class PermanentNameMigrationTests(TransactionTestCase):
    def test_upgrade_freezes_all_existing_names_without_rewriting_exports_or_counters(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'generation'] + [('generation', '0002_generation_submission_input')]
        try:
            executor.migrate(previous)
            apps = executor.loader.project_state(previous).apps
            Folder = apps.get_model('library', 'Folder')
            Generation = apps.get_model('generation', 'Generation')
            Naming = apps.get_model('library', 'GenerationNaming')
            Counter = apps.get_model('library', 'NamingCounter')
            Export = apps.get_model('exports', 'MediaExport')
            Item = apps.get_model('exports', 'MediaExportItem')
            root = Folder.objects.create(name='Scene', name_normalized='scene', created_at=1)
            child = Folder.objects.create(name='Take', name_normalized='take', parent_id=root.id, created_at=1)
            rows = [Generation.objects.create(kind='video', status='succeeded', prompt='legacy', model='fixture',
                aspect_ratio='1:1', url='/api/media/master.mov', created_at=1, updated_at=2, folder_id=fid)
                for fid in (child.id, None, None)]
            Naming.objects.filter(generation_id=rows[0].id).update(sequence=11)
            Naming.objects.filter(generation_id__in=[rows[1].id, rows[2].id]).delete()
            Counter.objects.filter(namespace=f'folder:{child.id}').update(next_sequence=12)
            export = Export.objects.create(user_id=uuid4(), status='ready', created_at=1, updated_at=2)
            Item.objects.create(export_id=export.id, generation_id=rows[0].id, position=1,
                source_key='generations/master.mov', filename='Global/Scene/Take/Take_0011.mov')
            output = io.StringIO()
            call_command('audit_generation_names', stdout=output)
            audit = json.loads(output.getvalue())
            self.assertEqual(audit['backfillRows'], 3)
            self.assertEqual(len(audit['newZipLeafChanges']), 1)
            self.assertEqual(len(audit['existingExportDisagreements']), 1)
            executor = MigrationExecutor(connection)
            executor.migrate(final)
            from apps.generation.models import Generation as CurrentGeneration
            from apps.library.filenames import batch_resolve_generation_filenames
            self.assertEqual(list(CurrentGeneration.objects.filter(pk__in=[r.id for r in rows]).order_by('folder_id').values_list('permanent_name', flat=True)).count('unsorted_0001'), 2)
            self.assertEqual(batch_resolve_generation_filenames([rows[0].id])[str(rows[0].id)]['filename'], 'Scene_Take_0011.mov')
            self.assertEqual(Item.objects.get(export_id=export.id).filename, 'Global/Scene/Take/Take_0011.mov')
            self.assertEqual(Counter.objects.get(namespace=f'folder:{child.id}').next_sequence, 12)
            self.assertEqual(Naming.objects.count(), 1)
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
        finally:
            MigrationExecutor(connection).migrate(final)
