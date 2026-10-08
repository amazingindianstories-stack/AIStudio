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

class LoginThrottleTests(TransactionTestCase):
    def setUp(self):
        from django.db import connection
        with connection.cursor() as c:
            c.execute('CREATE TABLE IF NOT EXISTS login_attempts (id uuid PRIMARY KEY,identifier text NOT NULL,created_at bigint NOT NULL)')
            c.execute('TRUNCATE login_attempts')

    def test_unknown_identifier_failures_expiry_and_retry(self):
        from .throttle import check, record_failure, WINDOW_MS
        from .models import LoginAttempt
        now=2000000
        record_failure('  UNKNOWN@example.invalid ',now=now-WINDOW_MS)
        for offset in range(5):
            record_failure('unknown@example.invalid',now=now-1000+offset)
        self.assertEqual(check(' UNKNOWN@EXAMPLE.INVALID ',now=now),{'allowed':False,'retryAfterMs':WINDOW_MS-1000})
        self.assertEqual(LoginAttempt.objects.count(),5)
        self.assertEqual(check('other@example.invalid',now=now),{'allowed':True,'retryAfterMs':0})
        self.assertTrue(check('unknown@example.invalid',now=now+WINDOW_MS)['allowed'])
        self.assertEqual(LoginAttempt.objects.count(),0)

    def test_disabled_gate_does_not_cleanup(self):
        from .throttle import check, record_failure, maximum_attempts
        from .models import LoginAttempt
        record_failure('fixture',now=1)
        self.assertEqual(check('fixture',now=2000000,max_attempts=0),{'allowed':True,'retryAfterMs':0})
        self.assertEqual(LoginAttempt.objects.count(),1)
        for raw,expected in [('0',0),('',0),('5.9',5),('0x10',16),('invalid',5),('-1',5)]:
            self.assertEqual(maximum_attempts(raw),expected)


class ThrottleSourceParityTests(TransactionTestCase):
    def test_current_node_configuration_parsing(self):
        import json
        import subprocess
        from pathlib import Path
        from .throttle import maximum_attempts, retry_after, admits
        values=[None,'','0','5.9','.5','1e1','0x10','0b10','-0x10','Infinity','NaN','1_0','１２','\ufeff2','\u001c2','-1',' 3 ']
        request={'values':values,'retries':[[None,1000],[1000,2000],[1000,1000000]],'admissions':[{'maxAttempts':0,'recentFailureCount':9},{'maxAttempts':5,'recentFailureCount':5},{'maxAttempts':5,'recentFailureCount':4}]}
        result=subprocess.run(['node','--import','tsx','scripts/django-migration/throttle-oracle.mjs'],input=json.dumps(request),text=True,capture_output=True,check=True,cwd=Path(__file__).resolve().parents[3])
        expected=json.loads(result.stdout)
        self.assertEqual([maximum_attempts(value) for value in values],expected['maximums'])
        self.assertEqual([retry_after(oldest,now) for oldest,now in request['retries']],expected['retries'])
        self.assertEqual([admits(value['maxAttempts'],value['recentFailureCount']) for value in request['admissions']],expected['admissions'])
