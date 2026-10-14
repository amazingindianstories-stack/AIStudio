"""Fake provider network for end-to-end worker tests and local runs.

Only the lowest network layer is replaced: ``HttpTransport.request`` (every
provider adapter, including the BytePlus asset client) and the provider media
fetcher. Everything above it — the real executor, adapters, payload builders,
persistence, naming and ledger wrappers — runs exactly as in production. Any
request to an unexpected host fails, so nothing can reach a real paid API.

``FakeProviders.handle`` is plain Python (no Django) so the same behaviour backs
in-process tests and the shared local fake-provider server.
"""
import base64
import contextlib
import io
import json
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

FAKE_MEDIA = 'https://fake-media.invalid/'
ASSET_HOST = 'ark.ap-southeast-1.byteplusapi.com'


def png_bytes(size=(64, 48)):
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', size, (180, 120, 60)).save(out, format='PNG')
    return out.getvalue()


def mov_bytes():
    """A real one-second QuickTime file (needs ffmpeg, present in the backend image)."""
    if not shutil.which('ffmpeg'):
        return b'\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  ' + b'\x00' * 64
    with tempfile.TemporaryDirectory() as directory:
        target = f'{directory}/v.mov'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12', '-t', '1',
                        '-c:v', 'mpeg4', '-f', 'mov', target], check=True)
        with open(target, 'rb') as handle:
            return handle.read()


