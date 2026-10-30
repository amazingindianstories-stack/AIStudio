"""Locks, layers and board settings: the shared format v1 cases, apps.canvas.locks.enforce, and the save path that
puts back what a save may not change (a protected lock someone else holds, the start view)."""
import copy
import json
from pathlib import Path
from unittest.mock import patch as mock
from uuid import uuid4

from django.test import SimpleTestCase, TransactionTestCase, override_settings

from apps.authentication.session import sign_session
from apps.projects.models import Project, ProjectMember
from . import access, locks, patch as board_patch
from .models import BoardMember, CanvasBoard
from .serialization import STAMP_KEYS, empty_state, validate_state
from .test_activity import BOARD, PROJECT, T0, graph, rect
from .test_roles import make_user

FIXTURE = json.loads((Path(__file__).with_name('fixtures') / 'format_v1_arrange_lock.json').read_text())
SETTER, OTHER = 'setter', 'other'


def held(identifier='p', by=SETTER, **fields):
    return rect(identifier, locked=True, lockedBy=by, lockProtected=True, **fields)


def unstamped(data):
    return {**data, **{key: [{k: v for k, v in item.items() if k not in STAMP_KEYS} for item in data[key]]
                       for key in ('nodes', 'connectors')}}


class ArrangeLockSerializationTests(SimpleTestCase):
    def test_shared_cases_match_the_frontend_serializer(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                self.assertEqual(validate_state(copy.deepcopy(case['input'])), case['expected'])

    def test_validated_boards_round_trip_unchanged(self):
        for name, case in FIXTURE['cases'].items():
            with self.subTest(case=name):
                once = validate_state(copy.deepcopy(case['expected']))
                self.assertEqual(validate_state(json.loads(json.dumps(once))), once)


class EnforceTests(SimpleTestCase):
    def enforce(self, stored, data, actor=OTHER, level=access.EDIT):
        return locks.enforce(validate_state(stored), validate_state(data), actor, level)

    def test_a_protected_object_is_put_back_for_anyone_but_its_setter_and_other_changes_land(self):
        stored = graph(held('p'), rect('a'))
        for name, data in {'move': graph(held('p', x=50), rect('a', x=5)),
                           'edit': graph(held('p', fill='#ff0000'), rect('a', x=5)),
                           'unlock': graph(rect('p'), rect('a', x=5)),
                           'delete': graph(rect('a', x=5))}.items():
            with self.subTest(change=name):
                result, corrected = self.enforce(stored, data, level=access.OWNER)
                self.assertTrue(corrected)
                self.assertEqual(result['nodes'], validate_state(graph(held('p'), rect('a', x=5)))['nodes'])
        result, corrected = self.enforce(stored, graph(rect('p', x=50), rect('a')), actor=SETTER, level=access.CO_OWNER)
        self.assertFalse(corrected)
        self.assertEqual(result['nodes'][0], validate_state(graph(rect('p', x=50)))['nodes'][0])

    def test_a_deleted_protected_object_goes_back_where_it_was(self):
        result, corrected = self.enforce(graph(rect('a'), held('p'), rect('b')), graph(rect('a'), rect('b')))
        self.assertTrue(corrected)
        self.assertEqual([item['id'] for item in result['nodes']], ['a', 'p', 'b'])

    def test_co_owners_and_owners_protect_for_themselves_only(self):
        for level in (access.CO_OWNER, access.OWNER):
            with self.subTest(level=level):
                result, corrected = self.enforce(graph(rect('a')), graph(held('a', by=OTHER)), actor=OTHER, level=level)
                self.assertFalse(corrected)
                self.assertTrue(result['nodes'][0]['lockProtected'])
        # Naming someone else as the setter is a forgery: the lock stays, unprotected.
        result, corrected = self.enforce(graph(rect('a')), graph(held('a', by=SETTER)), actor=OTHER, level=access.OWNER)
        self.assertTrue(corrected)
        self.assertEqual((result['nodes'][0]['locked'], result['nodes'][0]['lockedBy'], 'lockProtected' in result['nodes'][0]),
                         (True, SETTER, False))

    def test_an_editor_cannot_protect(self):
        result, corrected = self.enforce(graph(rect('a')), graph(held('a', by=OTHER)), actor=OTHER, level=access.EDIT)
        self.assertTrue(corrected)
        self.assertNotIn('lockProtected', result['nodes'][0])
        self.assertTrue(result['nodes'][0]['locked'])

    def test_an_existing_protected_lock_kept_unchanged_by_its_setter_is_not_a_correction(self):
        # A save from a co-owner's editor carries the object as it was; that is no new protection.
        stored = graph(held('p', by=OTHER), rect('a'))
        result, corrected = self.enforce(stored, graph(held('p', by=OTHER), rect('a', x=1)), actor=OTHER, level=access.EDIT)
        self.assertFalse(corrected)
        self.assertTrue(result['nodes'][0]['lockProtected'])

    def test_plain_locks_are_not_enforced(self):
        stored = graph(rect('a', locked=True, lockedBy=SETTER), rect('b', locked=True))
        data = graph(rect('a', x=40))
        result, corrected = self.enforce(stored, data)
        self.assertFalse(corrected)
        self.assertEqual(result, validate_state(data))

    def test_only_co_owners_and_owners_change_the_start_view(self):
        view = {'x': 1, 'y': 2, 'zoom': 0.5}
        stored = {**graph(), 'settings': {'background': '#101010', 'startView': view}}
        moved = {**graph(), 'settings': {'background': '#202020', 'startView': {'x': 9, 'y': 9, 'zoom': 2}}}
        result, corrected = self.enforce(stored, moved, level=access.EDIT)
        self.assertTrue(corrected)
        self.assertEqual(result['settings'], {'background': '#202020', 'startView': view}, 'the background still changes')
        result, corrected = self.enforce(stored, {**graph(), 'settings': {'background': '#101010'}}, level=access.EDIT)
        self.assertEqual((corrected, result['settings']['startView']), (True, view), 'nor can an editor clear it')
        result, corrected = self.enforce(graph(), {**graph(), 'settings': {'startView': view}}, level=access.EDIT)
        self.assertEqual((corrected, 'settings' in result), (True, False), 'nor set one')
        for level in (access.CO_OWNER, access.OWNER):
            result, corrected = self.enforce(stored, moved, level=level)
            self.assertEqual((corrected, result['settings']['startView']), (False, {'x': 9, 'y': 9, 'zoom': 2}))

    def test_layers_and_background_are_anyone_who_edits(self):
        data = {**graph(rect('a', layerId='L')), 'settings': {'layers': [{'id': 'L', 'name': 'Top', 'locked': True}]}}
        result, corrected = self.enforce(graph(rect('a')), data, level=access.EDIT)
        self.assertFalse(corrected)
        self.assertEqual(result, validate_state(data))


class SettingsPatchTests(SimpleTestCase):
    stored = validate_state({**graph(rect('a')), 'settings': {'background': '#101010'}})

    def test_a_patch_replaces_settings_whole_and_null_clears_them(self):
        settings = {'layers': [{'id': 'L', 'name': 'Top'}]}
        self.assertEqual(board_patch.apply_patch(self.stored, {'settings': settings})['settings'], settings)
        self.assertNotIn('settings', board_patch.apply_patch(self.stored, {'settings': None}))
        self.assertEqual(board_patch.apply_patch(self.stored, {})['settings'], {'background': '#101010'})

    def test_changes_always_carry_the_settings(self):
        records = [{'nodes': [], 'connectors': []}]
        self.assertEqual(board_patch.changes_since(self.stored, records)['settings'], {'background': '#101010'})
        self.assertIsNone(board_patch.changes_since(validate_state(graph(rect('a'))), records)['settings'])


@override_settings(ROOT_URLCONF='config.urls')
class LockSaveTests(TransactionTestCase):
    """Saves through the board endpoint, as owner (ana), co-owner (cara) and editor (ben)."""

    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.ana = make_user('ana')
        self.ben = make_user('ben')
        self.cara = make_user('cara')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.ana.id,
                                   data=empty_state(), created_at=1, updated_at=1, team_role='view')
        BoardMember.objects.create(board_id=BOARD, user_id=self.ben.id, role='edit', created_at=1, updated_at=1)
        ProjectMember.objects.create(project_id=PROJECT, user_id=self.cara.id, role='co_owner', created_at=1, updated_at=1)
        self.clock = T0

    def send(self, user, method, payload, expect=200):
        self.clock += 1000
        self.client.cookies['veevee_session'] = sign_session(user)
        body = {**payload, 'baseVersion': CanvasBoard.objects.get(pk=BOARD).version, 'saveId': str(uuid4())}
        with mock('apps.canvas.services.now_ms', return_value=self.clock):
            response = getattr(self.client, method)('/api/canvas-boards/' + BOARD, content_type='application/json',
                                                    data=json.dumps(body))
        self.assertEqual(response.status_code, expect, response.content)
        return response.json()

    def put(self, user, data):
        return self.send(user, 'put', {'data': data})

    def patch(self, user, patch):
        return self.send(user, 'patch', {'patch': patch})

    def stored(self):
        return CanvasBoard.objects.get(pk=BOARD)

    def nodes(self):
        return {item['id']: {k: v for k, v in item.items() if k not in STAMP_KEYS} for item in self.stored().data['nodes']}

    def protect(self, user, *others):
        """`user` protects node p for themselves, beside the `others`."""
        saved = self.put(user, graph(held('p', by=str(user.id)), *others))
        self.assertNotIn('board', saved)
        self.assertTrue(self.nodes()['p']['lockProtected'])

    def test_a_co_owner_protects_and_an_editors_move_edit_or_delete_is_put_back_while_the_rest_lands(self):
        self.protect(self.cara, rect('a'))
        cara = str(self.cara.id)
        for name, data in {'move': graph(held('p', by=cara, x=50), rect('a', x=5)),
                           'unlock': graph(rect('p'), rect('a', x=6)),
                           'delete': graph(rect('a', x=7))}.items():
            with self.subTest(change=name):
                before = self.stored().version
                saved = self.put(self.ben, data)
                self.assertEqual(saved['version'], before + 1)
                self.assertEqual(unstamped(saved['board']), unstamped(self.stored().data))
                self.assertEqual(self.nodes()['p'], {k: v for k, v in validate_state(graph(held('p', by=cara)))['nodes'][0].items()})
                self.assertEqual(self.nodes()['a']['x'], data['nodes'][-1]['x'], 'the allowed change lands')
        # Even the owner cannot lift a co-owner's protected lock.
        self.assertIn('board', self.put(self.ana, graph(rect('p'), rect('a'))))
        self.assertTrue(self.nodes()['p']['lockProtected'])
        # The setter can.
        self.assertNotIn('board', self.put(self.cara, graph(rect('p', x=3), rect('a'))))
        self.assertEqual(self.nodes()['p'], validate_state(graph(rect('p', x=3)))['nodes'][0])

    def test_patch_saves_are_held_to_the_same_rules(self):
        self.protect(self.ana, rect('a'))
        ana = str(self.ana.id)
        before = self.stored().version
        saved = self.patch(self.ben, {'nodes': {'upsert': [held('p', by=ana, x=50), rect('a', x=5)], 'delete': []}})
        self.assertEqual((saved['version'], 'board' in saved), (before + 1, True))
        self.assertEqual((self.nodes()['p']['x'], self.nodes()['a']['x']), (0, 5))
        saved = self.patch(self.ben, {'nodes': {'delete': ['p']}})
        self.assertIn('p', self.nodes())
        self.assertEqual(unstamped(saved['board']), unstamped(self.stored().data))
        # An editor's own protection is stripped; a forged one naming the owner is too.
        self.patch(self.ben, {'nodes': {'upsert': [held('b', by=str(self.ben.id))], 'add': ['b']}})
        self.patch(self.ben, {'nodes': {'upsert': [held('c', by=ana)], 'add': ['c']}})
        self.assertEqual([(self.nodes()[key]['lockedBy'], 'lockProtected' in self.nodes()[key]) for key in ('b', 'c')],
                         [(str(self.ben.id), False), (ana, False)])

    def test_an_editors_protect_is_stripped_and_a_co_owner_cannot_forge_another_setter(self):
        saved = self.put(self.ben, graph(held('a', by=str(self.ben.id))))
        self.assertIn('board', saved)
        self.assertNotIn('lockProtected', saved['board']['nodes'][0])
        self.assertEqual(self.nodes()['a']['locked'], True)
        saved = self.put(self.cara, graph(rect('a'), held('b', by=str(self.ana.id))))
        self.assertIn('board', saved)
        self.assertEqual((self.nodes()['b']['lockedBy'], 'lockProtected' in self.nodes()['b']), (str(self.ana.id), False))

    def test_plain_locks_are_for_the_editor_only(self):
        self.put(self.ana, graph(rect('a', locked=True, lockedBy=str(self.ana.id))))
        saved = self.put(self.ben, graph(rect('a', x=9)))
        self.assertNotIn('board', saved)
        self.assertEqual(self.nodes()['a'], validate_state(graph(rect('a', x=9)))['nodes'][0])
        self.put(self.ben, graph())
        self.assertEqual(self.nodes(), {})

    def test_only_co_owners_and_owners_change_the_start_view(self):
        view = {'x': 1, 'y': 2, 'zoom': 0.5}
        self.assertNotIn('board', self.put(self.cara, {**graph(), 'settings': {'startView': view}}))
        saved = self.put(self.ben, {**graph(rect('a')), 'settings': {'startView': {'x': 0, 'y': 0, 'zoom': 4}, 'background': '#202020'}})
        self.assertEqual(saved['board']['settings'], {'background': '#202020', 'startView': view})
        self.assertEqual(self.stored().data['settings'], {'background': '#202020', 'startView': view})
        self.assertIn('a', self.nodes())
        saved = self.patch(self.ben, {'settings': None})
        self.assertEqual(self.stored().data['settings'], {'startView': view})
        self.assertNotIn('board', self.put(self.ana, {**graph(rect('a')), 'settings': {'startView': {'x': 5, 'y': 5, 'zoom': 1}}}))
        self.assertEqual(self.stored().data['settings']['startView'], {'x': 5, 'y': 5, 'zoom': 1})

    def test_a_saved_board_keeps_the_shared_cases(self):
        # The cases name person "7" as a lock's setter; here that is ana, who may protect for herself.
        cases = json.loads(json.dumps(FIXTURE['cases']).replace('"7"', json.dumps(str(self.ana.id))))
        for name, case in cases.items():
            with self.subTest(case=name):
                saved = self.put(self.ana, case['input'])
                self.assertNotIn('board', saved)
                self.assertEqual(unstamped(self.stored().data), case['expected'])
