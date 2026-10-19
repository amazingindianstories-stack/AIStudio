"""GET /api/admin/errors: admin-only, retroactive, redacted, filtered and keyset-paged provider error log."""
import json
import uuid

from django.test import TransactionTestCase, override_settings

from apps.assets.models import ManagedPortraitAsset
from apps.authentication.models import User
from apps.generation import failure_copy, provider_errors
from apps.generation.models import Generation
from apps.generation.providers import seedance
from testsupport.fake_providers import PROVIDER_ERRORS, REQUEST_ID, asset_error
from . import tests as fixtures

OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
SECRET = 'private-fixture-token'


@override_settings(ROOT_URLCONF='apps.admin_dashboard.urls')
class AdminErrorsTests(TransactionTestCase):
    cookie = fixtures.SettingsTests.cookie

    def setUp(self):
        fixtures.SettingsTests.setUp(self)
        User.objects.filter(pk=fixtures.UID).update(role='admin')
        User.objects.create(id=OTHER, email='other@example.invalid', name='Other', role='user', password_hash='x', password_salt='x',
                            created_at=1, is_active=True, auth_version=0)
        self.cookie()

    def generation(self, created_at, **values):
        fields = dict(id=uuid.uuid4(), kind='video', status='failed', prompt='fixture', model='Seedance 2.5', aspect_ratio='16:9',
                      user_id=fixtures.UID, created_at=created_at, updated_at=created_at + 5, completed_at=created_at + 5)
        return Generation.objects.create(**{**fields, **values})

    def portrait(self, created_at, **values):
        fields = dict(content_sha256=uuid.uuid4().hex, source_key='references/x.png', status='FAILED', receipt={'version': 1},
                      created_by_id=OTHER, created_at=created_at, updated_at=created_at + 7, last_used_at=created_at)
        return ManagedPortraitAsset.objects.create(**{**fields, **values})

    def get(self, **params):
        response = self.client.get('/api/admin/errors', params)
        self.assertEqual(response.status_code, 200, response.content)
        return response.json()

    def test_admin_only(self):
        self.client.cookies.clear()
        self.assertEqual((self.client.get('/api/admin/errors').status_code, self.client.get('/api/admin/errors').json()), (401, {'error': 'UNAUTHENTICATED'}))
        User.objects.filter(pk=fixtures.UID).update(role='user')
        self.cookie()
        self.assertEqual((self.client.get('/api/admin/errors').status_code, self.client.get('/api/admin/errors').json()), (403, {'error': 'FORBIDDEN'}))
        self.assertEqual(self.client.post('/api/admin/errors').status_code, 405)

    def test_the_production_seedance_row_reads_retroactively_with_what_the_user_was_told(self):
        status, body = PROVIDER_ERRORS['seedance']
        # Exactly what production stored before this change: the raw body, the status and an empty request id.
        row = self.generation(1000, error=seedance.NEUTRAL_POLICY_MESSAGE, moderation_blocked=True, provider_responses=[
            {'provider': 'seedance', 'httpStatus': status, 'rawBody': json.dumps(body), 'requestId': None, 'receivedAt': 1004}])
        self.generation(2000, status='succeeded')     # not an error
        [item] = self.get()['rows']
        self.assertEqual({key: item[key] for key in ('id', 'source', 'createdAt', 'failedAt', 'userId', 'userEmail', 'kind', 'model', 'provider',
                                                     'httpStatus', 'code', 'param', 'requestId', 'phase', 'receivedAt', 'error', 'userMessage')}, {
            'id': str(row.id), 'source': 'generation', 'createdAt': 1000, 'failedAt': 1005, 'userId': fixtures.UID,
            'userEmail': 'fixture@example.invalid', 'kind': 'video', 'model': 'Seedance 2.5', 'provider': 'seedance', 'httpStatus': 400,
            'code': 'InputAudioSensitiveContentDetected', 'param': 'content[10]', 'requestId': REQUEST_ID, 'phase': None, 'receivedAt': 1004,
            'error': seedance.NEUTRAL_POLICY_MESSAGE,
            'userMessage': 'Seedance rejected the input audio (content[10]) under its content policy. '
                           f'Provider code: InputAudioSensitiveContentDetected. Request id: {REQUEST_ID}.'})
        self.assertEqual(item['message'], body['error']['message'])
        self.assertEqual(item['rawBody'], json.dumps(body))
        self.assertEqual(len(item['records']), 1)

    def test_older_rows_without_a_record_fall_back_to_the_stored_error(self):
        self.generation(1000, model='Nano Banana Pro', kind='image', error='Gemini returned no image (no candidates).',
                        provider_responses=[{'uncertainSubmission': True, 'errorType': 'ProviderError', 'recordedAt': 1}])
        [item] = self.get()['rows']
        self.assertEqual((item['code'], item['message'], item['records'], item['provider'], item['error'], item['userMessage']),
                         (None, None, [], 'gemini', 'Gemini returned no image (no candidates).', failure_copy.NO_IMAGE))

    def test_portrait_assets_that_failed_or_are_uncertain(self):
        record = provider_errors.capture('byteplus-assets', phase='CreateAsset', status=400,
                                         body=json.dumps(asset_error('CreateAsset', 'InvalidParameter.ImageInvalid', 'The image cannot be used.')))
        failed = self.portrait(1000, error_code='InvalidParameter.ImageInvalid', receipt={'version': 1, 'lastError': record}, byteplus_asset_id=None)
        uncertain = self.portrait(1100, status='UNCERTAIN', error_code='create_unverified', byteplus_asset_id='asset-9')
        self.portrait(1200, status='ACTIVE', byteplus_asset_id='asset-10')     # healthy: not listed
        rows = self.get()['rows']
        self.assertEqual([row['id'] for row in rows], [str(uncertain.id), str(failed.id)])
        self.assertEqual({key: rows[1][key] for key in ('source', 'kind', 'model', 'provider', 'status', 'userEmail', 'code', 'message', 'requestId', 'failedAt')},
                         {'source': 'portrait', 'kind': 'portrait', 'model': 'Portrait asset', 'provider': 'byteplus-assets', 'status': 'FAILED',
                          'userEmail': 'other@example.invalid', 'code': 'InvalidParameter.ImageInvalid', 'message': 'The image cannot be used.',
                          'requestId': 'req-asset-fixture', 'failedAt': 1007})
        self.assertEqual((rows[0]['code'], rows[0]['origin'], rows[0]['taskId'], rows[0]['records']), ('create_unverified', 'veevee', 'asset-9', []))

    def test_filters(self):
        kling = {'provider': 'kling', 'httpStatus': 429, 'code': '1102', 'message': 'Account balance not enough', 'receivedAt': 1}
        a = self.generation(1000, model='Kling Image 3.0', kind='image', error='x', provider_responses=[kling])
        b = self.generation(2000, user_id=OTHER, error='y', provider_responses=[{'provider': 'seedance', 'rawBody': json.dumps(PROVIDER_ERRORS['seedance'][1])}])
        c = self.portrait(3000, error_code='QuotaSharedPoolExceeded')
        ids = lambda **params: [row['id'] for row in self.get(**params)['rows']]
        self.assertEqual(ids(), [str(c.id), str(b.id), str(a.id)])
        self.assertEqual(ids(userId=OTHER), [str(c.id), str(b.id)])
        self.assertEqual(ids(model='Kling Image 3.0'), [str(a.id)])
        self.assertEqual(ids(model='Portrait asset'), [str(c.id)])
        self.assertEqual(ids(provider='kling'), [str(a.id)])
        self.assertEqual(ids(provider='seedance'), [str(b.id)], 'by registry model and by record')
        self.assertEqual(ids(provider='byteplus-assets'), [str(c.id)])
        self.assertEqual(ids(code='InputAudioSensitive'), [str(b.id)], 'an older row is found by the code inside its raw body')
        self.assertEqual(ids(code='Quota'), [str(c.id)])
        self.assertEqual(ids(code='100%_'), [], 'LIKE wildcards are literal')
        self.assertEqual(ids(**{'from': '1500', 'to': '3000'}), [str(b.id)])
        self.assertEqual(ids(source='portrait'), [str(c.id)])
        self.assertEqual(ids(source='generation'), [str(b.id), str(a.id)])
        self.assertEqual(self.get(userId='not-a-uuid')['total'], 3, 'a malformed user id is ignored, not an error')

    def test_keyset_paging_over_both_sources_keeps_the_total(self):
        rows = [self.generation(1000 + index * 10, error='e') for index in range(4)] + [self.portrait(1005), self.portrait(1025)]
        expected = [str(item.id) for item in sorted(rows, key=lambda item: (item.created_at, str(item.id)), reverse=True)]
        seen, cursor = [], None
        while True:
            page = self.get(limit='2', **({'cursor': cursor} if cursor else {}))
            self.assertEqual(page['total'], 6)
            seen += [row['id'] for row in page['rows']]
            cursor = page['nextCursor']
            if not cursor:
                break
        self.assertEqual(seen, expected)
        first = self.get(limit='2')
        self.assertIn('models', first)
        self.assertNotIn('models', self.get(limit='2', cursor=first['nextCursor']))

    def test_every_text_field_is_redacted_on_the_way_out(self):
        leaky = f'Authorization: Bearer {SECRET} at https://bucket.invalid/o?X-Goog-Signature={SECRET}'
        self.generation(1000, error=leaky, provider_responses=[{'provider': 'gemini', 'httpStatus': 400, 'rawBody': json.dumps(
            {'error': {'code': 400, 'status': 'INVALID_ARGUMENT', 'message': f'bad key={SECRET}'}})}])
        response = self.client.get('/api/admin/errors')
        self.assertNotIn(SECRET, response.content.decode())
        [item] = response.json()['rows']
        self.assertEqual((item['code'], item['message']), ('INVALID_ARGUMENT', 'bad key=[redacted]'))
        self.assertEqual(item['error'], 'Authorization: [redacted] at [url]')
