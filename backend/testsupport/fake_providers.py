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
MAGNIFIC_CDN = 'https://cdn-magnific.freepik.com/'


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


def mp4_bytes(size='160x90'):
    """A real one-second H.264 + AAC MP4, the shape Magnific returned in a live task; needs ffmpeg."""
    with tempfile.TemporaryDirectory() as directory:
        target = f'{directory}/v.mp4'
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', f'testsrc=size={size}:rate=24',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264',
                        '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-shortest', '-f', 'mp4', target], check=True)
        with open(target, 'rb') as handle:
            return handle.read()


class FakeProviders:
    """Context manager; ``calls`` records (method, host+path) for assertions."""

    def __init__(self, *, seedance_status='succeeded'):
        self.calls, self.lock, self.task_counter = [], threading.Lock(), 0
        self.seedance_status = seedance_status
        self.png, self.mov = png_bytes(), mov_bytes()
        self.mp4 = mp4_bytes() if shutil.which('ffmpeg') else b''
        self.magnific_tasks = {}
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
        if host == 'api.magnific.com' and method == 'POST' and path.startswith('/v1/ai/'):
            with self.lock:
                self.task_counter += 1
                task = f'mag-sim-{self.task_counter}'
                self.magnific_tasks[task] = {'path': path, 'body': body}
            return self._result({'data': {'task_id': task, 'status': 'CREATED', 'generated': []}})
        status = re.fullmatch(r'(/v1/ai/[a-z0-9-]+)/(mag-sim-\d+)', path)
        if host == 'api.magnific.com' and method == 'GET' and status and status[2] in self.magnific_tasks:
            created = self.magnific_tasks[status[2]]
            # Documented get-task paths: the create path, except Turbo which is read via the standard endpoint.
            expected = '/v1/ai/video-upscaler' if created['path'] == '/v1/ai/video-upscaler/turbo' else created['path']
            if status[1] != expected:
                raise AssertionError(f'Magnific task {status[2]} polled on {status[1]}, expected {expected}')
            if created['path'].startswith('/v1/ai/video-upscaler'):
                generated = [MAGNIFIC_CDN + status[2] + '.mp4?token=t']
                if (created['body'] or {}).get('output_format') == 'prores_422_hq':
                    generated = [MAGNIFIC_CDN + status[2] + '-preview.mp4?token=t', MAGNIFIC_CDN + status[2] + '.mov?token=t']
            else:
                generated = [MAGNIFIC_CDN + status[2] + '.png?token=t']
            return self._result({'data': {'task_id': status[2], 'status': 'COMPLETED', 'generated': generated}})
        raise AssertionError(f'Unexpected provider request {method} {host}{path}')

    def fetch(self, url):
        with self.lock:
            self.calls.append(('FETCH', url))
        if url == FAKE_MEDIA + 'seedream.png':
            return self.png, 'image/png'
        if url == FAKE_MEDIA + 'video.mov':
            return self.mov, 'video/quicktime'
        if url.startswith(MAGNIFIC_CDN):
            path = url.split('?')[0]
            if path.endswith('.png'):
                return self.png, 'image/png'
            if path.endswith('.mov'):
                return self.mov, 'video/quicktime'
            if path.endswith('.mp4'):
                return self.mp4, 'video/mp4'
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
