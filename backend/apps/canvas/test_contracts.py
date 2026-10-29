from testsupport.frozen_oracle import run as oracle_run
import json
import random
import uuid
import subprocess
from pathlib import Path
from unittest.mock import patch

from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.authentication.models import User
from .models import CanvasBoard, CanvasBoardSave
from .serialization import SHAPE_TYPES, empty_state, finite, js_json, json_length, validate_state


def with_shape_text(oracle_state, value):
    """The historical oracle predates text inside shapes; shapes now also keep text, fontSize and color."""
    nodes = value.get('nodes') if isinstance(value, dict) else None
    sources = {node.get('id'): node for node in nodes if isinstance(node, dict)} if isinstance(nodes, list) else {}
    for node in oracle_state['nodes']:
        source = sources[node['id']]
        if node['type'] not in SHAPE_TYPES:
            continue
        if isinstance(source.get('text'), str):
            node['text'] = source['text']
        if finite(source.get('fontSize')):
            node['fontSize'] = source['fontSize']
        if isinstance(source.get('color'), str):
            node['color'] = source['color']
    return oracle_state


class CanvasSerializationParityTests(SimpleTestCase):
    def test_current_node_normalization_and_json_size(self):
        base = {'id': 'node', 'x': 1, 'y': 2, 'w': 30, 'h': 40}
        cases = [None, [], {}, {'viewport': {'x': True, 'y': '2', 'zoom': 0}}]
        for kind in ['rect', 'ellipse', 'triangle', 'diamond', 'text', 'sticky', 'frame', 'image', 'unknown']:
            cases.append({'version': 99, 'nodes': [{**base, 'type': kind, 'src': '/api/media/fixture.png',
                         'opacity': 5, 'cornerRadius': 7, 'parentId': 'missing', 'groupId': 'loose',
                         'crop': {'x': -1, 'y': 2, 'zoom': 10}, 'alt': 'संदर्भ😀', 'naturalW': 22, 'naturalH': True}]})
        for src in ['https://example.invalid/image.png', 'data:image/png;base64,AA==', '', '/api/media/', '/api/media/a.png']:
            cases.append({'nodes': [{**base, 'type': 'image', 'src': src, 'crop': [], 'aspectLocked': False}]})
        cases.append({'nodes': [{**base, 'type': 'rect', 'parentId': 'node'}], 'connectors': [
            {'id': 'c', 'from': {'nodeId': 'node', 'anchor': []}, 'to': {'x': 0, 'y': 1}, 'opacity': -2},
            {'id': 'bad', 'from': {'nodeId': 'missing'}, 'to': {'nodeId': 'node'}},
        ]})
        rng = random.Random(421)
        values = [None, False, True, '', 'x', [], {}, -1, 0, 1, .25, 1e-7, 1e21]
        for _ in range(200):
            candidate = {key: rng.choice(values) for key in ['parentId', 'groupId', 'opacity', 'fill', 'stroke', 'strokeWidth', 'text', 'fontSize', 'align', 'cornerRadius', 'crop']}
            candidate.update(base, type=rng.choice(['rect', 'text', 'image', 'sticky', 'frame']), src='/api/media/test.png')
            cases.append({'nodes': [candidate], 'viewport': {key: rng.choice(values) for key in ['x', 'y', 'zoom']}})
        code = """import {validateCanvasState} from './src/lib/canvas/serialization.js';
let input=''; for await (const chunk of process.stdin) input+=chunk;
console.log(JSON.stringify(JSON.parse(input).map(value=>({state:validateCanvasState(value),length:JSON.stringify(value).length}))));"""
        result = oracle_run(['node', '--import', 'tsx', '--input-type=module', '-e', code],
                                input=json.dumps(cases), text=True, capture_output=True, check=True,
                                cwd=Path(__file__).resolve().parents[3])
        expected = json.loads(result.stdout)
        for value, oracle in zip(cases, expected):
            with self.subTest(value=value):
                self.assertEqual(validate_state(value), with_shape_text(oracle['state'], value))
                self.assertEqual(json_length(value), oracle['length'])

    def test_json_number_unicode_size_matches_node(self):
        values = [-0.0, 1.0, 1e-7, 1e-6, 1e20, 1e21, 1.0000000000000001e18,
                  9007199254740993, '😀', 'a\ud800b', '\u2028', {'nul': '\0'}]
        code = "let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>JSON.stringify(x))));"
        result = oracle_run(['node', '--input-type=module', '-e', code], input=json.dumps(values),
                                text=True, capture_output=True, check=True)
        self.assertEqual([js_json(value) for value in values], json.loads(result.stdout))


