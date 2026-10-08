from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from apps.admin_dashboard import tests as session_fixtures


class HistoryCountTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    folder = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        # Narrow disposable count fixture; no generation jobs/workers execute.
        with connection.cursor() as cursor:
            cursor.execute('CREATE TABLE IF NOT EXISTS generations (id uuid PRIMARY KEY,kind text NOT NULL,prompt text NOT NULL,project_id uuid,folder_id uuid,is_favorite boolean NOT NULL)')
            cursor.execute('TRUNCATE generations')
            for i, (kind, prompt, project, folder, favorite) in enumerate([
                ('image','100%_fixture\\ref',self.project,self.folder,True),
                ('video','100XXfixtureXref',self.project,None,False),
                ('depth','Depth fixture',None,None,True),
                ('audio','Audio fixture',None,None,True),
                ('image','Global fixture',None,self.folder,False),
            ]):
                cursor.execute('INSERT INTO generations VALUES (%s,%s,%s,%s,%s,%s)',[f'aaaaaaaa-aaaa-4aaa-8aaa-{i:012d}',kind,prompt,project,folder,favorite])

    def test_auth_and_scope_counts_ignore_folder_favorite(self):
        self.assertEqual(self.client.get('/api/history/counts').status_code,401)
        self.cookie(age=2*86400000)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/history/counts',{'projectId':self.project,'folderId':'none','favorite':'1'})
        self.assertEqual(response.json(),{'project':{'total':2,'unsorted':1,'byFolder':{self.folder:1}},'globalLibrary':{'total':2,'unsorted':1,'byFolder':{self.folder:1}},'allAssets':4,'favorites':2})
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
