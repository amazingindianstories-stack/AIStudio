"""Board and project roles: every board route checked per effective role."""
import json
from unittest.mock import patch
from uuid import uuid4
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase, override_settings
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.projects.models import Project, ProjectMember
from .models import BoardMember, CanvasBoard
from .serialization import empty_state

PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
BOARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'


def make_user(name, role='user', active=True):
    return User.objects.create(id=uuid4(), email=f'{name}@example.invalid', name=name, role=role,
                               password_hash='x', password_salt='', created_at=1, is_active=active)


@override_settings(ROOT_URLCONF='config.urls')
class BoardRoleTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.owner = make_user('owner')
        self.mate = make_user('mate')
        self.other = make_user('other')
        self.admin = make_user('admin', role='admin')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.owner.id,
                                   data={'legacy': 'unmodified'}, created_at=1, updated_at=2)

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def send(self, method, path, data=None):
        if method == 'get':
            return self.client.get(path)
        return getattr(self.client, method)(path, data=json.dumps(data if data is not None else {}), content_type='application/json')

    def grant_board(self, user, role):
        BoardMember.objects.update_or_create(board_id=BOARD, user_id=user.id,
            defaults={'role': role}, create_defaults={'role': role, 'created_at': 1, 'updated_at': 1})

    def grant_project(self, user, role):
        ProjectMember.objects.update_or_create(project_id=PROJECT, user_id=user.id,
            defaults={'role': role}, create_defaults={'role': role, 'created_at': 1, 'updated_at': 1})

    def team(self, role):
        CanvasBoard.objects.filter(pk=BOARD).update(team_role=role)

    def outcomes(self, user):
        """Status of every board route for one user, each mutation undone or harmless."""
        self.as_user(user)
        listed = self.client.get('/api/canvas-boards?projectId=' + PROJECT).json()['boards']
        read = self.client.get('/api/canvas-boards/' + BOARD)
        with patch('apps.media.images.save_canvas_asset', return_value='/api/media/canvas/fixture.png'):
            upload = self.send('post', f'/api/canvas-boards/{BOARD}/upload', {'dataUrl': 'data:image/png;base64,AA=='}).status_code
        save = self.send('put', '/api/canvas-boards/' + BOARD, {'data': {}, 'saveId': str(uuid4()),
                         'baseVersion': CanvasBoard.objects.get(pk=BOARD).version}).status_code
        rename = self.send('post', '/api/canvas-boards', {'op': 'renameBoard', 'id': BOARD, 'name': 'Board'}).status_code
        share = self.send('post', f'/api/canvas-boards/{BOARD}/access', {'op': 'setMember', 'userId': str(self.other.id), 'role': 'view'}).status_code
        settings = self.send('post', f'/api/canvas-boards/{BOARD}/access', {'op': 'setTeamRole', 'role': CanvasBoard.objects.get(pk=BOARD).team_role}).status_code
        BoardMember.objects.filter(board_id=BOARD, user_id=self.other.id).delete()
        return {'list': listed[0]['role'] if listed else None, 'read': read.status_code,
                'role': read.json().get('role'), 'upload': upload, 'save': save, 'rename': rename,
                'share': share, 'settings': settings}

    def test_migration_default_keeps_every_teammate_editing(self):
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).team_role, 'edit')
        self.assertEqual(self.outcomes(self.mate), {'list': 'edit', 'read': 200, 'role': 'edit', 'upload': 200,
            'save': 200, 'rename': 403, 'share': 403, 'settings': 403})

    def test_board_roles_on_every_route(self):
        self.team('view')
        expected = {
            'view': {'list': 'view', 'read': 200, 'role': 'view', 'upload': 403, 'save': 403, 'rename': 403, 'share': 403, 'settings': 403},
            'comment': {'list': 'comment', 'read': 200, 'role': 'comment', 'upload': 403, 'save': 403, 'rename': 403, 'share': 403, 'settings': 403},
            'edit': {'list': 'edit', 'read': 200, 'role': 'edit', 'upload': 200, 'save': 200, 'rename': 403, 'share': 403, 'settings': 403},
        }
        for role, outcome in expected.items():
            with self.subTest(role=role):
                self.grant_board(self.mate, role)
                self.assertEqual(self.outcomes(self.mate), outcome)
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).data, empty_state())

    def test_team_access_levels_apply_without_membership(self):
        for role in ('view', 'comment', 'edit'):
            with self.subTest(role=role):
                self.team(role)
                outcome = self.outcomes(self.mate)
                self.assertEqual((outcome['list'], outcome['role']), (role, role))
                self.assertEqual(outcome['save'], 200 if role == 'edit' else 403)

    def test_project_roles_and_higher_role_wins(self):
        self.team('view')
        expected = {
            'viewer': {'list': 'view', 'read': 200, 'role': 'view', 'upload': 403, 'save': 403, 'rename': 403, 'share': 403, 'settings': 403},
            'commenter': {'list': 'comment', 'read': 200, 'role': 'comment', 'upload': 403, 'save': 403, 'rename': 403, 'share': 403, 'settings': 403},
            'editor': {'list': 'edit', 'read': 200, 'role': 'edit', 'upload': 200, 'save': 200, 'rename': 403, 'share': 403, 'settings': 403},
            'co_owner': {'list': 'co_owner', 'read': 200, 'role': 'co_owner', 'upload': 200, 'save': 200, 'rename': 200, 'share': 200, 'settings': 403},
            'owner': {'list': 'owner', 'read': 200, 'role': 'owner', 'upload': 200, 'save': 200, 'rename': 200, 'share': 200, 'settings': 200},
        }
        for role, outcome in expected.items():
            with self.subTest(role=role):
                self.grant_project(self.mate, role)
                self.assertEqual(self.outcomes(self.mate), outcome)
        # The higher of project and board role wins, in both directions.
        self.grant_project(self.mate, 'viewer')
        self.grant_board(self.mate, 'edit')
        self.assertEqual(self.outcomes(self.mate)['save'], 200)
        self.grant_project(self.mate, 'editor')
        self.grant_board(self.mate, 'view')
        self.assertEqual(self.outcomes(self.mate)['save'], 200)
        # A project role in another project grants nothing here.
        ProjectMember.objects.filter(user_id=self.mate.id).delete()
        other = Project.objects.create(name='Elsewhere', created_at=1, updated_at=1)
        ProjectMember.objects.create(project=other, user_id=self.mate.id, role='owner', created_at=1, updated_at=1)
        self.assertEqual(self.outcomes(self.mate)['save'], 403)

    def test_owner_and_admin_keep_full_rights_whatever_the_team_access(self):
        self.team('view')
        full = {'read': 200, 'role': 'owner', 'upload': 200, 'save': 200, 'rename': 200, 'share': 200, 'settings': 200, 'list': 'owner'}
        self.assertEqual(self.outcomes(self.owner), full)
        self.assertEqual(self.outcomes(self.admin), full)

    def test_delete_is_owner_only(self):
        self.grant_project(self.mate, 'co_owner')
        self.as_user(self.mate)
        response = self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': BOARD})
        self.assertEqual((response.status_code, response.json()), (403, {'error': 'FORBIDDEN'}))
        self.grant_board(self.other, 'edit')
        self.as_user(self.other)
        self.assertEqual(self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': BOARD}).status_code, 403)
        self.as_user(self.owner)
        self.assertEqual(self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': BOARD}).json(), {'boards': [], 'canCreate': False})
        self.assertFalse(BoardMember.objects.exists())
        board = CanvasBoard.objects.create(project_id=PROJECT, name='Second', created_by=self.owner.id, data={}, created_at=1, updated_at=1)
        self.grant_project(self.mate, 'owner')
        self.as_user(self.mate)
        self.assertEqual(self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': str(board.id)}).json(), {'boards': [], 'canCreate': True})

    def test_share_dialog_members_and_validation(self):
        self.as_user(self.owner)
        path = f'/api/canvas-boards/{BOARD}/access'
        described = self.client.get(path).json()
        self.assertEqual(described, {'boardId': BOARD, 'projectId': PROJECT, 'ownerId': str(self.owner.id), 'teamRole': 'edit',
            'role': 'owner', 'members': [], 'projectMembers': [], 'canShare': True, 'canOwn': True,
            'canManageProject': False, 'projectRole': None})
        added = self.send('post', path, {'op': 'setMember', 'userId': str(self.mate.id), 'role': 'comment'}).json()
        self.assertEqual(added['members'], [{'userId': str(self.mate.id), 'role': 'comment'}])
        changed = self.send('post', path, {'op': 'setMember', 'userId': str(self.mate.id), 'role': 'view'}).json()
        self.assertEqual(changed['members'], [{'userId': str(self.mate.id), 'role': 'view'}])
        for payload, status, error in [
                ({'op': 'setMember', 'userId': str(self.mate.id), 'role': 'owner'}, 400, 'Invalid role.'),
                ({'op': 'setMember', 'userId': str(self.owner.id), 'role': 'view'}, 400, 'The board owner already has full access.'),
                ({'op': 'setMember', 'userId': str(uuid4()), 'role': 'view'}, 404, 'User not found.'),
                ({'op': 'setMember', 'userId': 'not-a-uuid', 'role': 'view'}, 404, 'User not found.'),
                ({'op': 'setMember', 'role': 'view'}, 400, 'userId required.'),
                ({'op': 'setMember', 'userId': str(make_user('gone', active=False).id), 'role': 'view'}, 404, 'User not found.'),
                ({'op': 'setTeamRole', 'role': 'none'}, 400, 'Invalid role.'),
                ({'op': 'nope'}, 400, 'Unknown op.')]:
            with self.subTest(payload=payload):
                response = self.send('post', path, payload)
                self.assertEqual((response.status_code, response.json()), (status, {'error': error}))
        self.assertEqual(self.send('post', path, {'op': 'setTeamRole', 'role': 'comment'}).json()['teamRole'], 'comment')
        removed = self.send('post', path, {'op': 'removeMember', 'userId': str(self.mate.id)}).json()
        self.assertEqual(removed['members'], [])
        # Members see who has access but cannot change it.
        self.as_user(self.mate)
        view = self.client.get(path).json()
        self.assertEqual((view['role'], view['canShare'], view['canOwn']), ('comment', False, False))
        self.assertEqual(self.send('post', path, {'op': 'removeMember', 'userId': str(self.owner.id)}).status_code, 403)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{uuid4()}/access').status_code, 404)
        self.assertEqual(self.client.get('/api/canvas-boards/not-a-uuid/access').status_code, 500)

    def test_access_changes_leave_the_graph_version_alone(self):
        self.as_user(self.owner)
        path = f'/api/canvas-boards/{BOARD}/access'
        self.send('post', path, {'op': 'setTeamRole', 'role': 'view'})
        self.send('post', path, {'op': 'setMember', 'userId': str(self.mate.id), 'role': 'edit'})
        self.send('post', path, {'op': 'transferOwner', 'userId': str(self.mate.id)})
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).updated_at, 2)

    def test_transfer_ownership(self):
        path = f'/api/canvas-boards/{BOARD}/access'
        self.grant_project(self.mate, 'co_owner')
        self.as_user(self.mate)
        self.assertEqual(self.send('post', path, {'op': 'transferOwner', 'userId': str(self.mate.id)}).status_code, 403)
        ProjectMember.objects.all().delete()
        self.grant_board(self.mate, 'view')
        self.as_user(self.owner)
        result = self.send('post', path, {'op': 'transferOwner', 'userId': str(self.mate.id)}).json()
        self.assertEqual((result['ownerId'], result['role'], result['canOwn']), (str(self.mate.id), 'edit', False))
        self.assertEqual(result['members'], [{'userId': str(self.owner.id), 'role': 'edit'}])
        self.as_user(self.mate)
        self.assertEqual(self.client.get('/api/canvas-boards/' + BOARD).json()['createdBy'], str(self.mate.id))
        self.assertEqual(self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': BOARD}).status_code, 200)

    def test_admin_assigns_an_owner_to_a_legacy_board(self):
        CanvasBoard.objects.filter(pk=BOARD).update(created_by=None)
        self.as_user(self.admin)
        result = self.send('post', f'/api/canvas-boards/{BOARD}/access', {'op': 'transferOwner', 'userId': str(self.mate.id)}).json()
        self.assertEqual((result['ownerId'], result['members']), (str(self.mate.id), []))

    def test_project_members_route(self):
        path = f'/api/projects/{PROJECT}/members'
        self.as_user(self.mate)
        self.assertEqual(self.client.get(path).json(), {'projectId': PROJECT, 'role': None, 'canManage': False, 'members': []})
        response = self.send('post', path, {'op': 'setMember', 'userId': str(self.mate.id), 'role': 'owner'})
        self.assertEqual((response.status_code, response.json()), (403, {'error': 'FORBIDDEN'}))
        self.as_user(self.admin)
        self.assertEqual(self.send('post', path, {'op': 'setMember', 'userId': str(self.owner.id), 'role': 'owner'}).status_code, 200)
        self.as_user(self.owner)
        self.send('post', path, {'op': 'setMember', 'userId': str(self.mate.id), 'role': 'co_owner'})
        self.as_user(self.mate)
        # Co-owners manage members below owner, never the owner role itself.
        self.assertEqual(self.send('post', path, {'op': 'setMember', 'userId': str(self.other.id), 'role': 'editor'}).status_code, 200)
        self.assertEqual(self.send('post', path, {'op': 'setMember', 'userId': str(self.other.id), 'role': 'owner'}).status_code, 403)
        self.assertEqual(self.send('post', path, {'op': 'removeMember', 'userId': str(self.owner.id)}).status_code, 403)
        listed = self.send('post', path, {'op': 'removeMember', 'userId': str(self.other.id)}).json()
        self.assertEqual(listed['members'], [{'userId': str(self.owner.id), 'role': 'owner'}, {'userId': str(self.mate.id), 'role': 'co_owner'}])
        self.assertEqual(self.send('post', path, {'op': 'setMember', 'userId': str(self.other.id), 'role': 'admin'}).json(), {'error': 'Invalid role.'})
        self.assertEqual(self.send('post', path, {'op': 'x'}).json(), {'error': 'Unknown op.'})
        self.assertEqual(self.client.get(f'/api/projects/{uuid4()}/members').status_code, 404)
        self.assertEqual(self.client.get('/api/projects/not-a-uuid/members').status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(path).status_code, 401)

    def test_new_project_creator_owns_it(self):
        self.as_user(self.mate)
        created = self.send('post', '/api/projects', {'op': 'createProject', 'name': 'Mine'}).json()['project']
        self.assertEqual(list(ProjectMember.objects.filter(project_id=created['id']).values_list('user_id', 'role')), [(self.mate.id, 'owner')])
        board = CanvasBoard.objects.create(project_id=created['id'], name='Theirs', created_by=self.other.id, data={}, created_at=1, updated_at=1, team_role='view')
        self.assertEqual(self.client.get(f'/api/canvas-boards/{board.id}').json()['role'], 'owner')

    def test_board_creation_follows_project_roles(self):
        def create(user):
            self.as_user(user)
            return self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': PROJECT, 'name': 'New'})

        def can_create(user):
            self.as_user(user)
            return self.client.get('/api/canvas-boards?projectId=' + PROJECT).json()['canCreate']

        # A project without explicit members, or with only its creator's owner row, stays team-wide.
        Project.objects.filter(pk=PROJECT).update(created_by=self.owner.id)
        for creator_row in (False, True):
            if creator_row:
                self.grant_project(self.owner, 'owner')
            for user in (self.mate, self.other, self.admin):
                with self.subTest(creator_row=creator_row, user=user.name):
                    self.assertTrue(can_create(user))
                    self.assertEqual(create(user).status_code, 200)
        # Any other member restricts creation to project editors and above.
        self.grant_project(self.other, 'viewer')
        before = CanvasBoard.objects.count()
        for role in ('commenter', 'viewer', None):
            with self.subTest(role=role):
                ProjectMember.objects.filter(user_id=self.mate.id).delete()
                if role:
                    self.grant_project(self.mate, role)
                self.assertFalse(can_create(self.mate))
                response = create(self.mate)
                self.assertEqual((response.status_code, response.json()), (403, {'error': 'FORBIDDEN'}))
        self.assertEqual(CanvasBoard.objects.count(), before)
        # Board membership and team access do not grant creation in a restricted project.
        ProjectMember.objects.filter(user_id=self.mate.id).delete()
        self.grant_board(self.mate, 'edit')
        self.assertEqual(create(self.mate).status_code, 403)
        for role in ('owner', 'co_owner', 'editor'):
            with self.subTest(role=role):
                self.grant_project(self.mate, role)
                self.assertTrue(can_create(self.mate))
                response = create(self.mate)
                self.assertEqual((response.status_code, response.json()['board']['role'], response.json()['canCreate']), (200, 'owner', True))
        self.assertTrue(can_create(self.admin))
        self.assertEqual(create(self.admin).status_code, 200)

    def test_teammates_create_boards_in_a_fresh_project_until_it_gets_members(self):
        self.as_user(self.owner)
        project = self.send('post', '/api/projects', {'op': 'createProject', 'name': 'Fresh'}).json()['project']['id']
        self.as_user(self.mate)
        created = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': project, 'name': 'Mine'})
        self.assertEqual(created.status_code, 200)
        self.as_user(self.owner)
        self.send('post', f'/api/projects/{project}/members', {'op': 'setMember', 'userId': str(self.other.id), 'role': 'viewer'})
        for user, status in ((self.other, 403), (self.mate, 403), (self.owner, 200)):
            with self.subTest(user=user.name):
                self.as_user(user)
                response = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': project, 'name': 'Next'})
                self.assertEqual(response.status_code, status)
        # The board the teammate created earlier stays theirs.
        self.as_user(self.mate)
        listed = self.client.get('/api/canvas-boards?projectId=' + project).json()
        self.assertEqual(([board['role'] for board in listed['boards'] if board['name'] == 'Mine'], listed['canCreate']), (['owner'], False))

    def test_deleting_a_user_removes_their_memberships(self):
        self.grant_board(self.mate, 'edit')
        self.grant_project(self.mate, 'editor')
        self.mate.delete()
        self.assertFalse(BoardMember.objects.exists())
        self.assertFalse(ProjectMember.objects.exists())

    def test_role_checks_run_before_body_validation_and_writes(self):
        self.team('view')
        self.as_user(self.mate)
        for data in [None, [], {}, {'padding': 'x' * 10}]:
            response = self.send('put', '/api/canvas-boards/' + BOARD, {'data': data})
            self.assertEqual((response.status_code, response.json()), (403, {'error': 'FORBIDDEN'}))
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).data, {'legacy': 'unmodified'})
        with patch('apps.media.images.save_canvas_asset') as save:
            self.assertEqual(self.send('post', f'/api/canvas-boards/{BOARD}/upload', {'dataUrl': 'data:image/png;base64,AA=='}).status_code, 403)
            save.assert_not_called()


