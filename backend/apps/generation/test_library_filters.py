import uuid

from django.test import TransactionTestCase

from apps.admin_dashboard import tests as session_fixtures
from apps.library.models import Folder
from .models import Generation


class LibraryFilterTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie

    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)
        self.cookie()

    def row(self, **values):
        defaults = dict(id=uuid.uuid4(), kind='video', model='Seedance 2.5', status='succeeded',
                        prompt='mountain test', aspect_ratio='16:9', resolution='1080p',
                        duration=8, draft_mode=False, bitrate_mode='high', created_at=100, updated_at=100)
        defaults.update(values)
        return Generation.objects.create(**defaults)

    def ids(self, **params):
        response = self.client.get('/api/history', params)
        self.assertEqual(response.status_code, 200, response.content)
        return [item['id'] for item in response.json()['items']]

    def test_intersected_facets_filter_before_pagination_and_preserve_scope_search(self):
        folder = Folder.objects.create(name='Filter scope', created_at=1)
        wanted = self.row(folder=folder, draft_mode=True, duration=5)
        self.row(folder=folder, model='Seedance 2.0', draft_mode=True, created_at=200)
        self.row(folder=folder, draft_mode=False, created_at=300)
        self.row(folder=folder, draft_mode=True, prompt='ocean', created_at=400)
        self.row(draft_mode=True, created_at=500)
        self.assertEqual(self.ids(type='video', model=['seedance-25', 'seedance'], stage='draft',
                                  folderId=str(folder.id), q='mountain', durationBucket='short', limit=1), [str(wanted.id)])
        self.assertEqual(self.ids(type='image', stage='draft'), [])

    def test_unknown_stage_and_duration_are_not_final_or_zero_and_images_are_not_final(self):
        final = self.row(draft_mode=False)
        unknown = self.row(draft_mode=None, duration=None)
        self.row(kind='image', draft_mode=False)
        self.assertEqual(self.ids(stage='final'), [str(final.id)])
        self.assertEqual(self.ids(stage='unknown', durationBucket='unknown'), [str(unknown.id)])
        self.assertEqual(self.ids(durationBucket='short'), [])

    def test_resolution_tokens_are_typed_and_normalized(self):
        image = self.row(kind='image', model='Nano Banana Pro', resolution='4K')
        video = self.row(resolution=' 4k ')
        missing = self.row(resolution=None)
        self.assertEqual(self.ids(resolution='image:4k'), [str(image.id)])
        self.assertEqual(self.ids(resolution='video:4k'), [str(video.id)])
        self.assertEqual(self.ids(resolution='video:unknown'), [str(missing.id)])

    def test_date_bounds_are_inclusive_start_exclusive_end_and_creator_favourite_intersect(self):
        creator = uuid.uuid4()
        wanted = self.row(created_at=200, user_id=creator, is_favorite=True, favorited_at=300)
        self.row(created_at=199, user_id=creator, is_favorite=True)
        self.row(created_at=300, user_id=creator, is_favorite=True)
        self.row(created_at=250, user_id=creator)
        self.assertEqual(self.ids(createdFrom=200, createdBefore=300, creator=str(creator), favorite='1'), [str(wanted.id)])

    def test_status_and_bitrate_alternatives(self):
        ready = self.row(bitrate_mode='high')
        running = self.row(status='running', bitrate_mode='standard')
        self.row(status='failed', bitrate_mode='high')
        self.assertCountEqual(self.ids(status=['ready', 'creating'], bitrate=['high', 'standard']), [str(ready.id), str(running.id)])

    def test_ascending_keyset_ties_and_query_bound_cursor(self):
        rows = [self.row(created_at=100) for _ in range(4)]
        first = self.client.get('/api/history', {'sort': 'oldest', 'model': 'seedance-25', 'limit': 2}).json()
        second = self.client.get('/api/history', {'sort': 'oldest', 'model': 'seedance-25', 'limit': 2, 'cursor': first['nextCursor']}).json()
        self.assertEqual([row['id'] for row in first['items'] + second['items']], sorted(str(row.id) for row in rows))
        self.assertIsNone(second['nextCursor'])
        for changed in ({'sort': 'newest'}, {'sort': 'oldest', 'q': 'elsewhere'}, {'sort': 'oldest', 'model': 'seedance'}):
            self.assertEqual(self.client.get('/api/history', {**changed, 'cursor': first['nextCursor']}).status_code, 400)

    def test_options_include_retired_and_missing_values_from_entire_source_without_counts(self):
        folder = Folder.objects.create(name='Option scope', created_at=1)
        for index in range(24):
            self.row(folder=folder, created_at=index, model='Seedance 2.5')
        self.row(folder=folder, model='Retired creative model', resolution=None, aspect_ratio='3:2')
        self.row(model='Other folder model')
        response = self.client.get('/api/history', {'options': '1', 'folderId': str(folder.id), 'limit': 1, 'q': 'no results', 'type': 'image'})
        self.assertEqual(response.status_code, 200)
        options = response.json()['options']
        self.assertEqual({item['label'] for item in options['models']}, {'Seedance 2.5', 'Retired creative model'})
        self.assertIn('video:unknown', options['resolutions'])
        self.assertIn('3:2', options['aspects'])
        self.assertNotIn('counts', options)

    def test_invalid_parameters_are_bounded_400s_and_options_require_authentication(self):
        for params in ({'type': 'audio'}, {'model': ['x'] * 51}, {'creator': 'bad'},
                       {'resolution': '4k'}, {'stage': 'approved'}, {'sort': 'created_at;drop'},
                       {'sort': 'starred'}, {'createdFrom': 'x'}, {'createdFrom': '3', 'createdBefore': '2'},
                       {'createdFrom': '9' * 5000}, {'sort': 'newest', 'cursor': 'v1:garbage'}):
            self.assertEqual(self.client.get('/api/history', params).status_code, 400, params)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/history?options=1').status_code, 401)
