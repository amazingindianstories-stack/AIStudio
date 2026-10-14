from testsupport.frozen_oracle import run as oracle_run
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
    @__import__('unittest').skipUnless(__import__('shutil').which('node'), 'Node.js is not installed (historical interop check runs where node exists)')
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
        result=oracle_run(['node','--import','tsx','scripts/django-migration/throttle-oracle.mjs'],input=json.dumps(request),text=True,capture_output=True,check=True,cwd=Path(__file__).resolve().parents[3])
        expected=json.loads(result.stdout)
        self.assertEqual([maximum_attempts(value) for value in values],expected['maximums'])
        self.assertEqual([retry_after(oldest,now) for oldest,now in request['retries']],expected['retries'])
        self.assertEqual([admits(value['maxAttempts'],value['recentFailureCount']) for value in request['admissions']],expected['admissions'])

class LoginApiTests(TransactionTestCase):
    setUp = SettingsTests.setUp

    def test_login_success_and_failure_throttle(self):
        from .models import LoginAttempt
        from apps.common.models import ActivityLog
        response=self.client.post('/api/auth/login',{'email':' FIXTURE@EXAMPLE.INVALID ','password':'fixture-password'},content_type='application/json')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['user']['email'],'fixture@example.invalid')
        self.assertEqual(response.cookies['veevee_session']['max-age'],2592000)
        self.assertEqual(ActivityLog.objects.filter(action='login').count(),1)
        self.assertEqual(LoginAttempt.objects.count(),0)
        for _ in range(5):
            response=self.client.post('/api/auth/login',{'email':'missing@example.invalid','password':'wrong'},content_type='application/json')
            self.assertEqual(response.status_code,401)
        response=self.client.post('/api/auth/login',{'email':'missing@example.invalid','password':'wrong'},content_type='application/json')
        self.assertEqual(response.status_code,429)
        self.assertTrue(int(response['Retry-After'])>0)
        self.assertEqual(LoginAttempt.objects.count(),5)

    def test_missing_credentials(self):
        response=self.client.post('/api/auth/login',{},content_type='application/json')
        self.assertEqual(response.status_code,400)
        self.assertEqual(response.json(),{'error':'Email and password are required.'})

class LogoutApiTests(TransactionTestCase):
    cookie=SettingsTests.cookie
    setUp=LoginApiTests.setUp

    def test_logout_clears_cookie_and_audits_only_valid_session(self):
        from apps.common.models import ActivityLog
        response=self.client.post('/api/auth/logout')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(),{'ok':True})
        self.assertEqual(response.cookies['veevee_session']['max-age'],0)
        self.assertTrue(response.cookies['veevee_session']['httponly'])
        self.assertEqual(response.cookies['veevee_session']['samesite'],'')
        self.assertEqual(ActivityLog.objects.count(),0)
        self.cookie(age=172800000)
        response=self.client.post('/api/auth/logout')
        self.assertEqual(response.cookies['veevee_session']['max-age'],0)
        self.assertEqual(response.cookies['veevee_session'].value,'')
        self.assertEqual(ActivityLog.objects.filter(action='logout').count(),1)

class PasswordChangeApiTests(TransactionTestCase):
    cookie=SettingsTests.cookie
    setUp=LoginApiTests.setUp

    def test_password_change_invalidates_old_cookie_and_reissues(self):
        from .models import User
        from .password import verify_password
        from apps.common.models import ActivityLog
        self.cookie()
        old=self.client.cookies['veevee_session'].value
        response=self.client.patch('/api/auth/password',{'currentPassword':'fixture-password','newPassword':'changed-fixture-password'},content_type='application/json')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(),{'ok':True})
        account=User.objects.get()
        self.assertEqual(account.auth_version,1)
        self.assertTrue(verify_password('changed-fixture-password',account.password_hash,account.password_salt))
        self.assertEqual(ActivityLog.objects.filter(action='password_changed').count(),1)
        self.client.cookies['veevee_session']=response.cookies['veevee_session'].value
        self.assertIsNotNone(self.client.get('/api/auth/me').json()['user'])
        self.client.cookies['veevee_session']=old
        self.assertEqual(self.client.get('/api/auth/me').json(),{'user':None})

    def test_wrong_current_password_does_not_mutate_account(self):
        from .models import User
        self.cookie()
        response=self.client.patch('/api/auth/password',{'currentPassword':'wrong','newPassword':'changed-fixture-password'},content_type='application/json')
        self.assertEqual(response.status_code,401)
        self.assertEqual(response.json(),{'error':'Current password is incorrect.'})
        self.assertEqual(User.objects.get().auth_version,0)

    def test_concurrent_auth_version_change_returns_conflict(self):
        from unittest.mock import patch
        from .models import User
        from .password import hash_password
        from apps.common.models import ActivityLog
        self.cookie()
        original=User.objects.get().password_hash
        def concurrent_change(password):
            User.objects.update(auth_version=1)
            return hash_password(password)
        with patch('apps.authentication.password.hash_password',side_effect=concurrent_change):
            response=self.client.patch('/api/auth/password',{'currentPassword':'fixture-password','newPassword':'changed-fixture-password'},content_type='application/json')
        self.assertEqual(response.status_code,409)
        self.assertEqual(response.json(),{'error':'Your session changed. Sign in and try again.'})
        self.assertEqual(response.cookies['veevee_session']['max-age'],0)
        self.assertEqual(User.objects.get().password_hash,original)
        self.assertEqual(ActivityLog.objects.count(),0)


class BrowserOriginTests(TransactionTestCase):
    setUp=LoginApiTests.setUp
    cookie=SettingsTests.cookie

    def test_cross_origin_mutations_fail_before_database_effects(self):
        from django.test import override_settings
        from .models import LoginAttempt
        from apps.common.models import ActivityLog
        self.cookie()
        with override_settings(VEEVEE_BROWSER_ORIGINS=('https://frontend.example',)):
            for endpoint,method in [('/api/auth/login',self.client.post),('/api/auth/logout',self.client.post),('/api/auth/password',self.client.patch)]:
                response=method(endpoint,{},content_type='application/json',HTTP_ORIGIN='https://attacker.example')
                self.assertEqual(response.status_code,403)
                self.assertEqual(response.json(),{'error':'FORBIDDEN_ORIGIN'})
            response=self.client.post('/api/auth/login',{},content_type='application/json',HTTP_ORIGIN='https://frontend.example')
            self.assertEqual(response.status_code,400)
            response=self.client.post('/api/auth/logout',HTTP_SEC_FETCH_SITE='cross-site')
            self.assertEqual(response.status_code,403)
        self.assertEqual(LoginAttempt.objects.count(),0)
        self.assertEqual(ActivityLog.objects.count(),0)
