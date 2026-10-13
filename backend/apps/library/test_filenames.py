"""Download filenames follow the folder name's case and stay portable."""
from django.test import SimpleTestCase
from .filenames import resolve_generation_filename, slugify_token


class FolderCaseTests(SimpleTestCase):
    def test_case_is_preserved(self):
        self.assertEqual(slugify_token('SC08 Sati Final'), 'SC08_Sati_Final')
        self.assertEqual(slugify_token('characters'), 'characters')
        self.assertEqual(slugify_token('R01_SC008'), 'R01_SC008')
        self.assertEqual(slugify_token('r01'), 'r01')  # follows the name; no forced upper-case

    def test_edge_whitespace_and_invisible_characters_are_trimmed(self):
        for raw in ('  Daksha  ', 'Daksha ', '﻿Daksha​', 'Daksha\t\n', ' Daksha . '):
            self.assertEqual(slugify_token(raw), 'Daksha', repr(raw))
        self.assertEqual(slugify_token('Sati   Young Look'), 'Sati_Young_Look')

    def test_unsafe_and_accented_characters_become_portable(self):
        self.assertEqual(slugify_token('Café/Scène: 1?'), 'Cafe_Scene_1')
        self.assertEqual(slugify_token('a<b>c|d*e"f\\g'), 'a_b_c_d_e_f_g')
        self.assertEqual(slugify_token('...'), 'folder')
        self.assertEqual(slugify_token('   '), 'folder')
        self.assertEqual(slugify_token(None), 'folder')
        self.assertEqual(slugify_token('सती'), 'folder')  # non-Latin names keep the safe fallback
        self.assertLessEqual(len(slugify_token('A' * 500)), 120)

    def test_full_download_names(self):
        ancestry = [{'name': ' R01_SC008 '}, {'name': 'Characters'}]
        self.assertEqual(resolve_generation_filename(ancestry, 'folder:x', 450, 'image', '/a.png'), 'R01_SC008_Characters_0450.png')
        self.assertEqual(resolve_generation_filename([{'name': 'Shot 2'}], 'folder:x', 43, 'video', '/v.mov'), 'Shot_2_0043.mov')
        self.assertEqual(resolve_generation_filename(None, 'project_unsorted:p', 7, 'image', '/a.png'), 'unsorted_0007.png')
        self.assertEqual(resolve_generation_filename([{'name': 'con'}], 'folder:x', 1, 'image', '/a.png'), '_con_0001.png')


class ZipFolderComponentTests(SimpleTestCase):
    def test_directory_names_keep_case_and_trim_invisible_edges(self):
        from apps.exports.zip_paths import component, safe_zip_member_path
        self.assertEqual(component('  Scene 01\u00a0 ', 'Folder'), 'Scene 01')
        self.assertEqual(component('\ufeffSati\u200b  Young', 'Folder'), 'Sati Young')
        self.assertEqual(component('A/B:C', 'Folder'), 'A_B_C')
        self.assertEqual(component(' . ', 'Folder'), 'Folder')
        safe_zip_member_path('Projects/' + component(' Veevee\u00a0', 'Project') + '/Characters_0001.png')
