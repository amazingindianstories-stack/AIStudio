"""Rehearse upgrade and reversal on a real-shaped copy of the supported schema."""
from uuid import uuid4
from django.db import connection, IntegrityError, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase


class NameOwnerMigrationTests(TransactionTestCase):
    def test_existing_runtime_roles_can_assign_shared_and_ordinary_names(self):
        from django.db import ProgrammingError
        from apps.generation.models import Generation
        from apps.library.services.naming import assign_generation_naming
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'generation'] + [('generation', '0004_generation_unique_permanent_name')]
        roles = ['goal4_green_preview_api', 'goal4_green_preview_worker']
        created = []
        try:
            executor.migrate(previous)
            with connection.cursor() as cursor:
                for role in roles:
                    cursor.execute(f'CREATE ROLE {role} NOLOGIN')
                    created.append(role)
                    cursor.execute(f'GRANT USAGE ON SCHEMA public TO {role}')
                    cursor.execute(f'GRANT SELECT, INSERT, UPDATE ON generations, generation_naming, naming_counters TO {role}')
            MigrationExecutor(connection).migrate(final)
            values = dict(kind='video', model='Seedance 2.5', status='succeeded', prompt='role fixture',
                aspect_ratio='1:1', created_at=1, updated_at=1)
            draft = Generation.objects.create(**values, draft_mode=True, task_id='draft', permanent_name='Runtime_0001')
            for index, role in enumerate(roles):
                with transaction.atomic(), connection.cursor() as cursor:
                    cursor.execute(f'SET LOCAL ROLE {role}')
                    row = Generation.objects.create(**values, draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
                    assign_generation_naming(row.id)
                    row.refresh_from_db()
                    self.assertEqual((row.permanent_name, row.name_owner_id), (draft.permanent_name, draft.id))
                    own = Generation.objects.create(**values, permanent_name=f'Own_{index}_0001')
                    own.refresh_from_db()
                    self.assertEqual(own.name_owner_id, own.id)
                    with self.assertRaises(ProgrammingError), transaction.atomic():
                        cursor.execute('UPDATE generation_name_owners SET permanent_name=%s WHERE id=%s', ['changed', own.id])
        finally:
            MigrationExecutor(connection).migrate(final)
            with connection.cursor() as cursor:
                for role in created:
                    cursor.execute(f'DROP OWNED BY {role}')
                    cursor.execute(f'DROP ROLE {role}')

    def test_upgrade_preserves_names_naming_counters_and_frozen_exports_and_reverses(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'generation'] + [('generation', '0004_generation_unique_permanent_name')]
        try:
            executor.migrate(previous)
            apps = executor.loader.project_state(previous).apps
            Generation = apps.get_model('generation', 'Generation')
            Folder = apps.get_model('library', 'Folder')
            Naming = apps.get_model('library', 'GenerationNaming')
            Counter = apps.get_model('library', 'NamingCounter')
            Export = apps.get_model('exports', 'MediaExport')
            Item = apps.get_model('exports', 'MediaExportItem')
            root = Folder.objects.create(name='Reel', name_normalized='reel', created_at=1)
            child = Folder.objects.create(name='Shot', name_normalized='shot', parent_id=root.id, created_at=1)
            values = dict(kind='video', status='succeeded', model='Seedance 2.5', prompt='copy fixture',
                aspect_ratio='1:1', created_at=1, updated_at=1, url='/api/media/master.mov')
            draft = Generation.objects.create(**values, folder_id=child.id, draft_mode=True, task_id='draft', permanent_name='Reel_Shot_0042')
            historical_final = Generation.objects.create(**values, folder_id=child.id, draft_mode=False,
                source_generation_id=draft.id, draft_task_id='draft', permanent_name='Reel_Shot_0043')
            duplicates = [Generation.objects.create(**values, permanent_name='unsorted_0001', legacy_name_duplicate=n) for n in (0, 1)]
            unnamed = Generation.objects.create(**values)
            Counter.objects.create(namespace='name:reel_shot', next_sequence=44, updated_at=1)
            names = dict(Generation.objects.values_list('id', 'permanent_name'))
            counters = list(Counter.objects.order_by('namespace').values())
            naming = list(Naming.objects.order_by('generation_id').values())
            export = Export.objects.create(user_id=uuid4(), status='ready', created_at=1, updated_at=1)
            Item.objects.create(export_id=export.id, generation_id=draft.id, position=1,
                filename='Global/Reel/Shot/Shot_0042.mov', source_key='generations/master.mov')
            MigrationExecutor(connection).migrate(final)
            from apps.generation.models import Generation as Current, GenerationNameOwner
            from apps.library.services.naming import assign_generation_naming
            self.assertEqual(dict(Current.objects.values_list('id', 'permanent_name')), names)
            self.assertEqual(list(Counter.objects.order_by('namespace').values()), counters)
            self.assertEqual(list(Naming.objects.order_by('generation_id').values()), naming)
            self.assertEqual(GenerationNameOwner.objects.count(), 4)
            self.assertIsNone(Current.objects.get(pk=unnamed.id).name_owner_id)
            self.assertEqual(Current.objects.get(pk=historical_final.id).name_owner_id, historical_final.id)
            for original in [draft, historical_final, *duplicates]:
                self.assertEqual(Current.objects.get(pk=original.id).name_owner_id, original.id)
            created = Current.objects.create(**values, draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
            assign_generation_naming(created.id)
            created.refresh_from_db()
            self.assertEqual((created.permanent_name, created.name_owner_id), (draft.permanent_name, draft.id))
            self.assertEqual(Item.objects.get(export_id=export.id).filename, 'Global/Reel/Shot/Shot_0042.mov')
            for replacement in (None, 'changed'):
                with self.assertRaises(IntegrityError), transaction.atomic():
                    Current.objects.filter(pk=created.id).update(permanent_name=replacement)
            MigrationExecutor(connection).migrate(previous)
            self.assertEqual(Generation.objects.get(pk=created.id).permanent_name, draft.permanent_name)
            self.assertEqual(Generation.objects.get(pk=created.id).legacy_name_duplicate, 1)
            self.assertEqual(dict(Generation.objects.exclude(pk=created.id).values_list('id', 'permanent_name')), names)
            with self.assertRaises(IntegrityError), transaction.atomic():
                Generation.objects.create(**values, permanent_name=draft.permanent_name)
            MigrationExecutor(connection).migrate(final)
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
            self.assertEqual(Item.objects.get(export_id=export.id).filename, 'Global/Reel/Shot/Shot_0042.mov')
        finally:
            MigrationExecutor(connection).migrate(final)
