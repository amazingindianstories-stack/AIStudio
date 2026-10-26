"""Real-shaped additive upgrade/reverse rehearsal for explicit folder renames."""
from uuid import uuid4
from django.db import connection, IntegrityError, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class FolderNameRenameMigrationTests(TransactionTestCase):
    def test_upgrade_and_reverse_keep_names_reservations_counters_and_frozen_exports(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'generation'] + [('generation', '0006_generation_cancellation_state')]
        try:
            legacy = [node for node in previous if node[0] != 'generation'] + [('generation', '0004_generation_unique_permanent_name')]
            executor.migrate(legacy)
            apps = executor.loader.project_state(legacy).apps
            Generation = apps.get_model('generation', 'Generation')
            Naming = apps.get_model('library', 'GenerationNaming')
            Counter = apps.get_model('library', 'NamingCounter')
            Folder = apps.get_model('library', 'Folder')
            Item = apps.get_model('exports', 'MediaExportItem')
            Export = apps.get_model('exports', 'MediaExport')
            User = apps.get_model('authentication', 'User')
            actor = User.objects.create(id=uuid4(), email='rename@example.test', name='Admin', role='admin', created_at=1)
            root = Folder.objects.create(name='R02', created_at=1)
            folder = Folder.objects.create(name='SC018', parent_id=root.id, created_at=1)
            values = dict(kind='video', model='Seedance 2.5', status='succeeded', prompt='fixture',
                aspect_ratio='1:1', url='/api/media/master.mov', created_at=1, updated_at=1)
            draft = Generation.objects.create(**values, folder_id=folder.id, draft_mode=True, task_id='draft', permanent_name='R01_SC018_0042')
            final_row = Generation.objects.create(**values, folder_id=folder.id, draft_mode=False,
                source_generation_id=draft.id, draft_task_id='draft', permanent_name='R01_SC018_0044')
            missing = Generation.objects.create(**values, folder_id=folder.id, permanent_name='R01_SC018_0043')
            Naming.objects.filter(generation_id=missing.id).delete()
            for ordinal in (0, 1):
                Generation.objects.create(**values, permanent_name='unsorted_0001', legacy_name_duplicate=ordinal)
            Counter.objects.create(namespace='name:r01_sc018', next_sequence=44, updated_at=1)
            export = Export.objects.create(user_id=actor.id, status='ready', created_at=1, updated_at=1)
            item = Item.objects.create(export_id=export.id, generation_id=draft.id, position=1,
                filename='Global/R01/SC018/R01_SC018_0042.mov', source_key='generations/master.mov')
            MigrationExecutor(connection).migrate(previous)
            # Add a genuinely shared final using the already deployed owner schema.
            Generation = MigrationExecutor(connection).loader.project_state(previous).apps.get_model('generation', 'Generation')
            final_row = Generation.objects.create(**values, folder_id=folder.id, draft_mode=False,
                source_generation_id=draft.id, draft_task_id='draft', permanent_name=draft.permanent_name, name_owner_id=draft.id)
            names = dict(Generation.objects.values_list('id', 'permanent_name'))
            counters = list(Counter.objects.order_by('namespace').values())
            naming = list(Naming.objects.order_by('generation_id').values())
            MigrationExecutor(connection).migrate(final)
            self.assertEqual(dict(Generation.objects.values_list('id', 'permanent_name')), names)
            self.assertEqual(list(Counter.objects.order_by('namespace').values()), counters)
            self.assertEqual(list(Naming.objects.order_by('generation_id').values()), naming)
            from apps.library.services.folder_naming import preview_folder_names, rename_folder_generations
            from apps.generation.models import GenerationNameOwner, GenerationNameChange
            preview = preview_folder_names(folder_id=folder.id, actor_id=actor.id)
            result = rename_folder_generations(folder_id=folder.id, actor_id=actor.id, preview_token=preview['previewToken'])
            self.assertEqual(result['renamedCount'], 4)
            changed = dict(Generation.objects.values_list('id', 'permanent_name'))
            self.assertEqual(changed[draft.id], changed[final_row.id])
            self.assertEqual(GenerationNameChange.objects.count(), 4)
            reserved = set(GenerationNameOwner.objects.values_list('permanent_name', 'legacy_name_duplicate'))
            self.assertIn(('R01_SC018_0042', 0), reserved)
            self.assertIn(('R01_SC018_0043', 0), reserved)
            self.assertEqual(Item.objects.get(pk=item.pk).filename, item.filename)
            MigrationExecutor(connection).migrate(previous)
            self.assertEqual(dict(Generation.objects.values_list('id', 'permanent_name')), changed)
            self.assertEqual(Item.objects.get(pk=item.pk).filename, item.filename)
            with self.assertRaises(IntegrityError), transaction.atomic():
                Generation.objects.filter(pk=draft.id).update(permanent_name='forbidden')
            with self.assertRaises(IntegrityError), transaction.atomic():
                Generation.objects.create(**values, permanent_name='R01_SC018_0042')
            MigrationExecutor(connection).migrate(final)
            self.assertEqual(dict(Generation.objects.values_list('id', 'permanent_name')), changed)
            self.assertEqual(set(GenerationNameOwner.objects.values_list('permanent_name', 'legacy_name_duplicate')), reserved)
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
        finally:
            MigrationExecutor(connection).migrate(final)

    def test_only_api_role_can_execute_and_cannot_forge_or_erase_receipts(self):
        from django.db import ProgrammingError
        from apps.authentication.models import User
        from apps.generation.models import Generation, GenerationNameChange
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'generation'] + [('generation', '0006_generation_cancellation_state')]
        roles = ['goal4_green_preview_api', 'goal4_green_preview_worker']
        created = []
        try:
            executor.migrate(previous)
            with connection.cursor() as cursor:
                for role in roles:
                    cursor.execute(f'CREATE ROLE {role} NOLOGIN')
                    created.append(role)
                    cursor.execute(f'GRANT USAGE ON SCHEMA public TO {role}')
                    cursor.execute(f'GRANT SELECT, UPDATE ON generations TO {role}')
                    cursor.execute(f'GRANT SELECT ON generation_name_owners TO {role}')
            MigrationExecutor(connection).migrate(final)
            actor = User.objects.create(id=uuid4(), email='role@example.test', name='Admin', role='admin', created_at=1)
            row = Generation.objects.create(kind='image', model='fixture', status='succeeded', prompt='fixture',
                aspect_ratio='1:1', created_at=1, updated_at=1, permanent_name='Old_0001')
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute('SET LOCAL ROLE goal4_green_preview_api')
                cursor.execute('SELECT rename_generation_lineage(%s,%s,%s,%s)', [row.id, 'New_0001', actor.id, 2])
                # A caller-owned temporary table must not impersonate audit authorization.
                cursor.execute('CREATE TEMP TABLE generation_name_changes (LIKE public.generation_name_changes) ON COMMIT DROP')
                cursor.execute("INSERT INTO generation_name_changes VALUES (%s,%s,'New_0001','Forged_0001',%s,3,txid_current())", [uuid4(), row.id, actor.id])
                with self.assertRaises(IntegrityError), transaction.atomic():
                    cursor.execute("UPDATE generations SET permanent_name='Forged_0001' WHERE id=%s", [row.id])
                for query in ["UPDATE public.generation_name_changes SET new_name='forged'", 'DELETE FROM public.generation_name_changes',
                              "INSERT INTO public.generation_name_changes SELECT * FROM public.generation_name_changes"]:
                    with self.assertRaises(ProgrammingError), transaction.atomic():
                        cursor.execute(query)
            with self.assertRaises(ProgrammingError), transaction.atomic(), connection.cursor() as cursor:
                cursor.execute('SET LOCAL ROLE goal4_green_preview_worker')
                cursor.execute('SELECT rename_generation_lineage(%s,%s,%s,%s)', [row.id, 'Forbidden_0001', actor.id, 3])
            with transaction.atomic(), connection.cursor() as cursor:
                cursor.execute('SET LOCAL ROLE goal4_green_preview_worker')
                cursor.execute('UPDATE generations SET permanent_name=permanent_name WHERE id=%s', [row.id])
            row.refresh_from_db()
            self.assertEqual(row.permanent_name, 'New_0001')
            self.assertEqual(GenerationNameChange.objects.get().old_name, 'Old_0001')
        finally:
            MigrationExecutor(connection).migrate(final)
            with connection.cursor() as cursor:
                for role in created:
                    cursor.execute(f'DROP OWNED BY {role}')
                    cursor.execute(f'DROP ROLE {role}')
