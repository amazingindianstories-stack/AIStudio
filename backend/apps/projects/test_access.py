"""Project access: 'all' (default), 'users' (a chosen list, plus the creator) and 'admin'.

A user who may not see a project gets no trace of it in any listing, and a 404 (the same as a missing project)
from every direct fetch by id.
"""
import json
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from django.db import OperationalError
from django.test import TransactionTestCase, override_settings
from apps.agents import media as agent_media
from apps.assets.models import Asset
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.canvas.models import CanvasBoard
from apps.generation.models import Generation
from apps.generation.services import enqueue, submission
from apps.library.models import Folder
from apps.mcp import errors as mcp_errors
from apps.mcp.tools import finishing, organize
from apps.media.views import MediaHidden, authorize_media_key
from .models import Project, ProjectAccessUser, ProjectMember
from . import visibility


def make_user(name, role='user'):
    return User.objects.create(id=uuid4(), email=f'{name}@example.invalid', name=name, role=role,
                               password_hash='x', password_salt='', created_at=1, is_active=True)


@override_settings(ROOT_URLCONF='config.urls')
class ProjectAccessTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.admin = make_user('admin', 'admin')
        self.creator = make_user('creator')
        self.invited = make_user('invited')
        self.outsider = make_user('outsider')
        self.open = Project.objects.create(name='Open', created_at=1, updated_at=1)
        self.generations = {}

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def post(self, payload):
        return self.client.post('/api/projects', json.dumps(payload), content_type='application/json')

    def seed(self, project):
        """A folder, a generation, a board and an asset-free export row's worth of content inside the project."""
        folder = Folder.objects.create(project=project, name='F', name_normalized='f', created_at=1, updated_at=1)
        generation = Generation.objects.create(kind='image', status='succeeded', prompt='secret prompt', model='fixture',
            aspect_ratio='1:1', project=project, folder=folder, url='generations/x.png', created_at=1, updated_at=1)
        generation.url = f'/api/media/generations/{generation.id}.png'
        generation.save(update_fields=['url'])
        board = CanvasBoard.objects.create(project_id=project.id, name='Board', created_by=self.creator.id,
            data={}, created_at=1, updated_at=1)
        return folder, generation, board

    def make(self, access, users=()):
        self.as_user(self.creator)
        payload = {'op': 'createProject', 'name': f'P-{access}', 'access': access, 'accessUserIds': [str(u.id) for u in users]}
        response = self.post(payload)
        self.assertEqual(response.status_code, 200, response.content)
        return Project.objects.get(pk=response.json()['project']['id'])

    def listed(self, user):
        self.as_user(user)
        return {row['name'] for row in self.client.get('/api/projects').json()['projects']}

    def test_existing_and_default_projects_stay_open_to_everyone(self):
        self.assertEqual(Project.objects.get(pk=self.open.id).access, 'all')
        for user in (self.admin, self.creator, self.outsider):
            self.assertIn('Open', self.listed(user))
        made = self.make('all')
        self.assertEqual(made.access, 'all')
        self.assertIn('P-all', self.listed(self.outsider))

    def test_invalid_access_and_empty_user_picks_are_rejected(self):
        self.as_user(self.creator)
        for payload in ({'access': 'nobody'}, {'access': 'users', 'accessUserIds': []},
                        {'access': 'users', 'accessUserIds': [str(uuid4())]}, {'access': 'users', 'accessUserIds': 'x'}):
            response = self.post({'op': 'createProject', 'name': 'Bad', **payload})
            self.assertEqual((response.status_code, response.json()['code']), (400, 'INVALID_ACCESS'), payload)
        self.assertFalse(Project.objects.filter(name='Bad').exists())

    def test_admin_only_project_is_hidden_everywhere_from_non_admins(self):
        project = self.make('admin')
        folder, generation, board = self.seed(project)
        self.assertEqual(self.listed(self.admin) >= {'P-admin', 'Open'}, True)
        for user in (self.creator, self.invited, self.outsider):
            self.assert_hidden(user, project, folder, generation, board)
        self.assert_visible(self.admin, project, folder, generation, board)

    def test_particular_users_project_is_open_to_the_list_and_its_creator_only(self):
        project = self.make('users', [self.invited])
        folder, generation, board = self.seed(project)
        self.assertEqual({str(row.user_id) for row in ProjectAccessUser.objects.filter(project=project)}, {str(self.invited.id)})
        self.assert_hidden(self.outsider, project, folder, generation, board)
        for user in (self.invited, self.creator, self.admin):
            self.assert_visible(user, project, folder, generation, board)

    def test_access_can_be_changed_by_the_owner_and_not_by_others(self):
        project = self.make('all')
        self.as_user(self.outsider)
        denied = self.post({'op': 'setAccess', 'projectId': str(project.id), 'access': 'admin'})
        self.assertEqual(denied.status_code, 403)
        self.as_user(self.creator)
        changed = self.post({'op': 'setAccess', 'projectId': str(project.id), 'access': 'users', 'accessUserIds': [str(self.invited.id)]})
        self.assertEqual(changed.status_code, 200, changed.content)
        row = next(row for row in changed.json()['projects'] if row['id'] == str(project.id))
        self.assertEqual((row['access'], row['accessUserIds']), ('users', [str(self.invited.id)]))
        self.assertNotIn('P-all', self.listed(self.outsider))
        self.as_user(self.creator)
        self.post({'op': 'setAccess', 'projectId': str(project.id), 'access': 'all'})
        self.assertIn('P-all', self.listed(self.outsider))
        self.assertFalse(ProjectAccessUser.objects.filter(project=project).exists())

    def test_hidden_project_cannot_be_renamed_deleted_or_given_members_by_an_outsider(self):
        project = self.make('admin')
        ProjectMember.objects.create(project=project, user=self.outsider, role='owner', created_at=1, updated_at=1)
        self.as_user(self.outsider)
        for payload in ({'op': 'renameProject', 'name': 'X'}, {'op': 'setBrief', 'brief': 'X'}, {'op': 'deleteProject'},
                        {'op': 'setAccess', 'access': 'all'}, {'op': 'createFolder', 'name': 'F'}):
            response = self.post({**payload, 'projectId': str(project.id)})
            self.assertEqual(response.status_code, 404, payload)
        self.assertEqual(self.client.get(f'/api/projects/{project.id}/members').status_code, 404)
        self.assertEqual(Project.objects.get(pk=project.id).name, 'P-admin')

    def test_denied_direct_id_fetch_matches_a_missing_id(self):
        project = self.make('admin')
        folder, generation, board = self.seed(project)
        self.as_user(self.outsider)
        missing = self.client.get(f'/api/history?ids={uuid4()}').json()
        hidden = self.client.get(f'/api/history?ids={generation.id}').json()
        self.assertEqual(hidden['items'], [])
        self.assertEqual(len(hidden['missing']), len(missing['missing']))
        self.assertEqual(self.client.get(f'/api/canvas-boards/{board.id}').status_code, 404)

    def assert_hidden(self, user, project, folder, generation, board):
        self.assertNotIn(project.name, self.listed(user))
        self.as_user(user)
        history = self.client.get('/api/history').json()['items']
        self.assertNotIn(str(generation.id), [row['id'] for row in history])
        self.assertEqual(self.client.get(f'/api/history?ids={generation.id}').json()['items'], [])
        self.assertEqual(self.client.get(f'/api/history?projectId={project.id}').json()['items'], [])
        self.assertEqual(self.client.get('/api/history?q=secret').json()['items'], [])
        counts = self.client.get(f'/api/history/counts?projectId={project.id}').json()
        self.assertEqual((counts['project']['total'], counts['allAssets']), (0, 0))
        self.assertEqual(self.client.get(f'/api/folders?projectId={project.id}').json()['folders'], [])
        self.assertEqual(self.client.get(f'/api/folders?ancestry={folder.id}').json()['breadcrumbs'], [])
        tree = self.client.get('/api/folders?tree=1').json()
        self.assertNotIn(str(project.id), [row['id'] for row in tree['projects']])
        self.assertEqual(self.client.get(f'/api/canvas-boards/{board.id}').status_code, 404)
        self.assertEqual(self.client.get(f'/api/canvas-boards?projectId={project.id}').json()['boards'], [])
        self.assertEqual(self.client.patch('/api/history', json.dumps({'id': str(generation.id), 'isFavorite': True}),
            content_type='application/json').status_code, 404)
        self.assertEqual(self.client.post('/api/generate/image', json.dumps({'prompt': 'x', 'model': 'seedream-5-5',
            'projectId': str(project.id)}), content_type='application/json').status_code, 404)
        download = self.client.get(f'/api/generations/{generation.id}/download')
        self.assertEqual((download.status_code, download.json()['error']), (404, 'GENERATION_NOT_FOUND'))
        for key in (f'generations/{generation.id}.png', f'generations/{generation.id}/layers/a.png',
                    f'thumbs/512/generations/{generation.id}.png.webp'):
            with self.assertRaises(MediaHidden, msg=key):
                authorize_media_key(key, user)
        with self.assertRaises(mcp_errors.ToolError):
            agent_media.load(user.id, str(generation.id))
        with self.assertRaises(mcp_errors.ToolError):
            finishing.upscale_source(user, str(generation.id))

    def assert_visible(self, user, project, folder, generation, board):
        self.assertIn(project.name, self.listed(user))
        self.assertEqual([row['id'] for row in self.client.get(f'/api/history?ids={generation.id}').json()['items']], [str(generation.id)])
        self.assertEqual(len(self.client.get(f'/api/folders?projectId={project.id}').json()['folders']), 1)
        self.assertEqual(authorize_media_key(f'generations/{generation.id}/layers/a.png', user),
                         f'generations/{generation.id}/layers/a.png')
        self.assertEqual(finishing.upscale_source(user, str(generation.id))[1], generation.url)

    def call(self, user, **arguments):
        return SimpleNamespace(principal=SimpleNamespace(user=user), arguments=arguments, record={})

    def test_agent_folder_writes_refuse_a_hidden_project_or_folder(self):
        project = self.make('admin')
        folder, _, _ = self.seed(project)
        writes = ((organize.create, {'name': 'N', 'in': {'projectId': str(project.id)}}),
                  (organize.create, {'name': 'N', 'in': {'folderId': str(folder.id)}}),
                  (organize.rename, {'folderId': str(folder.id), 'name': 'N', 'expectedVersion': 1}),
                  (organize.move, {'folderId': str(folder.id), 'destination': 'global', 'expectedVersion': 1}))
        for write, arguments in writes:
            with self.assertRaises(mcp_errors.ToolError) as refused:
                write(self.call(self.outsider, **arguments))
            self.assertEqual(refused.exception.code, mcp_errors.NOT_FOUND, arguments)
        self.assertEqual(list(Folder.objects.filter(project=project).values_list('name', flat=True)), ['F'])
        made = organize.create(self.call(self.admin, name='N', **{'in': {'projectId': str(project.id)}}))
        self.assertEqual(made['folder']['name'], 'N')

    def test_finalizing_a_draft_in_a_hidden_project_is_a_404(self):
        project = self.make('admin')
        _, generation, _ = self.seed(project)
        with self.assertRaises(submission.Refused) as refused:
            submission.draft_source(self.outsider, str(generation.id))
        self.assertEqual(refused.exception.status, 404)

    def test_asset_tags_never_resolve_to_a_hidden_project_asset(self):
        project = self.make('admin')
        Asset.objects.create(kind='character', name='Hidden', slug='hidden', project_id=project.id, created_at=1, updated_at=1)
        Asset.objects.create(kind='character', name='Shared', slug='shared', project_id=self.open.id, created_at=1, updated_at=1)
        self.assertEqual({row['slug'] for row in enqueue.assets(self.outsider.id)}, {'shared'})
        self.assertEqual({row['slug'] for row in enqueue.assets(self.admin.id)}, {'hidden', 'shared'})

    def test_a_failed_visibility_check_fails_closed(self):
        with patch.object(visibility, 'hidden_project_ids', side_effect=OperationalError('connection reset')):
            for check in (visibility.can_see, visibility.can_see_folder, visibility.can_see_generation):
                with self.assertRaises(OperationalError):
                    check(self.outsider, self.open.id)
        self.assertTrue(visibility.can_see(self.outsider, 'not-a-uuid'))

    def test_visibility_helper_matches_every_mode(self):
        users = self.make('users', [self.invited])
        admin_only = self.make('admin')
        for user, expect in ((self.admin, (True, True, True)), (self.invited, (True, True, False)),
                             (self.outsider, (True, False, False)), (self.creator, (True, True, False))):
            self.assertEqual((visibility.can_see(user, self.open.id), visibility.can_see(user, users.id),
                              visibility.can_see(user, admin_only.id)), expect, user.name)
            hidden = set(visibility.hidden_project_ids(user).values_list('id', flat=True))
            self.assertEqual(hidden, {p.id for p, ok in zip((self.open, users, admin_only), expect) if not ok}, user.name)
