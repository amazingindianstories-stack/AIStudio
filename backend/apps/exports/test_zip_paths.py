import unicodedata
import uuid
from django.test import SimpleTestCase, TransactionTestCase
from apps.generation.models import Generation
from apps.projects.models import Project
from apps.library.models import Folder
from .models import MediaExportItem
from . import services
from .zip_paths import safe_zip_member_path, component


class SafeZIPPathTests(SimpleTestCase):
    def test_traversal_reserved_absolute_and_nonportable_paths(self):
        for path in ('', '/', '/a.png', '../x', 'a/../x', 'a//x', 'a/./x', 'C:/x', 'a\\x',
                     'a/CON.png', 'a/COM¹.mov', 'a/CON .txt', 'a/NUL', 'a/LPT1.mov', 'a/foo.', 'a/foo ', 'a/\x00b',
                     'a/\nfoo', 'a/\u202efoo', 'a/CAFE\u0301.png', 'a/x:y', 'a/x?y',
                     'a/' + 'é' * 128, '/'.join(['a'] * 37)):
            with self.subTest(path=path), self.assertRaises(ValueError):
                safe_zip_member_path(path)

    def test_unicode_byte_bounds_and_sanitization(self):
        for raw in ('', '.', '..', 'CON.mov', ' bad/\\:*?<>|name. ', 'é' * 1000, 'दृश्य', 'Cafe\u0301'):
            token = component(raw, 'Folder')
            self.assertLessEqual(len(token.encode()), 180)
            self.assertEqual(unicodedata.normalize('NFC', token), token)
            self.assertEqual(safe_zip_member_path('Global/' + token + '/native.mov'), 'Global/' + token + '/native.mov')


