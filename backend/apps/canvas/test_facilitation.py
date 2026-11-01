"""Live facilitation: the board timer, voting sessions and private mode, each over the real routes."""
import json
from unittest.mock import patch
from uuid import uuid4
from django.test import TransactionTestCase, override_settings
from apps.authentication.session import sign_session
from apps.projects.models import Project
from .models import BoardActivity, BoardMember, CanvasBoard
from .serialization import empty_state
from .test_roles import make_user

PROJECT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
BOARD = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
T0 = 1700000000000


def sticky(identifier, text='', **fields):
    return {'id': identifier, 'type': 'sticky', 'x': 0, 'y': 0, 'w': 100, 'h': 100, 'text': text, **fields}


def graph(*nodes):
    return {**empty_state(), 'nodes': list(nodes)}


@override_settings(ROOT_URLCONF='config.urls')
class FacilitationBase(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.ana = make_user('ana')
        self.ben = make_user('ben')
        self.cat = make_user('cat')
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.ana.id,
                                   data=empty_state(), created_at=1, updated_at=1)
        self.clock = T0

    def tick(self, ms=1000):
        self.clock += ms

    def call(self, user, method, path, data=None, expect=200):
        self.client.cookies['veevee_session'] = sign_session(user)
        url = f'/api/canvas-boards/{BOARD}{path}'
        with patch('apps.canvas.services.now_ms', return_value=self.clock):
            if method == 'get':
                response = self.client.get(url)
            else:
                response = getattr(self.client, method)(url, content_type='application/json', data=json.dumps(data or {}))
        self.assertEqual(response.status_code, expect, response.content)
        return response.json()

    def save(self, user, data, expect=200, patch_body=None):
        self.tick()
        base = CanvasBoard.objects.get(pk=BOARD).version
        payload = {'baseVersion': base, 'saveId': str(uuid4())}
        payload.update({'patch': patch_body} if patch_body is not None else {'data': data})
        return self.call(user, 'patch' if patch_body is not None else 'put', '', payload, expect)

    def seed(self, *nodes):
        CanvasBoard.objects.filter(pk=BOARD).update(data=graph(*nodes), version=2)

    def read(self, user):
        return {node['id']: node for node in self.call(user, 'get', '')['data']['nodes']}


