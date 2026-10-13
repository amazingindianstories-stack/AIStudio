"""Fake provider network for end-to-end worker tests and local release rehearsals.

Only the lowest network layer is replaced: ``HttpTransport.request`` (every
provider adapter) and the provider media fetcher. Everything above it — the
real executor, adapters, payload builders, persistence, naming and ledger
wrappers — runs exactly as in production. Any request to an unexpected host
fails the run, so nothing can reach a real paid API.
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
from unittest.mock import patch

FAKE_MEDIA = 'https://fake-media.invalid/'


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
    """Context manager; ``calls`` records (method, host+path) for assertions."""

    def __init__(self, *, seedance_status='succeeded'):
        self.calls, self.lock, self.task_counter = [], threading.Lock(), 0
        self.seedance_status = seedance_status
        self.png, self.mov = png_bytes(), mov_bytes()
        self._stack = contextlib.ExitStack()

    def _result(self, payload, status=200):
        from apps.generation.providers.transport import HttpResult
        return HttpResult(status=status, body=json.dumps(payload).encode(), headers={'content-type': 'application/json'})

    def request(self, transport, method, url, *, headers=None, body=None, raw_body=None, signal=None):
        if signal is not None:
            signal.check()
        match = re.match(r'https://([^/]+)(/[^?]*)', url)
        host, path = (match[1], match[2]) if match else ('', url)
        with self.lock:
            self.calls.append((method, host + path))
        if host == 'generativelanguage.googleapis.com' and path.endswith(':generateContent'):
            return self._result({'candidates': [{'content': {'parts': [{'inlineData': {'mimeType': 'image/png', 'data': base64.b64encode(self.png).decode()}}]},
                                                 'finishReason': 'STOP'}], 'usageMetadata': {'promptTokenCount': 10, 'candidatesTokenCount': 1290}})
        if host.endswith('bytepluses.com') and path.endswith('/images/generations') and method == 'POST':
            return self._result({'data': [{'url': FAKE_MEDIA + 'seedream.png'}], 'usage': {'generated_images': 1}})
        if host.endswith('bytepluses.com') and path.endswith('/contents/generations/tasks') and method == 'POST':
            with self.lock:
                self.task_counter += 1
                return self._result({'id': f'cgt-sim-{self.task_counter}'})
        task = re.search(r'/contents/generations/tasks/(cgt-sim-\d+)$', path)
        if host.endswith('bytepluses.com') and task and method == 'GET':
            payload = {'id': task[1], 'status': self.seedance_status, 'created_at': 1, 'updated_at': 2,
                       'usage': {'completion_tokens': 100000, 'total_tokens': 100000}}
            if self.seedance_status == 'succeeded':
                payload['content'] = {'video_url': FAKE_MEDIA + 'video.mov'}
            return self._result(payload)
        raise AssertionError(f'Unexpected provider request {method} {host}{path}')

    def fetch(self, url):
        with self.lock:
            self.calls.append(('FETCH', url))
        if url == FAKE_MEDIA + 'seedream.png':
            return self.png, 'image/png'
        if url == FAKE_MEDIA + 'video.mov':
            return self.mov, 'video/quicktime'
        raise AssertionError(f'Unexpected media fetch {url}')

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
