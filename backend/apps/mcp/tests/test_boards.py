"""Board tools over both protocol eras: list, get, read items, add, change and delete, roles, scopes and credits."""
from uuid import uuid4

from apps.canvas.models import BoardMember, CanvasBoard
from apps.canvas.serialization import empty_state
from apps.mcp import errors
from apps.mcp.registry import REGISTRY
from apps.mcp_auth import policy
from apps.mcp_auth.models import McpRateWindow
from apps.projects.models import Project
from .support import ERAS, McpCase

READ, WRITE = 'veevee.boards.read', 'veevee.boards.write'
BOARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
STICKY = {'type': 'sticky', 'x': 10, 'y': 20, 'w': 120, 'h': 120, 'text': 'hello'}
TOOLS = ('list_boards', 'get_board', 'list_board_items', 'add_board_items', 'update_board_item', 'delete_board_item')


class BoardToolTests(McpCase):
    def setUp(self):
        super().setUp()
        self.viewer = self.make_user('viewer@example.invalid', 'Viewer', 'user')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.user.id, data=empty_state(),
                                   team_role='view', created_at=1, updated_at=2)
        BoardMember.objects.create(board_id=BOARD, user_id=self.viewer.id, role='view', created_at=1, updated_at=1)
        self.raw = self.token(scopes=(READ, WRITE))
        self.viewer_raw = self.token(self.viewer, scopes=(READ, WRITE))

    def schema(self, name):
        return REGISTRY[name].output_schema

    def test_tools_need_their_scope(self):
        for mode in ERAS:
            self.assertEqual(sorted(name for name in self.tool_names(self.token(scopes=(READ,)), mode) if name in TOOLS),
                             ['get_board', 'list_board_items', 'list_boards'])
            self.assertEqual(sorted(name for name in self.tool_names(self.raw, mode) if name in TOOLS), sorted(TOOLS))
            self.assertFalse([name for name in self.tool_names(self.token(), mode) if name in TOOLS])
        denied = self.call(self.token(scopes=(READ,)), 'add_board_items', {'boardId': BOARD, 'items': [STICKY]})
        self.assertIn(WRITE, self.assert_tool_error(denied, errors.INSUFFICIENT_SCOPE)['message'])

    def test_read_add_change_and_delete_over_both_eras(self):
        for mode in ERAS:
            listed = self.call(self.raw, 'list_boards', {}, mode)
            self.assert_structured(listed, self.schema('list_boards'))
            self.assertEqual([b['id'] for b in listed.structured_content['boards']], [BOARD])
            got = self.call(self.raw, 'get_board', {'boardId': BOARD.upper()}, mode)
            self.assert_structured(got, self.schema('get_board'))
            added = self.call(self.raw, 'add_board_items', {'boardId': BOARD, 'items': [STICKY, {**STICKY, 'text': 'two'}]}, mode)
            self.assert_structured(added, self.schema('add_board_items'))
            first, second = added.structured_content['items']
            self.assertEqual((first['type'], first['text']), ('sticky', 'hello'))
            items = self.call(self.raw, 'list_board_items', {'boardId': BOARD, 'type': 'sticky'}, mode)
            self.assert_structured(items, self.schema('list_board_items'))
            self.assertIn(first['id'], [item['id'] for item in items.structured_content['items']])
            changed = self.call(self.raw, 'update_board_item', {'boardId': BOARD, 'itemId': first['id'], 'fields': {'text': 'edited'}}, mode)
            self.assert_structured(changed, self.schema('update_board_item'))
            self.assertEqual(changed.structured_content['item']['text'], 'edited')
            removed = self.call(self.raw, 'delete_board_item', {'boardId': BOARD, 'itemId': first['id']}, mode)
            self.assert_structured(removed, self.schema('delete_board_item'))
            gone = self.call(self.raw, 'delete_board_item', {'boardId': BOARD, 'itemId': first['id']}, mode)
            self.assert_tool_error(gone, errors.NOT_FOUND)
            self.call(self.raw, 'delete_board_item', {'boardId': BOARD, 'itemId': second['id']}, mode)

    def test_a_viewer_reads_but_cannot_write(self):
        self.assert_structured(self.call(self.viewer_raw, 'list_board_items', {'boardId': BOARD}), self.schema('list_board_items'))
        refused = self.call(self.viewer_raw, 'add_board_items', {'boardId': BOARD, 'items': [STICKY]})
        self.assert_tool_error(refused, errors.FORBIDDEN)
        self.assertEqual(self.call(self.raw, 'list_board_items', {'boardId': BOARD}).structured_content['total'], 0)

    def test_unknown_board_and_bad_items_are_tool_errors(self):
        missing = self.call(self.raw, 'get_board', {'boardId': str(uuid4())})
        self.assertIn('list_boards', self.assert_tool_error(missing, errors.NOT_FOUND)['message'])
        bad = self.call(self.raw, 'add_board_items', {'boardId': BOARD, 'items': [{'type': 'sticky'}]})
        self.assertTrue(bad.is_error)

    def test_calls_spend_board_credits(self):
        self.call(self.raw, 'add_board_items', {'boardId': BOARD, 'items': [STICKY, STICKY]})
        self.call(self.raw, 'get_board', {'boardId': BOARD})
        spent = sum(w.count for w in McpRateWindow.objects.filter(bucket__startswith='board:'))
        self.assertEqual(spent, policy.BOARD_COSTS['bulk'] + policy.BOARD_COSTS['read'])

    def test_exhausted_credits_refuse_the_call(self):
        original = policy.BOARD_CREDITS
        policy.BOARD_CREDITS = (policy.BOARD_COSTS['write'], 60)
        self.addCleanup(setattr, policy, 'BOARD_CREDITS', original)
        self.assert_structured(self.call(self.raw, 'add_board_items', {'boardId': BOARD, 'items': [STICKY]}), self.schema('add_board_items'))
        self.assertTrue(self.call(self.raw, 'add_board_items', {'boardId': BOARD, 'items': [STICKY]}).is_error)
