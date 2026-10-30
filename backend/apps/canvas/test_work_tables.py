import datetime
from django.test import TransactionTestCase, SimpleTestCase
from apps.admin_dashboard import tests as fixtures
from apps.authentication.models import User
from .models import CanvasBoard, WorkTable, WorkRecord, WorkHistory, BoardNotification
from . import work_tables as work, work_notifications as notifications, access
from .work_formulas import calculate, parse
from .serialization import validate_state

FIELDS = [{'id': 'title', 'name': 'Title', 'type': 'text'}, {'id': 'assignee', 'name': 'Assignee', 'type': 'people'},
          {'id': 'end', 'name': 'Due', 'type': 'date'}, {'id': 'a', 'name': 'A', 'type': 'number'},
          {'id': 'b', 'name': 'B', 'type': 'points'}, {'id': 'total', 'name': 'Total', 'type': 'formula', 'expression': 'a * b'}]


class FormulaTests(SimpleTestCase):
    def test_bounded_arithmetic(self):
        self.assertEqual(calculate('a * b + 2', {'a': 3, 'b': 4}, {'a', 'b'}), 14)
        self.assertIsNone(calculate('a / b', {'a': 3, 'b': 0}, {'a', 'b'}))
        for expression in ('__import__("os")', 'a.__class__', 'a ** 100', '[a]', 'unknown + 1', '9' * 500):
            with self.assertRaises(ValueError): parse(expression, {'a', 'b'})

    def test_card_and_column_roundtrip(self):
        raw = {'nodes': [{'id': 'card', 'type': 'card', 'x': 0, 'y': 0, 'w': 280, 'h': 170, 'record': {'title': 'Task', 'assignee': 'id'}}], 'connectors': []}
        self.assertEqual(validate_state(raw)['nodes'][0]['record'], raw['nodes'][0]['record'])


class WorkTableTests(TransactionTestCase):
    cookie = fixtures.SettingsTests.cookie
    project = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    board_id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

    def setUp(self):
        fixtures.SettingsTests.setUp(self)
        self.cookie()
        self.user = User.objects.get(email='settings@example.test') if User.objects.filter(email='settings@example.test').exists() else User.objects.first()
        self.board = CanvasBoard.objects.create(id=self.board_id, project_id=self.project, name='Work', data={'nodes': [], 'connectors': []}, created_by=self.user.id, created_at=1, updated_at=1)
        self.row = access.board_row(self.board.id)
        self.base = f'/api/canvas-boards/{self.board.id}/work'

    def create(self):
        response = self.client.post(self.base, {'name': 'Plan', 'fields': FIELDS}, content_type='application/json')
        self.assertEqual(response.status_code, 201, response.content)
        return response.json()['table']

    def mutate(self, table, data, status=200):
        response = self.client.post(f"{self.base}/{table['id']}", data, content_type='application/json')
        self.assertEqual(response.status_code, status, response.content)
        return response.json()

    def test_crud_queries_aggregates_formula_versions_and_history(self):
        table = self.create()
        for title, a, b in [('Alpha', 5, 3), ('Beta', 2, 4)]:
            self.mutate(table, {'op': 'add', 'cells': {'title': title, 'a': a, 'b': b}})
        path = f"{self.base}/{table['id']}"
        result = self.client.get(path + '?sort=a&direction=desc').json()
        self.assertEqual([r['cells']['title'] for r in result['records']], ['Alpha', 'Beta'])
        self.assertEqual(result['aggregates']['a_sum'], 7)
        self.assertEqual(result['aggregates']['total_sum'], 23)
        record = result['records'][0]
        self.assertEqual(record['cells']['total'], 15)
        self.mutate(table, {'op': 'update', 'id': record['id'], 'version': record['version'], 'cells': {'title': 'New', 'a': 7}})
        self.mutate(table, {'op': 'update', 'id': record['id'], 'version': record['version'], 'cells': {'title': 'Stale'}}, 409)
        self.assertEqual(self.client.get(path + '?q=Beta').json()['total'], 1)
        self.assertEqual(self.client.get(path + '?filterField=a&filterValue=7').json()['total'], 1)
        self.assertEqual(WorkHistory.objects.filter(table_id=table['id']).count(), 4)
        self.assertEqual(len(self.client.get(path + '/history').json()['history']), 4)

    def test_relations_reject_cross_table_and_cycles(self):
        table = self.create()
        self.mutate(table, {'op': 'add', 'cells': {'title': 'Root'}})
        a = WorkRecord.objects.get(table_id=table['id'])
        self.mutate(table, {'op': 'add', 'cells': {'title': 'Child'}, 'parentId': str(a.id), 'blockedBy': [str(a.id)]})
        b = WorkRecord.objects.exclude(id=a.id).get(table_id=table['id'])
        self.mutate(table, {'op': 'update', 'id': str(a.id), 'version': 1, 'parentId': str(b.id)}, 400)
        self.mutate(table, {'op': 'update', 'id': str(a.id), 'version': 1, 'blockedBy': [str(b.id)]}, 400)
        other = self.create()
        self.mutate(other, {'op': 'add', 'cells': {}, 'parentId': str(a.id)}, 400)

    def test_roles_and_table_permissions(self):
        table = self.create()
        editor = User.objects.create(email='table-editor@example.test', password_hash='x', password_salt='x', name='Editor', created_at=1)
        table_model = WorkTable.objects.get(id=table['id'])
        table_model.owner_only = True; table_model.save()
        with self.assertRaises(access.AccessError): work.mutate(editor, self.row, table['id'], {'op': 'add', 'cells': {}})
        table_model.owner_only = False; table_model.save()
        self.board.created_by = None
        self.board.team_role = 'view'; self.board.save()
        with self.assertRaises(access.AccessError): work.mutate(editor, access.board_row(self.board.id), table['id'], {'op': 'add', 'cells': {}})

    def test_notifications_preferences_reminder_dedup_and_access_revocation(self):
        table = self.create()
        recipient = User.objects.create(email='notify@example.test', name='Recipient', password_hash='x', password_salt='x', created_at=1)
        today = datetime.datetime.now(datetime.timezone.utc).date()
        self.mutate(table, {'op': 'add', 'cells': {'title': 'Due', 'end': today.isoformat(), 'assignee': str(recipient.id)}})
        self.assertEqual(BoardNotification.objects.filter(user=recipient, kind='table_assignment').count(), 1)
        self.assertEqual(notifications.reminders(today=today)['delivered'], 1)
        self.assertEqual(notifications.reminders(today=today)['delivered'], 0)
        self.assertEqual(len(notifications.inbox(recipient)), 2)
        from .models import BoardNotificationPreference
        BoardNotificationPreference.objects.create(user=recipient, preferences={'table_assignment': False})
        self.mutate(table, {'op': 'add', 'cells': {'title': 'Muted', 'assignee': str(recipient.id)}})
        self.assertEqual(BoardNotification.objects.filter(user=recipient, kind='table_assignment').count(), 1)
        self.board.team_role = 'view'; self.board.save()
        # No board membership plus no team role is represented by a restricted project's viewer role;
        # patch role evaluation here to exercise the inbox's access filtering independently.
        from unittest.mock import patch
        with patch('apps.canvas.access.roles_for', return_value={}):
            self.assertEqual(notifications.inbox(recipient), [])
