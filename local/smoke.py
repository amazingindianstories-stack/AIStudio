#!/usr/bin/env python3
"""End-to-end smoke test of the local stack through the frontend (http://localhost:3000).

    python3 local/smoke.py            (reads the local admin login from local/.env)

Goes through the same path as a browser: Next.js middleware → gateway → Django → workers.
Prints PASS/FAIL per check; exits non-zero on failure. Local stack only.
"""
import http.cookiejar
import io
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
import zipfile

BASE = os.environ.get('VEEVEE_LOCAL_URL', 'http://localhost:3000')
HERE = os.path.dirname(os.path.abspath(__file__))
env = dict(line.split('=', 1) for line in open(os.path.join(HERE, '.env')).read().splitlines() if '=' in line and not line.startswith('#'))
class LocalhostSecurePolicy(http.cookiejar.DefaultCookiePolicy):
    """Browsers send Secure cookies to http://localhost; mirror that for the local stack."""
    def return_ok_secure(self, cookie, request):
        return True

    def set_ok(self, cookie, request):
        return True


jar = http.cookiejar.CookieJar(policy=LocalhostSecurePolicy())
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
failures = []


def call(method, path, body=None, headers=None, raw=False):
    request = urllib.request.Request(BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Origin': BASE, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', **(headers or {})})
    try:
        with opener.open(request, timeout=120) as response:
            data = response.read()
            return response.status, (data if raw else json.loads(data or b'null'))
    except urllib.error.HTTPError as error:
        data = error.read()
        try:
            return error.code, json.loads(data)
        except ValueError:
            return error.code, data[:200]


def check(name, condition, detail=''):
    print(('PASS ' if condition else 'FAIL ') + name + ('' if condition else f' — {str(detail)[:300]}'), flush=True)
    if not condition:
        failures.append(name)


status, me = call('POST', '/api/auth/login', {'email': env['LOCAL_ADMIN_EMAIL'], 'password': env['LOCAL_ADMIN_PASSWORD']})
check('login through the frontend proxy', status == 200, me)
status, me = call('GET', '/api/auth/me')
check('session is valid', status == 200 and (me or {}).get('user'), me)
status, history = call('GET', '/api/history?limit=5')
check('history loads', status == 200 and isinstance((history or {}).get('items'), list), history)
status, projects = call('GET', '/api/projects')
project_list = (projects or {}).get('projects') or []
status, assets = call('GET', '/api/assets')
asset_projects = {a.get('projectId') for a in (assets or {}).get('assets', []) if a.get('projectId')} if isinstance(assets, dict) else set()
project = next((p for p in project_list if p['id'] in asset_projects), project_list[0] if project_list else None)
check('a project is available', project is not None, projects)


def enqueue(kind, payload):
    status, item = call('POST', '/api/generate/' + kind, {**payload, 'projectId': project['id']}, {'Idempotency-Key': 'smoke-' + uuid.uuid4().hex})
    check(f'{payload["model"]}: accepted', status == 200 and isinstance(item, dict) and item.get('id'), item)
    return item.get('id') if status == 200 else None


def wait(identifier, seconds=180):
    deadline = time.time() + seconds
    while time.time() < deadline:
        _, data = call('GET', f'/api/history?limit=50&projectId={project["id"]}')
        row = next((i for i in (data or {}).get('items', []) if i['id'] == identifier), None)
        if row and row.get('status') in ('succeeded', 'failed'):
            return row
        time.sleep(2)
    return row or {}


jobs = {'Nano Banana Pro': enqueue('image', {'prompt': 'local smoke: a quiet courtyard at dawn', 'model': 'Nano Banana Pro', 'aspectRatio': '1:1'}),
        'Seedream 5.0 Pro': enqueue('image', {'prompt': 'local smoke: a quiet courtyard at dawn', 'model': 'Seedream 5.0 Pro', 'aspectRatio': '1:1', 'resolution': '2K'}),
        'Seedance 2.5': enqueue('video', {'prompt': 'local smoke: a slow pan across a candle-lit hall', 'model': 'Seedance 2.5', 'resolution': '480p', 'draftMode': True, 'duration': 5})}
done = []
for model, identifier in jobs.items():
    if not identifier:
        continue
    row = wait(identifier)
    check(f'{model}: finished', row.get('status') == 'succeeded', row.get('error') or row.get('status'))
    if row.get('url'):
        status, data = call('GET', row['url'], raw=True)
        check(f'{model}: media readable', status == 200 and len(data) > 100, status)
        done.append(identifier)
if jobs.get('Seedance 2.5') in done:
    status, final = call('POST', '/api/generate/video/finalize', {'sourceGenerationId': jobs['Seedance 2.5']})
    check('Seedance 2.5: finalize accepted', status == 200, final)
    if status == 200:
        row = wait(final['id'])
        check('Seedance 2.5 final: native MOV', row.get('status') == 'succeeded' and str(row.get('url', '')).endswith('.mov'), row.get('error') or row.get('url'))
        done.append(final['id'])
