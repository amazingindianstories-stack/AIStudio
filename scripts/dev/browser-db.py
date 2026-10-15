"""Test-only SQL fixture bridge; never an application route or shared DB client."""
import json
import os
import sys
from urllib.parse import urlsplit
import psycopg
from psycopg.rows import dict_row


def main():
    url = os.environ.get('DATABASE_URL', '')
    target = urlsplit(url)
    if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or target.hostname not in ('127.0.0.1', 'localhost') or target.path != '/veevee_django_migration':
        raise SystemExit('Browser fixtures require the verified disposable Django database')
    payload = json.load(sys.stdin)
    with psycopg.connect(url, row_factory=dict_row) as connection:
        with connection.cursor() as cursor:
            cursor.execute(payload['query'], payload['parameters'])
            rows = cursor.fetchall() if cursor.description else []
    print(json.dumps(rows, default=str))


if __name__ == '__main__':
    main()
