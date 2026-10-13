#!/usr/bin/env python3
"""Drive a local release rehearsal end to end through the ingress gateway.

Run inside the rehearsal API container:
    python /scripts/stabilization/rehearsal_probe.py <ingress-secret> <user-email>
Prints one PASS/FAIL line per check and exits non-zero on any failure.
"""
import http.client
import io
import json
import os
import sys
import time
import uuid
import zipfile

sys.path[:0] = ['/app']
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')
import django  # noqa: E402
django.setup()
from apps.authentication.models import User  # noqa: E402
from apps.authentication.session import sign_session  # noqa: E402
from apps.generation.models import Generation  # noqa: E402
from apps.library.models import GenerationNaming  # noqa: E402
from apps.projects.models import Project  # noqa: E402

SECRET, EMAIL = sys.argv[1], sys.argv[2]
user = User.objects.get(email=EMAIL)
cookie = sign_session(user)
project = Project.objects.order_by('-updated_at').first()
failures = []


def call(method, path, body=None, headers=None, raw=False):
    connection_ = http.client.HTTPConnection('127.0.0.1', 18081, timeout=120)
    sent = {'x-veevee-g4-ingress': SECRET, 'Cookie': 'veevee_session=' + cookie, 'Origin': 'https://veevee.ai',
            'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Proto': 'https'}
    if body is not None:
        sent['Content-Type'] = 'application/json'
    sent.update(headers or {})
    connection_.request(method, path, body=json.dumps(body) if body is not None else None, headers=sent)
    response = connection_.getresponse()
    data = response.read()
    return response.status, (data if raw else (json.loads(data) if data[:1] in (b'{', b'[') else data)), dict(response.getheaders())


def check(name, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + name + ('' if condition else f' — {detail}'), flush=True)
    if not condition:
        failures.append(name)


def ledger(identifier):
    # The API role cannot read the paid ledger (by design); observe it with the local copy's owner.
    import psycopg
    with psycopg.connect(os.environ['REHEARSAL_OBSERVER_URL']) as observer:
        row = observer.execute('SELECT state FROM goal4_preview_paid_budget.jobs WHERE generation_id=%s', [identifier]).fetchone()
    return row[0] if row else None


def wait(identifier, seconds=180):
    deadline = time.time() + seconds
    while time.time() < deadline:
        row = Generation.objects.get(pk=identifier)
        if row.status in ('succeeded', 'failed'):
            return row
        time.sleep(2)
    return Generation.objects.get(pk=identifier)


def enqueue(kind, payload):
    key = {'Idempotency-Key': 'rehearsal-' + uuid.uuid4().hex}
    status, item, _ = call('POST', '/api/generate/' + kind, {**payload, 'projectId': str(project.id)}, key)
    check(f'{payload["model"]}: enqueue accepted', status == 200 and isinstance(item, dict) and item.get('id'), f'{status} {str(item)[:200]}')
    if status != 200:
        return None
    replay_status, replay, _ = call('POST', '/api/generate/' + kind, {**payload, 'projectId': str(project.id)}, key)
    check(f'{payload["model"]}: duplicate submit returns the same job', replay_status == 200 and replay.get('id') == item['id'], str(replay)[:200])
    check(f'{payload["model"]}: ledger reserved by the API', ledger(item['id']) in ('RESERVED', 'ATTEMPTING', 'SUBMITTING'), ledger(item['id']))
    return item['id']


cases = [('image', {'prompt': 'rehearsal: a quiet courtyard at dawn', 'model': 'Nano Banana Pro', 'aspectRatio': '1:1'}, 'image/'),
         ('image', {'prompt': 'rehearsal: a quiet courtyard at dawn', 'model': 'Seedream 5.0 Pro', 'aspectRatio': '1:1', 'resolution': '2K'}, 'image/'),
         ('video', {'prompt': 'rehearsal: a slow pan across a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True, 'duration': 5}, 'video/')]
results = {}
for kind, payload, _ in cases:
    identifier = enqueue(kind, payload)
    if identifier:
        results[payload['model']] = identifier
for model, identifier in results.items():
    row = wait(identifier)
    check(f'{model}: worker completed', row.status == 'succeeded', f'{row.status} {row.error}')
    check(f'{model}: one paid submission claimed', ledger(identifier) == 'SUBMITTING', ledger(identifier))
    check(f'{model}: named', GenerationNaming.objects.filter(generation_id=identifier).exists())
    if row.url:
        status, data, headers = call('GET', row.url, raw=True)
        check(f'{model}: media readable through the API', status in (200, 206) and len(data) > 100, f'{status} {len(data)}')

draft = results.get('Seedance 2.5')
if draft and Generation.objects.get(pk=draft).status == 'succeeded':
    status, final, _ = call('POST', '/api/generate/video/finalize', {'sourceGenerationId': draft})
    check('Seedance 2.5: finalize accepted', status == 200, str(final)[:200])
    if status == 200:
        row = wait(final['id'])
        check('Seedance 2.5 final: completed as native MOV', row.status == 'succeeded' and (row.url or '').endswith('.mov'), f'{row.status} {row.url} {row.error}')
        results['final'] = final['id']

done = [identifier for identifier in results.values() if Generation.objects.get(pk=identifier).status == 'succeeded']
if done:
    status, export, _ = call('POST', '/api/history/exports', {})
    check('export created', status in (200, 201) and export.get('id'), f'{status} {str(export)[:200]}')
    if status in (200, 201):
        status, added, _ = call('POST', f'/api/history/exports/{export["id"]}/items', {'ids': done})
        check('export items added', status in (200, 201), f'{status} {str(added)[:200]}')
        status, finalized, _ = call('POST', f'/api/history/exports/{export["id"]}/finalize')
        check('export queued', status in (200, 201, 202), f'{status} {str(finalized)[:200]}')
        deadline, state = time.time() + 180, None
        while time.time() < deadline:
            _, state, _ = call('GET', f'/api/history/exports/{export["id"]}')
            if isinstance(state, dict) and state.get('status') in ('ready', 'failed'):
                break
            time.sleep(2)
        check('export worker built the ZIP', isinstance(state, dict) and state.get('status') == 'ready', str(state)[:300])
        if isinstance(state, dict) and state.get('status') == 'ready':
            status, data, _ = call('GET', f'/api/history/exports/{export["id"]}/download', raw=True)
            if status in (301, 302, 303, 307):
                check('ZIP download', False, f'redirect {status} (filesystem media expected to stream)')
            else:
                names = zipfile.ZipFile(io.BytesIO(data)).namelist()
                check('ZIP contains every item', len(names) == len(done), names)
                check('ZIP keeps native MOV masters', any(name.endswith('.mov') for name in names), names)
                print('     zip entries:', names, flush=True)

print(json.dumps({'failures': failures, 'checked': len(results)}), flush=True)
sys.exit(1 if failures else 0)
