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
        with connection.cursor() as c:
            c.execute('CREATE TABLE IF NOT EXISTS users (id uuid PRIMARY KEY, email text, name text, role text, color text, avatar_url text, is_active boolean, auth_version integer)')
            c.execute('CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value text NOT NULL, updated_at bigint NOT NULL)')
            c.execute('CREATE TABLE IF NOT EXISTS user_limits (user_id uuid, key text, value text NOT NULL, updated_at bigint NOT NULL, PRIMARY KEY(user_id,key))')
            c.execute('TRUNCATE users, settings, user_limits')
            c.execute("INSERT INTO users VALUES (%s,'fixture@example.invalid','Fixture','user',NULL,NULL,true,0)", [UID])

    def cookie(self, version=0, age=0):
        payload = encode(json.dumps({'uid': UID, 'ver': version, 'exp': int(time.time()*1000)+30*24*60*60*1000-age}).encode())
        signature = encode(hmac.new(settings.AUTH_SECRET.encode(), payload.encode(), hashlib.sha256).digest())
        self.client.cookies['veevee_session'] = payload+'.'+signature

    def test_authentication_and_defaults(self):
        self.assertEqual(self.client.get('/api/settings').status_code,401)
        self.cookie()
        response = self.client.get('/api/settings')
        self.assertEqual(response.json(), {'maxPromptLength':30000,'maxConcurrentJobs':4})
        self.assertNotIn('veevee_session', response.cookies)
        self.cookie(version=1)
        self.assertEqual(self.client.get('/api/settings').status_code,401)

    def test_personal_override_invalid_fallback_and_clamp(self):
        with connection.cursor() as c:
            c.execute("INSERT INTO settings VALUES ('maxPromptLength','100',0),('maxConcurrentJobs','2',0)")
            c.execute("INSERT INTO user_limits VALUES (%s,'maxPromptLength','nonsense',0),(%s,'maxConcurrentJobs','9tail',0)",[UID,UID])
        self.cookie(age=2*24*60*60*1000)
        response=self.client.get('/api/settings')
        self.assertEqual(response.json(),{'maxPromptLength':30000,'maxConcurrentJobs':4})
        self.assertEqual(response.cookies['veevee_session']['samesite'],'Lax')
        self.assertTrue(response.cookies['veevee_session']['httponly'])
        with connection.cursor() as c:
            c.execute('SELECT count(*) FROM settings')
            self.assertEqual(c.fetchone()[0],2)

    def test_disabled_user(self):
        with connection.cursor() as c:
            c.execute('UPDATE users SET is_active=false')
        self.cookie()
        self.assertEqual(self.client.get('/api/settings').status_code,401)


class CurrentNodeLimitParityTests(TransactionTestCase):
    def test_current_node_parser_contract(self):
        import subprocess
        from pathlib import Path
        from .views import LIMITS, parse
        cases = [None, '', '2', '2tail', '2.9', '0x10', '-3', '+7',
                 '\ufeff3', '\u00a02', '\u20282', '\u001c2', '１２',
                 '9007199254740993', '9'*400, '1e3', 'Infinity']
        root = Path(__file__).resolve().parents[3]
        result = subprocess.run(['node', 'scripts/django-migration/limits-oracle.mjs'],
                                input=json.dumps(cases), text=True, capture_output=True,
                                check=True, cwd=root)
        expected = json.loads(result.stdout)
        actual = [{key: parse(raw, definition) for key, definition in LIMITS.items()}
                  for raw in cases]
        self.assertEqual(actual, expected)
