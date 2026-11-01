"""Board collaboration: comments, threads, mentions, notifications, presence, collaboration-tool setting, Web Push."""
import json
from unittest.mock import MagicMock
from uuid import uuid4
from django.test import TransactionTestCase, override_settings
from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.projects.models import Project, ProjectMember
from . import comments, push
from .collab_models import BoardComment, BoardPresence, CommentFollow, Notification, PushSubscription
from .models import BoardMember, CanvasBoard
from .test_roles import BOARD, PROJECT, make_user

ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc'


def mention(user):
    return f'@[{user.name}](user:{user.id})'


@override_settings(ROOT_URLCONF='config.urls')
class CollabTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.owner, self.mate, self.viewer, self.third = (make_user(n) for n in ('owner', 'mate', 'viewer', 'third'))
        Project.objects.create(id=PROJECT, name='Project', created_at=1, updated_at=1, created_by=self.owner.id)
        CanvasBoard.objects.create(id=BOARD, project_id=PROJECT, name='Board', created_by=self.owner.id,
                                   data={}, created_at=1, updated_at=2, team_role='comment')
        BoardMember.objects.create(board_id=BOARD, user_id=self.mate.id, role='edit', created_at=1, updated_at=1)
        BoardMember.objects.create(board_id=BOARD, user_id=self.viewer.id, role='view', created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        BoardMember.objects.create(board_id=BOARD, user_id=self.third.id, role='comment', created_at=1, updated_at=1)
        self.base = f'/api/canvas-boards/{BOARD}'

    def as_user(self, user):
        self.client.cookies['veevee_session'] = sign_session(user)

    def send(self, method, path, data=None):
        if method == 'get':
            return self.client.get(path)
        return getattr(self.client, method)(path, data=json.dumps(data if data is not None else {}), content_type='application/json')

    def post(self, user, body, **extra):
        self.as_user(user)
        response = self.send('post', self.base + '/comments', {'body': body, 'x': 10, 'y': 20, **extra})
        return response, (response.json().get('comment') if response.status_code == 201 else None)

    def test_only_commenters_and_up_can_comment_and_everyone_can_read(self):
        self.assertEqual(self.post(self.viewer, 'hi')[0].status_code, 403)
        self.assertEqual(self.post(self.third, 'hi')[0].status_code, 201)
        self.assertEqual(self.post(self.mate, 'there')[0].status_code, 201)
        self.as_user(self.viewer)
        listed = self.send('get', self.base + '/comments').json()['comments']
        self.assertEqual([c['body'] for c in listed], ['hi', 'there'])
        self.as_user(make_user('stranger'))
        self.assertEqual(self.send('get', self.base + '/comments').status_code, 200)   # team access is view
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')

    def test_validation(self):
        for body in ('', '   ', 'x' * 4001, 5):
            self.assertEqual(self.post(self.mate, body)[0].status_code, 400, body)
        self.assertEqual(self.post(self.mate, 'ok', color='red')[0].status_code, 400)
        self.assertEqual(self.post(self.mate, 'ok', x=float('1e9'))[0].status_code, 400)
        self.assertEqual(self.post(self.mate, 'ok', anchorNodeId='n1', anchorDx=3, anchorDy=4, x=None, y=None)[0].status_code, 201)
        self.as_user(self.mate)
        self.assertEqual(self.send('post', self.base + '/comments', {'body': 'nowhere'}).status_code, 400)
        self.assertEqual(self.send('post', self.base + '/comments', {'body': 'r', 'parentId': str(uuid4())}).status_code, 404)

    def test_threads_edit_delete_resolve_react(self):
        _, root = self.post(self.mate, 'root', color='#FF0000')
        self.assertEqual(root['color'], '#ff0000')
        _, reply = self.post(self.third, 'reply', parentId=root['id'])
        self.assertEqual(reply['parentId'], root['id'])
        _, nested = self.post(self.third, 'nested', parentId=reply['id'])
        self.assertIsNone(nested)
        self.as_user(self.third)
        self.assertEqual(self.send('patch', f"{self.base}/comments/{root['id']}", {'body': 'hijack'}).status_code, 403)
        edited = self.send('patch', f"{self.base}/comments/{reply['id']}", {'body': 'edited'}).json()['comment']
        self.assertEqual((edited['body'], bool(edited['editedAt'])), ('edited', True))
        self.assertEqual(self.send('post', f"{self.base}/comments/{root['id']}/resolve", {}).json()['comment']['resolvedAt'] > 0, True)
        self.assertIsNone(self.send('post', f"{self.base}/comments/{root['id']}/resolve", {'resolved': False}).json()['comment']['resolvedAt'])
        self.assertEqual(self.send('post', f"{self.base}/comments/{reply['id']}/resolve", {}).status_code, 400)
        reacted = self.send('post', f"{self.base}/comments/{root['id']}/react", {'emoji': '👍'}).json()['comment']
        self.assertEqual(reacted['reactions'], {'👍': [str(self.third.id)]})
        self.assertEqual(self.send('post', f"{self.base}/comments/{root['id']}/react", {'emoji': '👍'}).json()['comment']['reactions'], {})
        self.assertEqual(self.send('post', f"{self.base}/comments/{root['id']}/react", {'emoji': 'x'}).status_code, 400)
        self.as_user(self.owner)   # the board owner may delete anyone's comment
        self.assertEqual(self.send('delete', f"{self.base}/comments/{root['id']}").status_code, 200)
        self.assertEqual(self.send('get', self.base + '/comments').json()['comments'], [])   # a full load omits tombstones
        listed = {c['id']: c for c in self.send('get', self.base + '/comments?since=0').json()['comments']}
        self.assertTrue(listed[root['id']]['deleted'] and listed[reply['id']]['deleted'])
        self.assertEqual(listed[root['id']]['body'], '')

    def test_poll_returns_changes_and_tombstones_are_pruned(self):
        _, first = self.post(self.mate, 'one')
        self.as_user(self.third)
        polled = self.send('post', self.base + '/pulse?since=' + str(first['updatedAt'] + 10000)).json()
        self.assertEqual(polled['comments'], [])
        _, second = self.post(self.mate, 'two')
        polled = self.send('post', self.base + '/pulse?since=' + str(second['updatedAt'])).json()
        self.assertIn('two', [c['body'] for c in polled['comments']])
        BoardComment.objects.filter(pk=first['id']).update(deleted_at=1)
        self.post(self.mate, 'three')
        self.assertFalse(BoardComment.objects.filter(pk=first['id']).exists())

    def test_read_and_unread(self):
        _, root = self.post(self.mate, 'root')
        self.as_user(self.third)
        self.assertFalse(self.send('get', self.base + '/comments').json()['comments'][0]['read'])
        self.send('post', self.base + '/comments/read', {'ids': [root['id']]})
        self.assertTrue(self.send('get', self.base + '/comments').json()['comments'][0]['read'])
        self.send('post', self.base + '/comments/read', {'ids': [root['id']], 'unread': True})
        self.assertFalse(self.send('get', self.base + '/comments').json()['comments'][0]['read'])
        self.send('post', self.base + '/comments/read', {'all': True})
        self.assertTrue(self.send('get', self.base + '/comments').json()['comments'][0]['read'])
        self.as_user(self.mate)
        self.assertTrue(self.send('get', self.base + '/comments').json()['comments'][0]['read'])   # own comments are never unread
        self.assertEqual(self.send('post', self.base + '/comments/read', {'ids': ['bad']}).status_code, 400)

    def test_mentions_notify_once_and_follow_the_thread(self):
        _, root = self.post(self.mate, f'hello {mention(self.third)} and {mention(self.mate)}')
        self.assertEqual(root['mentions']['users'], [str(self.third.id), str(self.mate.id)])
        rows = list(Notification.objects.all())
        self.assertEqual([(r.user_id, r.kind) for r in rows], [(self.third.id, 'mention')])   # not the author
        self.assertEqual(rows[0].snippet, 'hello @third and @mate')
        self.post(self.owner, 'reply', parentId=root['id'])
        kinds = {(r.user_id, r.kind) for r in Notification.objects.all()}
        self.assertEqual(kinds, {(self.third.id, 'mention'), (self.third.id, 'reply'), (self.mate.id, 'reply')})
        self.assertEqual(Notification.objects.filter(user_id=self.owner.id).count(), 0)

    def test_group_mentions_and_edit_only_notifies_new_mentions(self):
        ProjectMember.objects.create(project_id=PROJECT, user_id=self.viewer.id, role='viewer', created_at=1, updated_at=1)
        self.post(self.mate, 'all @[board](board)')
        self.assertEqual({r.user_id for r in Notification.objects.all()}, {self.owner.id, self.viewer.id, self.third.id})   # members and the owner, not the author
        Notification.objects.all().delete()
        self.post(self.mate, 'space @[Space](space)')
        self.assertEqual({r.user_id for r in Notification.objects.all()}, {self.viewer.id, self.owner.id})
        Notification.objects.all().delete()
        self.post(self.mate, 'team @[team](team)')
        self.assertEqual(Notification.objects.count(), 3)    # every teammate but the author
        Notification.objects.all().delete()
        _, root = self.post(self.mate, 'first')
        self.send('patch', f"{self.base}/comments/{root['id']}", {'body': f'first {mention(self.third)}'})
        self.send('patch', f"{self.base}/comments/{root['id']}", {'body': f'again {mention(self.third)}'})
        self.assertEqual(Notification.objects.filter(kind='mention').count(), 1)

    def test_a_group_mention_notifies_once_and_does_not_follow_the_thread(self):
        _, root = self.post(self.mate, 'team @[team](team)')
        self.assertEqual({r.user_id for r in Notification.objects.filter(kind='mention')}, {self.owner.id, self.viewer.id, self.third.id})
        _, edited = self.post(self.mate, 'plain')
        self.send('patch', f"{self.base}/comments/{edited['id']}", {'body': 'now @[board](board)'})
        self.assertEqual(set(CommentFollow.objects.values_list('user_id', flat=True)), {self.mate.id})
        self.post(self.owner, 'reply', parentId=root['id'])
        self.assertEqual([r.user_id for r in Notification.objects.filter(kind='reply')], [self.mate.id])
        self.as_user(self.mate)
        self.send('patch', f"{self.base}/comments/{root['id']}", {'body': f'team @[team](team) {mention(self.third)}'})
        self.assertEqual(Notification.objects.filter(comment_id=root['id'], kind='mention').count(), 3)
        self.assertIn(self.third.id, set(CommentFollow.objects.filter(thread_id=root['id']).values_list('user_id', flat=True)))
        Notification.objects.filter(kind='reply').delete()
        self.post(self.owner, 'again', parentId=root['id'])
        self.assertEqual({r.user_id for r in Notification.objects.filter(kind='reply')}, {self.mate.id, self.third.id})

    def test_an_edit_that_mentions_a_follower_turns_their_notice_into_one_mention(self):
        self.as_user(self.third)
        self.send('post', self.base + '/comments/follow', {'follow': True})
        _, root = self.post(self.mate, 'hi')
        Notification.objects.filter(user_id=self.third.id).update(read_at=5, pushed_at=5, created_at=5)
        self.send('patch', f"{self.base}/comments/{root['id']}", {'body': f'hi {mention(self.third)}'})
        rows = list(Notification.objects.filter(user_id=self.third.id).values('kind', 'read_at', 'pushed_at', 'snippet'))
        self.assertEqual(rows, [{'kind': 'mention', 'read_at': None, 'pushed_at': None, 'snippet': 'hi @third'}])
        self.assertGreater(Notification.objects.get(user_id=self.third.id).created_at, 5)

    def test_everyone_a_mention_reaches_can_open_the_board_it_names(self):
        outsider = make_user('outsider')
        self.post(self.mate, f'team @[team](team) {mention(outsider)}')
        self.as_user(outsider)
        item = self.send('get', '/api/notifications').json()['notifications'][0]
        self.assertEqual((item['boardName'], item['kind']), ('Board', 'mention'))
        self.assertEqual(self.send('get', f"/api/canvas-boards/{item['boardId']}/comments").status_code, 200)
        self.as_user(self.owner)
        self.assertEqual(self.send('post', f'{self.base}/access', {'op': 'setTeamRole', 'role': 'none'}).status_code, 400)

    def test_follow_all_threads_and_one_thread(self):
        self.as_user(self.third)
        self.assertTrue(self.send('post', self.base + '/comments/follow', {'follow': True}).json()['all'])
        _, root = self.post(self.mate, 'new thread')
        self.assertEqual(Notification.objects.filter(user_id=self.third.id, kind='comment').count(), 1)
        self.as_user(self.third)
        self.send('post', self.base + '/comments/follow', {'follow': False})
        self.assertEqual(self.send('post', self.base + '/comments/follow', {'threadId': root['id']}).json()['threads'], [root['id']])
        self.post(self.owner, 'reply', parentId=root['id'])
        self.assertEqual(Notification.objects.filter(user_id=self.third.id, kind='reply').count(), 1)
        self.as_user(self.third)
        self.assertEqual(self.send('post', self.base + '/comments/follow', {'threadId': root['id'], 'follow': False}).json()['threads'], [])

    def test_feed_pages_marks_read_and_filters_by_board(self):
        for index in range(32):
            self.post(self.mate, f'hi {mention(self.third)} {index}')
        self.as_user(self.third)
        page = self.send('get', '/api/notifications?boards=1').json()
        self.assertEqual((len(page['notifications']), page['unread'], bool(page['next'])), (30, 32, True))
        self.assertEqual(page['boards'], [{'boardId': BOARD, 'name': 'Board', 'projectId': PROJECT, 'unread': 32}])
        rest = self.send('get', f"/api/notifications?boardId={BOARD}&before={page['next']}").json()
        self.assertEqual(len(rest['notifications']), 2)
        self.send('post', '/api/notifications/read', {'ids': [page['notifications'][0]['id']]})
        self.assertEqual(self.send('get', '/api/notifications?unread=1').json()['unread'], 31)
        self.assertEqual(self.send('post', '/api/notifications/read', {'boardId': BOARD}).json()['unread'], 0)
        self.assertEqual(self.send('get', '/api/notifications?before=x').status_code, 400)
        self.as_user(self.viewer)
        self.assertEqual(self.send('get', '/api/notifications').json()['notifications'], [])   # nobody else's feed
        self.client.cookies.clear()
        self.assertEqual(self.send('get', '/api/notifications').status_code, 401)

    def test_suggested_mentions_are_people_you_mentioned_then_other_authors(self):
        self.post(self.mate, 'a'); self.post(self.third, 'b')
        self.post(self.owner, f'c {mention(self.viewer)}')
        self.as_user(self.owner)
        ids = self.send('get', self.base + '/comments/mentions').json()['userIds']
        self.assertEqual(ids, [str(self.viewer.id), str(self.third.id), str(self.mate.id)])

    def test_presence_beat_lists_recent_people_only(self):
        self.as_user(self.mate)
        self.send('post', self.base + '/pulse')
        BoardPresence.objects.update_or_create(board_id=BOARD, user_id=self.viewer.id, defaults={'seen_at': 1})
        self.as_user(self.third)
        people = self.send('post', self.base + '/pulse').json()['people']
        self.assertEqual({p['userId'] for p in people}, {str(self.mate.id), str(self.third.id)})

    def test_collab_tools_setting_is_a_board_sharer_choice_checked_server_side(self):
        row = lambda: CanvasBoard.objects.filter(pk=BOARD).values('id', 'project_id', 'created_by', 'team_role', 'collab_tools').get()
        from . import access
        self.assertTrue(access.can_start_collab_tools(self.mate, row()))
        self.as_user(self.mate)
        self.assertEqual(self.send('post', self.base + '/access', {'op': 'setCollabTools', 'who': 'owner'}).status_code, 403)
        self.as_user(self.owner)
        described = self.send('post', self.base + '/access', {'op': 'setCollabTools', 'who': 'owner'}).json()
        self.assertEqual(described['collabTools'], 'owner')
        self.assertFalse(access.can_start_collab_tools(self.mate, row()))
        self.assertTrue(access.can_start_collab_tools(self.owner, row()))
        self.assertEqual(self.send('post', self.base + '/access', {'op': 'setCollabTools', 'who': 'x'}).status_code, 400)

    def test_deleting_the_board_removes_collaboration_rows(self):
        _, root = self.post(self.mate, f'x {mention(self.third)}')
        self.as_user(self.third)
        self.send('post', self.base + '/comments/follow', {'follow': True})
        self.assertTrue(CommentFollow.objects.filter(board_id=BOARD, thread__isnull=True).exists())
        from . import services
        services.delete_board(BOARD)
        self.assertEqual((BoardComment.objects.count(), Notification.objects.count(), CommentFollow.objects.count()), (0, 0, 0))

    def test_a_sharer_cannot_edit_another_persons_comment_but_can_delete_it(self):
        _, root = self.post(self.mate, f'quote {mention(self.third)}')
        self.as_user(self.owner)
        refused = self.send('patch', f"{self.base}/comments/{root['id']}", {'body': 'words in their mouth'})
        self.assertEqual(refused.status_code, 403)
        self.assertEqual(BoardComment.objects.get(pk=root['id']).body, f'quote {mention(self.third)}')
        self.assertEqual(self.send('delete', f"{self.base}/comments/{root['id']}").status_code, 200)

    def test_moving_a_pin_needs_edit_access_or_being_its_author_and_never_changes_words(self):
        _, root = self.post(self.owner, 'pin me')
        url = f"{self.base}/comments/{root['id']}"
        self.as_user(self.mate)    # an editor keeps the fallback position current
        moved = self.send('patch', url, {'anchorNodeId': 'n1', 'anchorDx': 1, 'anchorDy': 2, 'x': 50, 'y': 60}).json()['comment']
        self.assertEqual((moved['x'], moved['anchor']['nodeId']), (50.0, 'n1'))
        detached = self.send('patch', url, {'anchorNodeId': None, 'x': 70, 'y': 80}).json()['comment']
        self.assertEqual((detached['x'], detached['anchor']), (70.0, None))
        self.assertEqual(self.send('patch', url, {'body': 'words', 'x': 1, 'y': 1}).status_code, 403)
        self.as_user(self.third)   # a commenter who is not the author may not
        self.assertEqual(self.send('patch', url, {'x': 5, 'y': 5}).status_code, 403)

    def test_deleting_or_editing_a_comment_rewrites_its_notifications(self):
        _, root = self.post(self.mate, f'secret {mention(self.third)}')
        self.assertEqual(Notification.objects.get(comment_id=root['id']).snippet, 'secret @' + self.third.name)
        self.as_user(self.mate)
        self.send('patch', f"{self.base}/comments/{root['id']}", {'body': f'fixed {mention(self.third)}'})
        self.assertEqual(Notification.objects.get(comment_id=root['id']).snippet, 'fixed @' + self.third.name)
        self.assertEqual(self.send('delete', f"{self.base}/comments/{root['id']}").status_code, 200)
        self.assertFalse(Notification.objects.filter(comment_id=root['id']).exists())

    def test_the_full_load_keeps_the_newest_comments_and_omits_tombstones(self):
        from unittest.mock import patch
        with patch.object(comments, 'MAX_COMMENTS_PER_BOARD', 3):
            for index in range(3):
                self.assertEqual(self.post(self.mate, f'c{index}')[0].status_code, 201)
            self.assertEqual(self.post(self.mate, 'one too many')[0].status_code, 409)
            _, newest = self.post(self.mate, 'reply no room', parentId=BoardComment.objects.first().pk.__str__())
            self.assertIsNone(newest)
            first = BoardComment.objects.order_by('created_at').first()
            self.as_user(self.mate)
            self.send('delete', f'{self.base}/comments/{first.pk}')
            self.assertEqual(self.post(self.mate, 'newest')[0].status_code, 201)
            bodies = [c['body'] for c in self.send('get', self.base + '/comments').json()['comments']]
            self.assertEqual(sorted(bodies), ['c1', 'c2', 'newest'])


KEYS = {'VEEVEE_WEB_PUSH_PUBLIC_KEY': 'k', 'VEEVEE_WEB_PUSH_PRIVATE_KEY': push._b64((7).to_bytes(32, 'big')), 'VEEVEE_WEB_PUSH_SUBJECT': 'mailto:ops@example.com'}


@override_settings(ROOT_URLCONF='config.urls')
class PushTests(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.user = make_user('pusher')
        self.client.cookies['veevee_session'] = sign_session(self.user)

    def configure(self):
        import os
        from unittest.mock import patch
        return patch.dict(os.environ, KEYS)

    def test_off_without_keys_and_never_fails(self):
        import os
        from unittest.mock import patch
        with patch.dict(os.environ, {}, clear=False):
            for name in KEYS:
                os.environ.pop(name, None)
            status = self.client.get('/api/push-subscription').json()
            self.assertEqual((status['enabled'], status['publicKey']), (False, None))
            response = self.client.post('/api/push-subscription', data=json.dumps({'endpoint': ENDPOINT}), content_type='application/json')
            self.assertEqual(response.status_code, 409)
            self.assertEqual(push.send_pending(), {'ok': True, 'enabled': False})

    def test_subscribe_validates_endpoint_and_unsubscribes(self):
        with self.configure():
            for bad in ('http://fcm.googleapis.com/x', 'https://evil.example.com/x', 'https://169.254.169.254/x', 'https://fcm.googleapis.com:8443/x',
                        'https://user@fcm.googleapis.com/x', 'https://evilgoogleapis.com/x', 5):
                response = self.client.post('/api/push-subscription', data=json.dumps({'endpoint': bad}), content_type='application/json')
                self.assertEqual(response.status_code, 400, bad)
            ok = self.client.post('/api/push-subscription', data=json.dumps({'endpoint': ENDPOINT}), content_type='application/json').json()
            self.assertEqual((ok['enabled'], ok['subscribed'], ok['publicKey']), (True, True, 'k'))
            gone = self.client.delete('/api/push-subscription', data=json.dumps({'endpoint': ENDPOINT}), content_type='application/json').json()
            self.assertFalse(gone['subscribed'])

    def test_send_pending_signs_pushes_once_per_user_and_drops_dead_endpoints(self):
        PushSubscription.objects.create(user_id=self.user.id, endpoint=ENDPOINT, created_at=1)
        PushSubscription.objects.create(user_id=self.user.id, endpoint='https://updates.push.services.mozilla.com/wpush/v2/dead', created_at=1)
        for _ in range(3):
            Notification.objects.create(user_id=self.user.id, board_id=BOARD, kind='mention', created_at=1000, snippet='s')
        seen = []

        def post(endpoint, headers):
            seen.append((endpoint, headers))
            return MagicMock(status_code=410 if 'dead' in endpoint else 201)

        with self.configure():
            result = push.send_pending(now=2000, post=post)
            self.assertEqual((result['sent'], result['dropped']), (1, 1))
            self.assertEqual(len(seen), 2)
            self.assertTrue(seen[0][1]['Authorization'].startswith('vapid t='))
            self.assertEqual(Notification.objects.filter(pushed_at__isnull=True).count(), 0)
            self.assertEqual(push.send_pending(now=3000, post=post)['sent'], 0)
        self.assertEqual(PushSubscription.objects.count(), 1)

    def test_a_notification_created_while_pushes_are_in_flight_stays_pending(self):
        PushSubscription.objects.create(user_id=self.user.id, endpoint=ENDPOINT, created_at=1)
        covered = Notification.objects.create(user_id=self.user.id, board_id=BOARD, kind='mention', created_at=1000, snippet='s')
        late = []

        def post(endpoint, headers):
            if not late:
                late.append(Notification.objects.create(user_id=self.user.id, board_id=BOARD, kind='reply', created_at=1500, snippet='r'))
            return MagicMock(status_code=201)

        with self.configure():
            self.assertEqual(push.send_pending(now=2000, post=post)['sent'], 1)
            covered.refresh_from_db()
            late[0].refresh_from_db()
            self.assertEqual((covered.pushed_at, late[0].pushed_at), (2000, None))
            self.assertEqual(push.send_pending(now=3000, post=post)['sent'], 1)
            late[0].refresh_from_db()
            self.assertEqual(late[0].pushed_at, 3000)

    def test_a_tick_sends_a_bounded_batch_and_leaves_the_rest_pending(self):
        other = make_user('pusher2')
        for user in (self.user, other):
            PushSubscription.objects.create(user_id=user.id, endpoint=ENDPOINT + str(user.id), created_at=1)
            Notification.objects.create(user_id=user.id, board_id=BOARD, kind='mention', created_at=1000, snippet='s')
        post = MagicMock(return_value=MagicMock(status_code=201))
        with self.configure():
            from unittest.mock import patch
            with patch.object(push, 'MAX_SENDS_PER_TICK', 1):
                self.assertEqual(push.send_pending(now=2000, post=post)['sent'], 1)
                self.assertEqual(Notification.objects.filter(pushed_at__isnull=True).count(), 1)
                self.assertEqual(push.send_pending(now=3000, post=post)['sent'], 1)
            self.assertEqual(Notification.objects.filter(pushed_at__isnull=True).count(), 0)

    def test_vapid_token_verifies_against_the_public_key(self):
        import time
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature
        private = push._b64((7).to_bytes(32, 'big'))
        headers = push.vapid_headers(ENDPOINT, 'k', private, 'mailto:a@b.c', now=1000)
        token = headers['Authorization'].split('t=')[1].split(',')[0]
        head, claims, signature = token.split('.')
        self.assertEqual(json.loads(push._unb64(claims)), {'aud': 'https://fcm.googleapis.com', 'exp': 1000 + 43200, 'sub': 'mailto:a@b.c'})
        raw = push._unb64(signature)
        public = ec.derive_private_key(7, ec.SECP256R1()).public_key()
        public.verify(encode_dss_signature(int.from_bytes(raw[:32], 'big'), int.from_bytes(raw[32:], 'big')),
                      f'{head}.{claims}'.encode(), ec.ECDSA(hashes.SHA256()))
