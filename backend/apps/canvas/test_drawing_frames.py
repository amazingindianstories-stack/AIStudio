"""Ink, grid, synced copies, hidden frames and visual notes: the serializer cases the frontend also runs, how
hidden frames are enforced on read and on save, notes stamping, and the synced-frame routes per role."""
import copy
import json
from pathlib import Path
from uuid import uuid4

from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.projects.models import Project
from . import access, extras, hidden
from . import services
from .models import BoardActivity, BoardMember, CanvasBoard
from .serialization import validate_state

FIXTURE = json.loads((Path(__file__).with_name('fixtures') / 'format_v1_drawing_frames.json').read_text())


def node(identifier, kind='sticky', **fields):
    return {'id': identifier, 'type': kind, 'x': 0, 'y': 0, 'w': 100, 'h': 100, **({'text': ''} if kind == 'sticky' else {}), **fields}


def frame(identifier, **fields):
    return node(identifier, 'frame', name='Frame', **fields)


def graph(nodes, connectors=()):
    return validate_state({'nodes': list(nodes), 'connectors': list(connectors)})


def ids(state):
    return [item['id'] for item in state['nodes']]


class DrawingFramesSerializationTests(SimpleTestCase):
    def test_shared_cases_match_the_frontend_serializer(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                self.assertEqual(validate_state(copy.deepcopy(case['input'])), case['expected'])

    def test_validated_boards_round_trip_unchanged(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                once = validate_state(copy.deepcopy(case['expected']))
                self.assertEqual(validate_state(json.loads(json.dumps(once))), once)


class HiddenFramesTests(SimpleTestCase):
    def setUp(self):
        self.board = graph([
            frame('open'), frame('secret', hidden=True), node('inside', parentId='secret'),
            frame('nested', parentId='secret'), node('deep', parentId='nested'), node('outside'),
        ], [{'id': 'c1', 'from': {'nodeId': 'deep'}, 'to': {'nodeId': 'outside'}}, {'id': 'c2', 'from': {'nodeId': 'outside'}, 'to': {'nodeId': 'open'}}])

    def test_only_co_owners_and_above_manage(self):
        self.assertEqual([hidden.can_manage(level) for level in (access.VIEW, access.COMMENT, access.EDIT, access.CO_OWNER, access.OWNER)],
                         [False, False, False, True, True])

    def test_a_viewer_reads_an_empty_placeholder_and_no_connector_touching_the_content(self):
        seen = hidden.view_of(self.board, access.EDIT)
        self.assertEqual(ids(seen), ['open', 'secret', 'outside'])
        self.assertEqual([item['id'] for item in seen['connectors']], ['c2'])
        self.assertEqual(hidden.view_of(self.board, access.CO_OWNER), self.board)

    def test_visible_data_leaves_a_board_without_hidden_frames_untouched(self):
        raw = {'nodes': [node('a')], 'connectors': []}
        self.assertIs(hidden.visible_data(raw, access.VIEW), raw)

    def test_a_save_without_the_hidden_content_keeps_it_and_the_flags(self):
        seen = hidden.view_of(self.board, access.EDIT)
        edited = copy.deepcopy(seen)
        edited['nodes'] = [item for item in edited['nodes'] if item['id'] != 'outside']
        saved = hidden.preserve(self.board, edited, access.EDIT)
        self.assertEqual(sorted(ids(saved)), sorted(['open', 'secret', 'inside', 'nested', 'deep']))
        self.assertEqual([item['id'] for item in saved['connectors']], ['c1', 'c2'])
        self.assertTrue(next(item for item in saved['nodes'] if item['id'] == 'secret')['hidden'])

    def test_an_editor_cannot_reveal_hide_or_add_into_a_hidden_frame(self):
        edited = copy.deepcopy(hidden.view_of(self.board, access.EDIT))
        for item in edited['nodes']:
            if item['id'] == 'secret':
                del item['hidden']
            if item['id'] == 'open':
                item['hidden'] = True
        edited['nodes'].append(node('planted', parentId='secret'))
        saved = hidden.preserve(self.board, edited, access.EDIT)
        flags = {item['id']: item.get('hidden') for item in saved['nodes'] if item['type'] == 'frame'}
        self.assertEqual(flags['secret'], True)
        self.assertFalse(flags['open'])
        self.assertIsNone(next(item for item in saved['nodes'] if item['id'] == 'planted')['parentId'])

    def test_notes_links_to_hidden_objects_are_not_read_and_survive_a_save(self):
        board = graph(self.board['nodes'], self.board['connectors'])
        board['notes'] = {'text': 'Plan', 'refs': [{'id': 'outside', 'type': 'sticky', 'label': 'Out'},
                                                    {'id': 'deep', 'type': 'sticky', 'label': 'Secret plan'},
                                                    {'id': 'c1', 'type': 'connector', 'label': 'Secret link'}]}
        board = validate_state(board)
        seen = hidden.view_of(board, access.EDIT)
        self.assertEqual(seen['notes'], {'text': 'Plan', 'refs': [{'id': 'outside', 'type': 'sticky', 'label': 'Out'}]})
        self.assertEqual(hidden.view_of(board, access.CO_OWNER)['notes'], board['notes'])
        edited = copy.deepcopy(seen)
        edited['notes'] = {'text': 'Plan two', 'refs': [{'id': 'deep', 'type': 'sticky', 'label': 'Forged'}]}
        saved = hidden.preserve(board, edited, access.EDIT)
        self.assertEqual(saved['notes'], {'text': 'Plan two', 'refs': board['notes']['refs'][1:]})
        del edited['notes']
        self.assertEqual(hidden.preserve(board, edited, access.EDIT)['notes']['refs'], board['notes']['refs'][1:])

    def test_a_co_owner_save_is_taken_as_sent(self):
        edited = copy.deepcopy(self.board)
        for item in edited['nodes']:
            item.pop('hidden', None)
        self.assertEqual(hidden.preserve(self.board, edited, access.CO_OWNER), edited)


class NotesStampTests(SimpleTestCase):
    def test_changed_notes_are_stamped_by_the_server_and_unchanged_notes_keep_their_stamp(self):
        stored = {'notes': {'text': 'one', 'updatedBy': 'a', 'updatedAt': 1}}
        same = extras.stamp_notes(stored, {'notes': {'text': 'one', 'updatedBy': 'forged', 'updatedAt': 99}}, 'b', 5)
        self.assertEqual(same['notes'], {'text': 'one', 'updatedBy': 'a', 'updatedAt': 1})
        changed = extras.stamp_notes(stored, {'notes': {'text': 'two'}}, 'b', 5)
        self.assertEqual(changed['notes'], {'text': 'two', 'updatedBy': 'b', 'updatedAt': 5})
        self.assertEqual(extras.stamp_notes(stored, {'nodes': []}, 'b', 5), {'nodes': []})


PROJECT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
SOURCE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
OTHER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'


def make_user(name):
    return User.objects.create(id=uuid4(), email=f'{name}@example.invalid', name=name, role='user',
                               password_hash='x', password_salt='', created_at=1, is_active=True)


@override_settings(ROOT_URLCONF='config.urls')
class FrameRoutesTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.owner = make_user('owner')
        self.viewer = make_user('viewer')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        data = graph([frame('open'), node('a', parentId='open'), frame('secret', hidden=True), node('b', parentId='secret')])
        CanvasBoard.objects.create(id=SOURCE, project_id=PROJECT, name='Source', created_by=self.owner.id, data=data,
                                   team_role='view', created_at=1, updated_at=2)
        CanvasBoard.objects.create(id=OTHER, project_id=PROJECT, name='Copy holder', created_by=self.owner.id,
                                   data=graph([node('s1', 'synced', sourceBoardId=SOURCE, sourceNodeId='open')]), team_role='view', created_at=1, updated_at=2)
        BoardMember.objects.create(board_id=SOURCE, user_id=self.viewer.id, role='view', created_at=1, updated_at=1)

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def test_the_list_hides_hidden_frames_from_a_viewer_but_not_from_the_owner(self):
        self.as_user(self.viewer)
        self.assertEqual([f['id'] for f in self.client.get(f'/api/canvas-boards/{SOURCE}/frames').json()['frames']], ['open'])
        self.as_user(self.owner)
        self.assertEqual(sorted(f['id'] for f in self.client.get(f'/api/canvas-boards/{SOURCE}/frames').json()['frames']), ['open', 'secret'])

    def test_a_frame_is_read_with_what_is_inside_it_and_a_hidden_one_is_refused_to_a_viewer(self):
        self.as_user(self.viewer)
        body = self.client.get(f'/api/canvas-boards/{SOURCE}/frames/open').json()
        self.assertEqual(sorted(item['id'] for item in body['nodes']), ['a', 'open'])
        self.assertEqual(self.client.get(f'/api/canvas-boards/{SOURCE}/frames/secret').status_code, 404)
        self.as_user(self.owner)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{SOURCE}/frames/secret').status_code, 200)

    def test_a_missing_source_board_or_frame_is_not_found(self):
        self.as_user(self.viewer)
        self.assertEqual(self.client.get('/api/canvas-boards/00000000-0000-4000-8000-000000000000/frames').status_code, 404)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{SOURCE}/frames/nope').status_code, 404)

    def test_the_board_read_strips_hidden_content_for_a_viewer(self):
        self.as_user(self.viewer)
        read = self.client.get(f'/api/canvas-boards/{SOURCE}').json()
        self.assertNotIn('b', [item['id'] for item in read['data']['nodes']])
        self.as_user(self.owner)
        read = self.client.get(f'/api/canvas-boards/{SOURCE}').json()
        self.assertIn('b', [item['id'] for item in read['data']['nodes']])

    def test_a_frame_lists_the_boards_holding_a_synced_copy_of_it(self):
        self.as_user(self.owner)
        copies = self.client.get(f'/api/canvas-boards/{SOURCE}/frames/open/copies').json()['copies']
        self.assertEqual([(c['boardId'], c['nodeId'], c['projectId']) for c in copies], [(OTHER, 's1', PROJECT)])

    def test_copies_come_only_from_boards_the_caller_can_open_and_carry_their_project(self):
        elsewhere = 'abababab-abab-4bab-8bab-abababababab'
        Project.objects.create(id=elsewhere, name='Elsewhere', created_at=1, updated_at=1)
        held = graph([node('s2', 'synced', sourceBoardId=SOURCE, sourceNodeId='open')])
        far = CanvasBoard.objects.create(id=uuid4(), project_id=elsewhere, name='Far', created_by=self.owner.id, data=held,
                                         team_role='view', created_at=1, updated_at=2)
        stranger = make_user('stranger')
        readable = set(CanvasBoard.objects.filter(access.readable(stranger)).values_list('id', flat=True))
        levels = access.roles_for(stranger, list(CanvasBoard.objects.values('id', 'project_id', 'created_by', 'team_role')))
        self.assertEqual({str(identifier) for identifier in readable}, {key for key, level in levels.items() if level >= access.READ})
        self.as_user(stranger)
        copies = self.client.get(f'/api/canvas-boards/{SOURCE}/frames/open/copies').json()['copies']
        self.assertEqual(sorted((c['boardId'], c['projectId']) for c in copies), sorted([(OTHER, PROJECT), (str(far.id), elsewhere)]))

    def test_a_notes_link_to_hidden_work_deleted_later_reaches_an_editor_without_its_label(self):
        editor = make_user('editor')
        BoardMember.objects.create(board_id=SOURCE, user_id=editor.id, role='edit', created_at=1, updated_at=1)
        stored = CanvasBoard.objects.get(pk=SOURCE).data
        CanvasBoard.objects.filter(pk=SOURCE).update(data={**stored, 'notes': {'text': 'Plan', 'refs': [
            {'id': 'a', 'type': 'sticky', 'label': 'Open work'}, {'id': 'b', 'type': 'sticky', 'label': 'Secret plan'}]}})

        def save(data, base):
            response = self.client.put(f'/api/canvas-boards/{SOURCE}', content_type='application/json',
                                       data=json.dumps({'data': data, 'baseVersion': base, 'saveId': str(uuid4())}))
            self.assertEqual(response.status_code, 200, response.content)
            return response.json()['version']

        self.as_user(self.owner)
        owned = self.client.get(f'/api/canvas-boards/{SOURCE}').json()
        last = owned['data']
        last['nodes'] = [item for item in last['nodes'] if item['id'] not in ('secret', 'b')]
        last['notes'] = {**last['notes'], 'text': 'Plan two'}
        version = save(last, owned['version'])

        unlabeled = [{'id': 'a', 'type': 'sticky', 'label': 'Open work'}, {'id': 'b', 'type': 'sticky', 'label': ''}]
        self.as_user(editor)
        read = self.client.get(f'/api/canvas-boards/{SOURCE}').json()
        self.assertEqual(read['data']['notes']['refs'], unlabeled)
        polled = self.client.get(f'/api/canvas-boards/{SOURCE}/changes', {'since': version - 1}).json()
        self.assertEqual(polled['changes']['notes']['refs'], unlabeled)
        edited = read['data']
        edited['notes'] = {**edited['notes'], 'text': 'Plan three'}
        save(edited, version)

        self.as_user(self.owner)
        notes = self.client.get(f'/api/canvas-boards/{SOURCE}').json()['data']['notes']
        self.assertEqual((notes['text'], [ref['label'] for ref in notes['refs']]), ('Plan three', ['Open work', 'Secret plan']))

    def test_history_hides_hidden_work_from_a_viewer_who_cannot_manage_it(self):
        CanvasBoard.objects.filter(pk=SOURCE).update(data=graph(
            [frame('open'), node('a', parentId='open', text='Visible'), frame('secret', hidden=True), node('b', parentId='secret', text='Secret')],
            [{'id': 'c1', 'from': {'nodeId': 'a'}, 'to': {'nodeId': 'b'}}, {'id': 'c2', 'from': {'nodeId': 'a'}, 'to': {'nodeId': 'open'}}]))
        rows = [('add', 'a', 'sticky', 'Visible'), ('edit', 'b', 'sticky', 'Secret'), ('add', 'c1', 'connector', None),
                ('add', 'c2', 'connector', None), ('delete', 'gone', 'sticky', 'Moved out of a hidden frame and deleted')]
        BoardActivity.objects.bulk_create([BoardActivity(board_id=SOURCE, actor_id=self.owner.id, action=action, node_id=node_id,
                                                         node_type=kind, snippet=text, created_at=10, ordinal=position)
                                           for position, (action, node_id, kind, text) in enumerate(rows)])
        seen = {row['nodeId']: (row['action'], row['actorId'], row['snippet'])
                for row in services.board_activity(SOURCE, level=access.EDIT)['activity']}
        self.assertEqual(seen, {'a': ('add', str(self.owner.id), 'Visible'), 'c2': ('add', str(self.owner.id), None),
                                'gone': ('delete', str(self.owner.id), None)})
        managed = {row['nodeId']: row['snippet'] for row in services.board_activity(SOURCE, level=access.CO_OWNER)['activity']}
        self.assertEqual(managed, {'a': 'Visible', 'b': 'Secret', 'c1': None, 'c2': None, 'gone': 'Moved out of a hidden frame and deleted'})
