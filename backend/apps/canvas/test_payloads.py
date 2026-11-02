"""Large format payloads kept outside the board JSON: the save and read paths, the payload API (roles, size
limit, conflicts), the data migration, and board creation, duplication and deletion."""
import json
from uuid import uuid4

from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase, override_settings

from apps.authentication.session import sign_session
from apps.projects.models import Project
from . import payloads, services
from .models import BoardFormatPayload, BoardMember, CanvasBoard
from .serialization import empty_state, validate_state
from .test_activity import BOARD, PROJECT, graph
from .test_roles import make_user

MIGRATION_BEFORE = ('canvas', '0017_sidekicks_flows')
MIGRATION_AFTER = ('canvas', '0018_format_payloads')


def doc(identifier='d', text='one', **fields):
    return {'id': identifier, 'type': 'format', 'format': 'doc', 'x': 0, 'y': 0, 'w': 9, 'h': 9,
            'blocks': [{'id': 'b', 'type': 'p', 'text': text}], **fields}


def html(identifier='h', source='<p>hi</p>'):
    return {'id': identifier, 'type': 'format', 'format': 'html', 'x': 0, 'y': 0, 'w': 9, 'h': 9, 'html': source}


def drawio(identifier='x', xml='<mxfile/>', preview=''):
    return {'id': identifier, 'type': 'format', 'format': 'drawio', 'x': 0, 'y': 0, 'w': 9, 'h': 9, 'xml': xml,
            **({'preview': preview} if preview else {})}