class FakeProviders:
    """Stateful fake of every provider Veevee calls. Thread-safe."""

    def __init__(self, *, seedance_status='succeeded', asset_capacity=None, asset_activation_polls=1):
        self.calls, self.lock, self.task_counter = [], threading.RLock(), 0
        self.seedance_status = seedance_status
        self.seedance_payloads = []
        self.asset_capacity = asset_capacity          # None = unlimited; int = BytePlus shared pool size
        self.asset_activation_polls = asset_activation_polls
        self.groups, self.assets = {}, {}
        self.png, self.mov = png_bytes(), mov_bytes()
        self._stack = contextlib.ExitStack()

    # ---- plain handler -------------------------------------------------
    def handle(self, method, url, body=None):
        """Return (status, payload) where payload is a dict (JSON) for provider APIs."""
        parts = urlsplit(url)
        host, path = parts.hostname or '', parts.path or '/'
        with self.lock:
            self.calls.append((method, host + path + ('?' + parts.query if host == ASSET_HOST else '')))
        data = body if isinstance(body, dict) else (json.loads(body) if body else {})
        if host == 'generativelanguage.googleapis.com' and path.endswith(':generateContent'):
            return 200, {'candidates': [{'content': {'parts': [{'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(self.png).decode()}}]},
                                         'finishReason': 'STOP'}], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 1290}}
        if host.endswith('bytepluses.com') and path.endswith('/images/generations') and method == 'POST':
            return 200, {'data': [{'url': FAKE_MEDIA + 'seedream.png'}], 'usage': {'generated_images': 1}}
        if host.endswith('bytepluses.com') and path.endswith('/contents/generations/tasks') and method == 'POST':
            with self.lock:
                self.task_counter += 1
                self.seedance_payloads.append(data)
                return 200, {'id': f'cgt-sim-{self.task_counter}'}
        task = re.search(r'/contents/generations/tasks/(cgt-sim-\d+)$', path)
        if host.endswith('bytepluses.com') and task and method == 'GET':
            payload = {'id': task[1], 'status': self.seedance_status, 'created_at': 1, 'updated_at': 2,
                       'usage': {'completion_tokens': 100000, 'total_tokens': 100000}}
            if self.seedance_status == 'succeeded':
                payload['content'] = {'video_url': FAKE_MEDIA + 'video.mov'}
            return 200, payload
        if host == ASSET_HOST and method == 'POST' and path == '/':
            action = (parse_qs(parts.query).get('Action') or [''])[0]
            return self.asset_api(action, data)
        raise AssertionError(f'Unexpected provider request {method} {host}{path}')

    def asset_api(self, action, body):
        meta = {'RequestId': 'req-' + uuid.uuid4().hex[:12], 'Action': action, 'Version': '2024-01-01'}

        def ok(result):
            return 200, {'ResponseMetadata': meta, 'Result': result}

        def error(status, code, message):
            return status, {'ResponseMetadata': {**meta, 'Error': {'Code': code, 'Message': message}}}
        now = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
        with self.lock:
            identifier = body.get('Id')
            if action == 'CreateAssetGroup':
                gid = 'group-' + uuid.uuid4().hex[:16]
                self.groups[gid] = {'Id': gid, 'Name': body.get('Name', ''), 'GroupType': body.get('GroupType', 'AIGC'),
                                    'ProjectName': body.get('ProjectName', 'default'), 'CreateTime': now}
                return ok({'Id': gid})
            if action == 'GetAssetGroup':
                return ok(self.groups[identifier]) if identifier in self.groups else error(404, 'NotFound.group_id', 'group not found')
            if action == 'ListAssetGroups':
                return ok({'Items': list(self.groups.values()), 'NextToken': ''})
            if action == 'CreateAsset':
                if body.get('GroupId') not in self.groups:
                    return error(404, 'NotFound.group_id', 'group not found')
                live = [a for a in self.assets.values() if a['Status'] != 'Deleted']
                if self.asset_capacity is not None and len(live) >= self.asset_capacity:
                    return error(400, 'QuotaSharedPoolExceeded', 'The shared asset pool is full.')
                aid = 'asset-' + uuid.uuid4().hex[:16]
                self.assets[aid] = {'Id': aid, 'GroupId': body['GroupId'], 'Name': body.get('Name', ''), 'URL': body.get('URL'),
                                    'AssetType': body.get('AssetType', 'Image'), 'ProjectName': body.get('ProjectName', 'default'),
                                    'Status': 'Processing' if self.asset_activation_polls else 'Active', 'CreateTime': now, '_polls': 0}
                return ok({'Id': aid, 'Status': self.assets[aid]['Status']})
            if action == 'GetAsset':
                asset = self.assets.get(identifier)
                if not asset or asset['Status'] == 'Deleted':
                    return error(404, 'NotFound.asset_id', 'asset not found')
                asset['_polls'] += 1
                if asset['Status'] == 'Processing' and asset['_polls'] >= self.asset_activation_polls:
                    asset['Status'] = 'Active'
                return ok({k: v for k, v in asset.items() if not k.startswith('_')})
            if action == 'ListAssets':
                flt = body.get('Filter') or {}
                rows = [a for a in self.assets.values() if a['Status'] != 'Deleted']
                if flt.get('GroupIds'):
                    rows = [a for a in rows if a['GroupId'] in flt['GroupIds']]
                if flt.get('Statuses'):
                    rows = [a for a in rows if a['Status'] in flt['Statuses']]
                return ok({'Items': [{k: v for k, v in a.items() if not k.startswith('_')} for a in rows], 'NextToken': ''})
            if action == 'DeleteAsset':
                asset = self.assets.get(identifier)
                if not asset or asset['Status'] == 'Deleted':
                    return error(404, 'NotFound.asset_id', 'asset not found')
                asset['Status'] = 'Deleted'
                return ok({})
        return error(400, 'InvalidAction', f'Fake does not implement {action}')

    def live_asset_count(self):
        with self.lock:
            return sum(1 for a in self.assets.values() if a['Status'] != 'Deleted')

    def media(self, url):
        with self.lock:
            self.calls.append(('FETCH', url))
        if url == FAKE_MEDIA + 'seedream.png':
            return self.png, 'image/png'
        if url == FAKE_MEDIA + 'video.mov':
            return self.mov, 'video/quicktime'
        raise AssertionError(f'Unexpected media fetch {url}')

    # ---- in-process patching (tests) ------------------------------------
    def request(self, transport, method, url, *, headers=None, body=None, raw_body=None, signal=None):
        from apps.generation.providers.transport import HttpResult
        if signal is not None:
            signal.check()
        status, payload = self.handle(method, url, body if body is not None else raw_body)
        return HttpResult(status=status, body=json.dumps(payload).encode(), headers={'content-type': 'application/json'})

    fetch = media

    def __enter__(self):
        fake = self

        def request(transport_self, method, url, **kwargs):
            return fake.request(transport_self, method, url, **kwargs)
        self._stack.enter_context(patch('apps.generation.providers.transport.HttpTransport.request', request))
        for target in ('apps.media.remote.get_media_fetcher', 'apps.media.persistence.get_media_fetcher',
                       'apps.generation.services.poller.get_media_fetcher'):
            self._stack.enter_context(patch(target, lambda: fake.fetch))
        return self

    def __exit__(self, *exc):
        return self._stack.__exit__(*exc)
