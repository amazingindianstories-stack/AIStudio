from unittest.mock import patch
from django.test import TransactionTestCase
from apps.admin_dashboard import tests as session_fixtures


class UpdateEndpointTests(TransactionTestCase):
    cookie = session_fixtures.SettingsTests.cookie
    def setUp(self):
        session_fixtures.SettingsTests.setUp(self)

    def test_auth_precedes_selection(self):
        with patch('apps.generation.updates.read_generation_updates') as select:
            response = self.client.get('/api/history/updates?since=invalid')
            self.assertEqual((response.status_code,response.json()),(401,{'error':'UNAUTHENTICATED'}))
            select.assert_not_called()

    def test_first_watermark_fallback_server_clock_and_renewal(self):
        # The separate full-schema PG16 probe qualifies actual query selection;
        # here its boundary is replaced to inspect route parsing/timestamps.
        with patch('apps.generation.updates.time.time',return_value=1700000000), patch('apps.generation.updates.read_generation_updates',return_value=[]) as select:
            self.cookie(age=2*86400000)
            response = self.client.get('/api/history/updates?since=0x10&since=999')
            select.assert_called_once_with(16.0)
            self.assertEqual(response.json(),{'items':[],'now':1700000000000})
            self.assertIn('veevee_session',response.cookies)
            for query in ['', '?since=invalid', '?since=', '?since=0', '?since=-1']:
                select.reset_mock()
                response = self.client.get('/api/history/updates'+query)
                self.assertEqual(response.status_code,200)
                select.assert_called_once_with(1699999700000)