class TimerTests(FacilitationBase):
    def test_start_pause_resume_add_and_stop_follow_the_server_clock(self):
        started = self.call(self.ana, 'post', '/timer', {'action': 'start', 'durationMs': 60000, 'music': 'calm'})['timer']
        self.assertEqual((started['state'], started['endsAt'], started['run'], started['music']), ('running', T0 + 60000, 1, 'calm'))
        snapshot = self.call(self.ben, 'get', '/facilitation')
        self.assertEqual((snapshot['serverNow'], snapshot['timer']['endsAt']), (T0, T0 + 60000))
        self.tick(20000)
        paused = self.call(self.ana, 'post', '/timer', {'action': 'pause'})['timer']
        self.assertEqual((paused['state'], paused['remainingMs'], paused['endsAt']), ('paused', 40000, None))
        self.tick(30000)
        self.call(self.ana, 'post', '/timer', {'action': 'add', 'addMs': 60000})
        resumed = self.call(self.ana, 'post', '/timer', {'action': 'resume'})['timer']
        self.assertEqual((resumed['state'], resumed['endsAt']), ('running', self.clock + 100000))
        added = self.call(self.ana, 'post', '/timer', {'action': 'add', 'addMs': 300000})['timer']
        self.assertEqual(added['endsAt'], self.clock + 400000)
        self.assertEqual(self.call(self.ana, 'post', '/timer', {'action': 'stop'})['timer']['state'], 'stopped')
        restarted = self.call(self.ana, 'post', '/timer', {'action': 'start', 'durationMs': 5000})['timer']
        self.assertEqual(restarted['run'], 2)

    def test_invalid_actions_are_refused(self):
        self.call(self.ana, 'post', '/timer', {'action': 'pause'}, expect=409)
        self.call(self.ana, 'post', '/timer', {'action': 'start', 'durationMs': 5}, expect=400)
        self.call(self.ana, 'post', '/timer', {'action': 'start', 'durationMs': 5000, 'music': 'nope'}, expect=400)
        self.call(self.ana, 'post', '/timer', {'action': 'add', 'addMs': 60000}, expect=409)
        self.call(self.ana, 'post', '/timer', {'action': 'bogus'}, expect=400)

    def test_an_expired_timer_cannot_be_paused_or_extended(self):
        self.call(self.ana, 'post', '/timer', {'action': 'start', 'durationMs': 5000})
        self.tick(6000)
        self.call(self.ana, 'post', '/timer', {'action': 'pause'}, expect=409)
        self.call(self.ana, 'post', '/timer', {'action': 'add', 'addMs': 60000}, expect=409)

    def test_viewers_and_commenters_read_the_timer_but_cannot_control_it(self):
        BoardMember.objects.create(board_id=BOARD, user_id=self.ben.id, role='view', created_at=1, updated_at=1)
        BoardMember.objects.create(board_id=BOARD, user_id=self.cat.id, role='comment', created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        for user in (self.ben, self.cat):
            self.call(user, 'post', '/timer', {'action': 'start', 'durationMs': 5000}, expect=403)
            self.assertEqual(self.call(user, 'get', '/facilitation')['timer']['state'], 'stopped')


class VotingTests(FacilitationBase):
    def setUp(self):
        super().setUp()
        self.seed(sticky('a', 'Alpha'), sticky('b', 'Beta'), {'id': 'r', 'type': 'rect', 'x': 0, 'y': 0, 'w': 10, 'h': 10})

    def start(self, **fields):
        return self.call(self.ana, 'post', '/voting', {'name': 'Dot vote', 'votesPerPerson': 3, **fields})['session']

    def vote(self, user, session, node, votes, expect=200):
        return self.call(user, 'post', f"/voting/{session['id']}/vote", {'nodeId': node, 'votes': votes}, expect)

    def test_votes_are_limited_per_person_and_results_are_aggregated_for_everyone(self):
        session = self.start()
        self.vote(self.ana, session, 'a', 2)
        self.vote(self.ana, session, 'b', 1)
        self.vote(self.ana, session, 'b', 2, expect=409)
        self.vote(self.ben, session, 'b', 3)
        mine = self.call(self.ana, 'get', '/facilitation')['voting']['active']
        self.assertEqual((mine['myVotes'], mine['votesUsed'], mine['progress']), ({'a': 2, 'b': 1}, 3, {'voted': 2, 'done': 0}))
        # Another person sees no totals and no progress while voting runs.
        BoardMember.objects.create(board_id=BOARD, user_id=self.cat.id, role='comment', created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        theirs = self.call(self.cat, 'get', '/facilitation')['voting']['active']
        self.assertEqual((theirs['myVotes'], 'progress' in theirs, 'results' in theirs), ({}, False, False))
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'end'})
        listed = self.call(self.cat, 'get', '/voting')['sessions'][0]
        self.assertEqual([(row['nodeId'], row['votes'], row['voters'], row['top'], row['label']) for row in listed['results']],
                         [('b', 4, 2, True, 'Beta'), ('a', 2, 1, True, 'Alpha')])
        self.assertEqual((listed['totalVotes'], listed['participants']), (6, 2))

    def test_one_vote_per_object_and_the_area_and_types_are_enforced(self):
        session = self.start(oneVotePerObject=True, objectTypes=['sticky'])
        self.vote(self.ana, session, 'a', 2, expect=409)
        self.vote(self.ana, session, 'a', 1)
        self.vote(self.ana, session, 'r', 1, expect=409)
        self.vote(self.ana, session, 'missing', 1, expect=409)
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'end'})
        framed = self.start(area={'x': 500, 'y': 500, 'w': 10, 'h': 10})
        self.vote(self.ana, framed, 'a', 1, expect=409)

    def test_only_one_session_runs_and_saved_sessions_start_later(self):
        saved = self.start(saveForLater=True)
        self.assertEqual(saved['status'], 'saved')
        running = self.start()
        self.call(self.ana, 'post', '/voting', {'name': 'Second', 'votesPerPerson': 1}, expect=409)
        self.call(self.ana, 'post', f"/voting/{saved['id']}", {'action': 'start'}, expect=409)
        self.call(self.ana, 'post', f"/voting/{running['id']}", {'action': 'end'})
        started = self.call(self.ana, 'post', f"/voting/{saved['id']}", {'action': 'start'})['session']
        self.assertEqual(started['status'], 'active')

    def test_a_timed_session_ends_by_the_server_clock_and_time_can_be_added(self):
        session = self.start(durationMs=60000)
        self.vote(self.ana, session, 'a', 1)
        self.tick(30000)
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'addTime', 'addMs': 60000})
        self.tick(40000)
        self.vote(self.ana, session, 'a', 2)
        self.tick(60000)
        self.vote(self.ana, session, 'a', 3, expect=409)
        listed = self.call(self.ana, 'get', '/voting')['sessions'][0]
        self.assertEqual((listed['status'], listed['endedAt']), ('ended', T0 + 120000))
        self.assertIsNone(self.call(self.ana, 'get', '/facilitation')['voting']['active'])

    def test_done_stops_voting_and_counts_in_progress(self):
        session = self.start()
        self.vote(self.ben, session, 'a', 1)
        self.call(self.ben, 'post', f"/voting/{session['id']}/done", {})
        self.vote(self.ben, session, 'a', 2, expect=409)
        active = self.call(self.ana, 'get', '/facilitation')['voting']['active']
        self.assertEqual(active['progress'], {'voted': 1, 'done': 1})
        self.call(self.ben, 'post', f"/voting/{session['id']}/done", {'done': False})
        self.vote(self.ben, session, 'a', 2)

    def test_results_stay_on_the_board_rename_and_delete(self):
        session = self.start()
        self.vote(self.ana, session, 'a', 2)
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'showOnBoard', 'value': True}, expect=409)
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'delete'}, expect=409)
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'end'})
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'showOnBoard', 'value': True})
        shown = self.call(self.cat, 'get', '/facilitation')['voting']['shown']
        self.assertEqual((shown['name'], shown['totals']), ('Dot vote', {'a': 2}))
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'rename', 'name': 'Round 1'})
        self.assertEqual(self.call(self.ana, 'get', '/voting')['sessions'][0]['name'], 'Round 1')
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'delete'})
        self.assertEqual(self.call(self.ana, 'get', '/voting')['sessions'], [])
        self.assertIsNone(self.call(self.ana, 'get', '/facilitation')['voting']['shown'])

    def test_roles_viewers_read_commenters_vote_and_only_editors_manage(self):
        session = self.start()
        BoardMember.objects.create(board_id=BOARD, user_id=self.ben.id, role='view', created_at=1, updated_at=1)
        BoardMember.objects.create(board_id=BOARD, user_id=self.cat.id, role='comment', created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        self.vote(self.ben, session, 'a', 1, expect=403)
        self.vote(self.cat, session, 'a', 1)
        for user in (self.ben, self.cat):
            self.call(user, 'post', '/voting', {'name': 'x', 'votesPerPerson': 1}, expect=403)
            self.call(user, 'post', f"/voting/{session['id']}", {'action': 'end'}, expect=403)
        self.assertEqual(self.call(self.ben, 'get', '/voting')['sessions'][0]['status'], 'active')

    def test_setup_is_validated(self):
        self.call(self.ana, 'post', '/voting', {'name': '', 'votesPerPerson': 3}, expect=400)
        self.call(self.ana, 'post', '/voting', {'name': 'x', 'votesPerPerson': 100}, expect=400)
        self.call(self.ana, 'post', '/voting', {'name': 'x', 'votesPerPerson': 0}, expect=400)
        self.call(self.ana, 'post', '/voting', {'name': 'x', 'votesPerPerson': 1, 'objectTypes': ['bogus']}, expect=400)
        self.call(self.ana, 'post', '/voting', {'name': 'x', 'votesPerPerson': 1, 'durationMs': 5}, expect=400)

    def test_voting_label_never_shows_text_hidden_by_private_mode(self):
        self.call(self.ana, 'post', '/private-mode', {'action': 'start'})
        self.seed(sticky('a', 'Secret', privateBy=str(self.ben.id)), sticky('b', 'Open'))
        session = self.start()
        self.vote(self.ana, session, 'a', 1)
        self.call(self.ana, 'post', f"/voting/{session['id']}", {'action': 'end'})
        labels = {row['nodeId']: row['label'] for row in self.call(self.ana, 'get', '/voting')['sessions'][0]['results']}
        self.assertIsNone(labels['a'])
        self.assertEqual(self.call(self.ben, 'get', '/voting')['sessions'][0]['results'][0]['label'], 'Secret')


class PrivateModeTests(FacilitationBase):
    def start_mode(self, **fields):
        return self.call(self.ana, 'post', '/private-mode', {'action': 'start', **fields})['privateMode']

    def test_other_peoples_new_and_edited_notes_are_hidden_and_never_leave_the_server(self):
        self.seed(sticky('old', 'Public'))
        self.start_mode()
        self.save(self.ben, graph(sticky('old', 'Public'), sticky('mine', 'Ben secret')))
        self.save(self.cat, graph(sticky('old', 'Cat rewrote'), sticky('mine', 'Ben secret')))
        ana_view = self.read(self.ana)
        self.assertEqual((ana_view['old']['text'], ana_view['old']['hiddenText'], 'marks' in ana_view['old']), ('', True, False))
        self.assertEqual((ana_view['mine']['text'], ana_view['mine']['hiddenText']), ('', True))
        self.assertEqual(self.read(self.ben)['mine']['text'], 'Ben secret')
        self.assertEqual(self.read(self.cat)['old']['text'], 'Cat rewrote')
        self.assertNotIn('Ben secret', json.dumps(self.call(self.ana, 'get', '')['data']))

    def test_a_client_that_cannot_read_a_note_cannot_erase_it_by_saving(self):
        self.start_mode()
        self.save(self.ben, graph(sticky('s', 'Ben secret', marks=[[0, 3, 'b']])))
        seen = self.read(self.ana)['s']
        self.assertEqual(seen['text'], '')
        # Moving it, resizing it and saving the whole board all keep the text.
        self.save(self.ana, graph({**seen, 'x': 40, 'w': 220}))
        self.save(self.ana, None, patch_body={'nodes': {'upsert': [{**seen, 'x': 40, 'w': 220, 'y': 55}]}})
        stored = CanvasBoard.objects.get(pk=BOARD).data['nodes'][0]
        self.assertEqual((stored['text'], stored['x'], stored['y'], stored['w'], stored['privateBy']),
                         ('Ben secret', 40, 55, 220, str(self.ben.id)))
        self.assertEqual(stored['marks'], [[0, 3, 'b']])
        # Trying to claim it or write over its text changes neither the owner nor the text.
        self.save(self.ana, graph({**seen, 'text': 'Hijack', 'privateBy': str(self.ana.id)}))
        stored = CanvasBoard.objects.get(pk=BOARD).data['nodes'][0]
        self.assertEqual((stored['text'], stored['privateBy']), ('Ben secret', str(self.ben.id)))
        self.assertTrue(all(row.snippet is None for row in BoardActivity.objects.filter(board_id=BOARD, actor_id=self.ana.id)))

    def test_history_never_records_private_text(self):
        self.start_mode()
        self.save(self.ben, graph(sticky('s', 'Ben secret')))
        self.assertEqual([row.snippet for row in BoardActivity.objects.filter(board_id=BOARD)], [None])

    def test_the_owner_may_reveal_their_own_notes_and_everyone_after_a_countdown(self):
        self.start_mode()
        self.save(self.ben, graph(sticky('b', 'Ben')))
        self.save(self.cat, graph(sticky('b', 'Ben'), sticky('c', 'Cat')))
        self.call(self.ben, 'post', '/private-mode', {'action': 'revealMine'})
        self.assertEqual(self.read(self.ana)['b']['text'], 'Ben')
        self.assertTrue(self.read(self.ana)['c']['hiddenText'])
        revealing = self.call(self.ana, 'post', '/private-mode', {'action': 'reveal'})['privateMode']
        self.assertEqual(revealing['revealAt'], self.clock + 5000)
        self.assertTrue(self.read(self.ana)['c']['hiddenText'])
        self.tick(5000)
        self.assertEqual(self.read(self.ana)['c']['text'], 'Cat')
        self.assertFalse(self.call(self.ana, 'get', '/facilitation')['privateMode']['active'])
        self.assertNotIn('privateBy', CanvasBoard.objects.get(pk=BOARD).data['nodes'][1])

    def test_revealing_follows_the_starters_choice(self):
        self.start_mode(allowOthersEnd=False)
        self.call(self.ben, 'post', '/private-mode', {'action': 'reveal'}, expect=403)
        self.call(self.ana, 'post', '/private-mode', {'action': 'reveal'})
        self.call(self.ana, 'post', '/private-mode', {'action': 'start'}, expect=409)

    def test_others_may_end_when_the_starter_allows_it(self):
        self.start_mode()
        self.call(self.ben, 'post', '/private-mode', {'action': 'reveal'})

    def test_anonymous_notes_withhold_their_author_for_good(self):
        self.start_mode(anonymous=True)
        self.save(self.ben, graph(sticky('s', 'Ben anonymous')))
        self.call(self.ana, 'post', '/private-mode', {'action': 'reveal'})
        self.tick(5000)
        seen = self.read(self.ana)['s']
        self.assertEqual(seen['text'], 'Ben anonymous')
        self.assertFalse(any(key in seen for key in ('createdBy', 'updatedBy', 'textBy', 'privateBy')))
        self.assertEqual(self.read(self.ben)['s']['createdBy'], str(self.ben.id))

    def test_viewers_cannot_start_or_reveal_but_never_see_hidden_text(self):
        BoardMember.objects.create(board_id=BOARD, user_id=self.cat.id, role='view', created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        self.start_mode()
        self.call(self.cat, 'post', '/private-mode', {'action': 'reveal'}, expect=403)
        self.assertTrue(self.call(self.cat, 'get', '/facilitation')['privateMode']['active'])

    def test_changes_and_conflicts_are_redacted_too(self):
        self.start_mode()
        before = CanvasBoard.objects.get(pk=BOARD).version
        self.save(self.ben, graph(sticky('s', 'Ben secret')))
        changes = self.call(self.ana, 'get', f'/changes?since={before}')['changes']['nodes']['upsert']
        self.assertEqual((changes[0]['text'], changes[0]['hiddenText']), ('', True))
        self.tick()
        conflict = self.call(self.ana, 'put', '', {'data': graph(), 'baseVersion': before, 'saveId': str(uuid4())}, expect=409)
        self.assertNotIn('Ben secret', json.dumps(conflict))
