from unittest.mock import patch
from django.db import OperationalError
from django.test import TestCase

class HealthTests(TestCase):
    def test_ready_checks_real_database(self):
        response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'ok': True, 'django': 'ready', 'database': 'ready'})
        self.assertEqual(response['Cache-Control'], 'no-store')
        self.assertTrue(response['X-Request-ID'])

    def test_database_failure_is_sanitized(self):
        with patch('apps.common.views.connection.cursor', side_effect=OperationalError('private credential diagnostic')):
            response = self.client.get('/api/health')
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('private', response.content.decode())


class CatalogEvidenceTests(TestCase):
    def test_catalog_detects_defaults_constraints_and_indexes(self):
        import importlib.util
        from pathlib import Path
        import psycopg
        from django.conf import settings
        module_path = Path(__file__).resolve().parents[3] / 'scripts/django-migration/schema-catalog.py'
        spec = importlib.util.spec_from_file_location('catalog_evidence', module_path)
        catalog = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(catalog)
        database = settings.DATABASES['default']
        # Use the test runner's database, never the unverified URL directly.
        with psycopg.connect(dbname=database['NAME'], host=database['HOST'],
                             port=database['PORT'], user=database['USER'],
                             password=database['PASSWORD'], autocommit=True) as db:
            before = catalog.snapshot(db)
            with db.cursor() as cursor:
                cursor.execute('CREATE TABLE catalog_fixture (id integer PRIMARY KEY, value integer DEFAULT 1 CHECK(value > 0))')
                cursor.execute('CREATE INDEX catalog_fixture_value ON catalog_fixture(value)')
            try:
                after = catalog.snapshot(db)
                self.assertTrue({'tables','columns','constraints','indexes'} <= set(catalog.compare(before,after)))
                indexes = [entry for entry in after['indexes'] if entry['table_name']=='catalog_fixture']
                self.assertEqual(len(indexes),2)
                self.assertTrue(all('index_name' in entry for entry in indexes))
                self.assertEqual(catalog.compare(after,after),[])
            finally:
                with db.cursor() as cursor:
                    cursor.execute('DROP TABLE catalog_fixture')