if done:
    status, export = call('POST', '/api/history/exports', {})
    if status in (200, 201):
        call('POST', f'/api/history/exports/{export["id"]}/items', {'ids': done})
        call('POST', f'/api/history/exports/{export["id"]}/finalize')
        state, deadline = {}, time.time() + 180
        while time.time() < deadline and state.get('status') not in ('ready', 'failed'):
            time.sleep(2)
            _, state = call('GET', f'/api/history/exports/{export["id"]}')
            state = state or {}
        check('ZIP built by the export worker', state.get('status') == 'ready', state)
        if state.get('status') == 'ready':
            status, data = call('GET', f'/api/history/exports/{export["id"]}/download', raw=True)
            names = zipfile.ZipFile(io.BytesIO(data)).namelist() if status == 200 else []
            check('ZIP downloads with every item', len(names) == len(done), names or status)
    else:
        check('export created', False, export)
# ---- managed portraits: a real face photo becomes a BytePlus asset automatically
def upload_bytes(data, content_type, filename, purpose='image-reference'):
    import hashlib
    status, session = call('POST', '/api/uploads/init', {'version': 1, 'purpose': purpose, 'contentType': content_type,
        'byteSize': len(data), 'filename': filename, 'requestKey': uuid.uuid4().hex, 'sha256': hashlib.sha256(data).hexdigest()})
    if status not in (200, 201) or not session.get('uploadUrl'):
        return None, session
    url = session['uploadUrl'] if session['uploadUrl'].startswith('http') else BASE + session['uploadUrl']
    request = urllib.request.Request(url, method='PUT', data=data, headers={'Content-Type': content_type,
        'Content-Range': f'bytes 0-{len(data) - 1}/{len(data)}', 'Origin': BASE, 'Sec-Fetch-Site': 'same-origin'})
    try:
        opener.open(request, timeout=60).read()
    except urllib.error.HTTPError as error:
        if error.code not in (200, 201, 204, 308):
            return None, {'put': error.code, 'body': error.read()[:200]}
    status, ready = call('POST', f'/api/uploads/{session["uploadId"]}/finalize', {'version': 1})
    return (ready if status == 200 and (ready.get('referenceId') or ready.get('key')) else None), ready


status, pool = call('GET', '/api/portraits/managed')
if isinstance(pool, dict) and pool.get('enabled'):
    face = open(os.path.join(HERE, '..', 'backend', 'testsupport', 'data', 'face_public_domain.jpg'), 'rb').read()
    ready, detail = upload_bytes(face, 'image/jpeg', 'face.jpg')
    check('face reference uploads through the normal flow', ready is not None, detail)
    if ready:
        identifier = enqueue('video', {'prompt': 'local smoke: portrait @img1 walks through the hall', 'model': 'Seedance 2.5',
                                       'resolution': '480p', 'draftMode': True, 'duration': 5, 'referenceImages': [{'referenceId': ready['referenceId']}]})
        row = wait(identifier) if identifier else {}
        check('face video finished (portrait prepared automatically)', row.get('status') == 'succeeded', row.get('error') or row.get('status'))
        status, pool = call('GET', '/api/portraits/managed')
        assets = (pool or {}).get('assets', [])
        check('Gallery lists the managed portrait as Ready', any(a['label'] == 'Ready' for a in assets), assets[:2])
        state = json.loads(urllib.request.urlopen('http://127.0.0.1:18099/state', timeout=10).read())
        check('fake BytePlus holds the registered asset', state['live_assets'] >= 1, state['live_assets'])
        status, refused = call('POST', '/api/assets/portraits/upload', {'referenceId': ready['referenceId']})
        check('manual portrait upload is refused', status == 410, refused)
else:
    print('INFO managed portraits are off on this stack', flush=True)

# ---- depth: the real external depth worker (local/veevee.sh depth) processes a short clip
status, depth = call('GET', '/api/worker/depth/status')
if isinstance(depth, dict) and depth.get('online'):
    import shutil
    import subprocess
    import tempfile
    if shutil.which('ffmpeg'):
        with tempfile.TemporaryDirectory() as directory:
            clip = os.path.join(directory, 'clip.mp4')
            subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=12', '-t', '1',
                            '-pix_fmt', 'yuv420p', '-c:v', 'libx264', clip], check=True)
            video = open(clip, 'rb').read()
        ready, detail = upload_bytes(video, 'video/mp4', 'clip.mp4', 'depth-input')
        check('depth input uploads through the normal flow', ready is not None, detail)
        if ready:
            status, item = call('POST', '/api/generate/depth', {'inputVideoKey': ready['key'], 'encoder': 'vits', 'trackCharacters': False,
                                                                'originalName': 'clip.mp4', 'projectId': project['id']})
            check('depth: accepted', status == 200 and bool((item or {}).get('id')), item)
            row, deadline = item or {}, time.time() + 900
            while row.get('id') and row.get('status') not in ('succeeded', 'failed') and time.time() < deadline:
                time.sleep(3)
                _, row = call('GET', f'/api/generate/depth/status?id={item["id"]}')
            check('depth: finished on the local worker', row.get('status') == 'succeeded', row.get('error') or row.get('status'))
            if row.get('url'):
                status, data = call('GET', row['url'], raw=True)
                check('depth: result readable', status == 200 and len(data) > 1000, f'{status} {len(data or b"")}')
    else:
        print('INFO ffmpeg missing on the host; depth job skipped', flush=True)
else:
    print(f'INFO depth worker offline (start it with local/veevee.sh depth): {depth}', flush=True)
print(json.dumps({'failures': failures}), flush=True)
sys.exit(1 if failures else 0)
