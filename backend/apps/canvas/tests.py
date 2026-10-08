import json
from django.db import connection
from django.test import TransactionTestCase
from django.test.utils import CaptureQueriesContext
from apps.admin_dashboard import tests as settings_fixtures


class BoardMetadataReadTests(TransactionTestCase):
    cookie = settings_fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

    def setUp(self):
        settings_fixtures.SettingsTests.setUp(self)
        with connection.cursor() as cursor:
            cursor.execute('CREATE TABLE IF NOT EXISTS canvas_boards (id uuid PRIMARY KEY, project_id uuid NOT NULL, name text NOT NULL, data jsonb NOT NULL, created_by uuid, created_at bigint NOT NULL, updated_at bigint NOT NULL)')
            cursor.execute('TRUNCATE canvas_boards')
            cursor.execute("INSERT INTO canvas_boards VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc',%s,'दृश्य','{\"private_graph\":\"fixture\"}',NULL,1,2),('dddddddd-dddd-4ddd-8ddd-dddddddddddd','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee','Other','{}',NULL,3,4)",[self.project])

    def test_auth_precedes_missing_project_and_first_query_value(self):
        self.assertEqual(self.client.get('/api/canvas-boards').status_code,401)
        self.cookie()
        for suffix in ['', '?projectId=', '?projectId=&projectId='+self.project]:
            response = self.client.get('/api/canvas-boards'+suffix)
            self.assertEqual((response.status_code,response.json()),(400,{'error':'projectId required.'}))
        self.assertEqual(self.client.get('/api/canvas-boards?projectId=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').json(),{'boards':[]})

    def test_metadata_projection_scope_and_renewal(self):
        self.cookie(age=2*86400000)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/canvas-boards?projectId='+self.project+'&projectId=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee')
        self.assertEqual(response.json(),{'boards':[{'id':'cccccccc-cccc-4ccc-8ccc-cccccccccccc','projectId':self.project,'name':'दृश्य','createdBy':None,'createdAt':1,'updatedAt':2}]})
        selects = [query['sql'] for query in queries if 'FROM "canvas_boards"' in query['sql']]
        self.assertEqual(len(selects),1)
        self.assertNotIn('"data"',selects[0])
        self.assertIn('veevee_session',response.cookies)
        with connection.cursor() as cursor:
            cursor.execute('SELECT data::text FROM canvas_boards WHERE id=%s',['cccccccc-cccc-4ccc-8ccc-cccccccccccc'])
            self.assertEqual(json.loads(cursor.fetchone()[0]),{'private_graph':'fixture'})
