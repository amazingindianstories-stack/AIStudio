from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from apps.admin_dashboard import tests as session_fixtures


class HistoryCountTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    folder = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    global_folder = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        from apps.projects.models import Project
        from apps.library.models import Folder
        from .models import Generation
        Project.objects.create(id=self.project, name='Fixture project', created_at=1, updated_at=1)
        Folder.objects.create(id=self.folder, project_id=self.project, name='Project folder', created_at=1)
        Folder.objects.create(id=self.global_folder, name='Global folder', created_at=1)
        # Both scopes use real parents; a global row cannot live in a project folder.
        # Full migrated generation defaults and naming/scope triggers remain active.
        for i, (kind, prompt, project, folder, favorite) in enumerate([
            ('image','100%_fixture\\ref',self.project,self.folder,True),
            ('video','100XXfixtureXref',self.project,None,False),
            ('depth','Depth fixture',None,None,True),
            ('audio','Audio fixture',None,None,True),
            ('image','Global fixture',None,self.global_folder,False),
        ]):
            Generation.objects.create(
                id=f'aaaaaaaa-aaaa-4aaa-8aaa-{i:012d}', kind=kind, prompt=prompt,
                project_id=project, folder_id=folder, is_favorite=favorite,
                status='succeeded', model='fixture', aspect_ratio='1:1', created_at=i+1, updated_at=i+1,
            )

    def test_auth_and_scope_counts_ignore_folder_favorite(self):
        self.assertEqual(self.client.get('/api/history/counts').status_code,401)
        self.cookie(age=2*86400000)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/history/counts',{'projectId':self.project,'folderId':'none','favorite':'1'})
        self.assertEqual(response.json(),{'project':{'total':2,'unsorted':1,'byFolder':{self.folder:1}},'globalLibrary':{'total':2,'unsorted':1,'byFolder':{self.global_folder:1}},'allAssets':4,'favorites':2})
        self.assertIn('veevee_session',response.cookies)
        counts = [row['sql'] for row in queries if 'FROM "generations"' in row['sql']]
        self.assertEqual(len(counts),4)
        self.assertTrue(all('COUNT(' in query for query in counts))
        self.assertFalse(any('provider_responses' in query for query in counts))

    def test_audio_and_unrecognized_depth_kind(self):
        self.cookie()
        audio = self.client.get('/api/history/counts',{'kind':'audio','projectId':'none'}).json()
        self.assertEqual((audio['project']['total'],audio['globalLibrary']['total'],audio['allAssets'],audio['favorites']),(0,1,1,1))
        self.assertEqual(self.client.get('/api/history/counts',{'kind':'depth'}).json()['allAssets'],4)

    def test_literal_search_and_first_repeated_query(self):
        self.cookie()
        result = self.client.get('/api/history/counts',{'q':'\ufeff100%_fixture\\ref\ufeff','projectId':self.project}).json()
        self.assertEqual((result['allAssets'],result['favorites'],result['project']['total']),(1,1,1))
        result = self.client.get('/api/history/counts?projectId=&projectId='+self.project+'&kind=audio&kind=image').json()
        self.assertEqual((result['project']['total'],result['allAssets']),(0,1))
