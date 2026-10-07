from django.db import connection
from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests

PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

class AssetReadTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    def setUp(self):
        SettingsTests.setUp(self)
        with connection.cursor() as c:
            c.execute('CREATE TABLE IF NOT EXISTS assets (id uuid PRIMARY KEY,kind text,name text,slug text,description text,images jsonb,project_id uuid,created_at bigint,updated_at bigint)')
            c.execute('TRUNCATE assets')
            c.execute("INSERT INTO assets VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','character','Global','global',NULL,'[]',NULL,1,1),('cccccccc-cccc-4ccc-8ccc-cccccccccccc','character','Project','project','Description','[\"/media/fixture.png\"]',%s,2,2)",[PROJECT])

    def test_auth_scope_order_and_omitted_nulls(self):
        self.assertEqual(self.client.get('/api/assets').status_code,401)
        self.cookie()
        result = self.client.get('/api/assets').json()['assets']
        self.assertEqual([row['name'] for row in result],['Project','Global'])
        self.assertNotIn('description',result[1])
        self.assertNotIn('projectId',result[1])
        self.assertEqual(result[0]['description'],'Description')
        scoped=self.client.get('/api/assets',{'projectId':PROJECT}).json()['assets']
        self.assertEqual([row['name'] for row in scoped],['Project'])
        self.assertEqual(len(self.client.get('/api/assets?projectId=&projectId='+PROJECT).json()['assets']),2)
