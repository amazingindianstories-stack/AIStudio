"""Release rehearsal only: the API process's Gemini calls (the admin chat agent) reach the fake provider network.

scripts/release/rehearse_local.sh puts this directory on the rehearsal API container's PYTHONPATH, so Python loads
it in gunicorn before Django starts. Only generativelanguage.googleapis.com is answered by
testsupport.fake_providers; every other host keeps the real transport (unreachable on the internal rehearsal
network). Only ``HttpTransport._send`` (the network call) is replaced, as its module is imported, so the paid guard's
check in ``HttpTransport.request`` runs in front of the fake exactly as it runs in front of the network in production.
Inert unless VEEVEE_REHEARSAL=1.
"""
import importlib.abc
import importlib.util
import os
import sys
import threading
from urllib.parse import urlsplit

TARGET = 'apps.integrations.transport'
GEMINI_HOST = 'generativelanguage.googleapis.com'


def _patch(module):
    original, lock, state = module.HttpTransport._send, threading.Lock(), {}

    def request(self, method, url, **kwargs):
        if urlsplit(url).hostname != GEMINI_HOST:
            return original(self, method, url, **kwargs)
        with lock:
            if 'fake' not in state:
                from testsupport.fake_providers import FakeProviders
                state['fake'] = FakeProviders()
        return state['fake'].request(self, method, url, **kwargs)
    module.HttpTransport._send = request


class _Hook(importlib.abc.MetaPathFinder):
    def find_spec(self, name, path, target=None):
        if name != TARGET:
            return None
        sys.meta_path.remove(self)
        try:
            spec = importlib.util.find_spec(name)
        finally:
            sys.meta_path.insert(0, self)
        original = spec.loader.exec_module

        def exec_module(module):
            original(module)
            _patch(module)
        spec.loader.exec_module = exec_module
        return spec


if os.environ.get('VEEVEE_REHEARSAL') == '1':
    sys.meta_path.insert(0, _Hook())
