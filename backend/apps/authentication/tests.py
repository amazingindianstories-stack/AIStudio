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

class PasswordCompatibilityTests(TransactionTestCase):
    def test_node_python_password_interoperability_and_validation(self):
        import json
        import subprocess
        from pathlib import Path
        from .password import hash_password, verify_password, validate_password
        root=Path(__file__).resolve().parents[3]
        passwords=['fixture-password','सुरक्षितपासवर्ड','😀'*4,'😀'*65,'short','fixture-\ud800-password']
        def oracle(request):
            result=subprocess.run(['node','scripts/django-migration/password-oracle.mjs'],input=json.dumps(request),text=True,capture_output=True,check=True,cwd=root)
            return json.loads(result.stdout)
        node=oracle({'operation':'hash','passwords':passwords})
        for password,entry in zip(passwords,node):
            self.assertTrue(verify_password(password,entry['hash'],entry['salt']))
            self.assertFalse(verify_password(password+'wrong',entry['hash'],entry['salt']))
            self.assertEqual(validate_password(password),entry['validation'])
        entries=[{'password':password,**hash_password(password)} for password in passwords]
        for password,result in zip(passwords,oracle({'operation':'verify','entries':entries})):
            self.assertTrue(result['verified'])
            self.assertEqual(validate_password(password),result['validation'])
        self.assertFalse(verify_password('fixture','malformed','salt'))
