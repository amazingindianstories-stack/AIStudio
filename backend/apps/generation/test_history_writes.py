import uuid
from unittest.mock import patch
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.authentication.models import User
from apps.common.models import ActivityLog
from apps.library.models import GenerationNaming, OrganizationIdempotencyKey
from apps.library.services.folder_engine import create_folder
from apps.projects.models import Project
from .models import Generation


@override_settings(ROOT_URLCONF='apps.generation.history_urls')
class HistoryWriteTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = SettingsTests.setUp

    def generation(self, **values):
        return Generation.objects.create(**{'kind':'image','status':'done','model':'fixture','prompt':'test',
            'aspect_ratio':'1:1','created_at':1,'updated_at':1,**values})

    def patch(self, body):
        return self.client.patch('/api/history', body, content_type='application/json')

    def move(self, body, **headers):
        return self.client.post('/api/history/move', body, content_type='application/json', **headers)

    def test_unauthenticated_all_write_methods(self):
        for response in (self.patch({'id': str(uuid.uuid4())}), self.client.delete('/api/history?id=x'), self.move({})):
            self.assertEqual((response.status_code, response.json()), (401, {'error': 'UNAUTHENTICATED'}))

    def test_missing_malformed_unknown_and_nonexistent(self):
        self.cookie()
        self.assertEqual(self.patch({}).json(), {'error': 'Missing id.'})
        self.assertEqual(self.client.patch('/api/history', '{', content_type='application/json').status_code, 400)
        self.assertEqual(self.client.delete('/api/history').status_code, 400)
        self.assertEqual(self.client.delete('/api/history?id=' + str(uuid.uuid4())).status_code, 404)
        self.assertEqual(self.patch({'id': str(uuid.uuid4()), 'isFavorite': True}).status_code, 404)
        self.assertEqual(self.patch({'id': str(uuid.uuid4()), 'flagged': True}).status_code, 404)
        self.assertEqual(self.patch({'id': str(uuid.uuid4())}).status_code, 500)
        self.assertEqual(self.patch({'id': 'not-uuid', 'isFavorite': True}).content, b'')

    def test_shared_favorite_flag_precedence_and_clear(self):
        self.cookie()
        row = self.generation(user_id=uuid.uuid4())
        favorite = self.patch({'id': str(row.id), 'isFavorite': True, 'flagged': True}).json()
        self.assertTrue(favorite['isFavorite'])
        self.assertFalse(favorite['flagged'])
        self.assertGreater(favorite['favoritedAt'], 1)
        flag = self.patch({'id': str(row.id), 'flagged': True, 'flagReason': 'Review details'}).json()
        self.assertTrue(flag['flagged'])
        self.assertTrue(flag['isFavorite'])
        self.assertEqual(flag['flagReason'], 'Review details')
        cleared = self.patch({'id': str(row.id), 'flagged': False, 'flagReason': 'Ignored'}).json()
        self.assertFalse(cleared['flagged'])
        self.assertNotIn('flagReason', cleared)
        self.assertNotIn('flaggedAt', cleared)
        removed = self.patch({'id': str(row.id), 'isFavorite': False}).json()
        self.assertNotIn('favoritedAt', removed)
        self.assertNotIn('providerResponses', removed)

    def test_single_item_moves_inherit_folder_scope_and_unsort(self):
        self.cookie()
        row = self.generation()
        project = Project.objects.create(name='P', created_at=1, updated_at=1)
        folder = create_folder(name='F', project_id=str(project.id))
        moved = self.patch({'id': str(row.id), 'folderId': folder['id']})
        self.assertEqual(moved.status_code, 200)
        self.assertEqual((moved.json()['folderId'], moved.json()['projectId'], moved.json()['locationVersion']), (folder['id'], str(project.id), 2))
        conflict = self.patch({'id': str(row.id), 'folderId': folder['id'], 'projectId': str(uuid.uuid4())})
        self.assertEqual(conflict.status_code, 500)
        unsorted = self.patch({'id': str(row.id), 'projectId': str(project.id)}).json()
        self.assertNotIn('folderId', unsorted)
        global_item = self.patch({'id': str(row.id), 'folderId': None, 'projectId': None}).json()
        self.assertNotIn('projectId', global_item)
        self.assertEqual(global_item['locationVersion'], 4)
        self.assertEqual(GenerationNaming.objects.get(generation=row).namespace, 'global_unsorted')

    def test_delete_owner_admin_orphan_and_storage_retention(self):
        self.cookie()
        actor = User.objects.get(pk='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        actor.role = 'member'
        actor.save(update_fields=['role'])
        own = self.generation(user_id=actor.id, url='/api/media/shared.png')
        other = self.generation(user_id=uuid.uuid4())
        orphan = self.generation()
        with patch('apps.media.storage.get_storage') as storage:
            self.assertEqual(self.client.delete('/api/history?id=' + str(other.id)).status_code, 403)
            self.assertEqual(self.client.delete('/api/history?id=' + str(orphan.id)).status_code, 403)
            self.assertEqual(self.client.delete('/api/history?id=' + str(own.id)).json(), {'ok': True})
            storage.assert_not_called()
        self.assertFalse(GenerationNaming.objects.filter(generation_id=own.id).exists())
        event = ActivityLog.objects.get(action='delete')
        self.assertEqual((event.user_id, event.detail['ownerId']), (actor.id, str(actor.id)))
        actor.role = 'admin'
        actor.save(update_fields=['role'])
        self.assertEqual(self.client.delete('/api/history?id=' + str(orphan.id)).status_code, 200)
        self.assertEqual(self.client.delete('/api/history?id=' + str(other.id)).status_code, 200)

    def test_delete_preserves_active_and_uncertain_job_evidence_for_owner_and_admin(self):
        self.cookie()
        actor=User.objects.get(pk='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
        for role in ('member','admin'):
            actor.role=role;actor.save(update_fields=['role'])
            for values in ({'status':'queued'},{'status':'running','task_id':'accepted'},
                    {'status':'pending'},{'status':'failed','provider_status':'SUBMISSION_UNCERTAIN'},
                    {'status':'failed','provider_status':'SUBMISSION_PENDING'}):
                with self.subTest(role=role,values=values):
                    row=self.generation(user_id=actor.id,submission_input={'version':2,'source':'fixture'},**values)
                    before=Generation.objects.filter(pk=row.id).values().get()
                    names=list(GenerationNaming.objects.filter(generation_id=row.id).values())
                    events=ActivityLog.objects.count()
                    with patch('apps.media.storage.get_storage') as storage:
                        response=self.client.delete('/api/history?id='+str(row.id))
                    self.assertEqual(response.status_code,409)
                    self.assertEqual(response.json()['error'],'GENERATION_REQUIRES_RECONCILIATION')
                    self.assertEqual(Generation.objects.filter(pk=row.id).values().get(),before)
                    self.assertEqual(list(GenerationNaming.objects.filter(generation_id=row.id).values()),names)
                    self.assertEqual(ActivityLog.objects.count(),events)
                    storage.assert_not_called()

    def test_move_validations_conflict_atomicity_and_replay(self):
        self.cookie()
        self.assertEqual(self.move({}).json(), {'error': 'At least one generation ID is required.'})
        self.assertEqual(self.move({'ids': ['id']}).json(), {'error': 'Destination descriptor is required.'})
        first, second = self.generation(), self.generation()
        ids = [str(first.id), str(second.id)]
        folder = create_folder(name='F')
        body = {'ids': ids, 'destination': {'type': 'folder', 'folderId': folder['id']}, 'expectedVersions': {ids[1]: 5}}
        failed = self.move(body, HTTP_X_IDEMPOTENCY_KEY='receipt')
        self.assertEqual((failed.status_code, failed.json()['code']), (409, 'VERSION_CONFLICT'))
        self.assertFalse(OrganizationIdempotencyKey.objects.filter(pk='receipt').exists())
        self.assertFalse(Generation.objects.filter(folder_id=folder['id']).exists())
        body['expectedVersions'][ids[1]] = 1
        moved = self.move(body, HTTP_X_IDEMPOTENCY_KEY='receipt')
        self.assertEqual(moved.status_code, 200)
        self.assertEqual((moved.json()['success'], moved.json()['movedCount']), (True, 2))
        self.assertEqual(self.move(body, HTTP_IDEMPOTENCY_KEY='receipt').json(), moved.json())
        self.assertEqual(list(Generation.objects.values_list('location_version', flat=True)), [2, 2])
        duplicate = self.move({'ids': [ids[0], ids[0]], 'destination': {'type': 'global_root'}})
        self.assertEqual((duplicate.status_code, duplicate.json()['code']), (400, 'DUPLICATE_GENERATION_IDS'))

    def test_partial_missing_batch_changes_nothing(self):
        self.cookie()
        row = self.generation()
        target = create_folder(name='Target')
        response = self.move({'ids': [str(row.id), str(uuid.uuid4())], 'destination': {'type': 'folder', 'folderId': target['id']}})
        self.assertEqual((response.status_code, response.json()['code']), (404, 'GENERATION_NOT_FOUND'))
        row.refresh_from_db()
        self.assertIsNone(row.folder_id)
        self.assertEqual(row.location_version, 1)
