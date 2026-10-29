from testsupport.frozen_oracle import run as oracle_run
import json
import random
import subprocess
from pathlib import Path
from unittest.mock import patch

from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.authentication.models import User
from .models import CanvasBoard
from .serialization import empty_state, js_json, json_length, validate_state


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
                self.assertEqual(validate_state(value), oracle['state'])
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
        self.assertEqual(detail, {**created, 'data': empty_state()})
        renamed = self.send('post', '/api/canvas-boards', {'op': 'renameBoard', 'id': created['id'], 'name': '  '})
        self.assertEqual(renamed.status_code, 200)
        self.assertEqual(CanvasBoard.objects.get(pk=created['id']).name, '')
        with patch('apps.canvas.services.now_ms', return_value=1700000001000):
            saved = self.send('put', '/api/canvas-boards/' + created['id'], {'data': {'version': 99, 'viewport': {'zoom': -1}}})
        self.assertEqual(saved.json(), {'ok': True, 'updatedAt': 1700000001000})
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
        self.assertEqual(self.send('put', '/api/canvas-boards/' + self.board, {'data': {}}).status_code, 200)
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
        response = self.send('put', '/api/canvas-boards/' + self.board, {'data': value})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(CanvasBoard.objects.get(pk=self.board).data, empty_state())
        value['padding'] += 'a'
        response = self.send('put', '/api/canvas-boards/' + self.board, {'data': value})
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
        response = self.client.delete('/api/canvas-boards/' + self.board)
        self.assertEqual((response.status_code, response.content), (405, b''))
        self.assertNotIn('Content-Type', response)
        self.assertNotIn('Allow', response)