class BoardRoleMigrationTests(TransactionTestCase):
    def test_upgrade_gives_existing_boards_team_edit_and_no_members(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] not in ('canvas', 'projects')] + [
            ('canvas', '0001_railway_v2_canvasboard'), ('projects', '0001_railway_v2_project')]
        identifier = uuid4()
        try:
            executor.migrate(previous)
            old = executor.loader.project_state(previous).apps.get_model('canvas', 'CanvasBoard')
            old.objects.create(id=identifier, project_id=uuid4(), name='Legacy', data={'nodes': []}, created_by=None, created_at=1, updated_at=2)
            executor = MigrationExecutor(connection)
            plan = executor.migration_plan(final)
            self.assertEqual(sorted((m.app_label, m.name) for m, backward in plan),
                             [('canvas', '0002_board_roles'), ('canvas', '0003_canvasboard_version'),
                              ('canvas', '0004_canvasboardsave'), ('canvas', '0005_boardactivity'), ('canvas', '0006_boardaijob'),
                              ('canvas', '0007_canvasboardsave_changes'),
                              ('projects', '0002_project_members')])
            executor.migrate(final)
            row = CanvasBoard.objects.get(pk=identifier)
            self.assertEqual((row.team_role, row.name, row.data, row.updated_at), ('edit', 'Legacy', {'nodes': []}, 2))
            self.assertFalse(BoardMember.objects.exists())
            self.assertFalse(ProjectMember.objects.exists())
            with connection.cursor() as cursor:
                cursor.execute("SELECT column_default FROM information_schema.columns WHERE table_name='canvas_boards' AND column_name='team_role'")
                self.assertEqual(cursor.fetchone()[0], "'edit'::text")
            self.assertFalse(MigrationExecutor(connection).migration_plan(final))
        finally:
            MigrationExecutor(connection).migrate(final)
