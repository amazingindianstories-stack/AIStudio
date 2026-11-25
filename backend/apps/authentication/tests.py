from testsupport.frozen_oracle import run as oracle_run
from django.test import TransactionTestCase, override_settings
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
        self.assertEqual(response.json()['user'],{'id':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','email':'fixture@example.invalid','name':'Fixture','role':'user','color':None,'avatarUrl':None,'agentsEnabled':False})
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
        oracle_script=Path(__file__).resolve().parents[2]/'testsupport'/'password-oracle.mjs'
        passwords=['fixture-password','सुरक्षितपासवर्ड','😀'*4,'😀'*65,'short','fixture-\ud800-password']
        def oracle(request):
            result=subprocess.run(['node',str(oracle_script)],input=json.dumps(request),text=True,capture_output=True,check=True)
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
        from .throttle import admit, record_failure, WINDOW_MS
        from .models import LoginAttempt
        now=2000000
        record_failure('  UNKNOWN@example.invalid ',now=now-WINDOW_MS)
        for offset in range(5):
            record_failure('unknown@example.invalid',now=now-1000+offset)
        refused=admit(' UNKNOWN@EXAMPLE.INVALID ',now=now)
        self.assertEqual((refused['allowed'],refused['retryAfterMs'],refused['layer']),(False,WINDOW_MS-1000,'login_account'))
        self.assertEqual(LoginAttempt.objects.count(),6)  # a refusal writes nothing; the stale row waits for cleanup
        other=admit('other@example.invalid',now=now)
        self.assertTrue(other['allowed'])
        self.assertTrue(admit('unknown@example.invalid',now=now+WINDOW_MS)['allowed'])

    def test_disabled_gate_writes_nothing(self):
        from .throttle import admit, record_failure, maximum_attempts
        from .models import LoginAttempt
        record_failure('fixture',now=1)
        self.assertEqual(admit('fixture',now=2000000,max_attempts=0),{'allowed':True,'retryAfterMs':0,'layer':None,'reservation':[]})
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
        self.assertEqual(LoginAttempt.objects.filter(identifier='missing@example.invalid').count(),5)

    def test_login_refuses_oversized_email(self):
        from .models import LoginAttempt
        response=self.client.post('/api/auth/login',{'email':'a'*290+'@example.invalid','password':'wrong'},content_type='application/json')
        self.assertEqual(response.status_code,400)
        self.assertEqual(response.json(),{'error':'Email is too long.'})
        self.assertEqual(LoginAttempt.objects.count(),0)

    def post(self,email,password='wrong',**headers):
        return self.client.post('/api/auth/login',{'email':email,'password':password},content_type='application/json',**headers)

    def test_a_forwarded_address_is_never_trusted(self):
        # Railway puts a shared Vercel egress address into X-Forwarded-For; keying on it would join every artist into one bucket.
        from .models import LoginAttempt
        for index in range(51):
            self.assertEqual(self.post(f'rotating{index}@example.invalid',HTTP_X_FORWARDED_FOR='8.8.8.8',HTTP_X_REAL_IP='8.8.8.8').status_code,401)
        self.assertFalse(LoginAttempt.objects.filter(identifier__startswith='ip:').exists())
        for _ in range(4):
            self.post('rotating0@example.invalid')
        self.assertEqual(self.post('rotating0@example.invalid').status_code,429)

    @override_settings(VEEVEE_ADDRESS_RATE_LIMITS=True,VEEVEE_CLIENT_ADDRESS_KEY='k'*64)
    def test_address_layer_limits_rotating_emails_from_a_vouched_address_only(self):
        from apps.common.client_address import sign
        def signed(address):
            return {'HTTP_X_VEEVEE_CLIENT_IP':address,'HTTP_X_VEEVEE_CLIENT_IP_PROOF':sign('k'*64,address)}
        for index in range(50):
            self.assertEqual(self.post(f'rotating{index}@example.invalid',**signed('8.8.8.8')).status_code,401)
        response=self.post('rotating-last@example.invalid',**signed('8.8.8.8'))
        self.assertEqual(response.status_code,429)
        self.assertTrue(int(response['Retry-After'])>0)
        self.assertEqual(self.post('rotating-last@example.invalid',**signed('1.1.1.1')).status_code,401)
        # A forged proof and an unsigned address are untrusted: no address bucket, so nothing is blocked by address.
        forged={'HTTP_X_VEEVEE_CLIENT_IP':'8.8.8.8','HTTP_X_VEEVEE_CLIENT_IP_PROOF':'v1.1.'+'0'*64}
        self.assertEqual(self.post('rotating-other@example.invalid',**forged).status_code,401)
        self.assertEqual(self.post('rotating-other2@example.invalid',HTTP_X_VEEVEE_CLIENT_IP='8.8.8.8').status_code,401)

    @override_settings(VEEVEE_ADDRESS_RATE_LIMITS=True,VEEVEE_CLIENT_ADDRESS_KEY='k'*64)
    def test_a_correct_password_from_a_known_address_is_not_locked_out_by_a_stranger(self):
        from apps.common.client_address import sign
        home={'HTTP_X_VEEVEE_CLIENT_IP':'8.8.8.8','HTTP_X_VEEVEE_CLIENT_IP_PROOF':sign('k'*64,'8.8.8.8')}
        attacker={'HTTP_X_VEEVEE_CLIENT_IP':'9.9.9.9','HTTP_X_VEEVEE_CLIENT_IP_PROOF':sign('k'*64,'9.9.9.9')}
        self.assertEqual(self.post('fixture@example.invalid','fixture-password',**home).status_code,200)
        for _ in range(5):
            self.assertEqual(self.post('fixture@example.invalid',**attacker).status_code,401)
        blocked=self.post('fixture@example.invalid','fixture-password',**attacker)
        self.assertEqual(blocked.status_code,429)
        self.assertEqual(self.post('fixture@example.invalid','fixture-password',**home).status_code,200)

    @override_settings(VEEVEE_ADDRESS_RATE_LIMITS=True,VEEVEE_CLIENT_ADDRESS_KEY='k'*64)
    def test_a_day_of_guessing_locks_strangers_out_but_not_the_artist_at_home(self):
        import time
        from .models import LoginAttempt
        from apps.common.client_address import sign
        def signed(address):
            return {'HTTP_X_VEEVEE_CLIENT_IP':address,'HTTP_X_VEEVEE_CLIENT_IP_PROOF':sign('k'*64,address)}
        self.assertEqual(self.post('fixture@example.invalid','fixture-password',**signed('8.8.8.8')).status_code,200)
        now=int(time.time()*1000)
        oldest=now-20*3600*1000
        # Twenty failures spread over the last day: under the 15-minute and hour tiers, at the 24 h tier.
        LoginAttempt.objects.bulk_create([LoginAttempt(identifier='fixture@example.invalid',created_at=oldest+index*3600*1000) for index in range(20)])
        stranger=self.post('fixture@example.invalid','fixture-password',**signed('9.9.9.9'))
        self.assertEqual(stranger.status_code,429)
        self.assertAlmostEqual(int(stranger['Retry-After']),4*3600,delta=60)
        self.assertEqual(self.post('fixture@example.invalid','fixture-password').status_code,429)
        self.assertEqual(self.post('fixture@example.invalid','fixture-password',**signed('8.8.8.8')).status_code,200)

    def test_the_lockout_response_carries_retry_after_and_the_blocked_counter(self):
        from apps.mcp_auth import ratelimits
        for _ in range(5):
            self.post('missing@example.invalid')
        response=self.post('missing@example.invalid')
        self.assertEqual(response.status_code,429)
        self.assertEqual(response.json(),{'error':'Too many failed attempts. Try again later.'})
        self.assertTrue(1<=int(response['Retry-After'])<=900)
        self.assertEqual(ratelimits.event_totals()['blocked:login_account'][0],1)

    def test_missing_credentials(self):
        response=self.client.post('/api/auth/login',{},content_type='application/json')
        self.assertEqual(response.status_code,400)
        self.assertEqual(response.json(),{'error':'Email and password are required.'})

class LogoutApiTests(TransactionTestCase):
    cookie=SettingsTests.cookie
    setUp=LoginApiTests.setUp

    def test_logout_clears_cookie_with_matching_attributes(self):
        from django.conf import settings
        cookie=self.client.post('/api/auth/logout').cookies['veevee_session']
        self.assertEqual(cookie['max-age'],0)
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'],'Lax')
        self.assertEqual(cookie['path'],'/')
        self.assertEqual(bool(cookie['secure']),bool(settings.SESSION_COOKIE_SECURE))

    def test_logout_clears_cookie_and_audits_only_valid_session(self):
        from apps.common.models import ActivityLog
        response=self.client.post('/api/auth/logout')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json(),{'ok':True})
        self.assertEqual(response.cookies['veevee_session']['max-age'],0)
        self.assertTrue(response.cookies['veevee_session']['httponly'])
        self.assertEqual(response.cookies['veevee_session']['samesite'],'Lax')
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
