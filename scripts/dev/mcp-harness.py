"""Local MCP service against Django + independent Python workers, with fake providers.

Run through scripts/dev/test-db.sh, which supplies a disposable loopback database and an
allowlisted environment:

  scripts/dev/test-db.sh PYTHON scripts/dev/mcp-harness.py --serve --token-file /abs/path/token
  scripts/dev/test-db.sh PYTHON scripts/dev/mcp-harness.py --probe

It migrates, seeds an admin fixture account with agent access on (images, a native MOV and a
WAV file), mints a personal access token and writes it only to the 0600 --token-file (it is never
printed), then starts the shared fake provider server, Django (gunicorn), the generation and export workers,
the scheduler and the MCP service through the real entrypoint (uvicorn behind the gateway in mcp
mode). --serve prints the MCP URL and stays up until interrupted; --probe drives every tool,
resource and prompt with the SDK client and exits non-zero on any failure.

Providers are faked the way the local stack fakes them (local/runtime/sitecustomize.py with
VEEVEE_LOCAL_PROVIDERS=fake and MOCK_GENERATION=0): the real adapters, executor and persistence run,
and only the network call and the media download reach testsupport.fake_provider_server, so jobs end
with each model's native master (Seedance a QuickTime MOV). Fixed fake credentials go only to the
generation worker and the scheduler, the only processes routed to the fake; Django and the MCP service get
neither, so URL imports keep the real SSRF-safe fetcher. Nothing leaves this machine.
"""
import argparse
import asyncio
import base64
import hashlib
import io
import json
import os
import secrets
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parents[2]
FAKE_MEDIA = 'https://fake-media.invalid/'
# Only the processes that call providers (generation worker, scheduler) are routed to the fake provider server and
# hold these fixed fake credentials (never real keys). Django and the MCP service keep the real SSRF-safe URL fetcher.
PROVIDER_ENV = {'VEEVEE_LOCAL_PROVIDERS': 'fake', 'ARK_API_KEY': 'local-fake-ark-key', 'GOOGLE_API_KEY': 'local-fake-google-key',
                 'BYTEPLUS_ACCESS_KEY_ID': 'local-fake-ak', 'BYTEPLUS_SECRET_ACCESS_KEY': 'local-fake-sk', 'KLING_API': 'local-fake-kling-key',
                 'MAGNIFIC_API_KEY': 'local-fake-magnific-key'}
MCP_PORT = 18082                       # deploy.entrypoint's fixed uvicorn port (loopback only)
USER_ID = 'b0b5a7e2-6d1c-4c3e-9f57-3c1d2a8e0001'
IMAGE_IDS = [f'30000000-0000-4000-8000-{index:012d}' for index in range(3)]
MOVIE_ID = '40000000-0000-4000-8000-000000000001'
ERAS = ('legacy', '2026-07-28')


def available_port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


def wait_ready(url, process, timeout=120):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if process.poll() is not None:
            raise RuntimeError(f'A local service exited before {url} was ready')
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(.2)
    raise RuntimeError(f'{url} readiness timed out')


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w') as handle:
        handle.write(text + '\n')


def seconds(stamp):
    """A tool result's ISO-8601 UTC time as epoch seconds."""
    return datetime.strptime(stamp, '%Y-%m-%dT%H:%M:%SZ').replace(tzinfo=timezone.utc).timestamp()


