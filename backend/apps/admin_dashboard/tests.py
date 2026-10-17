from testsupport.frozen_oracle import run as oracle_run
import hashlib
import hmac
import json
import time
from django.conf import settings
from django.db import connection
from django.test import TransactionTestCase
from apps.authentication.session import encode

UID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

class SettingsTests(TransactionTestCase):
    def setUp(self):
        # Browser cookie fixtures explicitly model same-origin Fetch Metadata.
        # Origin-denial tests override/clear this header deliberately.
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        from apps.authentication.models import User
        from apps.authentication.password import hash_password
        credentials = hash_password('fixture-password')
        User.objects.create(
            id=UID, email='fixture@example.invalid', name='Fixture', role='user',
            password_hash=credentials['hash'], password_salt=credentials['salt'],
            created_at=1, color=None, avatar_url=None, is_active=True, auth_version=0,
        )

    def cookie(self, version=0, age=0):
        payload = encode(json.dumps({'uid': UID, 'ver': version, 'exp': int(time.time()*1000)+30*24*60*60*1000-age}).encode())
        signature = encode(hmac.new(settings.AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).digest())
        self.client.cookies['veevee_session'] = payload+'.'+signature

    def test_authentication_and_defaults(self):
        self.assertEqual(self.client.get('/api/settings').status_code,401)
        self.cookie()
        response = self.client.get('/api/settings')
        self.assertEqual(response.json(), {'maxPromptLength':30000,'maxConcurrentJobs':8})
        self.assertNotIn('veevee_session', response.cookies)
        self.cookie(version=1)
        self.assertEqual(self.client.get('/api/settings').status_code,401)

    def test_personal_override_invalid_fallback_and_clamp(self):
        with connection.cursor() as c:
            c.execute("INSERT INTO settings VALUES ('maxPromptLength','100',0),('maxConcurrentJobs','2',0)")
            c.execute("INSERT INTO user_limits VALUES (%s,'maxPromptLength','nonsense',0),(%s,'maxConcurrentJobs','9tail',0)",[UID,UID])
        self.cookie(age=2*24*60*60*1000)
        response=self.client.get('/api/settings')
        self.assertEqual(response.json(),{'maxPromptLength':30000,'maxConcurrentJobs':8})
        self.assertEqual(response.cookies['veevee_session']['samesite'],'Lax')
        self.assertTrue(response.cookies['veevee_session']['httponly'])
        with connection.cursor() as c:
            c.execute('SELECT count(*) FROM settings')
            self.assertEqual(c.fetchone()[0],2)

    def test_production_cookie_flags_and_structured_request_log(self):
        from django.test import override_settings
        self.cookie(age=172800000)
        with override_settings(SESSION_COOKIE_SECURE=True):
            with self.assertLogs('veevee.requests', level='INFO') as capture:
                response = self.client.get('/api/settings?private=DO_NOT_LOG')
        cookie = response.cookies['veevee_session']
        self.assertTrue(cookie['secure'])
        self.assertTrue(cookie['httponly'])
        self.assertEqual(cookie['samesite'], 'Lax')
        self.assertEqual(cookie['max-age'], 2592000)
        event = json.loads(capture.records[0].getMessage())
        self.assertEqual(event['request_id'], response['X-Request-ID'])
        self.assertEqual(event['route'], 'api/settings')
        self.assertEqual(event['status'], 200)
        self.assertEqual(event['user_id'], UID)
        self.assertNotIn('DO_NOT_LOG', capture.records[0].getMessage())
        self.assertNotIn(self.client.cookies['veevee_session'].value, capture.records[0].getMessage())
        self.assertNotIn('fixture@example.invalid', capture.records[0].getMessage())

    def test_request_log_excludes_actor_from_invalid_session(self):
        self.cookie(version=1)
        with self.assertLogs('veevee.requests', level='INFO') as capture:
            response = self.client.get('/api/settings')
        self.assertEqual(response.status_code,401)
        self.assertNotIn('user_id',json.loads(capture.records[0].getMessage()))

    def test_disabled_user(self):
        with connection.cursor() as c:
            c.execute('UPDATE users SET is_active=false')
        self.cookie()
        self.assertEqual(self.client.get('/api/settings').status_code,401)

    def test_settings_reads_are_bounded_by_registered_keys(self):
        from django.test.utils import CaptureQueriesContext
        with connection.cursor() as c:
            c.execute("INSERT INTO settings SELECT 'unrelated-' || n, 'fixture', 0 FROM generate_series(1, 2000) n")
            c.execute("INSERT INTO user_limits SELECT %s, 'unrelated-' || n, 'fixture', 0 FROM generate_series(1, 2000) n", [UID])
            c.execute("INSERT INTO settings VALUES ('maxPromptLength','12000',0)")
            c.execute("INSERT INTO user_limits VALUES (%s,'maxConcurrentJobs','2',0)", [UID])
        self.cookie()
        with CaptureQueriesContext(connection) as queries:
            response = self.client.get('/api/settings')
        self.assertEqual(response.json(), {'maxPromptLength':12000,'maxConcurrentJobs':2})
        self.assertEqual(len(queries), 3)  # User, registered globals, registered overrides.
        for query in list(queries)[1:]:
            self.assertIn(' IN ', query['sql'])
            self.assertIn('maxPromptLength', query['sql'])
            self.assertIn('maxConcurrentJobs', query['sql'])


class CurrentNodeLimitParityTests(TransactionTestCase):
    def test_current_node_parser_contract(self):
        import subprocess
        from pathlib import Path
        from .views import LIMITS, parse
        cases = [None, '', '2', '2tail', '2.9', '0x10', '-3', '+7',
                 '\ufeff3', '\u00a02', '\u20282', '\u001c2', '１２',
                 '9007199254740993', '9'*400, '1e3', 'Infinity']
        root = Path(__file__).resolve().parents[3]
        result = oracle_run(['node', 'scripts/django-migration/limits-oracle.mjs'],
                                input=json.dumps(cases), text=True, capture_output=True,
                                check=True, cwd=root)
        expected = json.loads(result.stdout)
        # The recording was made when the per-user cap was 4; parser semantics are checked against that definition.
        recorded = {**LIMITS, 'maxConcurrentJobs': (4, 1, 4)}
        actual = [{key: parse(raw, definition) for key, definition in recorded.items()}
                  for raw in cases]
        self.assertEqual(actual, expected)
        self.assertEqual(LIMITS['maxConcurrentJobs'], (8, 1, 8), 'eight jobs per user by default, and at most eight')
