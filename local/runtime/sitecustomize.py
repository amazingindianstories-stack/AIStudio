"""Local stack only: route provider traffic to the shared fake-provider server.

Loaded automatically by Python when /opt/veevee-local is on PYTHONPATH (local
compose only — never in the production image). Active only when
VEEVEE_LOCAL_PROVIDERS=fake. The transport is patched as soon as its module is
imported, i.e. before Django installs the paid guard, so the guard wraps the
fake exactly as it wraps the real network in production.
"""
import importlib.abc
import importlib.util
import json
import os
import sys
import urllib.parse
import urllib.request

SERVER = os.environ.get('VEEVEE_FAKE_PROVIDER_URL', 'http://fake-providers:8099')


def _post(path, value):
    request = urllib.request.Request(SERVER + path, data=json.dumps(value).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read())


def _patch_transport(module):
    def request(self, method, url, *, headers=None, body=None, raw_body=None, signal=None):
        if signal is not None:
            signal.check()
        payload = body
        if payload is None and raw_body is not None:
            try:
                payload = json.loads(raw_body)
            except ValueError:
                payload = None
        answer = _post('/provider', {'method': method, 'url': url, 'body': payload})
        if 'status' not in answer:
            raise module.ProviderError('Local fake provider refused the request: ' + answer.get('error', ''), code='fake_refused',
                                       may_have_submitted=False)
        return module.HttpResult(status=answer['status'], body=json.dumps(answer['payload']).encode(),
                                 headers={'content-type': 'application/json'})
    module.HttpTransport.request = request


def _patch_media(module):
    from contextlib import contextmanager
    import io

    def fetch(self, url):
        with urllib.request.urlopen(SERVER + '/media?url=' + urllib.parse.quote(url, safe=''), timeout=30) as response:
            return response.read(), response.headers.get('Content-Type', 'application/octet-stream')

    @contextmanager
    def open_file(self, url, *, max_bytes=None):
        data, mime = fetch(self, url)
        yield io.BytesIO(data), mime
    module.SafeMediaFetcher.__call__ = fetch
    module.SafeMediaFetcher.open_file = open_file


PATCHES = {'apps.generation.providers.transport': _patch_transport, 'apps.media.remote': _patch_media}


class _Hook(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        patcher = PATCHES.get(name)
        if patcher is None:
            return None
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(name)
        finally:
            sys.meta_path.insert(0, self)
        original = spec.loader.exec_module

        def exec_module(module):
            original(module)
            patcher(module)
        spec.loader.exec_module = exec_module
        return spec


if os.environ.get('VEEVEE_LOCAL_PROVIDERS') == 'fake':
    sys.meta_path.insert(0, _Hook())
