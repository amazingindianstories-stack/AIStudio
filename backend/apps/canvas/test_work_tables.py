import datetime
import uuid
from django.test import TransactionTestCase, SimpleTestCase
from apps.admin_dashboard import tests as fixtures
from apps.authentication.models import User
from .models import CanvasBoard, WorkTable, WorkRecord, WorkRelation, WorkHistory, BoardNotification
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

    def create(self, extra=(), views=()):
        response = self.client.post(self.base, {'name': 'Plan', 'fields': FIELDS + list(extra), 'views': list(views)}, content_type='application/json')
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

    def editor(self, email='work-editor@example.test'):
        user = User.objects.create(email=email, password_hash='x', password_salt='x', name='Editor', created_at=1)
        self.board.created_by = None
        self.board.team_role = 'edit'; self.board.save()
        return user, access.board_row(self.board.id)

    def test_editor_saves_settings_but_cannot_change_owner_only(self):
        table = self.create()
        editor, row = self.editor()
        saved = work.mutate(editor, row, table['id'], {'op': 'settings', 'version': table['version'], 'name': 'Renamed', 'ownerOnly': False})['table']
        self.assertEqual((saved['name'], saved['ownerOnly']), ('Renamed', False))
        with self.assertRaises(access.AccessError) as raised:
            work.mutate(editor, row, table['id'], {'op': 'settings', 'version': saved['version'], 'ownerOnly': True})
        self.assertEqual(raised.exception.status, 403)
        self.assertFalse(WorkTable.objects.get(id=table['id']).owner_only)

    def test_relation_cells_and_explicit_dependencies_stay_separate(self):
        table = self.create([{'id': 'needs', 'name': 'Needs', 'type': 'relation'}])
        first = self.mutate(table, {'op': 'add', 'cells': {'title': 'First'}})['record']
        second = self.mutate(table, {'op': 'add', 'cells': {'title': 'Second'}})['record']
        links = lambda record: set(WorkRelation.objects.filter(source_id=record['id']).values_list('target_id', 'kind'))
        a, b = uuid.UUID(first['id']), uuid.UUID(second['id'])
        third = self.mutate(table, {'op': 'add', 'cells': {'title': 'Third', 'needs': [first['id'], second['id']]}, 'blockedBy': [second['id']]})['record']
        self.assertEqual(third['blockedBy'], [second['id']])
        self.assertEqual(links(third), {(a, 'relation'), (b, 'relation'), (b, 'blocked_by')})
        third = self.mutate(table, {'op': 'update', 'id': third['id'], 'version': third['version'], 'cells': third['cells'], 'blockedBy': []})['record']
        self.assertEqual((third['blockedBy'], links(third)), ([], {(a, 'relation'), (b, 'relation')}))
        third = self.mutate(table, {'op': 'update', 'id': third['id'], 'version': third['version'], 'cells': {'title': 'Third', 'needs': [second['id']]}})['record']
        self.assertEqual((third['blockedBy'], links(third)), ([], {(b, 'relation')}))
        third = self.mutate(table, {'op': 'update', 'id': third['id'], 'version': third['version'], 'cells': {'title': 'Third', 'needs': []}, 'blockedBy': [first['id']]})['record']
        self.assertEqual((third['blockedBy'], links(third)), ([first['id']], {(a, 'blocked_by')}))
        self.mutate(table, {'op': 'update', 'id': first['id'], 'version': first['version'], 'cells': {'title': 'First', 'needs': [third['id']]}}, 400)

    def test_deleting_a_record_prunes_and_records_every_linked_record(self):
        table = self.create([{'id': 'needs', 'name': 'Needs', 'type': 'relation'}])
        second = self.mutate(table, {'op': 'add', 'cells': {'title': 'Second'}})['record']
        third = self.mutate(table, {'op': 'add', 'cells': {'title': 'Third', 'needs': [second['id']]}})['record']
        child = self.mutate(table, {'op': 'add', 'cells': {'title': 'Child'}, 'parentId': second['id']})['record']
        self.mutate(table, {'op': 'delete', 'id': second['id'], 'version': second['version']})
        stale = self.mutate(table, {'op': 'update', 'id': third['id'], 'version': third['version'], 'cells': {'title': 'Stale', 'needs': [second['id']]}}, 409)
        self.assertIn('error', stale)
        records = {r['id']: r for r in self.client.get(f"{self.base}/{table['id']}").json()['records']}
        self.assertEqual((records[third['id']]['cells']['needs'], records[third['id']]['blockedBy']), ([], []))
        self.assertIsNone(records[child['id']]['parentId'])
        changes = {row.target_id: (row.before, row.after) for row in WorkHistory.objects.filter(table_id=table['id'], action='update')}
        self.assertEqual((changes[third['id']][0]['cells']['needs'], changes[third['id']][1]), ([second['id']], records[third['id']]))
        self.assertEqual((changes[child['id']][0]['parentId'], changes[child['id']][1]), (second['id'], records[child['id']]))
        saved = self.mutate(table, {'op': 'update', 'id': third['id'], 'version': records[third['id']]['version'], 'cells': {**records[third['id']]['cells'], 'title': 'Saved'}})['record']
        self.assertEqual(saved['cells']['title'], 'Saved')

    def test_record_with_deactivated_assignee_remains_editable(self):
        table = self.create()
        person = User.objects.create(email='leaver@example.test', name='Leaver', password_hash='x', password_salt='x', created_at=1)
        record = self.mutate(table, {'op': 'add', 'cells': {'title': 'Owned', 'assignee': str(person.id)}})['record']
        User.objects.filter(id=person.id).update(is_active=False)
        saved = self.mutate(table, {'op': 'update', 'id': record['id'], 'version': record['version'], 'cells': {**record['cells'], 'title': 'Renamed'}})['record']
        self.assertEqual((saved['cells']['title'], saved['cells']['assignee']), ('Renamed', str(person.id)))
        self.mutate(table, {'op': 'add', 'cells': {'title': 'New', 'assignee': str(person.id)}}, 404)

    def test_numeric_filter_rejects_non_finite_values(self):
        table = self.create()
        path = f"{self.base}/{table['id']}"
        for value in ('nan', 'inf', '-Infinity'):
            response = self.client.get(f'{path}?filterField=a&filterValue={value}')
            self.assertEqual(response.status_code, 400, value)
            self.assertEqual(response.json()['error'], 'Numeric filter requires a finite number.')

    def test_grouping_complete_loading_and_id_lookup_cover_the_whole_query(self):
        table = self.create([{'id': 'team', 'name': 'Team', 'type': 'text'}],
                            [{'kind': 'table', 'name': 'Grid', 'groupBy': 'team'}, {'kind': 'chart', 'name': 'Chart', 'groupBy': 'team', 'valueField': 'a'}])
        WorkRecord.objects.bulk_create([WorkRecord(table_id=table['id'], cells={'title': f'Item {i}', 'a': i, 'team': 'odd' if i % 2 else 'even'},
                                                   position=i, created_at=1, updated_at=1) for i in range(205)])
        path = f"{self.base}/{table['id']}"
        page = self.client.get(path + '?view=table&sort=a&direction=desc').json()
        self.assertEqual(page['groups'], [{'value': 'even', 'count': 103}, {'value': 'odd', 'count': 102}])
        self.assertEqual(len(page['records']), 200)
        self.assertEqual([r['cells']['a'] for r in page['records'][:2]], [204, 202])
        self.assertEqual([r['cells']['team'] for r in page['records']].index('odd'), 103)
        complete = self.client.get(path + '?all=1&view=table&q=Item').json()
        self.assertEqual((len(complete['records']), complete['total'], complete['limit']), (205, 205, 205))
        self.assertEqual(complete['aggregates']['a_sum'], sum(range(205)))
        filtered = self.client.get(path + '?filterField=team&filterValue=odd&view=table').json()
        self.assertEqual(filtered['groups'], [{'value': 'odd', 'count': 102}])
        preview = self.client.get(path + '?view=chart&limit=12').json()
        self.assertEqual((len(preview['records']), preview['total'], preview['limit']), (12, 205, 12))
        evens = sum(range(0, 205, 2))
        self.assertEqual(preview['groups'], [{'value': 'even', 'count': 103, 'sum': evens}, {'value': 'odd', 'count': 102, 'sum': sum(range(205)) - evens}])
        self.assertEqual(self.client.get(path + '?view=kanban').json()['groups'], [])
        self.assertEqual(self.client.get(path + '?limit=999').json()['limit'], 200)
        self.assertEqual(self.client.get(path + '?limit=few').status_code, 400)
        wanted = [str(r.id) for r in WorkRecord.objects.filter(table_id=table['id'], cells__a__in=[0, 204])]
        found = self.client.get(path + '?ids=' + ','.join(wanted)).json()['records']
        self.assertEqual({r['id'] for r in found}, set(wanted))
        self.assertEqual(self.client.get(path + '?ids=not-a-uuid').status_code, 400)

    def test_notifications_use_every_people_field_and_timeline_end_field(self):
        table = self.create([{'id': 'reviewer', 'name': 'Reviewer', 'type': 'people'}, {'id': 'due', 'name': 'Deadline', 'type': 'date'}],
                            [{'kind': 'timeline', 'name': 'Plan', 'startField': 'due', 'endField': 'due'}])
        reviewer = User.objects.create(email='reviewer@example.test', name='Reviewer', password_hash='x', password_salt='x', created_at=1)
        assignee = User.objects.create(email='assignee@example.test', name='Assignee', password_hash='x', password_salt='x', created_at=1)
        today = datetime.date(2026, 10, 31)
        record = self.mutate(table, {'op': 'add', 'cells': {'title': 'Check', 'reviewer': str(reviewer.id), 'due': today.isoformat(), 'end': '2026-11-02'}})['record']
        self.assertEqual(BoardNotification.objects.filter(user=reviewer, kind='table_assignment').count(), 1)
        self.mutate(table, {'op': 'update', 'id': record['id'], 'version': record['version'], 'cells': {**record['cells'], 'assignee': str(assignee.id)}})
        self.assertEqual(BoardNotification.objects.filter(user=assignee, kind='table_assignment').count(), 1)
        self.assertEqual(BoardNotification.objects.filter(user=reviewer, kind='table_assignment').count(), 1)
        self.assertEqual(BoardNotification.objects.filter(user=reviewer, kind='table_change').count(), 1)
        self.assertEqual(notifications.reminders(today=datetime.date(2026, 11, 2))['delivered'], 0)
        self.assertEqual(notifications.reminders(today=today)['delivered'], 2)
        self.assertEqual(set(BoardNotification.objects.filter(kind='table_due').values_list('user_id', flat=True)), {reviewer.id, assignee.id})
        self.assertEqual(notifications.reminders(today=today)['delivered'], 0)
