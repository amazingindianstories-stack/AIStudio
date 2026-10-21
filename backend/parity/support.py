"""Fixtures accessed through app labels and settings, independent of module layout."""
import io
import json
import os
import subprocess
import sys
from pathlib import Path

from django.apps import apps
from django.db import connection
from django.test import TransactionTestCase
from apps.authentication.session import sign_session


class ParityCase(TransactionTestCase):
    def setUp(self):
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.actor = apps.get_model('authentication', 'User').objects.create(
            email='parity@example.invalid', name='Parity', role='admin',
            password_hash='fixture', password_salt='fixture', created_at=1)
        self.client.cookies['veevee_session'] = sign_session(self.actor)

    def post(self, path, body=None):
        return self.client.post(path, body or {}, content_type='application/json')

    def command(self, name, *args):
        from django.core.management import call_command
        output = io.StringIO()
        call_command(name, *args, stdout=output)
        return output.getvalue()

    def scenario(self, action, flags=None, **payload):
        # test-db.sh provided this allowlisted environment. The child points at
        # this test's disposable database, never an inherited external DSN.
        env = dict(os.environ)
        env.update(flags or {})
        env['PARITY_DATABASE_NAME'] = connection.settings_dict['NAME']
        result = subprocess.run([sys.executable, '-m', 'parity.scenarios', action],
            input=json.dumps(payload), text=True, capture_output=True, env=env,
            cwd=Path(__file__).resolve().parents[1], timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(next(line[len('PARITY_RESULT='):] for line in result.stdout.splitlines()
                               if line.startswith('PARITY_RESULT=')))
