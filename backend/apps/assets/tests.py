from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests

PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

class AssetReadTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    def setUp(self):
        SettingsTests.setUp(self)
        from .models import Asset
        Asset.objects.create(id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind='character',
                             name='Global', slug='global', images=[], created_at=1, updated_at=1)
        Asset.objects.create(id='cccccccc-cccc-4ccc-8ccc-cccccccccccc', kind='character',
                             name='Project', slug='project', description='Description',
                             images=['/media/fixture.png'], project_id=PROJECT, created_at=2, updated_at=2)

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
