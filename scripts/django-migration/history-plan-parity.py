"""Managed PostgreSQL history plans with deterministic historical response goldens."""
import json
import os
import subprocess
import sys
from urllib.parse import urlsplit
url=urlsplit(os.environ.get('DATABASE_URL',''))
if os.environ.get('MIGRATION_TEST_ISOLATED')!='1' or url.hostname!='127.0.0.1' or url.path!='/veevee_django_migration':
    raise SystemExit('Disposable isolated loopback required')
subprocess.run([sys.executable,'backend/manage.py','test','testsupport.test_history_plans','--noinput','--verbosity','1'],check=True)
print(json.dumps({'qualification':'frozen Node history responses; live Django EXPLAIN ANALYZE',
    'synthetic_rows':5006,'live_node_business_execution':False,'performance_sla':False}))
