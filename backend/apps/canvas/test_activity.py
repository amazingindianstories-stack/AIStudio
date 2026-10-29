"""The server-side save diff: board History rows and per-object author/time stamps."""
import json
from unittest.mock import patch
from uuid import uuid4
from django.test import TransactionTestCase, override_settings
from apps.authentication.session import sign_session
from apps.projects.models import Project
from apps.workers import scheduler
from . import services
from .activity import ACTIVITY_RETENTION_MS, SNIPPET_LENGTH
from .models import BoardActivity, BoardMember, CanvasBoard
from .serialization import empty_state, validate_state
from .test_roles import make_user

PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
BOARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
T0 = 1700000000000


def rect(identifier, **fields):
    return {'id': identifier, 'type': 'rect', 'x': 0, 'y': 0, 'w': 10, 'h': 10, **fields}


def graph(*nodes, connectors=(), viewport=None):
    return {**empty_state(), 'nodes': list(nodes), 'connectors': list(connectors),
            **({'viewport': viewport} if viewport else {})}


@override_settings(ROOT_URLCONF='config.urls')
class BoardActivityTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.ana = make_user('ana')
        self.ben = make_user('ben')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.ana.id,
                                   data=empty_state(), created_at=1, updated_at=1)
        self.clock = T0

    def save(self, user, data, base=None, expect=200):
        """A save as `user`, at the next millisecond, over `base` (default: the board's current version)."""
        self.clock += 1000
        self.client.cookies['veevee_session'] = sign_session(user)
        base = CanvasBoard.objects.get(pk=BOARD).version if base is None else base
        with patch('apps.canvas.services.now_ms', return_value=self.clock):
            response = self.client.put('/api/canvas-boards/' + BOARD, content_type='application/json',
                                       data=json.dumps({'data': data, 'baseVersion': base, 'saveId': str(uuid4())}))
        self.assertEqual(response.status_code, expect, response.content)
        return response.json()

    def stored(self):
        return {item['id']: item for item in CanvasBoard.objects.get(pk=BOARD).data['nodes']}

    def history(self):
        return [(str(row.actor_id), row.action, row.node_id, row.node_type, row.snippet) for row in
                BoardActivity.objects.filter(board_id=BOARD).order_by('created_at', 'ordinal')]

    def test_adds_edits_and_deletes_are_recorded_and_stamped_and_moves_are_not(self):
        ana, ben = str(self.ana.id), str(self.ben.id)
        added = self.save(self.ana, graph(rect('a', text='  Hello\n  world '), {**rect('s'), 'type': 'sticky', 'text': 'Note'}))
        self.assertEqual(added['stamps'], {key: {'createdBy': ana, 'createdAt': self.clock, 'updatedBy': ana, 'updatedAt': self.clock}
                                           for key in ('a', 's')})
        self.assertEqual(self.stored()['a']['createdBy'], ana)
        created = self.clock
        # A move, a reparent and a regroup change arrangement, not content.
        moved = self.save(self.ben, graph(rect('a', x=50, y=60, groupId='g', text='  Hello\n  world '),
                                          {**rect('s'), 'type': 'sticky', 'text': 'Note', 'parentId': 'a'}))
        self.assertEqual((moved['version'], moved['stamps']), (3, {}))
        self.assertEqual({key: self.stored()['a'][key] for key in ('createdBy', 'updatedBy', 'updatedAt', 'x')},
                         {'createdBy': ana, 'updatedBy': ana, 'updatedAt': created, 'x': 50})
        edited = self.save(self.ben, graph(rect('a', x=50, y=60, groupId='g', text='Hello there', fill='#ff0000')))
        self.assertEqual(edited['stamps'], {'a': {'createdBy': ana, 'createdAt': created, 'updatedBy': ben, 'updatedAt': self.clock}})
        self.assertEqual(self.history(), [
            (ana, 'add', 'a', 'rect', 'Hello world'), (ana, 'add', 's', 'sticky', 'Note'),
            (ben, 'edit', 'a', 'rect', 'Hello there'), (ben, 'delete', 's', 'sticky', 'Note')])

    def test_client_stamps_are_ignored(self):
        ana = str(self.ana.id)
        forged = {'createdBy': str(self.ben.id), 'createdAt': 1, 'updatedBy': str(self.ben.id), 'updatedAt': 1}
        self.save(self.ana, graph(rect('a', **forged)))
        first = self.clock
        self.assertEqual({key: self.stored()['a'][key] for key in forged},
                         {'createdBy': ana, 'createdAt': first, 'updatedBy': ana, 'updatedAt': first})
        # Changing only the stamps is no change at all: same version, nothing recorded.
        unchanged = self.save(self.ben, graph(rect('a', **forged)))
        self.assertEqual((unchanged['version'], unchanged['stamps']), (2, {}))
        # Dropping them keeps the server's.
        self.save(self.ben, graph(rect('a')))
        self.assertEqual(self.stored()['a']['createdBy'], ana)
        self.assertEqual(len(self.history()), 1)

    def test_existing_boards_load_unchanged_and_legacy_objects_get_stamped_only_when_edited(self):
        legacy = graph(rect('old'), rect('kept'), viewport={'x': 4, 'y': 5, 'zoom': 2})
        CanvasBoard.objects.filter(pk=BOARD).update(data=legacy)
        self.client.cookies['veevee_session'] = sign_session(self.ana)
        self.assertEqual(self.client.get('/api/canvas-boards/' + BOARD).json()['data'], legacy)
        result = self.save(self.ben, graph(rect('old', w=20), rect('kept')))
        self.assertEqual(result['stamps'], {'old': {'updatedBy': str(self.ben.id), 'updatedAt': self.clock}})
        self.assertNotIn('updatedBy', self.stored()['kept'])
        self.assertEqual(self.history(), [(str(self.ben.id), 'edit', 'old', 'rect', None)])

    def test_both_serializers_carry_well_formed_stamps(self):
        stamps = {'createdBy': 'u1', 'createdAt': 5, 'updatedBy': 7, 'updatedAt': 'x'}
        state = validate_state(graph(rect('a', **stamps), connectors=[
            {'id': 'c', 'from': {'x': 0, 'y': 0}, 'to': {'x': 1, 'y': 1}, 'createdBy': 'u2', 'updatedAt': 9.5}]))
        self.assertEqual({key: state['nodes'][0].get(key) for key in stamps}, {'createdBy': 'u1', 'createdAt': 5, 'updatedBy': None, 'updatedAt': None})
        self.assertEqual((state['connectors'][0]['createdBy'], state['connectors'][0]['updatedAt']), ('u2', 9.5))

    def test_viewport_only_saves_record_nothing(self):
        self.save(self.ana, graph(rect('a')))
        panned = self.save(self.ben, graph(rect('a'), viewport={'x': 9, 'y': 9, 'zoom': 3}))
        self.assertEqual((panned['version'], panned['stamps']), (2, {}))
        self.assertEqual(len(self.history()), 1)

    def test_connectors_are_objects_and_moving_a_free_end_is_a_move(self):
        nodes = (rect('a'), rect('b'))
        free = {'id': 'c', 'from': {'x': 0, 'y': 0}, 'to': {'nodeId': 'a', 'anchor': 'auto'}}
        self.save(self.ana, graph(*nodes, connectors=[free]))
        moved = self.save(self.ana, graph(*nodes, connectors=[{**free, 'from': {'x': 30, 'y': 40}}]))
        self.assertEqual(moved['stamps'], {})
        attached = self.save(self.ben, graph(*nodes, connectors=[{**free, 'from': {'nodeId': 'b', 'anchor': 'top'}}]))
        self.assertEqual(set(attached['stamps']), {'c'})
        self.save(self.ben, graph(*nodes))
        self.assertEqual([row[1:4] for row in self.history() if row[2] == 'c'],
                         [('add', 'c', 'connector'), ('edit', 'c', 'connector'), ('delete', 'c', 'connector')])

    def test_snippets_use_frame_names_and_image_alt_text_and_are_short(self):
        long_text = 'word ' * 100
        self.save(self.ana, graph({**rect('f'), 'type': 'frame', 'name': 'Sprint plan'},
                                  {**rect('i'), 'type': 'image', 'src': '/api/media/canvas/x.png', 'alt': 'Moodboard'},
                                  {**rect('t'), 'type': 'text', 'text': long_text}, rect('plain')))
        snippets = {row[2]: row[4] for row in self.history()}
        self.assertEqual((snippets['f'], snippets['i'], snippets['plain']), ('Sprint plan', 'Moodboard', None))
        self.assertEqual(snippets['t'], ' '.join(long_text.split())[:SNIPPET_LENGTH])

    def test_merged_saves_after_a_conflict_record_only_the_merged_changes(self):
        """The 409 path of the conflict-safe autosave: the retry carries the other editor's objects with the
        stamps the server gave them, and only what this editor changed is theirs."""
        ana, ben = str(self.ana.id), str(self.ben.id)
        self.save(self.ana, graph(rect('shared'), rect('hers')))
        base = CanvasBoard.objects.get(pk=BOARD).version
        self.save(self.ana, graph(rect('shared', w=99), rect('hers', fill='#00ff00')))
        anas_edit = self.clock
        # Ben, still on the older version, is refused with Ana's graph...
        conflict = self.save(self.ben, graph(rect('shared'), rect('hers'), rect('his')), base=base, expect=409)
        remote = {item['id']: item for item in conflict['board']['data']['nodes']}
        self.assertEqual(remote['shared']['updatedBy'], ana)
        # ...merges it under his own edits (his new node, his change to `hers` wins) and saves the merged graph.
        merged = graph(remote['shared'], {**remote['hers'], 'fill': '#0000ff'}, rect('his'))
        result = self.save(self.ben, merged)
        self.assertEqual(set(result['stamps']), {'hers', 'his'})
        stored = self.stored()
        self.assertEqual((stored['shared']['updatedBy'], stored['shared']['updatedAt']), (ana, anas_edit))
        self.assertEqual((stored['hers']['createdBy'], stored['hers']['updatedBy']), (ana, ben))
        self.assertEqual([row[:3] for row in self.history()][-2:], [(ben, 'edit', 'hers'), (ben, 'add', 'his')])
        # A merge that drops the stamps (an older tab) or keeps a stale copy of them changes nothing of Ana's.
        stale = {**remote['shared'], 'updatedBy': ben, 'updatedAt': 1}
        again = self.save(self.ben, graph(stale, {**rect('hers', fill='#0000ff')}, rect('his')))
        self.assertEqual(again['stamps'], {})
        self.assertEqual(self.stored()['shared']['updatedBy'], ana)
        self.assertEqual(len(self.history()), 6)

    def test_a_refused_save_records_nothing(self):
        self.save(self.ana, graph(rect('a')))
        self.save(self.ben, graph(rect('b')), base=1, expect=409)
        self.assertEqual([row[2] for row in self.history()], ['a'])

    def test_a_graph_that_outgrows_the_limit_once_stamped_is_refused_without_writing(self):
        with patch('apps.canvas.services.MAX_BOARD_JSON_UNITS', 200):
            refused = self.save(self.ana, graph(rect('a'), rect('b')), expect=413)
        self.assertEqual(refused, {'error': 'Board is too large to save.'})
        self.assertEqual((CanvasBoard.objects.get(pk=BOARD).version, self.history()), (1, []))

    def activity(self, user, query=''):
        self.client.cookies['veevee_session'] = sign_session(user)
        return self.client.get(f'/api/canvas-boards/{BOARD}/activity{query}')

    def test_history_is_for_editors_only(self):
        self.save(self.ana, graph(rect('a', text='Hi')))
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        viewer, commenter, editor = (make_user(name) for name in ('viewer', 'commenter', 'editor'))
        for user, role in ((commenter, 'comment'), (editor, 'edit')):
            BoardMember.objects.create(board_id=BOARD, user_id=user.id, role=role, created_at=1, updated_at=1)
        statuses = {name: self.activity(user).status_code for name, user in
                    (('owner', self.ana), ('editor', editor), ('commenter', commenter), ('viewer', viewer))}
        self.assertEqual(statuses, {'owner': 200, 'editor': 200, 'commenter': 403, 'viewer': 403})
        self.assertEqual(self.activity(viewer).json(), {'error': 'FORBIDDEN'})
        # Refused before the cursor is even read.
        self.assertEqual(self.activity(commenter, '?before=x').status_code, 403)
        self.assertEqual(self.activity(editor).json(), {'next': None, 'activity': [
            {'actorId': str(self.ana.id), 'action': 'add', 'nodeId': 'a', 'nodeType': 'rect', 'snippet': 'Hi', 'at': self.clock}]})
        self.assertEqual(self.client.get('/api/canvas-boards/dddddddd-dddd-4ddd-8ddd-dddddddddddd/activity').status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(f'/api/canvas-boards/{BOARD}/activity').status_code, 401)

    def test_history_pages_newest_first_with_a_keyset_cursor(self):
        self.save(self.ana, graph(*(rect(f'n{index:03}') for index in range(services.ACTIVITY_PAGE + 5))))
        self.save(self.ben, graph())
        first = self.activity(self.ana).json()
        self.assertEqual(len(first['activity']), services.ACTIVITY_PAGE)
        self.assertEqual({row['action'] for row in first['activity']}, {'delete'})
        self.assertEqual(first['activity'][0]['nodeId'], f'n{services.ACTIVITY_PAGE + 4:03}')
        rest, seen = first, list(first['activity'])
        while rest['next']:
            rest = self.activity(self.ana, '?before=' + rest['next']).json()
            seen += rest['activity']
        self.assertEqual(len(seen), 2 * (services.ACTIVITY_PAGE + 5))
        self.assertEqual(seen[-1]['nodeId'], 'n000')
        self.assertEqual(seen[-1]['action'], 'add')
        for cursor in ('x', '1.', '-1.2', '1.2.3'):
            self.assertEqual(self.activity(self.ana, '?before=' + cursor).status_code, 400)

    def test_history_is_pruned_after_ninety_days_and_with_its_board(self):
        self.save(self.ana, graph(rect('old')))
        self.save(self.ana, graph(rect('old'), rect('new')))
        recent = self.clock
        with patch('apps.canvas.services.now_ms', return_value=recent - 1000 + ACTIVITY_RETENTION_MS):
            self.assertEqual(scheduler.default_handlers()['board_activity'](), {'ok': True, 'deleted': 1})
        self.assertEqual([row[2] for row in self.history()], ['new'])
        services.delete_board(BOARD)
        self.assertFalse(BoardActivity.objects.exists())
