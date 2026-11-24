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

    def _other_user(self, **extra):
        from apps.authentication.models import User
        return User.objects.create(id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email='owner@example.invalid', name='Owner',
            role='user', password_hash='x', password_salt='x', created_at=1, is_active=True, auth_version=0, **extra)

    def test_project_roles_gate_rename_brief_delete_and_folders(self):
        from .models import ProjectMember
        self.cookie()
        other = self._other_user()
        me = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
        project = Project.objects.create(name='P', created_by=str(other.id), created_at=1, updated_at=1)
        ProjectMember.objects.create(project=project, user_id=str(other.id), role='owner', created_at=1, updated_at=1)
        ProjectMember.objects.create(project=project, user_id=me, role='viewer', created_at=1, updated_at=1)
        pid = str(project.id)
        for payload in ({'op': 'renameProject', 'name': 'X'}, {'op': 'setBrief', 'brief': 'b'}, {'op': 'deleteProject'},
                {'op': 'createFolder', 'name': 'F'}):
            response = self.post({**payload, 'projectId': pid})
            self.assertEqual((response.status_code, response.json()['code']), (403, 'FORBIDDEN'), payload)
        self.assertEqual(Project.objects.get(pk=project.pk).name, 'P')
        # An editor may manage folders but not rename the project; a co-owner and an owner may do both.
        ProjectMember.objects.filter(project=project, user_id=me).update(role='editor')
        folder = self.post({'op': 'createFolder', 'projectId': pid, 'name': 'F'}).json()['folder']
        self.assertEqual(self.post({'op': 'renameProject', 'projectId': pid, 'name': 'X'}).status_code, 403)
        self.assertEqual(self.post({'op': 'renameFolder', 'projectId': pid, 'folderId': folder['id'], 'name': 'G'}).status_code, 200)
        ProjectMember.objects.filter(project=project, user_id=me).update(role='viewer')
        self.assertEqual(self.post({'op': 'renameFolder', 'folderId': folder['id'], 'name': 'H'}).status_code, 403)
        ProjectMember.objects.filter(project=project, user_id=me).update(role='owner')
        self.assertEqual(self.post({'op': 'renameProject', 'projectId': pid, 'name': 'X'}).status_code, 200)
        self.assertEqual(self.post({'op': 'setBrief', 'projectId': pid, 'brief': 'b'}).status_code, 200)

    def test_hidden_project_still_answers_404_before_role_errors(self):
        self.cookie()
        other = self._other_user()
        project = Project.objects.create(name='H', created_by=str(other.id), access='admin', created_at=1, updated_at=1)
        response = self.post({'op': 'renameProject', 'projectId': str(project.id), 'name': 'X'})
        self.assertEqual((response.status_code, response.json()['code']), (404, 'PROJECT_NOT_FOUND'))

    def test_non_admin_cannot_create_admin_projects_and_keeps_its_users_project(self):
        self.cookie()
        response = self.post({'op': 'createProject', 'name': 'A', 'access': 'admin'})
        self.assertEqual((response.status_code, response.json()['code']), (403, 'INVALID_ACCESS'))
        other = self._other_user()
        made = self.post({'op': 'createProject', 'name': 'U', 'access': 'users', 'accessUserIds': [str(other.id)]})
        self.assertEqual(made.status_code, 200)
        listed = [row for row in self.client.get('/api/projects').json()['projects'] if row['name'] == 'U']
        self.assertEqual(len(listed), 1)
        self.assertIn('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', listed[0]['accessUserIds'])