class ZIPHierarchyTests(TransactionTestCase):
    def setUp(self):
        self.actor = uuid.uuid4()

    def project(self, name):
        return Project.objects.create(name=name, created_at=1, updated_at=1)

    def folder(self, name, project=None, parent=None):
        return Folder.objects.create(name=name, name_normalized=str(uuid.uuid4()), project=project, parent=parent, created_at=1)

    def generation(self, project=None, folder=None):
        return Generation.objects.create(kind='video', status='completed', model='fixture', prompt='', aspect_ratio='1:1',
            url='/api/media/native.mov', project=project, folder=folder, created_at=1, updated_at=1)

    def paths(self, rows):
        job = services.create_export(self.actor)
        services.append_items(job['id'], self.actor, [str(g.id) for g in rows])
        finalized = services.finalize_export(job['id'], self.actor)
        return finalized, list(MediaExportItem.objects.filter(export=finalized).order_by('position').values_list('filename', flat=True))

    def test_real_scope_ancestry_and_project_unsorted_coexist(self):
        a, b = self.project('A'), self.project('B')
        scene = self.folder('Scene_01', a)
        shot = self.folder('Shot_02', a, scene)
        global_folder = self.folder('Folder_X')
        _, paths = self.paths([self.generation(a), self.generation(b), self.generation(a, shot), self.generation(folder=global_folder), self.generation()])
        self.assertEqual(paths, ['Projects/A/Unsorted/unsorted_0001.mov', 'Projects/B/Unsorted/unsorted_0001.mov',
            'Projects/A/Scene_01/Shot_02/Scene_01_Shot_02_0001.mov', 'Global/Folder_X/Folder_X_0001.mov', 'Global/Unsorted/unsorted_0001.mov'])

    def test_project_folder_casefold_sanitize_and_virtual_unsorted_collision(self):
        a, b = self.project('Café'), self.project('CAFE\u0301')
        f1, f2 = self.folder('bad/name', a), self.folder('bad\\name', a)
        unsorted = self.folder('Unsorted', a)
        _, paths = self.paths([self.generation(a, f1), self.generation(a, f2), self.generation(b), self.generation(a), self.generation(a, unsorted)])
        self.assertEqual(len({p.casefold() for p in paths}), 5)
        self.assertTrue(all(safe_zip_member_path(p) for p in paths))
        self.assertTrue(paths[0].startswith('Projects/Café_'))
        self.assertTrue(paths[1].split('/')[2].startswith('bad_name_'))
        self.assertIn('/Unsorted_', paths[-1])

    def test_circular_and_missing_source_metadata_fail_atomically(self):
        first = self.folder('First')
        second = self.folder('Second', parent=first)
        Folder.objects.filter(id=first.id).update(parent=second)
        g = self.generation(folder=first)
        job = services.create_export(self.actor)
        services.append_items(job['id'], self.actor, [str(g.id)])
        original = MediaExportItem.objects.get(export_id=job['id']).filename
        with self.assertRaisesMessage(services.ExportError, 'EXPORT_MANIFEST_INVALID'):
            services.finalize_export(job['id'], self.actor)
        self.assertEqual(MediaExportItem.objects.get(export_id=job['id']).filename, original)
        g.delete()
        with self.assertRaisesMessage(services.ExportError, 'EXPORT_MANIFEST_INVALID'):
            services.finalize_export(job['id'], self.actor)

    def test_names_and_source_keys_frozen_at_finalize_survive_project_move(self):
        project = self.project('Original Project')
        folder = self.folder('Original Folder', project)
        g = self.generation(project, folder)
        job, paths = self.paths([g])
        Project.objects.filter(id=project.id).update(name='Changed')
        Folder.objects.filter(id=folder.id).update(name='Changed')
        Generation.objects.filter(id=g.id).update(url='/api/media/other.mp4', folder=None, project=None)
        from .models import MediaExport
        MediaExport.objects.filter(id=job.id).update(status='failed')
        services.finalize_export(job.id, self.actor)
        item = MediaExportItem.objects.get(export=job)
        self.assertEqual(item.filename, paths[0])
        self.assertEqual(item.source_key, 'native.mov')

    def test_duplicate_permanent_leaves_disambiguate_directories_even_when_folder_uses_generation_id(self):
        from django.db import connection
        from apps.generation.models import GenerationNameOwner
        root = self.folder('Root')
        first, second = self.generation(folder=root), self.generation(folder=root)
        child = self.folder(str(first.id), parent=root)
        third = self.generation(folder=child)
        # Historical duplicates exist only as generation.0004/0005 backfilled them.
        with connection.cursor() as cursor:
            cursor.execute('SET session_replication_role = replica')
            try:
                for copy, row in enumerate((first, second, third)):
                    GenerationNameOwner.objects.create(id=row.id, permanent_name='Frozen_0001', legacy_name_duplicate=copy)
                    Generation.objects.filter(pk=row.id).update(permanent_name='Frozen_0001', legacy_name_duplicate=copy, name_owner_id=row.id)
            finally:
                cursor.execute('SET session_replication_role = DEFAULT')
        _, paths = self.paths([first, second, third])
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual(paths[0], f'Global/Root/{first.id}_1/Frozen_0001.mov')
        self.assertTrue(all(path.rsplit('/', 1)[-1] == 'Frozen_0001.mov' for path in paths))
        self.assertEqual(self.paths([first, second, third])[1], paths)

    def test_one_draft_lineage_shares_its_directory_with_ordered_final_and_draft_leaves(self):
        from apps.library.services.naming import assign_generation_naming
        project = self.project('P')
        shot = self.folder('Shot', project, self.folder('Reel', project))
        draft = self.generation(project, shot)
        Generation.objects.filter(pk=draft.id).update(model='Seedance 2.5', draft_mode=True, task_id='draft')
        assign_generation_naming(draft.id, shot.id, project.id)
        finals = []
        for created in (3, 2):
            row = Generation.objects.create(kind='video', status='completed', model='Seedance 2.5', prompt='', aspect_ratio='1:1',
                url='/api/media/native.mov', project=project, folder=shot, created_at=created, updated_at=created,
                draft_mode=False, source_generation_id=draft.id, draft_task_id='draft')
            assign_generation_naming(row.id, shot.id, project.id)
            finals.append(row)
        later, earlier = finals
        base = 'Projects/P/Reel/Shot/Reel_Shot_0001'
        _, paths = self.paths([draft, later, earlier])
        self.assertEqual(paths, [f'{base}_draft.mov', f'{base}_2.mov', f'{base}.mov'])
        self.assertEqual(self.paths([draft, later, earlier])[1], paths)
        self.assertEqual(self.paths([later, earlier])[1], [f'{base}_2.mov', f'{base}.mov'])
        self.assertEqual(self.paths([draft, earlier])[1], [f'{base}_draft.mov', f'{base}.mov'])
        self.assertEqual(self.paths([draft])[1], [f'{base}.mov'])