def seed_fixture(artifact):
    """Migrate, then the admin fixture account, agent access, library fixtures and two tokens (main and spare)."""
    import django
    django.setup()
    from django.core.management import call_command
    from django.db import connection
    from PIL import Image
    from apps.admin_dashboard.models import AppSetting, Pricing, UserLimit
    from apps.authentication.models import User
    from apps.authentication.password import hash_password
    from apps.authentication.session import sign_session
    from apps.common.leases import now_ms
    from apps.generation.models import Generation
    from apps.library.services.naming import assign_generation_naming
    from apps.mcp_auth import policy, tokens
    from apps.media.storage import get_storage
    call_command('migrate', interactive=False, verbosity=0)
    now = now_ms()
    credentials = hash_password('LocalMcpFixture!42')
    user, _ = User.objects.update_or_create(id=USER_ID, defaults={'email': 'mcp-harness@example.test', 'name': 'MCP fixture',
        'password_hash': credentials['hash'], 'password_salt': credentials['salt'], 'role': 'admin', 'created_at': 1})
    AppSetting.objects.update_or_create(key=policy.ENABLED_LIMIT, defaults={'value': 'true', 'updated_at': now})
    policy.set_enabled(USER_ID, True, now)
    # Owner defaults, as in production: no per-user agent cap or job limit, the main token at the default caps.
    UserLimit.objects.filter(user_id=USER_ID, key__in=(policy.DAILY_CAP_LIMIT, policy.ACTIVE_JOBS_LIMIT)).delete()
    # OmniHuman has no default rate; an admin sets the account's rate (the MCP tests use the same fixture value).
    Pricing.objects.get_or_create(model='OmniHuman 2.0', defaults={'unit_cost_cents': 7, 'unit': 'per_second', 'notes': ''})
    for index, identifier in enumerate(IMAGE_IDS):
        buffer = io.BytesIO()
        Image.new('RGB', (640, 480), (60 + index * 50, 90, 140)).save(buffer, format='PNG')
        url = get_storage().upload_buffer(buffer.getvalue(), f'generations/{identifier}.png', 'png')
        Generation.objects.update_or_create(id=identifier, defaults={'kind': 'image', 'status': 'succeeded',
            'model': 'Nano Banana Pro', 'prompt': f'MCP fixture image {index}', 'aspect_ratio': '4:3',
            'url': url, 'user_id': USER_ID, 'created_at': 1000 + index, 'updated_at': 1000 + index, 'completed_at': 1000 + index})
        assign_generation_naming(identifier)
    movie = artifact / 'native-fixture.mov'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=10',
        '-t', '1', '-c:v', 'prores_ks', '-profile:v', '2', '-pix_fmt', 'yuv422p10le', '-f', 'mov', str(movie)], check=True)
    url = get_storage().upload_buffer(movie.read_bytes(), f'generations/{MOVIE_ID}.mov', 'mov')
    Generation.objects.update_or_create(id=MOVIE_ID, defaults={'kind': 'video', 'status': 'succeeded', 'model': 'Seedance 2.5',
        'prompt': 'MCP native MOV fixture', 'aspect_ratio': '1:1', 'duration': 1, 'url': url, 'user_id': USER_ID,
        'created_at': 2000, 'updated_at': 2000, 'completed_at': 2000})
    assign_generation_naming(MOVIE_ID)
    voice = artifact / 'voice.wav'
    subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=16000',
        '-t', '5', '-ac', '1', str(voice)], check=True)
    user.refresh_from_db()
    expires = now + 7 * policy.DAY_MS
    raw, _ = tokens.issue(user, 'pat', scopes=list(policy.SCOPES), daily_cap_cents=policy.TOKEN_DAILY_CAP_DEFAULT,
                          auto_approve_cents=policy.AUTO_APPROVE_DEFAULT, expires_at=expires, name='MCP harness')
    spare, spare_row = tokens.issue(user, 'pat', scopes=['veevee.read'], daily_cap_cents=1, auto_approve_cents=0,
                                    expires_at=expires, name='MCP harness spare')
    connection.close()
    return {'token': raw, 'spare': spare, 'spareId': str(spare_row.id), 'movie': movie.read_bytes(), 'voice': voice.read_bytes(),
            'session': sign_session(user)}


