"""Per-object board saves (PATCH) and change reads (GET /changes), apps.canvas.patch."""
import json
from unittest.mock import patch as mock
from uuid import uuid4
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.authentication.session import sign_session
from apps.projects.models import Project
from . import patch as board_patch, services
from .models import BoardActivity, BoardMember, CanvasBoard, CanvasBoardSave
from .serialization import MAX_BOARD_JSON_UNITS, content_length, empty_state, validate_state
from .test_activity import BOARD, PROJECT, T0, graph, rect
from .test_roles import make_user


def line(identifier, start, end):
    return {'id': identifier, 'from': {'nodeId': start}, 'to': {'nodeId': end}}


class ApplyPatchTests(SimpleTestCase):
    stored = validate_state(graph(rect('a'), rect('b'), rect('c'), connectors=[line('k', 'a', 'b')]))

    def ids(self, result, kind='nodes'):
        return [item['id'] for item in result[kind]]

    def test_kept_items_keep_their_order_and_added_ones_follow_in_patch_order(self):
        result = board_patch.apply_patch(self.stored, {'nodes': {'upsert': [rect('e'), rect('b', x=5), rect('d')],
                                                                 'add': ['e', 'd'], 'delete': ['a']}})
        self.assertEqual(self.ids(result), ['b', 'c', 'e', 'd'])
        self.assertEqual(result['nodes'][0]['x'], 5)
        self.assertEqual(self.ids(result, 'connectors'), ['k'])
        self.assertEqual(result['viewport'], self.stored['viewport'])

    def test_an_explicit_order_reorders_and_must_name_every_item_once(self):
        result = board_patch.apply_patch(self.stored, {'nodeOrder': ['c', 'a', 'b']})
        self.assertEqual(self.ids(result), ['c', 'a', 'b'])
        for order in (['c', 'a'], ['c', 'a', 'a'], ['c', 'a', 'x'], 'cab', [['c'], 'a', 'b']):
            with self.subTest(order=order), self.assertRaises(board_patch.PatchError):
                board_patch.apply_patch(self.stored, {'nodeOrder': order})

    def test_malformed_patches_are_refused(self):
        for patch in ([], {'nodes': []}, {'nodes': {'upsert': {}}}, {'nodes': {'delete': [1]}},
                      {'nodes': {'upsert': [{'x': 1}]}}, {'nodes': {'upsert': [rect('a'), rect('a')]}},
                      {'connectors': {'upsert': ['k']}}, {'nodes': {'add': 'e'}}):
            with self.subTest(patch=patch), self.assertRaises(board_patch.PatchError):
                board_patch.apply_patch(self.stored, patch)

    def test_add_must_name_exactly_the_upserted_items_the_stored_graph_lacks(self):
        # An editor that still holds an image someone deleted, or lacks one someone added, built its patch over a
        # different graph: refused, so it sends the whole graph and nothing lands at a z-position it did not choose.
        for nodes in ({'upsert': [rect('e')]}, {'upsert': [rect('a')], 'add': ['a']},
                      {'upsert': [rect('e'), rect('f')], 'add': ['e']}, {'add': ['e']}):
            with self.subTest(nodes=nodes), self.assertRaises(board_patch.PatchError):
                board_patch.apply_patch(self.stored, {'nodes': nodes})

    def test_changed_ids_and_order_hash(self):
        new = validate_state(graph(rect('a', x=1), rect('c'), rect('d'), connectors=[line('k', 'a', 'c')]))
        self.assertEqual(board_patch.changed_ids(self.stored, new), {'nodes': ['a', 'b', 'd'], 'connectors': ['k']})
        many = validate_state(graph(*(rect(f'n{index}') for index in range(board_patch.MAX_RECORDED_IDS + 1))))
        self.assertIsNone(board_patch.changed_ids(self.stored, many))
        # Mirrored by orderHash in src/lib/canvas/patch.test.js.
        self.assertEqual(board_patch.order_hash([]), 0x811c9dc5)
        self.assertEqual(board_patch.order_hash(['a', 'b']), board_patch.order_hash(['a', 'b']))
        self.assertNotEqual(board_patch.order_hash(['a', 'b']), board_patch.order_hash(['b', 'a']))
        self.assertEqual(board_patch.order_hash(['n1', 'é\U0001f600']), 3903611430)


