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
