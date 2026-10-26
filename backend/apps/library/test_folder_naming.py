"""Observable API, reservation, lineage and concurrent allocation contracts."""
from django.db import connection, IntegrityError, transaction
from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests, UID
from apps.authentication.models import User
from apps.generation.models import Generation, GenerationNameOwner, GenerationNameChange
from apps.library.models import NamingCounter
from apps.library.filenames import batch_resolve_generation_filenames
from apps.library.services import folder_engine as folders
from apps.library.services.naming import assign_generation_naming, same_execution_identity
from apps.library.services.folder_naming import preview_folder_names, rename_folder_generations


class FolderNamingTests(TransactionTestCase):
    cookie = SettingsTests.cookie

    def setUp(self):
        SettingsTests.setUp(self)
        User.objects.filter(pk=UID).update(role='admin')
        self.cookie()
        self.root = folders.create_folder(name='R01')
        self.folder = folders.create_folder(name='SC018', parent_id=self.root['id'])

    def generation(self, folder=None, **values):
        row = Generation.objects.create(kind='video', model='Seedance 2.5', status='succeeded', prompt='fixture',
            aspect_ratio='1:1', created_at=1, updated_at=1, folder_id=(folder or self.folder)['id'],
            url='/api/media/master.mov', **values)
        assign_generation_naming(row.id, row.folder_id)
        row.refresh_from_db()
        return row

    def changed_folder(self):
        folders.rename_folder(folder_id=self.root['id'], name='R02')

    def preview(self, folder=None):
        response = self.client.get('/api/folders', {'renamePreview': (folder or self.folder)['id']})
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def rename(self, folder=None, preview=None, key=None):
        folder = folder or self.folder
        preview = preview or self.preview(folder)
        return self.client.patch('/api/folders', {'id': folder['id'], 'action': 'renameGenerations',
            'previewToken': preview['previewToken'], 'idempotencyKey': key}, content_type='application/json')

    def test_explicit_subtree_rename_preserves_number_order_matching_names_and_history(self):
        rows = [self.generation() for _ in range(3)]
        child = folders.create_folder(name='Closeup', parent_id=self.folder['id'])
        nested = self.generation(child)
        self.changed_folder()
        matching = self.generation()
        old = [row.permanent_name for row in rows + [nested]]
        preview = self.preview(self.root)
        self.assertEqual(preview['renamedCount'], 4)
        response = self.rename(self.root, preview, 'explicit-rename')
        self.assertEqual(response.status_code, 200, response.content)
        for row in rows + [nested, matching]:
            row.refresh_from_db()
        self.assertEqual([row.permanent_name for row in rows], [f'R02_SC018_{n:04}' for n in range(2, 5)])
        self.assertEqual(nested.permanent_name, 'R02_SC018_Closeup_0001')
        self.assertEqual(matching.permanent_name, 'R02_SC018_0001')
        self.assertEqual(GenerationNameChange.objects.count(), 4)
        self.assertEqual(set(GenerationNameChange.objects.values_list('old_name', flat=True)), set(old))
        self.assertEqual(set(GenerationNameChange.objects.values_list('actor_id', flat=True)), {User.objects.get(pk=UID).id})
        self.assertTrue(all(GenerationNameOwner.objects.filter(permanent_name=name).exists() for name in old))
        self.assertEqual(self.preview()['renamedCount'], 0)
        self.assertEqual(self.rename(self.root, preview, 'explicit-rename').json(), response.json())
        User.objects.filter(pk=UID).update(role='user')
        self.assertEqual(self.rename(self.root, preview, 'explicit-rename').status_code, 403)
        self.assertEqual(self.client.get('/api/folders', {'renamePreview': self.folder['id']}).status_code, 403)

    def test_lineage_inside_subtree_renames_together_and_future_final_inherits(self):
        draft = self.generation(draft_mode=True, task_id='draft')
        final = self.generation(draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
        self.changed_folder()
        preview = self.preview()
        self.assertEqual((preview['renamedCount'], preview['skippedCount']), (2, 0))
        self.assertEqual(self.rename(preview=preview).status_code, 200)
        draft.refresh_from_db(); final.refresh_from_db()
        self.assertEqual(draft.permanent_name, 'R02_SC018_0001')
        self.assertEqual(final.permanent_name, draft.permanent_name)
        later = self.generation(draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
        self.assertEqual(later.permanent_name, draft.permanent_name)
        self.assertEqual(later.name_owner_id, draft.id)

    def test_finals_of_deleted_draft_inside_subtree_rename_together(self):
        draft = self.generation(draft_mode=True, task_id='draft')
        finals = [self.generation(draft_mode=False, source_generation_id=draft.id, draft_task_id='draft') for _ in range(2)]
        Generation.objects.filter(pk=draft.id).delete()
        self.changed_folder()
        preview = self.preview()
        self.assertEqual((preview['renamedCount'], preview['skippedCount']), (2, 0))
        self.assertEqual(self.rename(preview=preview).status_code, 200)
        for final in finals:
            final.refresh_from_db()
        self.assertEqual([final.permanent_name for final in finals], ['R02_SC018_0001', 'R02_SC018_0001'])
        self.assertEqual({final.name_owner_id for final in finals}, {draft.id})
        self.assertEqual(set(GenerationNameChange.objects.values_list('old_name', flat=True)), {'R01_SC018_0001'})
        self.assertEqual(GenerationNameChange.objects.count(), 2)

    def test_boundary_lineage_is_skipped_while_independent_generation_renames(self):
        draft = self.generation(draft_mode=True, task_id='draft')
        other = folders.create_folder(name='Outside')
        final = self.generation(other, draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
        ordinary = self.generation()
        self.changed_folder()
        preview = self.preview()
        self.assertEqual((preview['renamedCount'], preview['skippedCount']), (1, 1))
        self.assertEqual(self.rename(preview=preview).status_code, 200)
        draft.refresh_from_db(); final.refresh_from_db(); ordinary.refresh_from_db()
        self.assertEqual((draft.permanent_name, final.permanent_name), ('R01_SC018_0001', 'R01_SC018_0001'))
        self.assertEqual(ordinary.permanent_name, 'R02_SC018_0001')

    def test_lineage_inside_subtree_with_different_stems_is_skipped(self):
        draft = self.generation(draft_mode=True, task_id='draft')
        child = folders.create_folder(name='Different', parent_id=self.folder['id'])
        final = self.generation(child, draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
        self.changed_folder()
        preview = self.preview()
        self.assertEqual((preview['renamedCount'], preview['skippedCount']), (0, 2))
        self.assertEqual(self.rename(preview=preview).status_code, 200)
        final.refresh_from_db()
        self.assertEqual(final.permanent_name, draft.permanent_name)
        self.assertEqual(GenerationNameChange.objects.count(), 0)

    def test_skipped_lineages_count_only_names_that_differ_from_their_current_path(self):
        self.changed_folder()
        draft = self.generation(draft_mode=True, task_id='draft')
        outside = folders.create_folder(name='Outside')
        self.generation(outside, draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
        nested_draft = self.generation(draft_mode=True, task_id='nested')
        child = folders.create_folder(name='Different', parent_id=self.folder['id'])
        self.generation(child, draft_mode=False, source_generation_id=nested_draft.id, draft_task_id='nested')
        preview = self.preview()
        self.assertEqual((preview['renamedCount'], preview['skippedCount'], preview['unchangedCount']), (0, 1, 2))
        self.assertEqual(self.rename(preview=preview).status_code, 200)
        self.assertEqual(GenerationNameChange.objects.count(), 0)

    def test_queued_and_running_names_survive_completion_and_stale_writes_fail(self):
        rows = [self.generation() for _ in range(2)]
        for row, status in zip(rows, ['queued', 'running']):
            Generation.objects.filter(pk=row.id).update(status=status, url=None, worker_lease_id='rename-worker')
            row.refresh_from_db()
        self.changed_folder()
        self.assertEqual(self.rename().status_code, 200)
        for stale in rows:
            current = Generation.objects.get(pk=stale.id)
            self.assertTrue(same_execution_identity(current, stale))
            from apps.generation.services.executor import _persist_completion
            _persist_completion(stale, 'rename-worker', {'status': 'succeeded', 'url': '/api/media/completed.mov'}, current.updated_at + 1)
            self.assertEqual(batch_resolve_generation_filenames([current.id])[str(current.id)]['filename'], current.permanent_name + '.mov')
            with self.assertRaises(IntegrityError), transaction.atomic():
                Generation.objects.filter(pk=stale.id).update(permanent_name=stale.permanent_name)
        with self.assertRaises(IntegrityError), transaction.atomic():
            GenerationNameChange.objects.all().update(new_name='forged')
        with self.assertRaises(IntegrityError), transaction.atomic():
            GenerationNameOwner.objects.filter(pk=rows[0].id).update(permanent_name='forged')

    def test_stale_preview_rolls_back_and_historical_names_are_never_reused(self):
        row = self.generation()
        self.changed_folder()
        preview = self.preview()
        # Another allocator with the same library-wide stem wins after preview.
        NamingCounter.objects.create(namespace='name:r02_sc018', next_sequence=8, updated_at=1)
        self.assertEqual(self.rename(preview=preview).status_code, 409)
        self.assertEqual(Generation.objects.get(pk=row.id).permanent_name, 'R01_SC018_0001')
        self.assertEqual(self.rename().status_code, 200)
        folders.rename_folder(folder_id=self.root['id'], name='R01')
        self.assertEqual(self.rename().status_code, 200)
        self.assertEqual(Generation.objects.get(pk=row.id).permanent_name, 'R01_SC018_0002')
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.generation(permanent_name='R01_SC018_0001')

    def test_database_function_checks_actor_and_direct_updates_cannot_rename(self):
        row = self.generation()
        User.objects.filter(pk=UID).update(is_active=False)
        from django.db import ProgrammingError
        with self.assertRaises(ProgrammingError), transaction.atomic(), connection.cursor() as cursor:
            cursor.execute('SELECT rename_generation_lineage(%s,%s,%s,%s)', [row.id, 'Other_0001', UID, 10])
        self.assertFalse(GenerationNameChange.objects.exists())

    def test_downloads_new_zip_leaves_and_live_updates_use_new_name_and_same_master(self):
        from types import SimpleNamespace
        from django.test import override_settings
        from apps.exports.zip_paths import resolve_archive_paths
        from apps.media.storage import MemoryAdapter, StorageService
        storage = StorageService(MemoryAdapter())
        storage.upload_buffer(b'native-master', 'master.mov', 'mov')
        row = self.generation()
        self.changed_folder()
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            self.assertEqual(self.rename().status_code, 200)
            response = self.client.get(f'/api/generations/{row.id}/download')
            self.assertEqual(response.status_code, 200)
            self.assertIn('R02_SC018_0001.mov', response['Content-Disposition'])
            self.assertEqual(b''.join(response.streaming_content), b'native-master')
        path = resolve_archive_paths([SimpleNamespace(generation_id=row.id)])[str(row.id)]
        self.assertEqual(path.rsplit('/', 1)[-1], 'R02_SC018_0001.mov')
        response = self.client.get('/api/history/updates', {'since': 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(next(item for item in response.json()['items'] if item['id'] == str(row.id))['filename'], 'R02_SC018_0001.mov')

    def test_concurrent_same_stem_allocations_never_collide(self):
        from apps.projects.models import Project
        from apps.library.test_organization import OrganizationTests
        first, second = self.generation(), self.generation()
        project = Project.objects.create(name='Other project', created_at=1, updated_at=1)
        root = folders.create_folder(name='R02', project_id=str(project.id))
        other = folders.create_folder(name='SC018', parent_id=root['id'], project_id=str(project.id))
        folders.move_generations(ids=[str(second.id)], destination={'type': 'folder', 'folderId': other['id']})
        self.changed_folder()
        previews = [preview_folder_names(folder_id=folder['id'], actor_id=UID) for folder in [self.folder, other]]
        calls = [lambda folder=folder, preview=preview: rename_folder_generations(folder_id=folder['id'], actor_id=UID,
                    preview_token=preview['previewToken']) for folder, preview in zip([self.folder, other], previews)]
        results = OrganizationTests.race(self, calls)
        self.assertEqual(sum(isinstance(result, dict) for result in results), 1)
        self.assertIn('PREVIEW_CHANGED', results)
        for folder in [self.folder, other]:
            preview = preview_folder_names(folder_id=folder['id'], actor_id=UID)
            rename_folder_generations(folder_id=folder['id'], actor_id=UID, preview_token=preview['previewToken'])
        names = list(Generation.objects.filter(pk__in=[first.id, second.id]).values_list('permanent_name', flat=True))
        self.assertEqual(set(names), {'R02_SC018_0001', 'R02_SC018_0002'})
