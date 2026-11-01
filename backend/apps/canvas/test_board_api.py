"""The board REST API (`/api/v1/boards`): bearer tokens, scopes, board roles, item CRUD, credits and the change feed."""
import json
from uuid import uuid4

from django.test import TransactionTestCase, override_settings

from apps.authentication.models import User
from apps.mcp_auth import controls, policy, tokens
from apps.mcp_auth.models import McpRateWindow
from apps.mcp_auth.principal import authenticate_bearer
from apps.projects.models import Project
from .models import BoardMember, CanvasBoard
from .serialization import empty_state

SITE = 'https://veevee.test'
PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
BOARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
READ, WRITE = 'veevee.boards.read', 'veevee.boards.write'
STICKY = {'type': 'sticky', 'x': 10, 'y': 20, 'w': 120, 'h': 120, 'text': 'hello'}


def make_user(name, role='user'):
    user = User.objects.create(id=uuid4(), email=f'{name}@example.invalid', name=name, role=role, password_hash='x',
                               password_salt='', created_at=1, is_active=True, auth_version=0)
    policy.set_enabled(user.id, True, 1)
    return user


@override_settings(ROOT_URLCONF='config.urls', PUBLIC_APP_URL=SITE, VEEVEE_BROWSER_ORIGINS=(SITE,))
class BoardApiTests(TransactionTestCase):
    def setUp(self):
        self.owner, self.viewer = make_user('owner'), make_user('viewer')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.owner.id, data=empty_state(),
                                   team_role='view', created_at=1, updated_at=2)
        BoardMember.objects.create(board_id=BOARD, user_id=self.viewer.id, role='view', created_at=1, updated_at=1)

    def token(self, user=None, scopes=(READ, WRITE)):
        raw, _ = tokens.issue(user or self.owner, 'pat', scopes=scopes, daily_cap_cents=1000, auto_approve_cents=25,
                              expires_at=10 ** 13, name='Test token')
        return raw

    def call(self, method, path, raw=None, data=None):
        extra = {'HTTP_AUTHORIZATION': f'Bearer {raw}'} if raw else {}
        if method == 'get':
            return self.client.get(path, **extra)
        return getattr(self.client, method)(path, data=json.dumps(data if data is not None else {}),
                                            content_type='application/json', **extra)

    def create(self, raw, item=None, kind='items'):
        response = self.call('post', f'/api/v1/boards/{BOARD}/{kind}', raw, {'item': item or STICKY})
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()['items'][0]

    def test_authentication_and_scopes(self):
        self.assertEqual(self.call('get', '/api/v1/boards').status_code, 401)
        self.assertEqual(self.call('get', '/api/v1/boards', 'vv_pat_wrong').status_code, 401)
        only_read = self.token(scopes=(READ,))
        self.assertEqual(self.call('get', '/api/v1/boards', only_read).status_code, 200)
        denied = self.call('post', f'/api/v1/boards/{BOARD}/items', only_read, {'item': STICKY})
        self.assertEqual((denied.status_code, denied.json()['error']), (403, 'insufficient_scope'))
        self.assertIn('veevee.boards.write', denied['WWW-Authenticate'])
        library_only = self.token(scopes=('veevee.read',))
        self.assertEqual(self.call('get', '/api/v1/boards', library_only).status_code, 403)
        policy.set_enabled(self.owner.id, False, 2)
        off = self.call('get', '/api/v1/boards', only_read)
        self.assertEqual((off.status_code, off.json()['error']), (403, 'MCP_DISABLED'))

    def test_a_session_cookie_is_not_accepted(self):
        from apps.authentication.session import sign_session
        self.client.cookies['veevee_session'] = sign_session(self.owner)
        self.assertEqual(self.call('get', '/api/v1/boards').status_code, 401)

    def test_list_and_read_a_board(self):
        raw = self.token()
        listed = self.call('get', '/api/v1/boards', raw).json()['boards']
        self.assertEqual([(board['id'], board['role']) for board in listed], [(BOARD, 'owner')])
        self.create(raw)
        board = self.call('get', f'/api/v1/boards/{BOARD}', raw).json()
        self.assertEqual((board['itemCount'], board['connectorCount'], board['role']), (1, 0, 'owner'))
        self.assertNotIn('data', board)
        self.assertEqual(self.call('get', f'/api/v1/boards/{uuid4()}', raw).status_code, 404)
        self.assertEqual(self.call('get', '/api/v1/boards/not-a-uuid', raw).status_code, 404)

    def test_item_create_read_update_delete(self):
        raw = self.token()
        item = self.create(raw)
        self.assertEqual((item['type'], item['text']), ('sticky', 'hello'))
        path = f"/api/v1/boards/{BOARD}/items/{item['id']}"
        self.assertEqual(self.call('get', path, raw).json()['item']['x'], 10)
        changed = self.call('patch', path, raw, {'fields': {'x': 300, 'text': 'moved'}}).json()
        self.assertEqual((changed['item']['x'], changed['item']['text']), (300, 'moved'))
        self.assertEqual(self.call('patch', path, raw, {'fields': {'type': 'text'}}).status_code, 400)
        self.assertEqual(self.call('patch', path, raw, {'fields': {'w': 'wide'}}).status_code, 400)
        self.assertEqual(self.call('delete', path, raw).status_code, 200)
        self.assertEqual(self.call('get', path, raw).status_code, 404)
        self.assertEqual(self.call('delete', path, raw).status_code, 404)

    def test_the_save_goes_through_the_editors_path(self):
        raw = self.token()
        item = self.create(raw)
        stored = CanvasBoard.objects.get(pk=BOARD)
        self.assertEqual(stored.version, 2)
        saved = next(node for node in stored.data['nodes'] if node['id'] == item['id'])
        self.assertEqual(saved['createdBy'], str(self.owner.id))

    def test_bulk_create_validation_and_caps(self):
        raw = self.token()
        many = [{**STICKY, 'x': index} for index in range(5)]
        made = self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'items': many})
        self.assertEqual((made.status_code, len(made.json()['items'])), (201, 5))
        over = self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'items': [STICKY] * (policy.BOARD_BULK_MAX + 1)})
        self.assertEqual(over.status_code, 400)
        self.assertEqual(self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'items': [STICKY, {'type': 'nope'}]}).status_code, 400)
        self.assertEqual(len(CanvasBoard.objects.get(pk=BOARD).data['nodes']), 5)
        self.assertEqual(self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {}).status_code, 400)
        duplicate = self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'items': [{**STICKY, 'id': 'same'}, {**STICKY, 'id': 'same'}]})
        self.assertEqual(duplicate.status_code, 409)

    def test_pages_and_type_filter(self):
        raw = self.token()
        self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'items': [{**STICKY, 'x': index} for index in range(3)] +
                  [{'type': 'rect', 'x': 0, 'y': 0, 'w': 5, 'h': 5}]})
        first = self.call('get', f'/api/v1/boards/{BOARD}/items?limit=3', raw).json()
        self.assertEqual((len(first['items']), first['total'], first['nextCursor']), (3, 4, '3'))
        second = self.call('get', f'/api/v1/boards/{BOARD}/items?limit=3&cursor=3', raw).json()
        self.assertEqual((len(second['items']), second['nextCursor']), (1, None))
        stickies = self.call('get', f'/api/v1/boards/{BOARD}/items?type=sticky', raw).json()
        self.assertEqual(stickies['total'], 3)
        self.assertEqual(self.call('get', f'/api/v1/boards/{BOARD}/items?limit=x', raw).status_code, 400)

    def test_connectors_and_their_cleanup(self):
        raw = self.token()
        first, second = self.create(raw), self.create(raw, {**STICKY, 'x': 400})
        line = self.create(raw, {'from': {'nodeId': first['id']}, 'to': {'nodeId': second['id']}}, 'connectors')
        self.assertEqual(self.call('get', f'/api/v1/boards/{BOARD}', raw).json()['connectorCount'], 1)
        missing = self.call('post', f'/api/v1/boards/{BOARD}/connectors', raw,
                            {'item': {'from': {'nodeId': 'ghost'}, 'to': {'nodeId': second['id']}}})
        self.assertEqual(missing.status_code, 400)
        self.assertEqual(self.call('get', f"/api/v1/boards/{BOARD}/connectors/{line['id']}", raw).status_code, 200)
        self.call('delete', f"/api/v1/boards/{BOARD}/items/{first['id']}", raw)
        self.assertEqual(self.call('get', f"/api/v1/boards/{BOARD}/connectors/{line['id']}", raw).status_code, 404)

    def test_board_roles_decide_whatever_the_scopes(self):
        owner_raw, viewer_raw = self.token(), self.token(self.viewer)
        item = self.create(owner_raw)
        path = f"/api/v1/boards/{BOARD}/items/{item['id']}"
        self.assertEqual(self.call('get', path, viewer_raw).status_code, 200)
        for method, data in (('post', {'item': STICKY}), ('patch', {'fields': {'x': 1}}), ('delete', None)):
            target = f'/api/v1/boards/{BOARD}/items' if method == 'post' else path
            refused = self.call(method, target, viewer_raw, data)
            self.assertEqual((refused.status_code, refused.json().get('error')), (403, 'FORBIDDEN'), (method, refused.content))
        stranger = self.token(make_user('stranger'))
        self.assertEqual(self.call('get', f'/api/v1/boards/{BOARD}', stranger).status_code, 200)  # team access is view
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='none')
        self.assertEqual(self.call('get', f'/api/v1/boards/{BOARD}', stranger).status_code, 404)
        self.assertEqual(self.call('get', '/api/v1/boards', stranger).json()['boards'], [])

    def test_credits_are_weighted_and_reported(self):
        raw = self.token()
        read = self.call('get', f'/api/v1/boards/{BOARD}', raw)
        limit = policy.BOARD_CREDITS[0]
        self.assertEqual((read['X-RateLimit-Limit'], read['X-RateLimit-Remaining']), (str(limit), str(limit - policy.BOARD_COSTS['read'])))
        self.assertTrue(1 <= int(read['X-RateLimit-Reset']) <= policy.BOARD_CREDITS[1])
        write = self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'item': STICKY})
        self.assertEqual(int(write['X-RateLimit-Remaining']), limit - policy.BOARD_COSTS['read'] - policy.BOARD_COSTS['write'])
        bulk = self.call('post', f'/api/v1/boards/{BOARD}/items', raw, {'items': [STICKY, STICKY]})
        self.assertEqual(int(write['X-RateLimit-Remaining']) - int(bulk['X-RateLimit-Remaining']), policy.BOARD_COSTS['bulk'])

    def test_an_exhausted_budget_refuses_with_retry_after_until_the_window_ends(self):
        raw = self.token()
        principal = authenticate_bearer(raw)
        limit, window = policy.BOARD_CREDITS
        controls.hit(f'board:{principal.token_id}', limit, window, weight=limit)
        refused = self.call('get', f'/api/v1/boards/{BOARD}', raw)
        self.assertEqual((refused.status_code, refused.json()['error']), (429, 'RATE_LIMITED'))
        self.assertTrue(int(refused['Retry-After']) >= 1)
        self.assertEqual(refused['X-RateLimit-Remaining'], '0')
        McpRateWindow.objects.all().delete()
        self.assertEqual(self.call('get', f'/api/v1/boards/{BOARD}', raw).status_code, 200)

    def test_change_feed_replaces_webhooks(self):
        raw = self.token()
        before = self.call('get', f'/api/v1/boards/{BOARD}', raw).json()['version']
        item = self.create(raw)
        feed = self.call('get', f'/api/v1/boards/{BOARD}/changes?since={before}', raw).json()
        self.assertEqual([node['id'] for node in feed['changes']['nodes']['upsert']], [item['id']])
        self.call('delete', f"/api/v1/boards/{BOARD}/items/{item['id']}", raw)
        later = self.call('get', f'/api/v1/boards/{BOARD}/changes?since={before + 1}', raw).json()
        self.assertEqual(later['changes']['nodes']['delete'], [item['id']])
        self.assertEqual(self.call('get', f'/api/v1/boards/{BOARD}/changes?since=x', raw).status_code, 400)

    def test_a_locked_item_stays_put_for_an_editor_who_did_not_lock_it(self):
        raw = self.token()
        item = self.create(raw, {**STICKY, 'locked': True, 'lockedBy': str(self.owner.id), 'lockProtected': True})
        editor = make_user('editor')
        BoardMember.objects.create(board_id=BOARD, user_id=editor.id, role='edit', created_at=1, updated_at=1)
        moved = self.call('patch', f"/api/v1/boards/{BOARD}/items/{item['id']}", self.token(editor), {'fields': {'x': 999}})
        self.assertEqual(moved.status_code, 200)
        self.assertEqual(moved.json()['item']['x'], 10)
