from django.db import connection
from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests

ROOT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
CHILD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

class FolderReadTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    def setUp(self):
        SettingsTests.setUp(self)
        with connection.cursor() as c:
            c.execute('CREATE TABLE IF NOT EXISTS projects (id uuid PRIMARY KEY,name text,brief text,created_by uuid,created_at bigint,updated_at bigint)')
            c.execute('CREATE TABLE IF NOT EXISTS folders (id uuid PRIMARY KEY,project_id uuid,parent_id uuid,name text,name_normalized text,version integer,color text,created_at bigint,updated_at bigint)')
            c.execute('TRUNCATE folders,projects')
            c.execute("INSERT INTO projects VALUES (%s,'Project',NULL,NULL,1,2)",[PROJECT])
            c.execute("INSERT INTO folders VALUES (%s,NULL,NULL,'Root','root',1,'blue',1,2),(%s,NULL,%s,'Child','child',2,NULL,3,4)",[ROOT,CHILD,ROOT])

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
