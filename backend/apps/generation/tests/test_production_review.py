import uuid
from unittest.mock import patch

from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from apps.common.test_utils import SECRET, _cookie_for, _make_user
from apps.generation.models import Generation
from apps.generation import generations_service as gs, queue_service
from apps.generation.production_views import production_context
from apps.admin_dashboard.admin_stats import read_admin_stats
from apps.admin_dashboard.admin_logs import parse_admin_log_filter, query_admin_logs
from django.http import QueryDict


@override_settings(AUTH_SECRET=SECRET)
class ProductionReviewTests(TestCase):
    def setUp(self):
        self.user = _make_user()
        self.client = APIClient()
        self.client.cookies['veevee_session'] = _cookie_for(str(self.user.id))
        self.project = uuid.uuid4()
        self.item = Generation.objects.create(kind='image', status='succeeded', prompt='portrait', model='Nano Banana Pro', aspect_ratio='1:1', project_id=self.project, created_at=1788566400000, updated_at=1, cost_cents=12)
        self.url = f'/api/history/production?id={self.item.id}'

    def test_authentication_required(self):
        self.assertIn(APIClient().get(self.url).status_code, (401, 403))

    def test_review_revision_and_server_attribution(self):
        response = self.client.patch(self.url, {'scene': 'Opening', 'shot': '12A', 'take': '2', 'reviewStatus': 'approved', 'expectedRevision': 0}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        metadata = response.data['item']['productionMetadata']
        self.assertEqual(metadata['review']['reviewerId'], str(self.user.id))
        self.assertEqual(metadata['revision'], 1)
        stale = self.client.patch(self.url, {'take': 'stale', 'expectedRevision': 0}, format='json')
        self.assertEqual(stale.status_code, 409)
        self.item.refresh_from_db()
        self.assertEqual(self.item.production_metadata['take'], '2')
        self.assertEqual(self.client.patch(self.url, {'reviewerId': 'forged', 'expectedRevision': 1}, format='json').status_code, 400)

    def test_lineage_is_bidirectional_and_not_editable_in_review(self):
        child = Generation.objects.create(kind='video', status='succeeded', prompt='continue', model='Seedance 2.0', aspect_ratio='16:9', project_id=self.project, created_at=2, updated_at=2, production_metadata=production_context({'sourceGenerationId': str(self.item.id), 'relation': 'continuation'}, str(self.project)))
        self.assertEqual(self.client.get(self.url).data['children'][0]['id'], str(child.id))
        child_data = self.client.get(f'/api/history/production?id={child.id}').data
        self.assertEqual(child_data['source']['id'], str(self.item.id))
        self.assertEqual(child_data['item']['productionMetadata']['frame'], 'last')
        self.assertEqual(self.client.patch(self.url, {'sourceGenerationId': str(child.id), 'expectedRevision': 0}, format='json').status_code, 400)

    def test_worker_upsert_preserves_human_review(self):
        self.item.production_metadata = {'scene': 'Opening', 'reviewStatus': 'approved', 'revision': 1}
        self.item.save()
        payload = gs.row_to_item(self.item)
        payload['productionMetadata'] = {}
        queue_service.upsert_item(payload)
        self.item.refresh_from_db()
        self.assertEqual(self.item.production_metadata['reviewStatus'], 'approved')

    def test_filters_counts_and_oldest_cursor_agree(self):
        for index in range(4):
            Generation.objects.create(kind='image', status='succeeded', prompt='portrait', model='Nano Banana Pro', aspect_ratio='1:1', project_id=self.project, created_at=1788566400000+index, updated_at=1, production_metadata={'scene':'Opening', 'reviewStatus':'approved'})
        filter = {'model': 'Nano Banana Pro', 'q':'Opening', 'reviewStatus':'approved', 'from':'2026-09-05', 'to':'2026-09-05', 'sort':'oldest'}
        page = gs.query_history(filter, limit_n=2)
        second = gs.query_history(filter, gs.decode_cursor(page['nextCursor']), limit_n=2)
        self.assertEqual(len(page['items']) + len(second['items']), 4)
        self.assertFalse(set(i['id'] for i in page['items']) & set(i['id'] for i in second['items']))
        self.assertEqual(gs.count_scope(filter), 4)
        counts = self.client.get('/api/history/counts', {**filter, 'projectId': str(self.project)}).data
        self.assertEqual(counts['allAssets'], 4)
        self.assertEqual(counts['project']['total'], 4)

    def test_admin_scope_totals_match_log_scope(self):
        filter = parse_admin_log_filter(QueryDict(f'from=2026-09-05&to=2026-09-05&projectId={self.project}'))
        stats = read_admin_stats(filter)
        logs = query_admin_logs(filter)
        self.assertEqual(stats['totalGenerations'], logs['total'])
        self.assertEqual(stats['totalCostCents'], 12)
        self.assertEqual(read_admin_stats({'from':'2026-09-06'})['totalGenerations'], 0)

    def test_pricing_requires_auth_and_exposes_configured_rows(self):
        self.assertIn(APIClient().get('/api/pricing').status_code, (401, 403))
        response = self.client.get('/api/pricing')
        self.assertEqual(response.status_code, 200)
        self.assertIn('pricing', response.data)
        self.assertEqual(response['Cache-Control'], 'no-store')

    def test_invalid_lineage_rejected_before_upload(self):
        with patch('apps.generation.generation_views.save_media.save_reference_images') as upload:
            response = self.client.post('/api/generate/image', {'prompt':'test', 'productionContext': {'sourceGenerationId': str(uuid.uuid4()), 'relation':'clone'}}, format='json')
        self.assertEqual(response.status_code, 400)
        upload.assert_not_called()

    def test_continuity_reference_approval_is_bound_to_recorded_inputs(self):
        self.item.reference_images = ['/api/media/reference.png']
        self.item.save()
        invalid = self.client.patch(self.url, {'expectedRevision': 0, 'referenceNotes': [{'url': '/not-attached', 'label': 'Identity', 'approved': True}]}, format='json')
        self.assertEqual(invalid.status_code, 400)
        response = self.client.patch(self.url, {'expectedRevision': 0, 'referenceNotes': [{'url': '/api/media/reference.png', 'label': 'Identity', 'approved': True}]}, format='json')
        self.assertEqual(response.status_code, 200)
        note = response.data['item']['productionMetadata']['referenceNotes'][0]
        self.assertEqual(note['reviewerId'], str(self.user.id))
        self.assertEqual(note['label'], 'Identity')

    def test_unknown_review_state_and_overlong_context_do_not_write(self):
        self.assertEqual(self.client.patch(self.url, {'expectedRevision': 0, 'reviewStatus': 'published'}, format='json').status_code, 400)
        self.assertEqual(self.client.patch(self.url, {'expectedRevision': 0, 'shot': 'x' * 121}, format='json').status_code, 400)
        self.item.refresh_from_db()
        self.assertEqual(self.item.production_metadata, {})
