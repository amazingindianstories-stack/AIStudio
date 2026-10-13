from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests

ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

class FolderReadTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    def setUp(self):
        SettingsTests.setUp(self)
        from apps.projects.models import Project
        from .models import Folder
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=2)
        Folder.objects.create(id=ROOT, name='Root', version=1, color='blue', created_at=1, updated_at=2)
        Folder.objects.create(id=CHILD, parent_id=ROOT, name='Child', version=2, created_at=3, updated_at=4)

    def test_scope_and_ancestry(self):
        self.assertEqual(self.client.get('/api/folders').status_code,401)
        self.cookie()
        roots=self.client.get('/api/folders').json()['folders']
        self.assertEqual([f['id'] for f in roots],[ROOT])
        self.assertEqual(roots[0]['nameNormalized'],'root')
        children=self.client.get('/api/folders',{'parentId':ROOT,'projectId':PROJECT}).json()['folders']
        self.assertEqual([f['id'] for f in children],[CHILD])
        breadcrumbs=self.client.get('/api/folders',{'ancestry':CHILD}).json()['breadcrumbs']
        self.assertEqual([f['id'] for f in breadcrumbs],[ROOT,CHILD])
        self.assertEqual(breadcrumbs[0]['color'],'blue')

    def test_tree_priority_and_shape(self):
        self.cookie()
        response=self.client.get('/api/folders',{'tree':'true','ancestry':CHILD}).json()
        self.assertEqual(response['globalFolders'][0]['children'][0]['id'],CHILD)
        self.assertNotIn('nameNormalized',response['globalFolders'][0])
        self.assertEqual(response['projects'][0]['folders'],[])
        self.assertIsNone(response['projects'][0]['brief'])
