import json
import time
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard import tests as fixtures
from apps.authentication.models import User
from apps.common.models import ActivityLog
from . import workspace


@override_settings(ROOT_URLCONF='apps.admin_dashboard.urls')
class WorkspaceTests(TransactionTestCase):
    cookie = fixtures.SettingsTests.cookie

    def setUp(self):
        fixtures.SettingsTests.setUp(self)
        self.cookie()

    def post(self, data):
        return self.client.post('/api/admin/workspace', json.dumps(data), content_type='application/json')

    def make_admin(self):
        User.objects.filter(pk=fixtures.UID).update(role='admin')

    def test_non_admin_and_anonymous_are_refused(self):
        self.assertEqual(self.client.get('/api/admin/workspace').status_code, 403)
        self.assertEqual(self.post({'name': 'X'}).status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/admin/workspace').status_code, 401)
        self.assertEqual(self.client.get('/api/workspace').status_code, 401)

    def test_name_logo_and_validation(self):
        self.make_admin()
        self.assertEqual(self.client.get('/api/workspace').json()['name'], 'Veevee')
        response = self.post({'name': '  Studio  ', 'logoUrl': 'https://example.com/logo.png'})
        self.assertEqual(response.status_code, 200)
        shown = self.client.get('/api/workspace').json()
        self.assertEqual((shown['name'], shown['logoUrl']), ('Studio', 'https://example.com/logo.png'))
        for bad in ({'name': ''}, {'name': 'x' * 81}, {'logoUrl': 'javascript:alert(1)'}, {'logoUrl': '//evil.test/x'}, {}):
            self.assertEqual(self.post(bad).status_code, 400, bad)
        self.assertTrue(ActivityLog.objects.filter(action='admin_workspace_updated').exists())

    def test_feature_activation_and_beta(self):
        self.make_admin()
        self.assertTrue(self.client.get('/api/workspace').json()['features']['board_ai'])
        self.assertFalse(self.client.get('/api/workspace').json()['features']['kling_images'])
        self.post({'betaOptIn': True})
        self.assertTrue(self.client.get('/api/workspace').json()['features']['kling_images'])
        self.post({'features': {'board_ai': {'mode': 'none'}, 'kling_images': {'mode': 'users', 'userIds': [fixtures.UID]}}})
        features = self.client.get('/api/workspace').json()['features']
        self.assertFalse(features['board_ai'])
        self.assertTrue(features['kling_images'])
        self.post({'features': {'kling_images': {'mode': 'users', 'userIds': ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']}}})
        self.assertFalse(self.client.get('/api/workspace').json()['features']['kling_images'])
        self.assertEqual(self.post({'features': {'nope': {'mode': 'all'}}}).status_code, 400)
        self.assertEqual(self.post({'features': {'board_ai': {'mode': 'some'}}}).status_code, 400)
        self.assertEqual(self.post({'betaOptIn': 'yes'}).status_code, 400)
        self.assertFalse(workspace.feature_enabled('unknown', fixtures.UID))

    def test_ai_provider_and_model_blocking_reaches_availability(self):
        from apps.generation import availability
        from apps.generation.model_registry import MODEL_REGISTRY
        self.make_admin()
        with override_settings(VEEVEE_KLING=True, VEEVEE_OMNIHUMAN=True, VEEVEE_GEMINI_OMNI=True, VEEVEE_MAGNIFIC_UPSCALE=True):
            before = availability.availability()['models']
            self.assertTrue(before)
            target = next(m for m in MODEL_REGISTRY if m['id'] in before)
            self.assertEqual(self.post({'aiBlocked': {'models': [target['id']]}}).status_code, 200)
            self.assertNotIn(target['id'], availability.availability()['models'])
            self.assertEqual(self.post({'aiBlocked': {'models': [], 'providers': [target['provider']]}}).status_code, 200)
            after = availability.availability()['models']
            self.assertFalse([m for m in MODEL_REGISTRY if m['provider'] == target['provider'] and m['id'] in after])
            self.assertEqual(self.client.get('/api/admin/workspace').json()['aiBlocked']['providers'], [target['provider']])
            self.assertEqual(self.post({'aiBlocked': {'models': ['nope']}}).status_code, 400)
            self.post({'aiBlocked': {'providers': []}})
            self.assertEqual(availability.availability()['models'], before)

    def test_announcements_schedule_audience_and_priority(self):
        self.make_admin()
        now = int(time.time() * 1000)
        items = [
            {'title': 'Live', 'priority': 'info', 'startsAt': now - 1000, 'endsAt': now + 100000},
            {'title': 'Urgent', 'priority': 'critical', 'ctaUrl': 'https://example.com', 'ctaLabel': 'Read'},
            {'title': 'Later', 'startsAt': now + 100000},
            {'title': 'Expired', 'endsAt': now - 1},
            {'title': 'Others', 'audience': 'users', 'userIds': ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb']},
            {'title': 'Mine', 'audience': 'users', 'userIds': [fixtures.UID]},
        ]
        response = self.post({'announcements': items})
        self.assertEqual(response.status_code, 200, response.content)
        shown = self.client.get('/api/workspace').json()['announcements']
        self.assertEqual([a['title'] for a in shown], ['Urgent', 'Live', 'Mine'])
        self.assertEqual(shown[0]['ctaLabel'], 'Read')
        self.assertEqual(self.post({'announcements': [{'title': 'x', 'startsAt': 5, 'endsAt': 4}]}).status_code, 400)
        self.assertEqual(self.post({'announcements': [{'title': 'x', 'ctaUrl': 'http://insecure'}]}).status_code, 400)

    def test_audit_csv_export_streams_and_neutralises_formulas(self):
        import csv, io
        ActivityLog.objects.create(action='fixture', detail={'note': '=1+1'}, created_at=10)
        ActivityLog.objects.create(action='=HYPERLINK("x")', detail=None, created_at=5)
        ActivityLog.objects.create(action='other', detail=None, created_at=1)
        self.assertEqual(self.client.get('/api/admin/activity?format=csv').status_code, 403)
        self.make_admin()
        response = self.client.get('/api/admin/activity?format=csv')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.streaming)
        self.assertIn('veevee-audit-', response['Content-Disposition'])
        rows = list(csv.DictReader(io.StringIO(b''.join(response.streaming_content).decode())))
        self.assertEqual([r['action'] for r in rows][-3:], ['fixture', "'=HYPERLINK(\"x\")", 'other'])
        self.assertEqual(rows[-3]['time'], '1970-01-01T00:00:00.010Z')
        filtered = b''.join(self.client.get('/api/admin/activity?format=csv&action=other').streaming_content).decode()
        self.assertEqual(len(list(csv.DictReader(io.StringIO(filtered)))), 1)

    def test_content_log_is_admin_only_paged_and_exports_csv(self):
        import csv, io, uuid
        from apps.canvas.models import BoardActivity
        board = uuid.uuid4()
        for index in range(3):
            BoardActivity.objects.create(board_id=board, actor_id=fixtures.UID, action='add', node_id=f'n{index}', node_type='sticky',
                                         snippet='=cmd' if index == 0 else 'hi', created_at=100 + index, ordinal=0)
        BoardActivity.objects.create(board_id=uuid.uuid4(), action='delete', node_id='z', node_type='shape', created_at=50, ordinal=0)
        self.assertEqual(self.client.get('/api/admin/content-log').status_code, 403)
        self.assertEqual(self.client.get('/api/admin/content-log?format=csv').status_code, 403)
        self.make_admin()
        data = self.client.get(f'/api/admin/content-log?boardId={board}').json()
        self.assertEqual([r['nodeId'] for r in data['rows']], ['n2', 'n1', 'n0'])
        self.assertIsNone(data['nextCursor'])
        self.assertEqual(self.client.get('/api/admin/content-log?action=bogus').status_code, 400)
        self.assertEqual(self.client.get('/api/admin/content-log?boardId=nope').status_code, 400)
        response = self.client.get(f'/api/admin/content-log?format=csv&boardId={board}')
        self.assertTrue(response.streaming)
        rows = list(csv.DictReader(io.StringIO(b''.join(response.streaming_content).decode())))
        self.assertEqual([r['node_id'] for r in rows], ['n2', 'n1', 'n0'])
        self.assertEqual(rows[-1]['snippet'], "'=cmd")
        allrows = list(csv.DictReader(io.StringIO(b''.join(self.client.get('/api/admin/content-log?format=csv&action=delete').streaming_content).decode())))
        self.assertEqual([r['node_id'] for r in allrows], ['z'])

    def test_ai_log_is_admin_only_joins_generation_and_exports_csv(self):
        import csv, io, uuid
        from apps.canvas.models import BoardAiJob, CanvasBoard
        from apps.generation.models import Generation
        from apps.projects.models import Project
        project = Project.objects.create(id=uuid.uuid4(), name='P', created_at=1, updated_at=1)
        board = CanvasBoard.objects.create(id=uuid.uuid4(), project_id=project.id, name='B', data={}, created_at=1, updated_at=1)
        gens = []
        for index in range(2):
            gen = Generation.objects.create(id=uuid.uuid4(), kind='image', status='completed' if index else 'failed', prompt='p', model='Nano Banana Pro',
                                            aspect_ratio='1:1', user_id=fixtures.UID, cost_cents=7, created_at=1, updated_at=1)
            BoardAiJob.objects.create(board=board, user_id=fixtures.UID, format='stickies' if index else 'image', prompt='=boom' if index else 'ok',
                                      generation_id=gen.id, created_at=100 + index, updated_at=100 + index)
        BoardAiJob.objects.create(board=board, user_id=fixtures.UID, format='image', prompt='gone', generation_id=uuid.uuid4(), created_at=50, updated_at=50)
        self.assertEqual(self.client.get('/api/admin/ai-log').status_code, 403)
        self.assertEqual(self.client.get('/api/admin/ai-log?format=csv').status_code, 403)
        self.make_admin()
        data = self.client.get(f'/api/admin/ai-log?boardId={board.id}').json()
        self.assertEqual([(r['capability'], r['status'], r['model'], r['costCents']) for r in data['rows']],
                         [('stickies', 'completed', 'Nano Banana Pro', 7), ('image', 'failed', 'Nano Banana Pro', 7), ('image', 'deleted', None, None)])
        self.assertEqual(self.client.get('/api/admin/ai-log?capability=stickies').json()['rows'][0]['prompt'], '=boom')
        self.assertEqual(self.client.get('/api/admin/ai-log?userId=nope').status_code, 400)
        response = self.client.get('/api/admin/ai-log?format=csv')
        rows = list(csv.DictReader(io.StringIO(b''.join(response.streaming_content).decode())))
        self.assertEqual([r['capability'] for r in rows], ['stickies', 'image', 'image'])
        self.assertEqual(rows[0]['prompt'], "'=boom")
