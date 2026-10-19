#!/usr/bin/env python3
"""Drive a local release rehearsal end to end through the ingress gateway.

Run inside the rehearsal API container:
    python /scripts/release/rehearsal_probe.py <ingress-secret> <user-email>
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
# Use a project with material assets: the worker's asset lookup only runs where assets exist
# (the 2026-10-13 regression hid behind an empty project).
from django.db.models import Count  # noqa: E402
project = Project.objects.annotate(n=Count('assets')).filter(n__gt=0).order_by('-n').first() if hasattr(Project, 'assets') else None
if project is None:
    from apps.assets.models import Asset  # noqa: E402
    busiest = Asset.objects.exclude(project_id=None).values('project_id').annotate(n=Count('id')).order_by('-n').first()
    project = Project.objects.get(pk=busiest['project_id'])
print(f'     project with assets: {project.id}', flush=True)
failures = []


def call(method, path, body=None, headers=None, raw=False, session=None):
    connection_ = http.client.HTTPConnection('127.0.0.1', 18081, timeout=150)
    sent = {'x-veevee-g4-ingress': SECRET, 'Cookie': 'veevee_session=' + (session or cookie), 'Origin': 'https://veevee.ai',
            'Sec-Fetch-Site': 'same-origin', 'X-Forwarded-Proto': 'https'}
    if body is not None:
        sent['Content-Type'] = 'application/json'
    sent.update(headers or {})
    if isinstance(body, bytes):
        sent['Content-Type'] = (headers or {}).get('Content-Type', 'application/octet-stream')
    connection_.request(method, path, body=body if isinstance(body, bytes) else (json.dumps(body) if body is not None else None), headers=sent)
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

# Magnific upscaling (VEEVEE_MAGNIFIC_UPSCALE): image and video through the gateway, paid guard and worker.
def png_data_uri():
    import base64
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', (64, 48), (90, 120, 160)).save(out, format='PNG')
    return 'data:image/png;base64,' + base64.b64encode(out.getvalue()).decode()


IMAGE_UPSCALE = {'image': png_data_uri(), 'model': 'Magnific Precision V2', 'projectId': str(project.id),
                 'params': {'model': 'Magnific Precision V2', 'filterNsfw': False, 'scaleFactor': '2x', 'flavor': 'photo', 'sharpen': 7, 'smartGrain': 7, 'ultraDetail': 30}}
if os.environ.get('VEEVEE_MAGNIFIC_UPSCALE') == '1':
    upscales = {}
    status, item, _ = call('POST', '/api/generate/upscale', IMAGE_UPSCALE)
    check('Magnific image: enqueue accepted', status == 200 and isinstance(item, dict) and item.get('id'), f'{status} {str(item)[:200]}')
    if status == 200:
        upscales['Magnific image'] = (item['id'], 'image/', '.png')
    source = Generation.objects.filter(pk=draft).values_list('url', flat=True).first() if draft else None
    check('Magnific video: Seedance draft available as the source', bool(source), draft)
    for model, params in (('Magnific Video Creative', {'resolution': '2k', 'creativity': 0, 'sharpen': 0, 'smartGrain': 0, 'fpsBoost': False, 'flavor': 'vivid', 'outputFormat': 'h264'}),
                          ('Magnific Video Precision', {'resolution': '4k', 'sharpen': 0, 'smartGrain': 0, 'strength': 60, 'fpsBoost': False, 'outputFormat': 'prores_422_hq'}),
                          ('Magnific Video Topaz', {'resolution': '1k', 'enhancementModel': 'starlight_fast_2', 'targetFps': 30, 'frameInterpolation': 'apollo', 'noise': 0})):
        if not source:
            break
        status, item, _ = call('POST', '/api/generate/upscale', {'video': source, 'model': model, 'projectId': str(project.id), 'params': {'model': model, **params}})
        check(f'{model}: enqueue accepted', status == 200 and isinstance(item, dict) and item.get('kind') == 'video', f'{status} {str(item)[:200]}')
        if status == 200:
            check(f'{model}: ledger reserved by the API', ledger(item['id']) in ('RESERVED', 'ATTEMPTING', 'SUBMITTING'), ledger(item['id']))
            check(f'{model}: estimate recorded', isinstance(item.get('costCents'), int) and item['costCents'] > 0, item.get('costCents'))
            upscales[model] = (item['id'], 'video/', '.mov' if params.get('outputFormat') == 'prores_422_hq' else '.mp4')
    status, refused, _ = call('POST', '/api/generate/upscale', {'video': 'https://evil.example/v.mp4', 'model': 'Magnific Video Creative', 'params': {'model': 'Magnific Video Creative'}})
    check('Magnific video: foreign source refused', status == 400, f'{status} {str(refused)[:120]}')
    for name, (identifier, prefix, suffix) in upscales.items():
        row = wait(identifier, seconds=240)
        check(f'{name}: worker completed', row.status == 'succeeded', f'{row.status} {row.provider_status} {row.error}')
        check(f'{name}: one paid submission claimed', ledger(identifier) == 'SUBMITTING', ledger(identifier))
        check(f'{name}: named', GenerationNaming.objects.filter(generation_id=identifier).exists())
        check(f'{name}: native master kept', (row.url or '').endswith(suffix), row.url)
        if row.url:
            status, data, headers = call('GET', row.url, raw=True)
            check(f'{name}: media readable through the API', status in (200, 206) and len(data) > 100, f'{status} {len(data)}')
        results[name] = identifier
else:
    status, refused, _ = call('POST', '/api/generate/upscale', IMAGE_UPSCALE)
    check('Magnific off: gateway refuses upscale', status == 403 and isinstance(refused, dict) and refused.get('code') == 'PREVIEW_PAID_PROVIDER_DISABLED', f'{status} {str(refused)[:160]}')

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
                if os.environ.get('VEEVEE_MAGNIFIC_UPSCALE') == '1':
                    check('ZIP keeps Magnific MP4 masters', any(name.endswith('.mp4') for name in names), names)
                print('     zip entries:', names, flush=True)

# Managed portraits (when enabled): a face reference becomes a pool asset in the worker, as the real roles.
status, pool, _ = call('GET', '/api/portraits')
if isinstance(pool, dict) and pool.get('enabled'):
    import hashlib
    from apps.assets.models import ManagedPortraitAsset  # noqa: E402
    face = open('/app/testsupport/data/face_public_domain.jpg', 'rb').read()
    status, session, _ = call('POST', '/api/uploads/init', {'version': 1, 'purpose': 'image-reference', 'contentType': 'image/jpeg',
        'byteSize': len(face), 'filename': 'face.jpg', 'requestKey': uuid.uuid4().hex, 'sha256': hashlib.sha256(face).hexdigest()})
    ready = None
    if status in (200, 201) and session.get('uploadUrl'):
        call('PUT', session['uploadUrl'], face, {'Content-Type': 'image/jpeg', 'Content-Range': f'bytes 0-{len(face) - 1}/{len(face)}'})
        status, ready, _ = call('POST', f'/api/uploads/{session["uploadId"]}/finalize', {'version': 1})
    check('portraits: face reference uploaded', isinstance(ready, dict) and ready.get('referenceId'), str(ready or session)[:200])
    if isinstance(ready, dict) and ready.get('referenceId'):
        identifier = enqueue('video', {'prompt': 'rehearsal: portrait @img1 walks through the hall', 'model': 'Seedance 2.5', 'resolution': '480p',
                                       'draftMode': True, 'duration': 5, 'referenceImages': [{'referenceId': ready['referenceId']}]})
        if identifier:
            row = wait(identifier)
            check('portraits: face video completed', row.status == 'succeeded', f'{row.status} {row.error}')
            check('portraits: one paid submission claimed', ledger(identifier) == 'SUBMITTING', ledger(identifier))
            check('portraits: pool asset is ACTIVE', ManagedPortraitAsset.objects.filter(status='ACTIVE').exists(),
                  list(ManagedPortraitAsset.objects.values_list('status', 'error_code')))
        status, pool, _ = call('GET', '/api/portraits')
        check('portraits: Gallery lists it as ready', any(p.get('state') == 'ready' for p in (pool or {}).get('portraits', [])), str(pool)[:200])
        status, refused, _ = call('POST', '/api/assets/portraits/upload', {'referenceId': ready['referenceId']})
        check('portraits: manual upload refused', status == 410, f'{status} {str(refused)[:120]}')
        status, settings_, _ = call('GET', '/api/admin/portrait-settings')
        check('portraits: admin settings reachable through the gateway', status in (200, 403), status)
else:
    print('     managed portraits off in this rehearsal', flush=True)

def upload(data, purpose, content_type, filename):
    import hashlib
    status, session, _ = call('POST', '/api/uploads/init', {'version': 1, 'purpose': purpose, 'contentType': content_type,
        'byteSize': len(data), 'filename': filename, 'requestKey': uuid.uuid4().hex, 'sha256': hashlib.sha256(data).hexdigest()})
    if status not in (200, 201) or not session.get('uploadUrl'):
        return session
    call('PUT', session['uploadUrl'], data, {'Content-Type': content_type, 'Content-Range': f'bytes 0-{len(data) - 1}/{len(data)}'})
    return call('POST', f'/api/uploads/{session["uploadId"]}/finalize', {'version': 1})[1]


# Audio transcription: the gateway admits it, the API registers the intent in the paid ledger (the worker role sees
# only registered rows), and the worker claims its single Gemini call exactly once.
import struct  # noqa: E402
from testsupport.fake_providers import AGENT_REPLY, TRANSCRIPT  # noqa: E402
pcm = b'\x00\x00' * 8000
wav = (b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 8000, 16000, 2, 16)
       + b'data' + struct.pack('<I', len(pcm)) + pcm)
ready = upload(wav, 'audio-reference', 'audio/wav', 'rehearsal.wav')
check('audio: reference uploaded', isinstance(ready, dict) and ready.get('ref'), str(ready)[:200])
if isinstance(ready, dict) and ready.get('ref'):
    status, transcribed, _ = call('POST', '/api/audio/transcribe', {'audioRef': ready['ref'], 'name': 'rehearsal.wav', 'projectId': str(project.id)})
    check('audio: transcript returned through the gateway', status == 200 and isinstance(transcribed, dict) and transcribed.get('transcript') == TRANSCRIPT,
          f'{status} {str(transcribed)[:200]}')
    if status == 200:
        check('audio: one paid submission claimed', ledger(transcribed['id']) == 'SUBMITTING', ledger(transcribed['id']))
        row = Generation.objects.get(pk=transcribed['id'])
        check('audio: saved as a completed history item', (row.status, row.provider_status, row.prompt) == ('succeeded', 'COMPLETED', TRANSCRIPT),
              f'{row.status} {row.provider_status}')
        status, history, _ = call('GET', f'/api/history?kind=audio&limit=5&projectId={project.id}')
        check('audio: listed in the project history', status == 200 and any(item.get('id') == transcribed['id'] for item in history.get('items', [])),
              f'{status} {str(history)[:160]}')

# Admin: agent chat (its own transport and endpoint allowlist, no job row) and admin mutations through the gateway.
admin = User.objects.filter(role='admin', is_active=True).order_by('created_at').first()
check('admin: an admin account exists in the copy', admin is not None)
if admin is not None:
    admin_session = sign_session(admin)
    status, created, _ = call('POST', '/api/agent-conversations', {'op': 'createConversation', 'projectId': str(project.id), 'agentKind': 'image',
                                                                   'name': 'rehearsal'}, session=admin_session)
    check('agent: conversation created', status == 200 and created.get('conversation', {}).get('id'), f'{status} {str(created)[:160]}')
    if status == 200:
        conversation = created['conversation']['id']
        status, turn, _ = call('POST', f'/api/agent-conversations/{conversation}/messages', {'content': 'A quiet courtyard at dawn', 'images': []},
                               session=admin_session)
        check('agent: reply through the gateway and the agent transport',
              status == 200 and (turn.get('assistantMessage') or {}).get('content') == AGENT_REPLY, f'{status} {str(turn)[:200]}')
        call('POST', '/api/agent-conversations', {'op': 'deleteConversation', 'id': conversation}, session=admin_session)
    status, refused, _ = call('POST', f'/api/agent-conversations/{uuid.uuid4()}/messages', {'content': 'x'})
    check('agent: refused for the non-admin session' if user.role != 'admin' else 'agent: unknown conversation answered by Django',
          status == (404 if user.role == 'admin' else 403), f'{status} {str(refused)[:120]}')
    email = f'rehearsal-{uuid.uuid4().hex[:12]}@example.invalid'
    status, made, _ = call('POST', '/api/admin/users', {'email': email, 'password': 'rehearsal-password', 'name': 'Rehearsal'}, session=admin_session)
    check('admin: user created through the gateway', status == 200 and made.get('user', {}).get('email') == email, f'{status} {str(made)[:160]}')
    if status == 200:
        target = made['user']['id']
        status, edited, _ = call('PATCH', '/api/admin/users', {'id': target, 'name': 'Rehearsal Renamed'}, session=admin_session)
        check('admin: user edited', status == 200 and edited.get('user', {}).get('name') == 'Rehearsal Renamed', f'{status} {str(edited)[:160]}')
        status, limited, _ = call('POST', '/api/admin/user-limits', {'userId': target, 'key': 'maxConcurrentJobs', 'value': 2}, session=admin_session)
        check('admin: user limit changed', (status, limited) == (200, {'ok': True}), f'{status} {limited}')
        status, removed, _ = call('DELETE', f'/api/admin/users?id={target}', session=admin_session)
        check('admin: user deleted', (status, removed) == (200, {'ok': True}), f'{status} {removed}')
    status, data, _ = call('GET', '/api/admin/data', session=admin_session)
    check('admin: dashboard shows the gated operations as off', status == 200 and data.get('operations') == {'runtimeAudit': False, 'higgsfieldToken': False},
          f'{status} {str(data.get("operations") if isinstance(data, dict) else data)[:120]}')
    status, checks, _ = call('GET', '/api/admin/status', session=admin_session)
    check('admin: dependency status reachable', status == 200 and len(checks.get('checks', [])) > 5, f'{status} {str(checks)[:160]}')
    for path in ('/api/admin/audit/runtime', '/api/admin/set-token'):
        status, refused, _ = call('POST', path, {}, session=admin_session)
        check(f'admin: {path} stays closed', status == 403 and refused.get('code') == 'PREVIEW_OPERATION_DISABLED', f'{status} {str(refused)[:120]}')

print(json.dumps({'failures': failures, 'checked': len(results)}), flush=True)
sys.exit(1 if failures else 0)
