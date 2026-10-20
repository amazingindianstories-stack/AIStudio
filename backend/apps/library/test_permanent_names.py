"""User-facing regression coverage for permanent media identity and deletion."""
from django.test import TransactionTestCase
from apps.admin_dashboard import tests as settings_tests
UID = settings_tests.UID
from apps.authentication.models import User
from apps.generation.models import Generation
from apps.library.services import folder_engine as folders
from apps.library.services.naming import assign_generation_naming


class PermanentNamesTests(TransactionTestCase):
    setUp = settings_tests.SettingsTests.setUp
    cookie = settings_tests.SettingsTests.cookie

    def test_history_name_survives_folder_rename_and_generation_move(self):
        self.cookie()
        User.objects.filter(pk=UID).update(role='admin')
        folder = folders.create_folder(name='Scene One')
        row = Generation.objects.create(kind='video', status='succeeded', model='fixture', prompt='fixture',
            aspect_ratio='1:1', created_at=1, updated_at=1, folder_id=folder['id'], url='/api/media/master.mov')
        assign_generation_naming(row.id, row.folder_id)
        before = self.client.get('/api/history').json()['items'][0]['filename']
        renamed = self.client.patch('/api/folders', {'id': folder['id'], 'name': 'Scene Two'}, content_type='application/json')
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(self.client.get('/api/history').json()['items'][0]['filename'], before)
        moved = self.client.post('/api/history/move', {'ids': [str(row.id)], 'destination': {'type': 'global_unsorted'}}, content_type='application/json')
        self.assertEqual(moved.status_code, 200)
        self.assertEqual(self.client.get('/api/history').json()['items'][0]['filename'], before)

    def test_owner_cannot_delete_generation_or_empty_folder(self):
        self.cookie()
        folder = folders.create_folder(name='Empty')
        row = Generation.objects.create(kind='video', status='succeeded', model='fixture', prompt='fixture',
            aspect_ratio='1:1', created_at=1, updated_at=1, user_id=UID)
        self.assertEqual(self.client.delete('/api/history?id=' + str(row.id)).status_code, 403)
        self.assertEqual(self.client.delete('/api/folders?id=' + folder['id']).status_code, 403)
        self.assertTrue(Generation.objects.filter(pk=row.id).exists())

    def generation(self, **values):
        return Generation.objects.create(kind='video', status='succeeded', model='fixture', prompt='fixture',
            aspect_ratio='1:1', created_at=1, updated_at=1, url='/api/media/master.mov', **values)

    def filename(self, row):
        from apps.library.filenames import batch_resolve_generation_filenames
        return batch_resolve_generation_filenames([row.id])[str(row.id)]['filename']

    def test_name_frozen_before_the_master_exists_fits_every_supported_extension(self):
        from apps.exports.zip_paths import safe_zip_member_path
        parent = None
        for letter in 'ABC':
            parent = folders.create_folder(name=letter * 100, parent_id=parent and parent['id'])
        row = self.generation(folder_id=parent['id'])
        Generation.objects.filter(pk=row.id).update(url='')
        assign_generation_naming(row.id, row.folder_id)
        for extension in ('png', 'webp', 'webm', 'mov'):
            Generation.objects.filter(pk=row.id).update(url='/api/media/generated/master.' + extension)
            name = self.filename(row)
            self.assertTrue(name.endswith('.' + extension))
            self.assertLessEqual(len(name.encode('utf-8')), 255)
            self.assertEqual(safe_zip_member_path(name), name)

    def test_delete_role_and_ownership_matrix_for_all_generation_kinds(self):
        from uuid import uuid4
        self.cookie()
        for role in ('user', 'admin'):
            User.objects.filter(pk=UID).update(role=role)
            for owner in (UID, uuid4(), None):
                for kind, model, draft in [('image', 'fixture', False), ('video', 'fixture', True),
                        ('video', 'fixture', False), ('audio', 'fixture', False), ('depth', 'fixture', False),
                        ('image', 'Magnific Upscale', False), ('video', 'Magnific Video Upscale', False)]:
                    with self.subTest(role=role, owner=owner, kind=kind, draft=draft, model=model):
                        row = Generation.objects.create(kind=kind, status='succeeded', model=model, draft_mode=draft,
                            prompt='fixture', aspect_ratio='1:1', created_at=1, updated_at=1, user_id=owner)
                        response = self.client.delete('/api/history?id=' + str(row.id))
                        self.assertEqual(response.status_code, 200 if role == 'admin' else 403)
                        self.assertEqual(Generation.objects.filter(pk=row.id).exists(), role != 'admin')
                        if role != 'admin':
                            self.assertEqual(response.json()['error'], 'Only admins can delete generations.')

    def test_folder_delete_and_single_and_bulk_move_role_matrix_is_atomic(self):
        from uuid import uuid4
        from apps.library.models import Folder, GenerationNaming, OrganizationIdempotencyKey
        self.cookie()
        target = folders.create_folder(name='Target')
        for role in ('user', 'admin'):
            User.objects.filter(pk=UID).update(role=role)
            empty = folders.create_folder(name='Empty ' + role)
            response = self.client.delete('/api/folders?id=' + empty['id'])
            self.assertEqual(response.status_code, 200 if role == 'admin' else 403)
            self.assertEqual(Folder.objects.filter(pk=empty['id']).exists(), role != 'admin')
            for owner in (UID, uuid4()):
                for bulk in (False, True):
                    with self.subTest(role=role, owner=owner, bulk=bulk):
                        rows = [self.generation(user_id=owner), self.generation(user_id=UID)]
                        before = list(Generation.objects.filter(pk__in=[r.id for r in rows]).order_by('id').values())
                        naming_before = list(GenerationNaming.objects.filter(generation_id__in=[r.id for r in rows]).order_by('generation_id').values())
                        if bulk:
                            response = self.client.post('/api/history/move', {'ids': [str(r.id) for r in rows],
                                'destination': {'type': 'folder', 'folderId': target['id']},
                                'idempotencyKey': str(uuid4())}, content_type='application/json')
                        else:
                            response = self.client.patch('/api/history', {'id': str(rows[0].id),
                                'folderId': target['id']}, content_type='application/json')
                        self.assertEqual(response.status_code, 200 if role == 'admin' else 403)
                        if role != 'admin':
                            self.assertEqual(before, list(Generation.objects.filter(pk__in=[r.id for r in rows]).order_by('id').values()))
                            self.assertEqual(naming_before, list(GenerationNaming.objects.filter(generation_id__in=[r.id for r in rows]).order_by('generation_id').values()))
        # A non-admin cannot bypass the guard with an invalid or cached operation.
        User.objects.filter(pk=UID).update(role='user')
        self.assertEqual(self.client.post('/api/history/move', {}, content_type='application/json').status_code, 403)
        self.assertEqual(self.client.delete('/api/folders?id=' + str(uuid4())).status_code, 403)

    def test_first_filing_freezes_full_ancestry_and_future_zip_leaf(self):
        from types import SimpleNamespace
        from apps.exports.zip_paths import resolve_archive_paths
        from apps.projects.models import Project
        from apps.library.models import GenerationNaming, NamingCounter
        from apps.media.storage import MemoryAdapter, StorageService
        from django.test import override_settings
        storage = StorageService(MemoryAdapter())
        storage.upload_buffer(b'native-master-fixture', 'generated/master.mov', 'mov')
        self.cookie()
        override = override_settings(VEEVEE_MEDIA_STORAGE=storage)
        override.enable()
        self.addCleanup(override.disable)
        root = folders.create_folder(name='Scene')
        child = folders.create_folder(name='Take', parent_id=root['id'])
        row = self.generation()
        Generation.objects.filter(pk=row.id).update(url='/api/media/generated/master.mov')
        assign_generation_naming(row.id)
        self.assertIsNone(Generation.objects.get(pk=row.id).permanent_name)
        self.assertEqual(self.filename(row), 'unsorted_0001.mov')
        folders.move_generations(ids=[str(row.id)], destination={'type': 'folder', 'folderId': child['id']})
        frozen = self.filename(row)
        self.assertEqual(frozen, 'Scene_Take_0001.mov')
        original_naming = GenerationNaming.objects.filter(generation_id=row.id).values().get()
        def assert_stable():
            response = self.client.get(f'/api/generations/{row.id}/download')
            self.assertEqual(response.status_code, 200)
            self.assertIn(frozen, response['Content-Disposition'])
            self.assertEqual(response['Content-Type'], 'video/quicktime')
            self.assertEqual(b''.join(response.streaming_content), b'native-master-fixture')
            self.assertEqual(self.filename(row), frozen)
            path = resolve_archive_paths([SimpleNamespace(generation_id=row.id)])[str(row.id)]
            self.assertEqual(path.rsplit('/', 1)[-1], frozen)
            self.assertEqual(GenerationNaming.objects.filter(generation_id=row.id).values().get(), original_naming)
        folders.rename_folder(folder_id=root['id'], name='New Scene')
        assert_stable()
        project = Project.objects.create(name='Film', created_at=1, updated_at=1)
        folders.move_folder(folder_id=root['id'], destination={'type': 'project_root', 'projectId': str(project.id)})
        assert_stable()
        for destination in ({'type': 'project_unsorted', 'projectId': str(project.id)},
                {'type': 'global_unsorted'}, {'type': 'folder', 'folderId': root['id']}):
            folders.move_generations(ids=[str(row.id)], destination=destination)
            assert_stable()
        self.assertEqual(NamingCounter.objects.get(namespace='folder:' + child['id']).next_sequence, 2)

    def test_favorite_and_flag_remain_available_to_non_admins(self):
        self.cookie()
        row = self.generation()
        for field in ('isFavorite', 'flagged'):
            self.assertEqual(self.client.patch('/api/history', {'id': str(row.id), field: True}, content_type='application/json').status_code, 200)

    def test_permanent_name_cannot_be_cleared_or_replaced_by_stale_writes(self):
        from django.db import IntegrityError, transaction
        folder = folders.create_folder(name='Locked')
        row = self.generation(folder_id=folder['id'])
        assign_generation_naming(row.id, row.folder_id)
        before = self.filename(row)
        for replacement in (None, 'wrong'):
            with self.assertRaises(IntegrityError), transaction.atomic():
                Generation.objects.filter(pk=row.id).update(permanent_name=replacement)
            self.assertEqual(self.filename(row), before)

    def test_legacy_project_folder_delete_obeys_same_admin_boundary(self):
        from apps.library.models import Folder
        self.cookie()
        for role in ('user', 'admin'):
            User.objects.filter(pk=UID).update(role=role)
            folder = self.client.post('/api/folders', {'name': 'Legacy ' + role}, content_type='application/json').json()['folder']
            response = self.client.post('/api/projects', {'op': 'deleteFolder', 'folderId': folder['id']}, content_type='application/json')
            self.assertEqual(response.status_code, 200 if role == 'admin' else 403)
            self.assertEqual(Folder.objects.filter(pk=folder['id']).exists(), role != 'admin')

    def test_folder_delete_service_requires_verified_admin_even_for_internal_calls(self):
        from apps.library.models import Folder
        from apps.library.services.idempotency import OrganizationError
        folder = folders.create_folder(name='Service guard')
        for actor in (None, UID):
            with self.assertRaises(OrganizationError) as error:
                folders.delete_folder(folder_id=folder['id'], actor_id=actor)
            self.assertEqual(error.exception.status, 403)
            self.assertTrue(Folder.objects.filter(pk=folder['id']).exists())
        User.objects.filter(pk=UID).update(role='admin')
        folders.delete_folder(folder_id=folder['id'], actor_id=UID)
        self.assertFalse(Folder.objects.filter(pk=folder['id']).exists())

    def test_other_non_admin_cannot_delete_another_users_folder_through_either_route(self):
        from uuid import uuid4
        from apps.authentication.session import sign_session
        from apps.library.models import Folder
        other = User.objects.create(id=uuid4(), email='other-delete@example.test', name='Other', role='user',
            password_hash='fixture', password_salt='fixture', created_at=1)
        for legacy in (False, True):
            self.cookie()
            folder = self.client.post('/api/folders', {'name': 'Other actor ' + str(legacy)}, content_type='application/json').json()['folder']
            self.client.cookies['veevee_session'] = sign_session(other)
            response = (self.client.post('/api/projects', {'op': 'deleteFolder', 'folderId': folder['id']}, content_type='application/json')
                if legacy else self.client.delete('/api/folders?id=' + folder['id']))
            self.assertEqual(response.status_code, 403)
            self.assertTrue(Folder.objects.filter(pk=folder['id']).exists())