class Probe:
    """Drives the running service with the SDK client and prints one PASS/FAIL line per check."""

    def __init__(self, fixture, mcp_url, gateway_url, ingress, fake_url):
        self.fixture, self.mcp_url, self.gateway_url, self.ingress, self.fake_url = fixture, mcp_url, gateway_url, ingress, fake_url
        self.failures, self.native_movie = [], None

    def check(self, name, condition, detail=''):
        print(('PASS ' if condition else 'FAIL ') + name + ('' if condition else f' - {str(detail)[:400]}'), flush=True)
        if not condition:
            self.failures.append(name)
        return condition

    async def raw(self, url, body, headers=None):
        import httpx2
        async with httpx2.AsyncClient(timeout=30) as http:
            return await http.post(url, content=json.dumps(body).encode(), headers={
                'accept': 'application/json, text/event-stream', 'content-type': 'application/json', **(headers or {})})

    async def fetch(self, url, headers=None):
        import httpx2
        async with httpx2.AsyncClient(timeout=60, follow_redirects=True) as http:
            response = await http.get(url, headers=headers)
            return response.status_code, response.content, response.headers.get('content-type', '')

    def session(self, mode='2026-07-28', *, url=None, token=None, headers=None):
        import httpx2
        from mcp import Client
        from mcp.client.streamable_http import streamable_http_client
        http = httpx2.AsyncClient(timeout=120, headers={'authorization': f'Bearer {token or self.fixture["token"]}', **(headers or {})})
        return http, Client(streamable_http_client(url or self.mcp_url, http_client=http), mode=mode)

    async def tool(self, client, name, arguments=None):
        """Structured content of one call, retrying rate, concurrency and hold refusals; None (and FAIL) on any other error."""
        for _ in range(30):
            result = await client.call_tool(name, arguments or {})
            content = result.structured_content or {}
            if result.is_error and content.get('code') in ('RATE_LIMITED', 'CONCURRENCY_LIMIT'):
                await asyncio.sleep(min(max(content.get('retryAfterSeconds') or 5, 1), 20))
                continue
            if result.is_error:
                self.check(f'{name}: answered without a tool error', False, content or result.content)
                return None
            return content
        self.check(f'{name}: admitted within the retry window', False, content)
        return None

    async def error(self, client, name, arguments):
        result = await client.call_tool(name, arguments)
        return (result.structured_content or {}).get('code') if result.is_error else None

    async def paid(self, client, name, arguments):
        """A paid call through its quote (confirming when asked) and holds until a terminal outcome."""
        found = await self.tool(client, name, arguments)
        for _ in range(12):
            if not found:
                return None
            if found['outcome'] == 'quote_required':
                following = dict(found['next']['arguments'])
                if found['quote']['requiresUserConfirmation']:
                    following['confirmedByUser'] = True
                found = await self.tool(client, found['next']['tool'], following)
            elif found['outcome'] == 'running':
                found = await self.tool(client, 'get_generation', {'id': found['generation']['id'], 'wait': True})
            else:
                return found
        return found

    async def connection(self):
        response = await self.raw(self.mcp_url, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'})
        self.check('no bearer token: 401 with a challenge', response.status_code == 401
                   and 'resource_metadata=' in response.headers.get('www-authenticate', ''), response.status_code)
        response = await self.raw(self.mcp_url, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
                                  {'authorization': f'Bearer {self.fixture["token"]}', 'origin': 'https://evil.example'})
        self.check('foreign Origin: 403', response.status_code == 403, response.status_code)
        response = await self.raw(self.gateway_url, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
                                  {'authorization': f'Bearer {self.fixture["token"]}'})
        self.check('gateway without the ingress header: 403', response.status_code == 403, response.status_code)
        for mode in ERAS:
            for label, url, headers in (('direct', self.mcp_url, None), ('gateway', self.gateway_url, {'x-veevee-g4-ingress': self.ingress})):
                http, client = self.session(mode, url=url, headers=headers)
                async with http, client:
                    names = {tool.name for tool in (await client.list_tools()).tools}
                    account = await self.tool(client, 'get_account')
                self.check(f'{mode} era via {label}: all 24 tools listed', len(names) == 24, sorted(names))
                self.check(f'{mode} era via {label}: get_account', bool(account) and account['user']['id'] == USER_ID, account)

    async def reads(self, client):
        models = await self.tool(client, 'list_models')
        kinds = {model['kind'] for model in (models or {}).get('models', [])}
        self.check('list_models: image, video and upscale models', kinds == {'image', 'video', 'upscale'}, kinds)
        found = await self.tool(client, 'search_generations', {'kind': 'image', 'sort': 'oldest'})
        self.check('search_generations: the image fixtures, SQL total', found and found['total'] >= 3
                   and [item['id'] for item in found['items'][:3]] == IMAGE_IDS, found and found['total'])
        found = await self.tool(client, 'search_generations', {'text': 'native MOV'})
        self.check('search_generations: name search', found and [item['id'] for item in found['items']] == [MOVIE_ID], found)
        movie = await self.tool(client, 'get_generation', {'id': MOVIE_ID})
        output = (movie or {}).get('generation', {}).get('outputs', [{}])[0]
        self.check('get_generation: native MOV master', output.get('mimeType') == 'video/quicktime'
                   and output.get('filename', '').endswith('.mov'), output)
        links = await self.tool(client, 'get_download_links', {'ids': [MOVIE_ID, IMAGE_IDS[0], str(uuid.uuid4())],
                                                               'variants': ['original', 'poster', 'thumbnail']})
        items = (links or {}).get('items', [])
        self.check('get_download_links: per-item error for an unknown id', len(items) == 3 and items[2]['error']['code'] == 'NOT_FOUND', items)
        urls = items[0]['outputs'][0]['urls'] if items and 'outputs' in items[0] else {}
        status, data, _ = await self.fetch(urls.get('original') or 'http://127.0.0.1:9/missing')
        self.check('original link: the exact native MOV bytes', status == 200 and hashlib.sha256(data).digest()
                   == hashlib.sha256(self.fixture['movie']).digest(), (status, len(data)))
        status, data, kind = await self.fetch(urls.get('poster') or 'http://127.0.0.1:9/missing')
        self.check('poster link: a WebP frame', status == 200 and data[:4] == b'RIFF' and data[8:12] == b'WEBP', (status, kind))
        folders = await self.tool(client, 'list_folders', {'projectId': 'global'})
        self.check('list_folders: the global tree', folders is not None, folders)
        listed = await client.list_resources()
        templates = await client.list_resource_templates()
        self.check('resources: models, global library and five templates', {item.uri for item in listed.resources}
                   == {'veevee://models', 'veevee://folder/global'} and len(templates.resource_templates) == 5, listed)
        for uri in ('veevee://models', f'veevee://generation/{MOVIE_ID}', f'veevee://generation/{MOVIE_ID}/original',
                    f'veevee://generation/{IMAGE_IDS[0]}/thumbnail', 'veevee://folder/global'):
            contents = (await client.read_resource(uri)).contents
            self.check(f'resource {uri}', len(contents) == 1 and (getattr(contents[0], 'text', None) or getattr(contents[0], 'blob', None)), contents)
        prompts = (await client.list_prompts()).prompts
        self.check('prompts: four', sorted(prompt.name for prompt in prompts) == ['product_shot_variations', 'seedance_draft_then_final',
                   'storyboard_to_shots', 'upscale_for_delivery'], prompts)
        got = await client.get_prompt('seedance_draft_then_final', {'idea': 'A fox crossing a frozen lake'})
        self.check('get_prompt: guidance text', 'fox' in got.messages[0].content.text, got)
        return models['models'] if models else []

    async def uploads(self, client):
        image = base64.b64encode(self.png()).decode()
        picture = await self.tool(client, 'upload_reference', {'dataBase64': image, 'contentType': 'image/png'})
        voice = await self.tool(client, 'upload_reference', {'dataBase64': base64.b64encode(self.fixture['voice']).decode(),
                                                             'contentType': 'audio/wav'})
        self.check('upload_reference: inline image and audio ready', picture and voice and picture['outcome'] == voice['outcome'] == 'ready'
                   and voice['reference']['kind'] == 'audio', (picture, voice))
        data = self.png((32, 200, 90))
        started = await self.tool(client, 'upload_reference', {'contentType': 'image/png', 'byteSize': len(data), 'filename': 'signed.png'})
        if self.check('upload_reference: signed upload session', started and started['outcome'] == 'upload_pending', started):
            import httpx2
            async with httpx2.AsyncClient(timeout=30) as http:
                put = await http.put(started['upload']['url'], content=data, headers=started['upload']['headers'])
            self.check('signed upload PUT accepted', put.status_code in (200, 201, 204, 308), put.status_code)
            finished = await self.tool(client, 'upload_reference', {'uploadId': started['reference']['id']})
            self.check('upload_reference: finalized by uploadId', finished and finished['outcome'] == 'ready', finished)
        code = await self.error(client, 'upload_reference', {'url': 'https://127.0.0.1/secret.png'})
        self.check('upload_reference: a loopback URL is refused', code == 'INVALID_INPUT', code)
        return picture and picture['reference']['id'], voice and voice['reference']['id']

    @staticmethod
    def png(color=(200, 120, 40)):
        from PIL import Image
        buffer = io.BytesIO()
        Image.new('RGB', (512, 512), color).save(buffer, format='PNG')     # OmniHuman takes 300-6000 px sides
        return buffer.getvalue()

    async def budget(self, client):
        """A confirmed 30 s 1080p Seedance 2.5 final passes the default $10 token cap and is refused before any row exists."""
        arguments = {'model': 'seedance-25', 'prompt': 'MCP harness: over budget', 'durationSeconds': 30, 'resolution': '1080p'}
        quoted = await self.tool(client, 'generate_video', arguments)
        if not self.check('budget: a 30 s 1080p Seedance 2.5 quote asks for confirmation', quoted and quoted['outcome'] == 'quote_required'
                          and quoted['quote']['requiresUserConfirmation'], quoted):
            return
        result = await client.call_tool('generate_video', {**quoted['next']['arguments'], 'confirmedByUser': True})
        error = result.structured_content or {}
        self.check('budget: the confirmed call is refused with BUDGET_EXCEEDED naming get_account', result.is_error
                   and error.get('code') == 'BUDGET_EXCEEDED' and 'get_account' in error.get('message', ''), error)

    async def generate(self, client, models, picture, voice):
        estimate = await self.tool(client, 'estimate_cost', {'tool': 'generate_image', 'arguments': {'prompt': 'A lighthouse at dusk'}})
        self.check('estimate_cost: a quote-free price', estimate is not None and estimate.get('costCents', 0) > 0, estimate)
        done = {}
        for model in models:
            if model['kind'] == 'upscale':
                continue
            arguments = {'model': model['id'], 'prompt': f'MCP harness: {model["name"]} test shot'}
            if model['inputs'].get('durationSeconds', {}).get('inputDriven'):
                arguments.update(referenceImageIds=[picture], referenceAudioIds=[voice])
            elif model['kind'] == 'video' and model['inputs'].get('draft'):
                arguments.update(draft=True, resolution='480p')
            found = await self.paid(client, model['tool'], arguments)
            generation = (found or {}).get('generation') or {}
            if self.check(f'{model["tool"]} {model["id"]}: completed through MCP', found and found['outcome'] == 'completed'
                          and generation.get('createdVia') == 'mcp' and generation.get('outputs'), found):
                done[model['id']] = generation
        await self.native(client, done)
        draft = done.get('seedance-25')
        if draft:
            final = await self.paid(client, 'finalize_draft', {'id': draft['id']})
            generation = (final or {}).get('generation') or {}
            output = (generation.get('outputs') or [{}])[0]
            self.check('finalize_draft: a 1080p Seedance 2.5 MOV final of the draft', final and final['outcome'] == 'completed'
                       and generation['related']['draftId'] == draft['id'] and generation['params'].get('resolution') == '1080p'
                       and generation['params'].get('draft') is not True and output.get('mimeType') == 'video/quicktime'
                       and output.get('filename', '').endswith('.mov'), final)
        arguments = {'model': 'nano-banana-2-1', 'prompt': 'MCP harness: idempotent replay', 'idempotencyKey': 'harness-replay-' + uuid.uuid4().hex,
                     'wait': False}
        first, again = await self.tool(client, 'generate_image', arguments), await self.tool(client, 'generate_image', arguments)
        self.check('idempotency: the same key returns the same job', first and again and first['generation']['id'] == again['generation']['id'],
                   (first, again))
        code = await self.error(client, 'generate_image', {**arguments, 'prompt': 'different'})
        self.check('idempotency: the same key with other arguments conflicts', code == 'IDEMPOTENCY_CONFLICT', code)
        queued = await self.tool(client, 'generate_image', {'model': 'nano-banana-2-1', 'prompt': 'MCP harness: cancel me', 'wait': False})
        if queued:
            cancelled = await self.tool(client, 'cancel_generation', {'id': queued['generation']['id']})
            self.check('cancel_generation: a cancellation answer', cancelled and 'cancellation' in cancelled, cancelled)

    async def native(self, client, done):
        """Each fake provider's native master survives: Seedance 2.5 the fake's exact MOV, Gemini a PNG, OmniHuman an MP4."""
        status, movie, _ = await self.fetch(self.fake_url + '/media?url=' + FAKE_MEDIA + 'video.mov')
        for model, mime, suffix, magic in (('seedance-25', 'video/quicktime', '.mov', lambda data: data[4:12] == b'ftypqt  ' and data == movie),
                                           ('nano-banana-2-1', 'image/png', '.png', lambda data: data[:8] == b'\x89PNG\r\n\x1a\n'),
                                           ('omnihuman-2', 'video/mp4', '.mp4', lambda data: data[4:8] == b'ftyp' and data[8:12] != b'qt  ')):
            generation = done.get(model)
            output = (generation or {}).get('outputs', [{}])[0]
            if not self.check(f'{model}: native {mime} master named {suffix}', output.get('mimeType') == mime
                              and output.get('filename', '').endswith(suffix), output):
                continue
            urls = output['urls']
            status, data, _ = await self.fetch(urls.get('original') or 'http://127.0.0.1:9/missing')
            self.check(f'{model}: the original link serves the native bytes unchanged', status == 200 and magic(data), (status, data[:16]))
            if model == 'seedance-25':
                self.native_movie = {'id': generation['id'], 'filename': output['filename'], 'bytes': data}
                cost = generation['cost']
                self.check(f'{model}: reconciled from provider tokens, booked at the same cents', cost['basis'] == 'reconciled'
                           and cost['bookedCents'] == cost['cents'] and 'note' not in cost, cost)
                status, poster, _ = await self.fetch(urls.get('poster') or 'http://127.0.0.1:9/missing')
                self.check(f'{model}: a WebP poster frame', status == 200 and poster[:4] == b'RIFF' and poster[8:12] == b'WEBP', (status, urls))

    async def finishing(self, client, models):
        for model in (model for model in models if model['kind'] == 'upscale'):
            # Videos upscale the ProRes MOV fixture (the fake never reads the source). Every upscale records its
            # source generation at submission, so image upscales (whose source is copied) link back too.
            video = model['inputs']['media'] == 'video'
            source = MOVIE_ID if video else IMAGE_IDS[1]
            found = await self.paid(client, 'upscale_media', {'sourceId': source, 'model': model['id']})
            generation = (found or {}).get('generation') or {}
            self.check(f'upscale_media {model["id"]}: completed', found and found['outcome'] == 'completed' and generation.get('outputs')
                       and generation['kind'] == model['inputs']['media']
                       and generation['related']['upscaleSourceId'] == source
                       and [ref['generationId'] for ref in generation.get('references') or []] == [source],
                       found and (found['outcome'], generation.get('kind'), generation.get('related'), generation.get('references'),
                                  len(generation.get('outputs') or []), generation.get('error')))

    async def organise(self, client):
        favourite = await self.tool(client, 'set_favorite', {'id': IMAGE_IDS[0], 'favorite': True})
        self.check('set_favorite', favourite and favourite['generation']['favorite'] is True, favourite)
        name = 'Harness ' + uuid.uuid4().hex[:6]
        parent = await self.tool(client, 'create_folder', {'name': name})
        child = parent and await self.tool(client, 'create_folder', {'name': name + ' child', 'in': {'folderId': parent['folder']['id']}})
        if not self.check('create_folder: a parent and a child', parent and child, (parent, child)):
            return None
        renamed = await self.tool(client, 'rename_folder', {'folderId': child['folder']['id'], 'name': name + ' shots',
                                                            'expectedVersion': child['folder']['version']})
        self.check('rename_folder', renamed and renamed['folder']['name'] == name + ' shots', renamed)
        code = await self.error(client, 'rename_folder', {'folderId': child['folder']['id'], 'name': 'stale', 'expectedVersion': 1})
        self.check('rename_folder: a stale version conflicts', code == 'VERSION_CONFLICT', code)
        moved = await self.tool(client, 'move_folder', {'folderId': child['folder']['id'], 'destination': 'global',
                                                        'expectedVersion': renamed['folder']['version']})
        self.check('move_folder: to the top level', moved and moved['folder']['parentId'] is None, moved)
        ids = [IMAGE_IDS[2], MOVIE_ID] + ([self.native_movie['id']] if self.native_movie else [])
        filed = await self.tool(client, 'move_to_folder', {'ids': ids, 'destination': {'folderId': parent['folder']['id']}})
        self.check(f'move_to_folder: {len(ids)} items filed', filed and len(filed['items']) == len(ids), filed)
        found = await self.tool(client, 'search_generations', {'folderId': parent['folder']['id']})
        self.check('search_generations: the folder holds the filed items', found and found['total'] == len(ids), found)
        return parent['folder']['id']

    async def exports(self, client, folder):
        made = await self.tool(client, 'export_zip', {'folderId': folder})
        for _ in range(6):
            if not made or made['outcome'] != 'running':
                break
            made = await self.tool(client, 'get_export', {'id': made['export']['id'], 'wait': True})
        if not self.check('export_zip: the folder archive is ready', made and made['outcome'] == 'completed', made):
            return
        asked = time.time()
        again = await self.tool(client, 'get_export', {'id': made['export']['id']})
        link, archive_end = (seconds(again['export']['download']['expiresAt']) - asked,
                             seconds(again['export']['expiresAt']) - asked)
        self.check('get_export: the download link lasts 5 minutes, the archive 7 days',
                   240 <= link <= 301 and 6 * 86_400 < archive_end <= 7 * 86_400, again['export'])
        # Filesystem storage cannot sign archive links, so locally the link is the web's signed-in download route.
        status, data, _ = await self.fetch(again['export']['download']['url'], {'cookie': 'veevee_session=' + self.fixture['session']})
        archive = zipfile.ZipFile(io.BytesIO(data)) if status == 200 else None
        names = archive.namelist() if archive else []
        self.check('export download: the native MOV kept in the archive', any(name.endswith('.mov') for name in names), (status, names))
        if self.native_movie:
            entries = [name for name in names if name.rsplit('/', 1)[-1] == self.native_movie['filename']]
            self.check('export download: the Seedance 2.5 entry is its .mov with the original bytes', len(entries) == 1
                       and archive.read(entries[0]) == self.native_movie['bytes'], (self.native_movie['filename'], names))
        contents = (await client.read_resource(made['export']['resourceUri'])).contents
        read = json.loads(contents[0].text)['export'] if len(contents) == 1 else {}
        self.check('resource veevee://export/{id}: a fresh 5-minute link',
                   read.get('download') and 0 < seconds(read['download']['expiresAt']) - time.time() <= 301, contents)

    async def admin(self, client):
        spend = await self.tool(client, 'admin_spend_report', {'groupBy': 'client'})
        self.check('admin_spend_report: MCP spend by client', spend is not None and spend['totals']['mcpCount'] > 0
                   and any(row['key'] == 'personal-access-token' for row in spend['rows']), spend)
        # get_account and the report's booked column sum the same rows: read the account on both sides of the report.
        before = await self.tool(client, 'get_account')
        users = await self.tool(client, 'admin_spend_report', {'days': 1, 'groupBy': 'user'})
        after = await self.tool(client, 'get_account')
        booked = next((row['mcpBookedCents'] for row in (users or {}).get('rows', []) if row['key'] == USER_ID), None)
        self.check('admin_spend_report: booked agent spend equals get_account', booked is not None and booked in
                   {account['spend']['todayCents'] for account in (before, after) if account}, (booked, before, after))
        errors = await self.tool(client, 'admin_provider_errors', {'limit': 5})
        self.check('admin_provider_errors', errors is not None and 'rows' in errors, errors)
        status = await self.tool(client, 'admin_system_status')
        self.check('admin_system_status: agents switched on', status and status['agents']['changesEnabled'] is True, status)
        revoked = await self.tool(client, 'admin_revoke_mcp_tokens', {'tokenId': self.fixture['spareId']})
        self.check('admin_revoke_mcp_tokens: the spare token', revoked and revoked['revokedTokens'] == 1, revoked)
        response = await self.raw(self.mcp_url, {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'},
                                  {'authorization': f'Bearer {self.fixture["spare"]}'})
        self.check('the revoked token gets 401', response.status_code == 401, response.status_code)

    async def controls(self):
        http, client = self.session(headers={'x-veevee-maintenance': '1'})
        async with http, client:
            code = await self.error(client, 'create_folder', {'name': 'Paused'})
            account = await self.tool(client, 'get_account')
        self.check('maintenance: writes refused, reads work', code == 'MAINTENANCE' and account is not None, code)

    async def run(self):
        await self.connection()
        http, client = self.session()
        async with http, client:
            models = await self.reads(client)
            picture, voice = await self.uploads(client)
            await self.budget(client)
            await self.generate(client, models, picture, voice)
            await self.finishing(client, models)
            folder = await self.organise(client)
            if folder:
                await self.exports(client, folder)
            await self.admin(client)
        await self.controls()
        print(json.dumps({'probe': 'failed' if self.failures else 'passed', 'failures': self.failures}), flush=True)
        return 1 if self.failures else 0


def interrupt(signum, frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser()
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument('--serve', action='store_true', help='stay up until interrupted')
    action.add_argument('--probe', action='store_true', help='drive every tool, then stop')
    parser.add_argument('--token-file', help='0600 file to receive the personal access token (required with --serve)')
    args = parser.parse_args()
    if args.serve and not args.token_file:
        parser.error('--serve needs --token-file')
    # SIGTERM stops the owned process groups like Ctrl-C does, and Ctrl-C works even when the harness was started from a
    # shell that ignores SIGINT for background jobs.
    signal.signal(signal.SIGINT, signal.default_int_handler)
    signal.signal(signal.SIGTERM, interrupt)
    target = urlsplit(os.environ.get('DATABASE_URL', ''))
    if os.environ.get('MIGRATION_TEST_ISOLATED') != '1' or target.hostname != '127.0.0.1' or target.path != '/veevee_django_migration':
        raise SystemExit('Run this harness through scripts/dev/test-db.sh against a disposable database')
    with socket.socket() as sock:
        if sock.connect_ex(('127.0.0.1', MCP_PORT)) == 0:
            raise SystemExit(f'Port {MCP_PORT} is in use; the MCP service needs it')
    artifact = Path(os.environ['TMPDIR']) / 'mcp-harness'
    artifact.mkdir(parents=True, exist_ok=True)
    backend_port, gateway_port, fake_port = available_port(), available_port(), available_port()
    backend = f'http://127.0.0.1:{backend_port}'
    # Links and upload URLs point straight at Django, so a local client can fetch them without the web front end.
    settings = artifact / 'mcp_harness_settings.py'
    settings.write_text('''from config.settings.test import *
# Every model switch on (fake providers), so the catalogue and the probe cover them all.
VEEVEE_GEMINI_OMNI = True
VEEVEE_MAGNIFIC_UPSCALE = True
VEEVEE_KLING = True
VEEVEE_OMNIHUMAN = True
''')
    os.environ.update(VEEVEE_MEDIA_BACKEND='filesystem', VEEVEE_MEDIA_ROOT=str(artifact / 'media'), PUBLIC_APP_URL=backend,
        DJANGO_BROWSER_ORIGINS=backend, DJANGO_SETTINGS_MODULE='mcp_harness_settings', VEEVEE_MCP='1',
        MCP_QUOTE_SECRET='harness-quote-' + secrets.token_hex(24), MOCK_GENERATION='0', MOCK_ASSET_PROVIDER='0',
        VEEVEE_FAKE_PROVIDER_URL=f'http://127.0.0.1:{fake_port}', VEEVEE_PROVIDER_MEDIA_HOSTS='fake-media.invalid',
        PYTHONPATH=os.pathsep.join(str(path) for path in (artifact, ROOT / 'local' / 'runtime', ROOT / 'backend')))
    sys.path[:0] = [str(artifact), str(ROOT / 'backend')]
    fixture = seed_fixture(artifact)
    if args.token_file:
        write_private(Path(args.token_file).resolve(), fixture['token'])
    ingress = 'harness-ingress-' + secrets.token_hex(24)
    env = dict(os.environ)
    processes, streams = [], []
    def launch(command, name, environment, cwd=ROOT):
        stream = (artifact / (name + '.log')).open('w')
        streams.append(stream)
        process = subprocess.Popen(command, cwd=cwd, env=environment, stdout=stream, stderr=subprocess.STDOUT, start_new_session=True)
        processes.append(process)
        return process
    try:
        fake = launch([sys.executable, '-m', 'testsupport.fake_provider_server', str(fake_port), '127.0.0.1'], 'fake-providers', env,
                      cwd=ROOT / 'backend')
        wait_ready(env['VEEVEE_FAKE_PROVIDER_URL'] + '/health', fake)
        django = launch([sys.executable, '-m', 'gunicorn', '--chdir', 'backend', 'config.wsgi:application',
            '--bind', f'127.0.0.1:{backend_port}', '--workers', '2', '--threads', '4'], 'django', env)
        wait_ready(backend + '/api/health', django)
        # The worker signs provider-facing source grants, which must be https; the fake providers never fetch them.
        launch([sys.executable, 'backend/manage.py', 'generation_worker', '--interval', '.2'], 'generation-worker',
               {**env, **PROVIDER_ENV, 'PUBLIC_APP_URL': 'https://mcp-harness.invalid'})
        launch([sys.executable, 'backend/manage.py', 'media_export_worker', '--interval', '.2'], 'export-worker', env)
        launch([sys.executable, 'backend/manage.py', 'run_scheduler'], 'scheduler', {**env, **PROVIDER_ENV})
        service = launch([sys.executable, '-m', 'deploy.entrypoint', 'mcp'], 'mcp',
                         {**env, 'VEEVEE_INGRESS_SECRET': ingress, 'PORT': str(gateway_port)}, cwd=ROOT / 'backend')
        wait_ready(f'http://127.0.0.1:{gateway_port}/__g4_readiness', service)
        mcp_url, gateway_url = f'http://127.0.0.1:{MCP_PORT}/mcp', f'http://127.0.0.1:{gateway_port}/mcp'
        print(json.dumps({'mcp': mcp_url, 'gateway': gateway_url + ' (needs the ingress header; use the direct URL)',
                          'tokenFile': str(Path(args.token_file).resolve()) if args.token_file else None,
                          'web': backend, 'logs': str(artifact)}), flush=True)
        if args.probe:
            return asyncio.run(Probe(fixture, mcp_url, gateway_url, ingress, env['VEEVEE_FAKE_PROVIDER_URL']).run())
        print('Serving; connect an MCP client with "Authorization: Bearer <token file contents>". Ctrl-C stops.', flush=True)
        while all(process.poll() is None for process in processes):
            time.sleep(1)
        print('A service exited; stopping. See ' + str(artifact), flush=True)
        return 1
    except KeyboardInterrupt:
        print('MCP harness interrupted; stopping its owned process groups.', flush=True)
        return 130
    finally:
        for process in reversed(processes):
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
        for process in reversed(processes):
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        for stream in streams:
            stream.close()


if __name__ == '__main__':
    raise SystemExit(main())