@override_settings(ROOT_URLCONF='config.urls')
class PatchSaveTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.ana = make_user('ana')
        self.ben = make_user('ben')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.ana.id,
                                   data=empty_state(), created_at=1, updated_at=1)
        self.clock = T0

    def send(self, user, method, payload, base=None, expect=200):
        self.clock += 1000
        self.client.cookies['veevee_session'] = sign_session(user)
        base = CanvasBoard.objects.get(pk=BOARD).version if base is None else base
        body = {**payload, 'baseVersion': base, 'saveId': str(uuid4())}
        with mock('apps.canvas.services.now_ms', return_value=self.clock):
            response = getattr(self.client, method)('/api/canvas-boards/' + BOARD, content_type='application/json',
                                                    data=json.dumps(body))
        self.assertEqual(response.status_code, expect, response.content)
        return response.json()

    def put(self, user, data, **options):
        return self.send(user, 'put', {'data': data}, **options)

    def patch(self, user, patch, **options):
        return self.send(user, 'patch', {'patch': patch}, **options)

    def stored(self):
        return CanvasBoard.objects.get(pk=BOARD).data

    def history(self):
        return [(str(row.actor_id), row.action, row.node_id) for row in
                BoardActivity.objects.filter(board_id=BOARD).order_by('created_at', 'ordinal')]

    def changes(self, user, since):
        self.client.cookies['veevee_session'] = sign_session(user)
        return self.client.get(f'/api/canvas-boards/{BOARD}/changes?since={since}')

    def test_a_patch_saves_the_same_board_as_the_full_graph_it_stands_for(self):
        self.put(self.ana, graph(rect('a'), rect('b'), connectors=[line('k', 'a', 'b')]))
        patched = self.patch(self.ben, {'nodes': {'upsert': [rect('a', x=40), rect('c')], 'add': ['c'], 'delete': ['b']},
                                        'connectors': {'delete': ['k']}, 'viewport': {'x': 1, 'y': 2, 'zoom': 2}})
        self.assertEqual(patched['version'], 3)
        stored = self.stored()
        self.assertEqual([(item['id'], item['x']) for item in stored['nodes']], [('a', 40), ('c', 0)])
        self.assertEqual((stored['connectors'], stored['viewport']), ([], {'x': 1, 'y': 2, 'zoom': 2}))
        # The same edit as a full save from the same start gives the same graph, stamps aside.
        CanvasBoard.objects.filter(pk=BOARD).update(data=empty_state(), version=1)
        self.put(self.ana, graph(rect('a'), rect('b'), connectors=[line('k', 'a', 'b')]))
        self.put(self.ben, graph(rect('a', x=40), rect('c'), viewport={'x': 1, 'y': 2, 'zoom': 2}))
        strip = lambda data: {**data, 'nodes': [{key: value for key, value in item.items() if not key.endswith(('By', 'At'))}
                                                for item in data['nodes']]}
        self.assertEqual(strip(self.stored()), strip(stored))

    def test_stamps_and_history_cover_exactly_the_patched_objects(self):
        ana, ben = str(self.ana.id), str(self.ben.id)
        self.put(self.ana, graph(rect('a', text='A'), rect('b', text='B'), rect('c', text='C')))
        created = self.clock
        patched = self.patch(self.ben, {'nodes': {'upsert': [rect('a', text='A2'), rect('d', text='D')], 'add': ['d'],
                                                    'delete': ['c']}})
        self.assertEqual(patched['stamps'], {
            'a': {'createdBy': ana, 'createdAt': created, 'updatedBy': ben, 'updatedAt': self.clock},
            'd': {'createdBy': ben, 'createdAt': self.clock, 'updatedBy': ben, 'updatedAt': self.clock}})
        nodes = {item['id']: item for item in self.stored()['nodes']}
        self.assertEqual((nodes['b']['updatedBy'], nodes['b']['updatedAt']), (ana, created))
        self.assertEqual(self.history()[3:], [(ben, 'edit', 'a'), (ben, 'add', 'd'), (ben, 'delete', 'c')])
        # Client stamps in a patch are ignored, as on a full save.
        forged = {'createdBy': ben, 'createdAt': 1, 'updatedBy': ben, 'updatedAt': 1}
        self.patch(self.ben, {'nodes': {'upsert': [{**rect('b', text='B'), **forged}]}})
        self.assertEqual({key: {item['id']: item for item in self.stored()['nodes']}['b'][key] for key in forged},
                         {'createdBy': ana, 'createdAt': created, 'updatedBy': ana, 'updatedAt': created})
        # A viewport-only patch keeps the version and records nothing.
        version = CanvasBoard.objects.get(pk=BOARD).version
        self.assertEqual(self.patch(self.ben, {'viewport': {'x': 9, 'y': 9, 'zoom': 1}})['version'], version)
        self.assertEqual(len(self.history()), 6)

    def test_a_patch_over_a_stale_version_is_a_conflict_with_the_board(self):
        self.put(self.ana, graph(rect('a')))
        self.put(self.ana, graph(rect('a'), rect('b')))
        refused = self.patch(self.ben, {'nodes': {'upsert': [rect('c')], 'add': ['c']}}, base=2, expect=409)
        self.assertEqual(refused['error'], 'VERSION_CONFLICT')
        self.assertEqual((refused['board']['version'], [item['id'] for item in refused['board']['data']['nodes']]), (3, ['a', 'b']))
        self.assertEqual([item['id'] for item in self.stored()['nodes']], ['a', 'b'])
        # The editor merges, then patches over the new base.
        self.patch(self.ben, {'nodes': {'upsert': [rect('c')], 'add': ['c']}}, base=3)
        self.assertEqual([item['id'] for item in self.stored()['nodes']], ['a', 'b', 'c'])

    def test_a_patch_that_does_not_apply_is_refused_so_the_editor_sends_the_whole_graph(self):
        self.put(self.ana, graph(rect('a'), rect('b')))
        for patch in ([], {'nodes': {'upsert': [{'type': 'rect'}]}}, {'nodeOrder': ['a']}, {'nodes': {'upsert': [rect('c')]}}):
            with self.subTest(patch=patch):
                self.assertEqual(self.send(self.ana, 'patch', {'patch': patch}, expect=400), {'error': 'INVALID_PATCH'})
        self.assertEqual(self.send(self.ana, 'patch', {'data': graph(rect('a'))}, expect=400), {'error': 'INVALID_PATCH'})
        self.assertEqual((CanvasBoard.objects.get(pk=BOARD).version, len(self.history())), (2, 2))
        # Deleting an id that is already gone, or upserting a node into a missing parent, normalizes like PUT.
        self.patch(self.ana, {'nodes': {'delete': ['zz'], 'upsert': [rect('c', parentId='gone')], 'add': ['c']}})
        self.assertEqual(([item['id'] for item in self.stored()['nodes']], self.stored()['nodes'][-1]['parentId']),
                         (['a', 'b', 'c'], None))

    def test_roles_apply_to_patches_exactly_as_to_full_saves(self):
        self.put(self.ana, graph(rect('a')))
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        mate = make_user('mate')
        outcomes = {}
        for role in ('view', 'comment', 'edit'):
            BoardMember.objects.update_or_create(board_id=BOARD, user_id=mate.id, defaults={'role': role},
                                                 create_defaults={'role': role, 'created_at': 1, 'updated_at': 1})
            # A read-only role is refused before the version check, so even a stale patch gets 403, never the graph.
            stale = self.send(mate, 'patch', {'patch': {'nodes': {'upsert': [rect('x')], 'add': ['x']}}}, base=1,
                              expect=403 if role != 'edit' else 409)
            outcomes[role] = (self.send(mate, 'patch', {'patch': {'nodes': {'upsert': [rect(role)], 'add': [role]}}},
                                        expect=403 if role != 'edit' else 200).get('error'), 'board' in stale)
        self.assertEqual(outcomes, {'view': ('FORBIDDEN', False), 'comment': ('FORBIDDEN', False), 'edit': (None, True)})
        self.assertEqual([item['id'] for item in self.stored()['nodes']], ['a', 'edit'])
        self.client.cookies.clear()
        self.assertEqual(self.client.patch('/api/canvas-boards/' + BOARD, content_type='application/json',
                                           data='{}').status_code, 401)
        self.client.cookies['veevee_session'] = sign_session(self.ana)
        missing = '/api/canvas-boards/dddddddd-dddd-4ddd-8ddd-dddddddddddd'
        self.assertEqual(self.client.patch(missing, content_type='application/json', data=json.dumps(
            {'patch': {}, 'baseVersion': 1, 'saveId': str(uuid4())})).status_code, 404)

    def test_the_size_limit_is_measured_on_the_resulting_board(self):
        def nodes(text):
            return [rect(f'n{index:04}') for index in range(2000)] + [rect('pad', text=text)]
        room = MAX_BOARD_JSON_UNITS - content_length(validate_state(graph(*nodes(''))))
        self.put(self.ana, graph(*nodes('x' * (room - 10))))
        version = CanvasBoard.objects.get(pk=BOARD).version
        # A small patch that would take the whole board one unit over is refused without writing anything.
        refused = self.patch(self.ben, {'nodes': {'upsert': [rect('pad', text='x' * (room + 1))]}}, expect=413)
        self.assertEqual(refused, {'error': 'Board is too large to save.'})
        self.assertEqual((CanvasBoard.objects.get(pk=BOARD).version, len(self.history())), (version, 2001))
        # Exactly at the limit saves.
        self.patch(self.ben, {'nodes': {'upsert': [rect('pad', text='x' * room)]}})
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).version, version + 1)

    def test_a_patch_is_measured_as_the_board_it_produces_not_by_its_own_size(self):
        ids = [f'n{index:04}' for index in range(2000)]
        bare = content_length(validate_state(graph(*[rect(identifier) for identifier in ids])))
        filler = (MAX_BOARD_JSON_UNITS - 100_000 - bare) // len(ids)
        self.put(self.ana, graph(*[rect(identifier, text='x' * filler) for identifier in ids]))
        # Select-all and move: the patch carries every stamped node and the order, so it is over the limit itself.
        moved = [{**item, 'x': 5} for item in self.stored()['nodes']]
        patch = {'nodes': {'upsert': moved}, 'nodeOrder': ids}
        self.assertGreater(content_length(patch), MAX_BOARD_JSON_UNITS)
        version = CanvasBoard.objects.get(pk=BOARD).version
        self.patch(self.ben, patch)
        self.assertEqual(CanvasBoard.objects.get(pk=BOARD).version, version + 1)
        self.assertEqual({item['x'] for item in self.stored()['nodes']}, {5})
        # Growing every node past the limit is refused without changing the stored board or version.
        before, history = CanvasBoard.objects.get(pk=BOARD), len(self.history())
        grown = [{**item, 'text': item['text'] + 'y' * 60} for item in self.stored()['nodes']]
        refused = self.patch(self.ben, {'nodes': {'upsert': grown}}, expect=413)
        self.assertEqual(refused, {'error': 'Board is too large to save.'})
        after = CanvasBoard.objects.get(pk=BOARD)
        self.assertEqual((after.version, after.data, len(self.history())), (before.version, before.data, history))

    def test_open_boards_fetch_only_what_changed(self):
        self.put(self.ana, graph(rect('a'), rect('b'), rect('c'), connectors=[line('k', 'a', 'b')]))
        self.patch(self.ana, {'nodes': {'upsert': [rect('a', x=7)]}})
        self.patch(self.ana, {'nodes': {'delete': ['c']}, 'viewport': {'x': 3, 'y': 3, 'zoom': 1}})
        self.patch(self.ana, {'nodeOrder': ['b', 'a']})
        current = CanvasBoard.objects.get(pk=BOARD)
        response = self.changes(self.ben, 2)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual((body['version'], body['updatedAt'], 'data' in body), (5, current.updated_at, False))
        changes = body['changes']
        # A reorder changes no object, only the order hash, so the editor whose rebuilt order differs refetches.
        self.assertEqual(([item['id'] for item in changes['nodes']['upsert']], changes['nodes']['delete']), (['a'], ['c']))
        self.assertEqual(changes['nodes']['upsert'][0], current.data['nodes'][1])
        self.assertEqual(changes['connectors'], {'upsert': [], 'delete': []})
        self.assertEqual((changes['nodeOrderHash'], changes['connectorOrderHash']),
                         (board_patch.order_hash(['b', 'a']), board_patch.order_hash(['k'])))
        # Up to date: nothing changed.
        self.assertEqual(self.changes(self.ben, 5).json()['changes']['nodes'], {'upsert': [], 'delete': []})
        # A full save records its ids too.
        self.put(self.ben, {**current.data, 'nodes': current.data['nodes'][:1]})
        self.assertEqual(self.changes(self.ben, 5).json()['changes']['nodes']['delete'], ['a'])

    def test_changes_fall_back_to_the_whole_board_when_they_cannot_be_told(self):
        self.put(self.ana, graph(rect('a')))
        self.put(self.ana, graph(rect('a'), rect('b')))
        whole = {'version': 3, 'updatedAt': CanvasBoard.objects.get(pk=BOARD).updated_at, 'data': self.stored()}
        # Version 1 predates any recorded save, a version from the future is unknown.
        self.assertEqual(self.changes(self.ben, 1).json()['changes']['nodes']['upsert'][0]['id'], 'a')
        self.assertEqual(self.changes(self.ben, 4).json(), whole)
        # A pruned save, or one saved before ids were recorded, cannot be told apart from any other change.
        CanvasBoardSave.objects.filter(board_id=BOARD, version=3).update(changes=None)
        self.assertEqual(self.changes(self.ben, 2).json(), whole)
        CanvasBoardSave.objects.filter(board_id=BOARD, version=3).delete()
        self.assertEqual(self.changes(self.ben, 2).json(), whole)
        with mock.object(board_patch, 'MAX_CHANGE_VERSIONS', 1):
            self.assertEqual(self.changes(self.ben, 1).json(), whole)

    def test_changes_need_read_access_and_a_version(self):
        self.put(self.ana, graph(rect('a')))
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        self.assertEqual(self.changes(self.ben, 1).status_code, 200)
        for query in ('', 'x', '-1', '1.5', '1' * 17):
            with self.subTest(query=query):
                self.assertEqual(self.changes(self.ben, query).json(), {'error': 'Invalid version.'})
        self.client.cookies['veevee_session'] = sign_session(self.ben)
        self.assertEqual(self.client.get('/api/canvas-boards/dddddddd-dddd-4ddd-8ddd-dddddddddddd/changes?since=1').status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/changes?since=1').status_code, 401)


class ChangesMigrationTests(TransactionTestCase):
    def test_upgrade_keeps_applied_saves_without_recorded_ids(self):
        executor = MigrationExecutor(connection)
        final = executor.loader.graph.leaf_nodes()
        previous = [node for node in final if node[0] != 'canvas'] + [('canvas', '0006_boardaijob')]
        board = uuid4()
        try:
            executor.migrate(previous)
            old = executor.loader.project_state(previous).apps
            old.get_model('canvas', 'CanvasBoard').objects.create(id=board, project_id=uuid4(), name='Kept', data=empty_state(),
                                                                   created_at=1, updated_at=2, version=2)
            old.get_model('canvas', 'CanvasBoardSave').objects.create(board_id=board, save_id=uuid4(), version=2, applied_at=2)
            executor = MigrationExecutor(connection)
            self.assertEqual([(m.app_label, m.name) for m, backward in executor.migration_plan(final)],
                             [('canvas', '0007_canvasboardsave_changes'), ('canvas', '0008_customshapepack')])
            executor.migrate(final)
            self.assertEqual(list(CanvasBoardSave.objects.filter(board_id=board).values_list('version', 'changes')), [(2, None)])
            # A board saved before the upgrade is fetched whole by editors that missed that save.
            self.assertIn('data', services.board_changes(str(board), 1))
        finally:
            MigrationExecutor(connection).migrate(final)
