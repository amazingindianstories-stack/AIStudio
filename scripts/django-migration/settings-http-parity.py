"""Managed Django API contracts; historical Node comparison is frozen evidence.

--browser invokes the Django/Gunicorn + credential-free Next gateway UI harness.
The default qualification uses DRF's in-process HTTP client and disposable test
DBs created from the managed graph; it does not claim a live Node comparison.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--browser',action='store_true')
parser.add_argument('--gunicorn',action='store_true',help='Run the gateway/browser qualification with Gunicorn')
args=parser.parse_args()
target=urlsplit(os.environ.get('DATABASE_URL',''))
if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or target.hostname != '127.0.0.1' or target.path != '/veevee_django_migration':
    raise SystemExit('Verified disposable loopback database required')
if args.browser or args.gunicorn:
    subprocess.run([sys.executable,'scripts/django-migration/browser-harness.py'],check=True)
else:
    labels=['apps.authentication.tests','apps.admin_dashboard.tests','apps.projects.tests',
            'apps.library.tests','apps.assets.tests','apps.canvas.tests','apps.canvas.test_contracts',
            'apps.generation.tests','apps.generation.test_history_writes','testsupport.test_history_plans']
    subprocess.run([sys.executable,'backend/manage.py','test',*labels,'--noinput','--verbosity','1'],check=True)
    print(json.dumps({'qualification':'managed Django HTTP contracts and frozen historical response goldens',
        'http_transport':'DRF in-process client','database':'disposable managed PostgreSQL test database',
        'live_node_business_execution':False,'historical_harness':'docs/django-migration/historical-oracles/settings-http-parity.py.txt'}))
