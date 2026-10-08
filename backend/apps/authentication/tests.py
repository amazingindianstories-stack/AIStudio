from django.test import TransactionTestCase
from apps.admin_dashboard.tests import SettingsTests

class CurrentUserTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = SettingsTests.setUp

    def test_missing_or_invalid_session_returns_null_and_clears_cookie(self):
        for token in ['', 'invalid']:
            self.client.cookies['veevee_session'] = token
            response = self.client.get('/api/auth/me')
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.json(),{'user':None})
            self.assertEqual(response.cookies['veevee_session']['max-age'],0)
            self.assertTrue(response.cookies['veevee_session']['httponly'])

    def test_public_user_and_renewal(self):
        self.cookie(age=172800000)
        response = self.client.get('/api/auth/me')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['user'],{'id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','email':'fixture@example.invalid','name':'Fixture','role':'user','color':None,'avatarUrl':None})
        self.assertEqual(response.cookies['veevee_session']['max-age'],2592000)
        self.cookie(version=1)
        self.assertEqual(self.client.get('/api/auth/me').json(),{'user':None})
