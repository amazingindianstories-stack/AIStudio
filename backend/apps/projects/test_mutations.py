from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests
from apps.library.services.folder_engine import create_folder
from apps.generation.models import Generation
from .models import Project


class ProjectMutationTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = SettingsTests.setUp

    def post(self, payload):
        return self.client.post('/api/projects', payload, content_type='application/json')

    def test_project_create_rename_brief_delete_and_default(self):
        self.assertEqual(self.post({'op': 'createProject', 'name': 'Denied'}).status_code, 401)
        self.cookie()
        self.assertEqual(self.post({'op': 'createProject', 'name': '  '}).status_code, 400)
        made = self.post({'op': 'createProject', 'name': '  Title  '}).json()
        project = made['project']
        self.assertEqual(project['name'], 'Title')
        self.assertEqual(project['folders'], [])
        self.assertNotIn('brief', project)
        renamed = self.post({'op': 'renameProject', 'projectId': project['id'], 'name': 'Renamed'}).json()
        self.assertEqual(renamed['projects'][0]['name'], 'Renamed')
        brief = self.post({'op': 'setBrief', 'projectId': project['id'], 'brief': 'A brief'}).json()
        self.assertEqual(brief['projects'][0]['brief'], 'A brief')
        self.assertEqual(self.post({'op': 'deleteProject', 'projectId': project['id']}).json(), {'projects': []})
        self.assertEqual(self.client.get('/api/projects').json()['projects'][0]['name'], 'My Project')

    def test_legacy_folder_operations_and_not_empty(self):
        self.cookie()
        project = Project.objects.create(name='P', created_at=1, updated_at=1)
        folder = self.post({'op': 'createFolder', 'projectId': str(project.id), 'name': 'F'}).json()['folder']
        self.assertEqual(set(folder), {'id', 'name', 'createdAt'})
        response = self.post({'op': 'deleteProject', 'projectId': str(project.id)})
        self.assertEqual((response.status_code, response.json()['code']), (400, 'PROJECT_NOT_EMPTY'))
        renamed = self.post({'op': 'renameFolder', 'projectId': str(project.id), 'folderId': folder['id'], 'name': 'New'}).json()
        self.assertEqual(renamed['projects'][0]['folders'][0]['name'], 'New')
        self.assertEqual(self.post({'op': 'deleteFolder', 'projectId': str(project.id), 'folderId': folder['id']}).status_code, 403)
        from apps.authentication.models import User
        User.objects.filter(pk='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').update(role='admin')
        self.assertEqual(self.post({'op': 'deleteFolder', 'projectId': str(project.id), 'folderId': folder['id']}).json()['projects'][0]['folders'], [])
        Generation.objects.create(kind='image', status='done', prompt='', model='fixture', aspect_ratio='1:1', project=project, created_at=1, updated_at=1)
        response = self.post({'op': 'deleteProject', 'projectId': str(project.id)})
        self.assertEqual((response.status_code, response.json()['code']), (400, 'PROJECT_NOT_EMPTY'))
        self.assertIn('generations', response.json()['error'])

    def test_unknown_malformed_missing_and_empty_rename(self):
        self.cookie()
        self.assertEqual(self.post({'op': 'unknown'}).json(), {'error': 'Unknown op.'})
        self.assertEqual(self.client.post('/api/projects', '{', content_type='application/json').status_code, 400)
        self.assertEqual(self.post({'op': 'deleteProject', 'projectId': 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'}).status_code, 404)
        project = Project.objects.create(name='P', created_at=1, updated_at=1)
        # Project rename intentionally permits empty names in the existing contract.
        self.assertEqual(self.post({'op': 'renameProject', 'projectId': str(project.id), 'name': ''}).json()['projects'][0]['name'], '')
