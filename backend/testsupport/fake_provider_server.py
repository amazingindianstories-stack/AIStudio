"""Shared fake provider server for the local Veevee stack (never deployed).

    python -m testsupport.fake_provider_server [port]

One process holds all fake provider state (Seedance tasks, BytePlus asset pool,
media) so the API, workers and scheduler see the same world. Containers reach
it through local/runtime/sitecustomize.py, which redirects HttpTransport and
the media fetcher here when VEEVEE_LOCAL_PROVIDERS=fake.

    POST /provider  {"method", "url", "body"}  -> {"status", "payload"}
    GET  /media?url=...                         -> media bytes
    GET  /state                                 -> pool, groups, recent calls
    POST /control   {"asset_capacity", "seedance_status", "asset_activation_polls", "reset"}
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

from testsupport.fake_providers import FakeProviders

FAKE = FakeProviders()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _json(self, status, value):
        data = json.dumps(value).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        return json.loads(self.rfile.read(length) or b'{}')

    def do_GET(self):
        target = urlsplit(self.path)
        if target.path == '/media':
            url = (parse_qs(target.query).get('url') or [''])[0]
            try:
                data, mime = FAKE.media(url)
            except AssertionError as exc:
                return self._json(404, {'error': str(exc)})
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if target.path == '/state':
            with FAKE.lock:
                assets = [{k: v for k, v in a.items() if not k.startswith('_')} for a in FAKE.assets.values()]
                return self._json(200, {'asset_capacity': FAKE.asset_capacity, 'live_assets': FAKE.live_asset_count(),
                                        'assets': assets, 'groups': list(FAKE.groups.values()),
                                        'seedance_tasks': FAKE.task_counter, 'calls': FAKE.calls[-50:]})
        if target.path == '/health':
            return self._json(200, {'ok': True})
        self._json(404, {'error': 'not found'})

    def do_POST(self):
        target = urlsplit(self.path)
        if target.path == '/provider':
            request = self._body()
            try:
                status, payload = FAKE.handle(request['method'], request['url'], request.get('body'))
            except AssertionError as exc:
                return self._json(502, {'error': str(exc)})
            return self._json(200, {'status': status, 'payload': payload})
        if target.path == '/control':
            change = self._body()
            with FAKE.lock:
                if change.get('reset'):
                    FAKE.groups.clear(); FAKE.assets.clear(); FAKE.calls.clear(); FAKE.seedance_payloads.clear()
                for key in ('asset_capacity', 'seedance_status', 'asset_activation_polls'):
                    if key in change:
                        setattr(FAKE, key, change[key])
            return self._json(200, {'ok': True})
        self._json(404, {'error': 'not found'})


def main(argv):
    port = int(argv[1]) if len(argv) > 1 else 8099
    server = ThreadingHTTPServer(('0.0.0.0', port), Handler)
    server.daemon_threads = True
    print(json.dumps({'event': 'fake_provider_server_listening', 'port': port}), flush=True)
    server.serve_forever()


if __name__ == '__main__':
    main(sys.argv)
