"""Direct tests of the library keyset pages and SQL counts in services/reads.py."""
import uuid

from django.test import TransactionTestCase

from apps.library.models import Folder
from .models import Generation
from .services import reads


class LibraryKeysetTests(TransactionTestCase):
    def row(self, **values):
        defaults = dict(id=uuid.uuid4(), kind='image', model='seedream-5-pro', status='succeeded', prompt='keyset',
                        aspect_ratio='1:1', created_at=100, updated_at=100)
        defaults.update(values)
        return Generation.objects.create(**defaults)

    def walk(self, params, limit):
        """Every page of a scope: ids per page, so duplicates and gaps show."""
        pages, cursor = [], None
        while True:
            page = reads.query_history({**params, 'limit': limit, **({'cursor': cursor} if cursor else {})})
            pages.append([item['id'] for item in page['items']])
            cursor = page['nextCursor']
            if not cursor:
                return pages

    def test_created_at_cursor_breaks_ties_by_id_and_neither_repeats_nor_skips_rows(self):
        rows = [self.row(created_at=100 if index < 5 else 200 + index) for index in range(8)]
        expected = [str(row.id) for row in sorted(rows, key=lambda row: (row.created_at, row.id), reverse=True)]
        pages = self.walk({}, 3)
        self.assertEqual([len(page) for page in pages], [3, 3, 2])
        self.assertEqual([item for page in pages for item in page], expected)
        oldest = self.walk({'sort': 'oldest'}, 3)
        self.assertEqual([item for page in oldest for item in page], expected[::-1])

    def test_a_page_reports_more_only_when_a_row_exists_past_the_limit(self):
        for index in range(4):
            self.row(created_at=100 + index)
        exact = reads.query_history({'limit': 4})
        self.assertEqual((len(exact['items']), exact['nextCursor']), (4, None))
        short = reads.query_history({'limit': 3})
        self.assertEqual(len(short['items']), 3)
        self.assertIsNotNone(short['nextCursor'])
        last = reads.query_history({'limit': 3, 'cursor': short['nextCursor']})
        self.assertEqual((len(last['items']), last['nextCursor']), (1, None))

    def test_favorite_cursor_orders_by_favorited_at_then_id(self):
        favorites = [self.row(is_favorite=True, favorited_at=500 if index < 4 else 600 + index, created_at=10 + index) for index in range(6)]
        self.row(created_at=999)
        expected = [str(row.id) for row in sorted(favorites, key=lambda row: (row.favorited_at, row.id), reverse=True)]
        pages = self.walk({'favorite': '1'}, 2)
        self.assertEqual([len(page) for page in pages], [2, 2, 2])
        self.assertEqual([item for page in pages for item in page], expected)

    def test_cursor_text_is_created_at_and_id_of_the_last_row(self):
        for index in range(3):
            self.row(created_at=100 + index)
        page = reads.query_history({'limit': 2})
        last = Generation.objects.get(pk=page['items'][-1]['id'])
        self.assertEqual(page['nextCursor'], f'{last.created_at}.{last.id}')


class LibraryCountTests(TransactionTestCase):
    def test_counts_come_from_sql_and_do_not_follow_the_page_size(self):
        folder = Folder.objects.create(name='Counted', created_at=1, updated_at=1)

        def make(index, **values):
            fields = dict(id=uuid.uuid4(), kind='image', model='seedream-5-pro', status='succeeded', prompt='count',
                aspect_ratio='1:1', created_at=100 + index, updated_at=100 + index)
            return Generation.objects.create(**{**fields, **values})
        for index in range(7):
            make(index, project_id=None, folder_id=folder.id if index < 3 else None, is_favorite=index < 2, favorited_at=500 + index if index < 2 else None)
        make(7, kind='audio')
        make(8, kind='text')
        page = reads.query_history({'limit': 2})
        self.assertEqual(len(page['items']), 2)
        counts = reads.count_library({})
        self.assertEqual((counts['allAssets'], counts['favorites']), (7, 2))
        self.assertEqual(counts['globalLibrary'], {'total': 7, 'unsorted': 4, 'byFolder': {str(folder.id): 3}})
        self.assertEqual(counts['project'], {'total': 0, 'unsorted': 0, 'byFolder': {}})
        self.assertEqual(reads.count_library({'kind': 'audio'})['allAssets'], 1)
        with self.assertNumQueries(3):
            reads.count_library({})