@override_settings(ROOT_URLCONF='config.urls')
class PayloadApiTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.owner, self.viewer, self.commenter, self.other = (make_user(name) for name in ('owner', 'viewer', 'commenter', 'other'))
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.owner.id,
                                   data=empty_state(), created_at=1, updated_at=1, team_role='view')
        BoardMember.objects.create(board_id=BOARD, user_id=self.viewer.id, role='view', created_at=1, updated_at=1)
        BoardMember.objects.create(board_id=BOARD, user_id=self.commenter.id, role='comment', created_at=1, updated_at=1)

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def version(self):
        return CanvasBoard.objects.get(pk=BOARD).version

    def save(self, user, method='put', base=None, query='', **payload):
        self.as_user(user)
        body = {**payload, 'baseVersion': self.version() if base is None else base, 'saveId': str(uuid4())}
        return getattr(self.client, method)(f'/api/canvas-boards/{BOARD}{query}', content_type='application/json', data=json.dumps(body))

    def stored_nodes(self):
        return {node['id']: node for node in CanvasBoard.objects.get(pk=BOARD).data['nodes']}

    def test_a_save_moves_the_payload_into_its_row_and_leaves_a_reference(self):
        self.assertEqual(self.save(self.owner, data=graph(doc(text='one'), html(), drawio(xml='<m/>', preview='data:image/svg+xml;base64,AAAA'))).status_code, 200)
        nodes = self.stored_nodes()
        for node_id, absent in (('d', 'blocks'), ('h', 'html'), ('x', 'xml')):
            self.assertNotIn(absent, nodes[node_id])
            self.assertEqual(nodes[node_id]['payload']['rev'], 1)
        self.assertNotIn('preview', nodes['x'])
        rows = {row.node_id: row for row in BoardFormatPayload.objects.filter(board_id=BOARD)}
        self.assertEqual(rows['d'].body['blocks'][0]['text'], 'one')
        self.assertEqual(rows['h'].body, {'html': '<p>hi</p>'})
        self.assertEqual(rows['x'].body, {'xml': '<m/>', 'preview': 'data:image/svg+xml;base64,AAAA'})
        self.assertEqual(nodes['d']['payload'], {'size': rows['d'].size, 'rev': 1})

    def test_payloads_beyond_the_board_json_limit_still_save(self):
        big = 'x' * 400_000
        nodes = [doc(f'd{index}', big) for index in range(3)] + [html('h', '<p>' + big + '</p>')]
        self.assertEqual(self.save(self.owner, data=graph(*nodes)).status_code, 200)
        self.assertEqual(BoardFormatPayload.objects.filter(board_id=BOARD).count(), 4)
        self.assertLess(len(json.dumps(CanvasBoard.objects.get(pk=BOARD).data)), 100_000)

    def test_the_default_read_is_inline_and_the_lazy_read_is_the_reference(self):
        self.save(self.owner, data=graph(doc(text='one')))
        self.as_user(self.owner)
        inline = self.client.get(f'/api/canvas-boards/{BOARD}').json()['data']['nodes'][0]
        self.assertEqual(inline['blocks'][0]['text'], 'one')
        self.assertNotIn('payload', inline)
        lazy = self.client.get(f'/api/canvas-boards/{BOARD}?payloads=lazy').json()['data']['nodes'][0]
        self.assertNotIn('blocks', lazy)
        self.assertEqual(lazy['payload']['rev'], 1)

    def test_the_payload_endpoint_loads_one_node_on_demand(self):
        self.save(self.owner, data=graph(doc(text='one'), html()))
        self.as_user(self.viewer)
        found = self.client.get(f'/api/canvas-boards/{BOARD}/payloads/d').json()
        self.assertEqual((found['kind'], found['rev'], found['blocks'][0]['text']), ('doc', 1, 'one'))
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/payloads/missing').status_code, 404)
        self.as_user(self.other)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/payloads/d').status_code, 200)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/payloads/d').status_code, 401)

    def test_a_payload_inside_a_hidden_frame_is_not_served_to_a_viewer(self):
        frame = {'id': 'f', 'type': 'frame', 'x': 0, 'y': 0, 'w': 50, 'h': 50, 'hidden': True}
        self.save(self.owner, data=graph(frame, {**doc(text='secret'), 'parentId': 'f'}))
        self.as_user(self.viewer)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/payloads/d').status_code, 404)
        self.as_user(self.owner)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/payloads/d').status_code, 200)

    def test_viewers_and_commenters_cannot_change_a_payload(self):
        self.save(self.owner, data=graph(doc(text='one')))
        for user in (self.viewer, self.commenter):
            self.assertEqual(self.save(user, data=graph(doc(text='hacked'))).status_code, 403)
            self.assertEqual(self.save(user, method='patch', patch={'nodes': {'upsert': [doc(text='hacked')]}}).status_code, 403)
        self.assertEqual(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').body['blocks'][0]['text'], 'one')

    def test_an_edit_bumps_the_revision_and_an_unchanged_payload_does_not(self):
        self.save(self.owner, data=graph(doc(text='one')))
        before = self.version()
        self.assertEqual(self.save(self.owner, data=graph(doc(text='one'))).status_code, 200)
        self.assertEqual(self.version(), before)
        self.assertEqual(self.save(self.owner, method='patch', patch={'nodes': {'upsert': [doc(text='two')]}}).status_code, 200)
        self.assertEqual(self.stored_nodes()['d']['payload']['rev'], 2)
        self.assertEqual(self.version(), before + 1)
        self.assertEqual(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').body['blocks'][0]['text'], 'two')

    def test_a_save_that_never_loaded_the_payload_keeps_the_stored_row(self):
        self.save(self.owner, data=graph(doc(text='one'), html()))
        lazy = self.client.get(f'/api/canvas-boards/{BOARD}?payloads=lazy').json()['data']
        moved = {**lazy['nodes'][0], 'x': 40}
        self.assertEqual(self.save(self.owner, method='patch', patch={'nodes': {'upsert': [moved]}}).status_code, 200)
        self.assertEqual(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').body['blocks'][0]['text'], 'one')
        self.assertEqual(self.stored_nodes()['d']['x'], 40)

    def test_a_stale_save_conflicts_and_writes_no_payload(self):
        self.save(self.owner, data=graph(doc(text='one')))
        stale = self.version()
        self.save(self.owner, data=graph(doc(text='mine')))
        refused = self.save(self.owner, base=stale, data=graph(doc(text='theirs')))
        self.assertEqual(refused.status_code, 409)
        self.assertEqual(refused.json()['board']['data']['nodes'][0]['blocks'][0]['text'], 'mine')
        self.assertEqual(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').body['blocks'][0]['text'], 'mine')
        lazy = self.save(self.owner, base=stale, query='?payloads=lazy', data=graph(doc(text='theirs')))
        self.assertNotIn('blocks', lazy.json()['board']['data']['nodes'][0])

    def test_a_payload_over_the_size_limit_is_refused_and_a_big_doc_saves(self):
        big = [{'id': f'b{n}', 'type': 'p', 'text': 'y' * 20000} for n in range(30)]
        self.assertEqual(self.save(self.owner, data=graph(doc(blocks=big))).status_code, 200)
        self.assertGreater(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').size, 500000)
        self.assertLess(len(json.dumps(CanvasBoard.objects.get(pk=BOARD).data)), 2000)
        huge = [{'id': f'b{n}', 'type': 'p', 'text': 'y' * 20000} for n in range(60)]
        refused = self.save(self.owner, data=graph(doc(blocks=huge)))
        self.assertEqual((refused.status_code, refused.json()['limit']), (413, 'payload'))
        self.assertEqual(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').body['blocks'][0]['id'], 'b0')
        self.assertEqual(len(BoardFormatPayload.objects.get(board_id=BOARD, node_id='d').body['blocks']), 30)

    def test_a_deleted_node_keeps_its_row_so_an_undo_without_the_payload_restores_its_content(self):
        self.save(self.owner, data=graph(doc(text='one'), html()))
        self.as_user(self.owner)
        unloaded = self.client.get(f'/api/canvas-boards/{BOARD}?payloads=lazy').json()['data']['nodes'][0]
        self.save(self.owner, method='patch', patch={'nodes': {'delete': ['d']}})
        self.assertNotIn('d', self.stored_nodes())
        self.assertEqual(self.save(self.owner, method='patch', patch={'nodes': {'upsert': [unloaded], 'add': ['d']}}).status_code, 200)
        self.as_user(self.owner)
        restored = self.client.get(f'/api/canvas-boards/{BOARD}').json()['data']['nodes']
        self.assertEqual(next(node for node in restored if node['id'] == 'd')['blocks'][0]['text'], 'one')

    def test_a_save_returns_the_new_reference_of_a_changed_payload_with_its_stamps(self):
        self.save(self.owner, data=graph(doc(text='one'), html()))
        stamps = self.save(self.owner, method='patch', query='?payloads=lazy', patch={'nodes': {'upsert': [doc(text='two')]}}).json()['stamps']
        self.assertEqual(stamps['d']['payload'], self.stored_nodes()['d']['payload'])
        self.assertEqual(stamps['d']['payload']['rev'], 2)
        self.assertNotIn('h', stamps)

    def test_a_corrected_save_returns_the_board_inline_unless_lazy(self):
        editor = make_user('editor')
        BoardMember.objects.create(board_id=BOARD, user_id=editor.id, role='edit', created_at=1, updated_at=1)
        held = {'locked': True, 'lockedBy': str(self.owner.id), 'lockProtected': True}
        self.save(self.owner, data=graph(doc(text='one', **held), html()))
        for query, inline in (('', True), ('?payloads=lazy', False)):
            with self.subTest(query=query):
                reply = self.save(editor, query=query, data=graph(doc(text='one', x=50, **held), html()))
                self.assertEqual(reply.status_code, 200)
                node = next(item for item in reply.json()['board']['nodes'] if item['id'] == 'd')
                self.assertEqual(node['x'], 0)
                if inline:
                    self.assertEqual(node['blocks'][0]['text'], 'one')
                    self.assertNotIn('payload', node)
                else:
                    self.assertNotIn('blocks', node)
                    self.assertEqual(node['payload']['rev'], 1)

    def test_a_synced_frame_reads_the_payloads_of_its_own_objects_inline(self):
        frame = {'id': 'f', 'type': 'frame', 'x': 0, 'y': 0, 'w': 50, 'h': 50}
        self.save(self.owner, data=graph(frame, {**doc(text='inside'), 'parentId': 'f'}, html()))
        self.as_user(self.viewer)
        content = self.client.get(f'/api/canvas-boards/{BOARD}/frames/f').json()
        self.assertEqual([node['id'] for node in content['nodes']], ['f', 'd'])
        self.assertEqual(content['nodes'][1]['blocks'][0]['text'], 'inside')
        self.assertNotIn('payload', content['nodes'][1])

    def test_the_changes_feed_is_inline_unless_lazy(self):
        self.save(self.owner, data=graph(doc(text='one')))
        base = self.version()
        self.save(self.owner, method='patch', patch={'nodes': {'upsert': [doc(text='two')]}})
        self.as_user(self.owner)
        inline = self.client.get(f'/api/canvas-boards/{BOARD}/changes?since={base}').json()
        self.assertEqual(inline['changes']['nodes']['upsert'][0]['blocks'][0]['text'], 'two')
        lazy = self.client.get(f'/api/canvas-boards/{BOARD}/changes?since={base}&payloads=lazy').json()
        self.assertEqual(lazy['changes']['nodes']['upsert'][0]['payload']['rev'], 2)
        self.assertNotIn('blocks', lazy['changes']['nodes']['upsert'][0])


class PayloadLifecycleTests(TransactionTestCase):
    def setUp(self):
        self.owner = make_user('owner')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)

    def test_a_new_board_from_a_graph_gets_its_own_payload_rows(self):
        source = validate_state(graph(doc(text='kept'), html()))
        made = services.create_board(PROJECT, 'Copy', self.owner, source)
        self.assertIn('blocks', source['nodes'][0])
        stored = CanvasBoard.objects.get(pk=made['id']).data['nodes']
        self.assertTrue(all('payload' in node and 'blocks' not in node and 'html' not in node for node in stored))
        self.assertEqual(BoardFormatPayload.objects.get(board_id=made['id'], node_id='d').body['blocks'][0]['text'], 'kept')
        self.assertEqual(services.get_board(made['id'])['data']['nodes'][0]['blocks'][0]['text'], 'kept')

    def test_duplicating_a_board_through_its_read_copies_the_payloads_and_leaves_the_source(self):
        original = services.create_board(PROJECT, 'Original', self.owner, validate_state(graph(doc(text='kept'))))
        copy = services.create_board(PROJECT, 'Copy', self.owner, services.get_board(original['id'])['data'])
        services.delete_board(original['id'])
        self.assertEqual(BoardFormatPayload.objects.filter(board_id=original['id']).count(), 0)
        self.assertEqual(services.get_board(copy['id'])['data']['nodes'][0]['blocks'][0]['text'], 'kept')

    def test_deleting_a_board_removes_every_payload_row(self):
        made = services.create_board(PROJECT, 'Doomed', self.owner, validate_state(graph(doc(), html(), drawio())))
        self.assertEqual(BoardFormatPayload.objects.filter(board_id=made['id']).count(), 3)
        services.delete_board(made['id'])
        self.assertEqual(BoardFormatPayload.objects.count(), 0)

    def test_a_template_counts_its_graph_without_payloads_against_the_board_limit(self):
        from .models import BoardTemplate
        from .templates import TemplateError, create_template, snapshot
        blocks = [{'id': f'b{n}', 'type': 'p', 'text': 'y' * 20000} for n in range(40)]
        made = services.create_board(PROJECT, 'Big', self.owner, validate_state(graph(*(doc(f'd{n}', blocks=blocks) for n in range(3)))))
        entry = create_template(self.owner, {'name': 'Big', 'boardId': str(made['id'])})
        nodes = BoardTemplate.objects.get(pk=entry['id']).graph['nodes']
        self.assertEqual([len(node['blocks']) for node in nodes], [40, 40, 40])
        self.assertGreater(len(json.dumps(nodes)), 2 * 1024 * 1024)
        huge = [{'id': f'b{n}', 'type': 'p', 'text': 'y' * 20000} for n in range(60)]
        with self.assertRaises(TemplateError) as refused:
            snapshot(graph(doc(blocks=huge)))
        self.assertEqual(refused.exception.status, 413)

    def test_a_template_from_a_selection_takes_unloaded_payloads_from_the_source_board(self):
        from .models import BoardTemplate
        from .templates import create_template
        made = services.create_board(PROJECT, 'Source', self.owner, validate_state(graph(doc(text='kept'), html())))
        unloaded = services.get_board(made['id'], lazy=True)['data']['nodes'][0]
        self.assertNotIn('blocks', unloaded)
        entry = create_template(self.owner, {'name': 'Part', 'boardId': str(made['id']), 'graph': {'nodes': [unloaded], 'connectors': []}})
        nodes = BoardTemplate.objects.get(pk=entry['id']).graph['nodes']
        self.assertEqual([(node['id'], node['blocks'][0]['text'], 'payload' in node) for node in nodes], [('d', 'kept', False)])

    def test_a_template_made_from_a_board_carries_the_payloads_inline(self):
        from .templates import _board_graph
        made = services.create_board(PROJECT, 'Source', self.owner, validate_state(graph(doc(text='kept'))))
        shared = _board_graph(self.owner, str(made['id']), 0)
        self.assertEqual(shared['nodes'][0]['blocks'][0]['text'], 'kept')
        self.assertNotIn('payload', shared['nodes'][0])


class PayloadMigrationTests(TransactionTestCase):
    """The data step of canvas.0018 moves inline payloads into rows, once."""

    def migrate(self, target):
        executor = MigrationExecutor(connection)
        executor.migrate([target])
        return executor.loader.project_state([target]).apps

    def tearDown(self):
        self.migrate(MIGRATION_AFTER)

    def test_inline_payloads_move_to_rows_idempotently_and_read_back_inline(self):
        old = self.migrate(MIGRATION_BEFORE)
        Board = old.get_model('canvas', 'CanvasBoard')
        legacy = {**empty_state(), 'nodes': [doc(text='old'), html(), drawio(xml='<m/>', preview='data:image/svg+xml;base64,AAAA'),
                                              {'id': 'r', 'type': 'rect', 'x': 0, 'y': 0, 'w': 5, 'h': 5}]}
        Board.objects.create(id=BOARD, project_id=PROJECT, name='Legacy', data=legacy, created_at=1, updated_at=1, version=7)
        self.migrate(MIGRATION_AFTER)
        board = CanvasBoard.objects.get(pk=BOARD)
        self.assertEqual((board.version, board.updated_at), (7, 1))
        nodes = {node['id']: node for node in board.data['nodes']}
        self.assertTrue(all('payload' in nodes[key] and absent not in nodes[key] for key, absent in (('d', 'blocks'), ('h', 'html'), ('x', 'xml'))))
        self.assertNotIn('payload', nodes['r'])
        self.assertEqual(BoardFormatPayload.objects.filter(board_id=BOARD).count(), 3)
        self.assertEqual(services.get_board(BOARD)['data']['nodes'], legacy['nodes'])
        # Running the data step again changes nothing.
        from importlib import import_module
        step = import_module('apps.canvas.migrations.0018_format_payloads').move_payloads
        snapshot = (CanvasBoard.objects.get(pk=BOARD).data, list(BoardFormatPayload.objects.order_by('node_id').values_list('node_id', 'rev', 'digest')))
        from django.apps import apps as live
        step(live, None)
        self.assertEqual((CanvasBoard.objects.get(pk=BOARD).data, list(BoardFormatPayload.objects.order_by('node_id').values_list('node_id', 'rev', 'digest'))), snapshot)

    def test_a_board_saved_by_the_application_after_the_migration_sees_no_change(self):
        old = self.migrate(MIGRATION_BEFORE)
        old.get_model('canvas', 'CanvasBoard').objects.create(id=BOARD, project_id=PROJECT, name='Legacy', data=validate_state({**empty_state(), 'nodes': [doc(text='old')]}),
                                                              created_at=1, updated_at=1, version=3)
        self.migrate(MIGRATION_AFTER)
        user = make_user('owner')
        result = services.save_board(BOARD, validate_state({**empty_state(), 'nodes': [doc(text='old')]}), 3, uuid4(), user.id)
        self.assertEqual(result['version'], 3)