@override_settings(ROOT_URLCONF='apps.canvas.urls')
class CanvasContractTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    board = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    missing = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        CanvasBoard.objects.create(id=self.board, project_id=self.project, name='Existing',
                                   created_by=session_fixtures.UID, data={'legacy': 'unmodified'}, created_at=1, updated_at=2)

    def send(self, method, path, data=None):
        if method == 'get':
            return self.client.get(path)
        return getattr(self.client, method)(path, data=json.dumps(data), content_type='application/json')

    def test_auth_precedes_validation_for_every_method(self):
        for method, path in [('get', '/api/canvas-boards'), ('post', '/api/canvas-boards'),
                             ('get', '/api/canvas-boards/not-a-uuid'), ('put', '/api/canvas-boards/not-a-uuid'),
                             ('get', '/api/canvas-boards/not-a-uuid/version'),
                             ('post', '/api/canvas-boards/not-a-uuid/upload')]:
            response = self.send(method, path)
            self.assertEqual((response.status_code, response.json()), (401, {'error': 'UNAUTHENTICATED'}))
        self.assertEqual(CanvasBoard.objects.count(), 1)

    def test_create_rename_get_save_delete_shapes_and_timestamps(self):
        self.cookie(age=172800000)
        with patch('apps.canvas.services.now_ms', return_value=1700000000000):
            response = self.send('post', '/api/canvas-boards', {'op': 'createBoard', 'projectId': self.project, 'name': '\ufeff New 😀 \u00a0'})
        self.assertEqual(response.status_code, 200)
        created = response.json()['board']
        self.assertEqual(created['name'], 'New 😀')
        self.assertEqual(created['createdAt'], 1700000000000)
        self.assertEqual(created['updatedAt'], created['createdAt'])
        self.assertEqual(created['createdBy'], session_fixtures.UID)
        self.assertNotIn('data', created)
        self.assertEqual(len(response.json()['boards']), 2)
        self.assertTrue(response.cookies['veevee_session']['httponly'])
        detail = self.client.get('/api/canvas-boards/' + created['id']).json()
        self.assertEqual(detail, {**created, 'version': 1, 'data': empty_state()})
        renamed = self.send('post', '/api/canvas-boards', {'op': 'renameBoard', 'id': created['id'], 'name': '  '})
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(CanvasBoard.objects.get(pk=created['id']).name, '')
        with patch('apps.canvas.services.now_ms', return_value=1700000001000):
            saved = self.send('put', '/api/canvas-boards/' + created['id'], {'data': {'version': 99, 'viewport': {'zoom': -1}}, 'baseVersion': 1, 'saveId': str(uuid.uuid4())})
        # Normalizes to the empty graph it already holds, so the version stays.
        self.assertEqual(saved.json(), {'ok': True, 'updatedAt': 1700000001000, 'version': 1, 'stamps': {}})
        self.assertEqual(CanvasBoard.objects.get(pk=created['id']).data, empty_state())
        deleted = self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': created['id']})
        self.assertEqual([item['id'] for item in deleted.json()['boards']], [self.board])
        self.assertEqual(self.client.get('/api/canvas-boards/' + created['id']).status_code, 404)

    def test_role_owner_and_shared_graph_edit_semantics(self):
        self.cookie()
        CanvasBoard.objects.filter(pk=self.board).update(created_by=None)
        for operation in ('renameBoard', 'deleteBoard'):
            response = self.send('post', '/api/canvas-boards', {'op': operation, 'id': self.board, 'name': 'blocked'})
            self.assertEqual((response.status_code, response.json()), (403, {'error': 'FORBIDDEN'}))
        self.assertEqual(self.send('put', '/api/canvas-boards/' + self.board, {'data': {}, 'baseVersion': 1, 'saveId': str(uuid.uuid4())}).status_code, 200)
        self.assertEqual(self.client.get('/api/canvas-boards/' + self.board).status_code, 200)
        User.objects.filter(pk=session_fixtures.UID).update(role='admin')
        self.assertEqual(self.send('post', '/api/canvas-boards', {'op': 'deleteBoard', 'id': self.board}).json(), {'boards': [], 'canCreate': True})

    def test_validation_missing_rows_and_uncaught_source_failures(self):
        self.cookie()
        for payload, error in [({}, 'Unknown op.'), ([], 'Unknown op.'),
                               ({'op': 'createBoard'}, 'projectId required.'),
                               ({'op': 'createBoard', 'projectId': self.project}, 'Name required.'),
                               ({'op': 'renameBoard'}, 'id required.'), ({'op': 'deleteBoard'}, 'id required.')]:
            response = self.send('post', '/api/canvas-boards', payload)
            self.assertEqual((response.status_code, response.json()), (400, {'error': error}))
        for payload in [None, {'op': 'createBoard', 'name': {}}, {'op': 'renameBoard', 'id': 'invalid'}]:
            response = self.send('post', '/api/canvas-boards', payload)
            self.assertEqual((response.status_code, response.content), (500, b''))
            self.assertNotIn('Content-Type', response)
        for method, path, payload in [('get', '/api/canvas-boards/' + self.missing, {}),
                                      ('put', '/api/canvas-boards/' + self.missing, {'data': {}}),
                                      ('post', '/api/canvas-boards', {'op': 'renameBoard', 'id': self.missing})]:
            response = self.send(method, path, payload)
            self.assertEqual((response.status_code, response.json()), (404, {'error': 'Board not found.'}))
        self.assertEqual(self.client.get('/api/canvas-boards/not-a-uuid').status_code, 500)
        for data in [None, [], 1, 'text']:
            response = self.send('put', '/api/canvas-boards/' + self.board, {'data': data})
            self.assertEqual((response.status_code, response.json()), (400, {'error': 'Invalid board data.'}))
        self.assertEqual(CanvasBoard.objects.get(pk=self.board).data, {'legacy': 'unmodified'})

    def test_unicode_graph_size_gate_runs_before_coercion_and_database_write(self):
        self.cookie()
        # JSON.stringify({padding:...}) adds 14 units; UTF-8 bytes are larger.
        units = 2 * 1024 * 1024
        value = {'padding': '😀' * ((units - 14) // 2)}
        self.assertEqual(json_length(value), units)
        response = self.send('put', '/api/canvas-boards/' + self.board, {'data': value, 'baseVersion': 1, 'saveId': str(uuid.uuid4())})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(CanvasBoard.objects.get(pk=self.board).data, empty_state())
        value['padding'] += 'a'
        response = self.send('put', '/api/canvas-boards/' + self.board, {'data': value, 'baseVersion': 1, 'saveId': str(uuid.uuid4())})
        self.assertEqual((response.status_code, response.json()), (413, {'error': 'Board is too large to save.'}))

    def test_upload_existence_namespace_validation_and_adapter_errors(self):
        self.cookie()
        with patch('apps.media.images.save_canvas_asset', return_value='/api/media/canvas/fixture.png') as save:
            for identifier in ('invalid', self.missing):
                self.assertEqual(self.send('post', '/api/canvas-boards/' + identifier + '/upload', {'dataUrl': 'data:image/png;base64,AA=='}).status_code, 404)
            save.assert_not_called()
            path = '/api/canvas-boards/' + self.board + '/upload'
            self.assertEqual(self.send('post', path, {'dataUrl': 'https://example.invalid/image.png'}).json(), {'error': 'dataUrl required.'})
            result = self.send('post', path, {'dataUrl': 'data:image/png;base64,AA=='})
            self.assertEqual(result.json(), {'url': '/api/media/canvas/fixture.png'})
            save.assert_called_once_with('data:image/png;base64,AA==', self.board)
        with patch('apps.media.images.save_canvas_asset', side_effect=ValueError('fixture invalid')):
            result = self.send('post', path, {'dataUrl': 'data:image/svg+xml;base64,AA=='})
            self.assertEqual((result.status_code, result.json()), (400, {'error': 'Upload failed.'}))

    def test_implicit_head_options_and_empty_method_not_allowed(self):
        self.cookie()
        response = self.client.head('/api/canvas-boards/' + self.board)
        self.assertEqual((response.status_code, response.content), (200, b''))
        response = self.client.options('/api/canvas-boards')
        self.assertEqual((response.status_code, response.content, response['Allow']), (204, b'', 'GET, HEAD, OPTIONS, POST'))
        response = self.client.options('/api/canvas-boards/' + self.board)
        self.assertEqual(response['Allow'], 'GET, HEAD, OPTIONS, PUT')
        response = self.client.options('/api/canvas-boards/' + self.board + '/upload')
        self.assertEqual(response['Allow'], 'OPTIONS, POST')
        response = self.client.options('/api/canvas-boards/' + self.board + '/version')
        self.assertEqual(response['Allow'], 'GET, HEAD, OPTIONS')
        self.assertEqual(self.send('put', '/api/canvas-boards/' + self.board + '/version', {}).status_code, 405)
        response = self.client.delete('/api/canvas-boards/' + self.board)
        self.assertEqual((response.status_code, response.content), (405, b''))
        self.assertNotIn('Content-Type', response)
        self.assertNotIn('Allow', response)


@override_settings(ROOT_URLCONF='apps.canvas.urls')
class CanvasVersionConflictTests(TransactionTestCase):
    """Several editors: a save only lands on the version it was based on; the loser gets the current graph."""
    cookie = session_fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    board = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    missing = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        CanvasBoard.objects.create(id=self.board, project_id=self.project, name='Shared', created_by=None,
                                   data=empty_state(), created_at=1, updated_at=2)
        self.cookie()

    def graph(self, *ids):
        return {**empty_state(), 'nodes': [{'id': node, 'type': 'rect', 'x': 1, 'y': 2, 'w': 3, 'h': 4} for node in ids]}

    def put(self, payload, board=None):
        """A save as the editor sends it: every attempt carries a fresh save id unless the test sets one."""
        return self.client.put('/api/canvas-boards/' + (board or self.board),
                               data=json.dumps({'saveId': str(uuid.uuid4()), **payload}), content_type='application/json')

    def test_existing_rows_start_at_version_one_and_every_save_bumps_it(self):
        self.assertEqual(self.client.get('/api/canvas-boards/' + self.board).json()['version'], 1)
        with patch('apps.canvas.services.now_ms', return_value=1700000000000):
            first = self.put({'data': self.graph('a'), 'baseVersion': 1})
        self.assertEqual((first.status_code, first.json()), (200, {'ok': True, 'updatedAt': 1700000000000, 'version': 2, 'stamps': {
            'a': {'createdBy': session_fixtures.UID, 'createdAt': 1700000000000, 'updatedBy': session_fixtures.UID, 'updatedAt': 1700000000000}}}))
        self.assertEqual(self.put({'data': self.graph('a', 'b'), 'baseVersion': 2}).json()['version'], 3)
        row = CanvasBoard.objects.get(pk=self.board)
        self.assertEqual((row.version, [node['id'] for node in row.data['nodes']]), (3, ['a', 'b']))

    def test_a_save_that_only_moves_the_viewport_keeps_the_version(self):
        self.assertEqual(self.put({'data': self.graph('a'), 'baseVersion': 1}).json()['version'], 2)
        panned = {**self.graph('a'), 'viewport': {'x': 40, 'y': -8, 'zoom': 2}}
        self.assertEqual(self.put({'data': panned, 'baseVersion': 2}).json()['version'], 2)
        self.assertEqual(CanvasBoard.objects.get(pk=self.board).data['viewport'], {'x': 40, 'y': -8, 'zoom': 2})
        # Still conditional: a stale pan is refused like any other stale save.
        self.assertEqual(self.put({'data': self.graph('a'), 'baseVersion': 1}).status_code, 409)
        self.assertEqual(self.put({'data': self.graph('a', 'b'), 'baseVersion': 2}).json()['version'], 3)

    def test_stale_base_version_is_refused_with_the_current_graph(self):
        self.assertEqual(self.put({'data': self.graph('theirs'), 'baseVersion': 1}).status_code, 200)
        before = CanvasBoard.objects.values('data', 'version', 'updated_at').get(pk=self.board)
        self.cookie(age=172800000)
        stale = self.put({'data': self.graph('mine'), 'baseVersion': 1})
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(stale.json(), {'error': 'VERSION_CONFLICT', 'board': {
            'id': self.board, 'projectId': self.project, 'name': 'Shared', 'createdBy': None, 'createdAt': 1,
            'updatedAt': before['updated_at'], 'teamRole': 'edit', 'version': 2, 'data': before['data']}})
        self.assertEqual([node['id'] for node in before['data']['nodes']], ['theirs'])
        self.assertIn('veevee_session', stale.cookies)
        self.assertEqual(CanvasBoard.objects.values('data', 'version', 'updated_at').get(pk=self.board), before)
        # A base newer than the server is just as stale.
        self.assertEqual(self.put({'data': self.graph('mine'), 'baseVersion': 7}).status_code, 409)
        merged = self.put({'data': self.graph('theirs', 'mine'), 'baseVersion': 2})
        self.assertEqual((merged.status_code, merged.json()['version']), (200, 3))

    def test_missing_base_version_is_refused_with_the_current_graph_and_never_writes(self):
        self.assertEqual(self.put({'data': self.graph('theirs'), 'baseVersion': 1}).json()['version'], 2)
        before = CanvasBoard.objects.values('data', 'version', 'updated_at').get(pk=self.board)
        for payload in ({'data': self.graph('legacy'), 'saveId': None}, {'data': self.graph('legacy'), 'baseVersion': None},
                        {'data': self.graph('legacy'), 'baseVersion': 2, 'saveId': None}):
            with self.subTest(payload=payload):
                refused = self.put(payload)
                self.assertEqual(refused.status_code, 409)
                self.assertEqual(refused.json()['error'], 'VERSION_CONFLICT')
                self.assertEqual((refused.json()['board']['version'], refused.json()['board']['data']), (2, before['data']))
        self.assertEqual(CanvasBoard.objects.values('data', 'version', 'updated_at').get(pk=self.board), before)
        # What a tab on the previous frontend sends: neither field.
        legacy = self.client.put('/api/canvas-boards/' + self.board, data=json.dumps({'data': self.graph('legacy')}),
                                 content_type='application/json')
        self.assertEqual(legacy.status_code, 409)
        self.assertEqual(CanvasBoard.objects.values('data', 'version', 'updated_at').get(pk=self.board), before)

    def test_malformed_save_id_is_refused_before_any_write(self):
        for value in ['', 'not-a-uuid', str(uuid.uuid4()) + 'x', 7, True, [], {}]:
            with self.subTest(value=value):
                response = self.put({'data': self.graph('x'), 'baseVersion': 1, 'saveId': value})
                self.assertEqual((response.status_code, response.json()), (400, {'error': 'Invalid save id.'}))
        self.assertEqual((CanvasBoard.objects.get(pk=self.board).version, CanvasBoardSave.objects.count()), (1, 0))
        for value in ['not-a-uuid', '']:
            response = self.client.get('/api/canvas-boards/' + self.board, {'saveId': value})
            self.assertEqual((response.status_code, response.json()), (400, {'error': 'Invalid save id.'}))

    def saved_version(self, save_id):
        return self.client.get('/api/canvas-boards/' + self.board, {'saveId': save_id}).json()['saveVersion']

    def test_a_busy_board_still_answers_whether_an_early_save_landed(self):
        first, refused = str(uuid.uuid4()), str(uuid.uuid4())
        self.assertEqual(self.put({'data': self.graph('0'), 'baseVersion': 1, 'saveId': first}).json()['version'], 2)
        self.assertEqual(self.put({'data': self.graph('stale'), 'baseVersion': 1, 'saveId': refused}).status_code, 409)
        for index in range(1, 80):
            self.assertEqual(self.put({'data': self.graph(*map(str, range(index + 1))), 'baseVersion': index + 1}).status_code, 200)
        self.assertEqual(self.saved_version(first), 2)
        self.assertIsNone(self.saved_version(refused))
        self.assertIsNone(self.saved_version(str(uuid.uuid4())))
        # Only the ids asked about are read: the plain board read carries no save information.
        self.assertNotIn('saveVersion', self.client.get('/api/canvas-boards/' + self.board).json())
        self.assertEqual(CanvasBoardSave.objects.filter(board_id=self.board).count(), 80)

    def test_viewport_only_saves_and_reused_ids_record_nothing_new(self):
        first = str(uuid.uuid4())
        self.put({'data': self.graph('a'), 'baseVersion': 1, 'saveId': first})
        pan = str(uuid.uuid4())
        panned = {**self.graph('a'), 'viewport': {'x': 5, 'y': 5, 'zoom': 1}}
        self.assertEqual(self.put({'data': panned, 'baseVersion': 2, 'saveId': pan}).json()['version'], 2)
        self.assertIsNone(self.saved_version(pan))
        # A reused id keeps the version it first landed at instead of failing the save.
        self.assertEqual(self.put({'data': self.graph('a', 'b'), 'baseVersion': 2, 'saveId': first}).json()['version'], 3)
        self.assertEqual(self.saved_version(first), 2)

    def test_saves_are_pruned_after_the_retention_window_and_with_their_board(self):
        from apps.workers import scheduler
        from . import services
        with patch('apps.canvas.services.now_ms', return_value=1700000000000):
            self.put({'data': self.graph('old'), 'baseVersion': 1})
        with patch('apps.canvas.services.now_ms', return_value=1700000000000 + services.SAVE_RETENTION_MS - 1000):
            recent = str(uuid.uuid4())
            self.put({'data': self.graph('new'), 'baseVersion': 2, 'saveId': recent})
        with patch('apps.canvas.services.now_ms', return_value=1700000000000 + services.SAVE_RETENTION_MS):
            self.assertEqual(scheduler.default_handlers()['board_saves'](), {'ok': True, 'deleted': 1})
        self.assertEqual(list(CanvasBoardSave.objects.values_list('save_id', flat=True)), [uuid.UUID(recent)])
        self.cookie()
        User.objects.filter(pk=session_fixtures.UID).update(role='admin')
        self.client.post('/api/canvas-boards', data=json.dumps({'op': 'deleteBoard', 'id': self.board}), content_type='application/json')
        self.assertEqual(CanvasBoardSave.objects.count(), 0)

    def test_malformed_base_version_is_refused_before_any_write(self):
        for value in ['1', True, False, 1.5, 0, -1, [], {}, 2 ** 53 + 2]:
            with self.subTest(value=value):
                response = self.put({'data': self.graph('x'), 'baseVersion': value})
                self.assertEqual((response.status_code, response.json()), (400, {'error': 'Invalid base version.'}))
        self.assertEqual(CanvasBoard.objects.get(pk=self.board).version, 1)
        self.assertEqual(self.put({'data': self.graph('x'), 'baseVersion': 1.0}).status_code, 200)

    def test_missing_board_is_not_found_with_or_without_a_base_version(self):
        for payload in ({'data': {}}, {'data': {}, 'baseVersion': 1}):
            response = self.put(payload, self.missing)
            self.assertEqual((response.status_code, response.json()), (404, {'error': 'Board not found.'}))

    def test_concurrent_saves_on_one_base_version_land_exactly_once(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        from django.db import connection as thread_connection
        from . import services
        barrier = Barrier(2)

        def save(label):
            try:
                barrier.wait()
                return services.save_board(self.board, self.graph(label), 1, str(uuid.uuid4()), session_fixtures.UID)
            except services.VersionConflict as conflict:
                return conflict.board
            finally:
                thread_connection.close()

        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(save, ['left', 'right']))
        winners = [result for result in results if 'data' not in result]
        losers = [result for result in results if 'data' in result]
        self.assertEqual((len(winners), len(losers)), (1, 1))
        self.assertEqual(winners[0]['version'], 2)
        row = CanvasBoard.objects.get(pk=self.board)
        self.assertEqual((row.version, row.data), (2, losers[0]['data']))

    def test_version_poll_reads_two_integers_without_the_graph(self):
        from django.db import connection
        from django.test.utils import CaptureQueriesContext
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/canvas-boards/' + self.board + '/version').status_code, 401)
        self.cookie()
        self.put({'data': self.graph('a'), 'baseVersion': 1})
        self.cookie(age=172800000)
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/canvas-boards/' + self.board + '/version')
        row = CanvasBoard.objects.get(pk=self.board)
        self.assertEqual((response.status_code, response.json()), (200, {'version': 2, 'updatedAt': row.updated_at}))
        self.assertIn('veevee_session', response.cookies)
        board_reads = [query['sql'] for query in queries if 'FROM "canvas_boards"' in query['sql']]
        self.assertEqual(len(board_reads), 1)
        self.assertNotIn('"data"', board_reads[0])
        missing = self.client.get('/api/canvas-boards/' + self.missing + '/version')
        self.assertEqual((missing.status_code, missing.json()), (404, {'error': 'Board not found.'}))
