"""Fresh-process startup scenarios so settings install policies exactly once."""
import io
import json
import os
import sys


def main():
    payload = json.load(sys.stdin)
    action = sys.argv[1]
    if action == 'worker_loop':
        os.environ['VEEVEE_RUNTIME_COMPONENT'] = payload['component']
    import tempfile
    temporary_media = tempfile.TemporaryDirectory(prefix='parity-scenario-media-')
    import django
    from django.conf import settings
    settings.DATABASES['default']['NAME'] = os.environ['PARITY_DATABASE_NAME']
    if not os.environ.get('VEEVEE_MEDIA_BACKEND'):
        settings.VEEVEE_MEDIA_CONFIG = {'backend': 'filesystem', 'root': temporary_media.name}
    settings.PUBLIC_APP_URL = 'https://fixture.invalid'
    settings.INSTALLED_APPS = ['parity.fake_app.ParityProviderConfig', *settings.INSTALLED_APPS]
    django.setup()
    from django.apps import apps
    from django.test import Client, RequestFactory
    from django.core.management import call_command
    from apps.authentication.session import sign_session
    actor = apps.get_model('authentication', 'User').objects.get(email='parity@example.invalid')
    token = sign_session(actor)
    client = Client(HTTP_SEC_FETCH_SITE='same-origin')
    client.cookies['veevee_session'] = token
    result = {}
    if action == 'paid':
        from config.wsgi import application
        from django.db import connection
        # SQL fixture records reservations but never claims provider acceptance.
        # SQL functions are the production guard's stable external DB seam.
        try:
            with connection.cursor() as cursor:
                cursor.execute('CREATE SCHEMA IF NOT EXISTS goal4_preview_paid_budget')
                cursor.execute('CREATE TABLE IF NOT EXISTS goal4_preview_paid_budget.parity_reservations (id text PRIMARY KEY, cents integer, state text, fingerprint text)')
                cursor.execute('''CREATE OR REPLACE FUNCTION goal4_preview_paid_budget.reserve(uuid,uuid,integer,text,text)
                    RETURNS void LANGUAGE SQL AS $$ INSERT INTO goal4_preview_paid_budget.parity_reservations VALUES ($1::text,$3,'RESERVED',$5) $$''')
                cursor.execute("""CREATE OR REPLACE FUNCTION goal4_preview_paid_budget.transition(uuid,text,text,text)
                    RETURNS void LANGUAGE plpgsql AS $$ BEGIN
                    UPDATE goal4_preview_paid_budget.parity_reservations SET state=$4
                    WHERE id=$1::text AND fingerprint=$2 AND state=$3;
                    IF NOT FOUND THEN RAISE EXCEPTION 'invalid fixture ledger transition'; END IF;
                    END $$""")
            if payload.get('reserve_failure'):
                with connection.cursor() as cursor:
                    cursor.execute('DROP FUNCTION goal4_preview_paid_budget.reserve(uuid,uuid,integer,text,text)')
            responses = []
            def requests():
                from django.db import connections
                try:
                    for case in payload['cases']:
                        request = RequestFactory().generic('POST', case['path'], json.dumps(case['body']),
                            content_type='application/json', HTTP_SEC_FETCH_SITE='same-origin',
                            HTTP_COOKIE='veevee_session=' + token)
                        captured = {}
                        def start(status, headers, exc_info=None):
                            captured['status'] = int(status.split()[0])
                        response = application(request.environ, start)
                        try:
                            raw = b''.join(response)
                        finally:
                            if hasattr(response, 'close'):
                                response.close()
                        responses.append({'status': captured['status'], 'body': json.loads(raw)})
                finally:
                    connections.close_all()
            if payload.get('run_audio_worker'):
                import threading
                import time
                thread = threading.Thread(target=requests, daemon=True)
                thread.start()
                for _ in range(200):
                    if apps.get_model('generation', 'Generation').objects.filter(kind='audio', status='queued').exists():
                        call_command('generation_worker', '--once', stdout=io.StringIO())
                        break
                    time.sleep(.01)
                thread.join(timeout=5)
                if thread.is_alive():
                    raise AssertionError('fake audio worker did not complete the HTTP request')
            else:
                requests()
            with connection.cursor() as cursor:
                cursor.execute('SELECT count(*) FROM goal4_preview_paid_budget.parity_reservations')
                result = {'responses': responses, 'reservations': cursor.fetchone()[0]}
        finally:
            with connection.cursor() as cursor:
                cursor.execute('DROP SCHEMA IF EXISTS goal4_preview_paid_budget CASCADE')
    elif action == 'export_admission':
        job = client.post('/api/history/exports', {}, content_type='application/json')
        identifier = job.json()['id']
        receipt = apps.get_model('library', 'OrganizationIdempotencyKey').objects.get(pk='g4preview:new-export:' + identifier)
        old = apps.get_model('exports', 'MediaExport').objects.create(user_id=actor.id, created_at=1, updated_at=1)
        refused = []
        for suffix in ('items', 'finalize'):
            response = client.post(f'/api/history/exports/{old.id}/{suffix}', {'ids': []}, content_type='application/json')
            refused.append([response.status_code, response.json()])
        result = {'status': job.status_code, 'receipt': {'operation': receipt.operation,
            'status': receipt.status, 'expires_at': receipt.expires_at, 'result': receipt.result},
            'id': identifier, 'refused': refused}
    elif action == 'video_master':
        from parity.fake_app import NETWORK
        import base64
        response = client.post('/api/generate/video', {'model': 'Seedance 2.5', 'prompt': 'A quiet garden',
            'duration': 5, 'resolution': '480p', 'aspectRatio': '16:9', 'draftMode': True}, content_type='application/json')
        assert response.status_code == 200, response.content
        identifier = response.json()['id']
        generations = apps.get_model('generation', 'Generation')
        for _ in range(8):
            generations.objects.filter(pk=identifier).update(next_poll_at=0)
            call_command('generation_worker', '--once', stdout=io.StringIO())
            if generations.objects.get(pk=identifier).status in ('succeeded', 'failed'):
                break
        row = generations.objects.get(pk=identifier)
        result = {'id': identifier, 'status': row.status, 'url': row.url,
            'formats': [p.get('output_format') for p in NETWORK.seedance_payloads],
            'master': base64.b64encode(NETWORK.mov).decode()}
    elif action == 'legacy_portraits':
        from parity.fake_app import NETWORK
        NETWORK.groups['group-fixture'] = {'Id': 'group-fixture', 'Name': 'Fixture', 'GroupType': 'AIGC', 'ProjectName': 'default'}
        NETWORK.assets['asset-fixture'] = {'Id': 'asset-fixture', 'GroupId': 'group-fixture', 'Name': 'Face',
            'AssetType': 'Image', 'ProjectName': 'default', 'Status': 'Active', '_polls': 0,
            'URL': '/api/media/uploads/portrait/fixture'}
        listing = client.get('/api/assets/portraits').json()
        deletion = client.delete('/api/assets/portraits?assetId=' + payload['asset'] + '&groupId=' + payload['group'])
        after = client.get('/api/assets/portraits').json()
        result = {'listing': listing, 'delete': [deletion.status_code, deletion.json()], 'after': after,
            'remote_status': NETWORK.assets['asset-fixture']['Status'], 'calls': NETWORK.calls}
    elif action == 'export_worker':
        from django.db import connection
        try:
            with connection.cursor() as cursor:
                cursor.execute('CREATE SCHEMA goal4_preview_worker_holds')
                cursor.execute("""CREATE VIEW goal4_preview_worker_holds.new_export_registrations AS
                    SELECT key,actor_id,result,fingerprint FROM organization_idempotency_keys
                    WHERE operation='GOAL4_PREVIEW_NEW_EXPORT_ONLY' AND status='completed' AND expires_at=0""")
            out = io.StringIO()
            call_command('media_export_worker', '--once', stdout=out)
            result = {'output': out.getvalue()}
        finally:
            with connection.cursor() as cursor:
                cursor.execute('DROP SCHEMA IF EXISTS goal4_preview_worker_holds CASCADE')
    elif action == 'worker_loop':
        import signal
        import threading
        import time
        from django.db import connections
        observed = []
        def watch():
            try:
                for _ in range(100):
                    time.sleep(.05)
                    if payload['component'] == 'scheduler':
                        ready = apps.get_model('admin_dashboard', 'AppSetting').objects.filter(key__contains='scheduler:').exists()
                    else:
                        label, model, terminal = ('generation', 'Generation', 'succeeded') if payload['component'] == 'generation' else ('exports', 'MediaExport', 'ready')
                        ready = apps.get_model(label, model).objects.filter(pk=payload['identifier'], status=terminal).exists()
                    if ready:
                        observed.append(True)
                        break
            finally:
                connections.close_all()
                os.kill(os.getpid(), signal.SIGTERM)
        thread = threading.Thread(target=watch)
        thread.start()
        from deploy import entrypoint
        code = entrypoint.main(['entrypoint', payload['component']])
        thread.join(timeout=10)
        result = {'exit': code, 'observed': bool(observed)}
    elif action == 'command':
        out = io.StringIO()
        call_command(payload['name'], *payload.get('args', []), stdout=out)
        result = {'output': out.getvalue()}
    else:
        raise AssertionError(action)
    temporary_media.cleanup()
    print('PARITY_RESULT=' + json.dumps(result))


if __name__ == '__main__':
    main()
