"""Tests for tiered board thumbnails, concurrent on-demand generation, upload-time derivatives,
backfill_thumbnails command, and gateway cache headers."""
from datetime import timedelta
import http.client
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch
from uuid import uuid4

from django.core.management import call_command
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.utils import timezone
from PIL import Image

from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.canvas.models import CanvasBoard
from apps.media.derivatives import (
    DERIVATIVE_CACHE_CONTROL,
    MAX_INPUT_BYTES,
    MAX_PIXELS,
    THUMB_WIDTHS,
    bounded_derivative,
    derivative_key,
    derivative_step,
)
from apps.media.models import UploadSession
from apps.media.storage import FileSystemAdapter, MemoryAdapter, PrefixedGCSAdapter, StorageService


def make_png(size=(1600, 1000), color=(40, 120, 200)):
    buf = io.BytesIO()
    Image.new('RGB', size, color).save(buf, format='PNG')
    return buf.getvalue()


class TieredDerivativeTests(SimpleTestCase):
    def test_derivative_step_and_bounds(self):
        self.assertEqual(THUMB_WIDTHS, (256, 512, 1280))
        self.assertEqual(derivative_step(64), 256)
        self.assertEqual(derivative_step(256), 256)
        self.assertEqual(derivative_step(257), 512)
        self.assertEqual(derivative_step(400), 512)
        self.assertEqual(derivative_step(512), 512)
        self.assertEqual(derivative_step(1024), 1280)
        self.assertEqual(derivative_step(1280), 1280)
        self.assertIsNone(derivative_step(1281))
        self.assertIsNone(derivative_step(None))
        # Large studio PNGs (20-50+ MB, >20 MP) must be eligible
        self.assertGreaterEqual(MAX_INPUT_BYTES, 64 * 1024 * 1024)
        self.assertGreaterEqual(MAX_PIXELS, 40_000_000)
        self.assertEqual(DERIVATIVE_CACHE_CONTROL, 'private, max-age=31536000, immutable')

    def test_single_read_generates_all_tiers_and_leaves_master_untouched(self):
        adapter = MemoryAdapter()
        storage = StorageService(adapter)
        master = make_png((1600, 1000))
        storage.primary.put('canvas/b1/photo.png', master, 'image/png', 'private')

        target, fresh = bounded_derivative(storage, 'canvas/b1/photo.png', 256)
        self.assertEqual(target, 'thumbs/256/canvas/b1/photo.png.webp')
        self.assertTrue(fresh)
        # All three tiers written create-only from one read
        for width in THUMB_WIDTHS:
            key = derivative_key('canvas/b1/photo.png', width)
            self.assertIn(key, adapter.objects)
            with Image.open(io.BytesIO(adapter.objects[key][0])) as img:
                self.assertEqual(img.format, 'WEBP')
                self.assertEqual(img.width, width)
        # Master bytes preserved byte-for-byte
        self.assertEqual(adapter.objects['canvas/b1/photo.png'][0], master)

    def test_concurrent_same_key_deduplicates_master_reads(self):
        adapter = MemoryAdapter()
        storage = StorageService(adapter)
        master = make_png((1400, 900))
        storage.primary.put('canvas/b1/race.png', master, 'image/png', 'private')

        opens = 0
        open_lock = threading.Lock()
        entered = threading.Event()
        release = threading.Event()
        real_open = storage.open

        def tracked_open(key, range_header=None):
            nonlocal opens
            if key == 'canvas/b1/race.png':
                with open_lock:
                    opens += 1
                entered.set()
                release.wait(timeout=5)
            return real_open(key, range_header)

        results = []

        def worker(width):
            results.append(bounded_derivative(storage, 'canvas/b1/race.png', width))

        with patch.object(storage, 'open', side_effect=tracked_open):
            t1 = threading.Thread(target=worker, args=(256,))
            t1.start()
            self.assertTrue(entered.wait(timeout=5))
            started = time.monotonic()
            worker(512)
            self.assertLess(time.monotonic() - started, 1)
            release.set()
            t1.join(timeout=10)

        self.assertEqual(opens, 1)
        self.assertEqual(results[0], ('canvas/b1/race.png', None))
        self.assertEqual(results[1][0], 'thumbs/256/canvas/b1/race.png.webp')
        self.assertEqual(
            bounded_derivative(storage, 'canvas/b1/race.png', 512),
            ('thumbs/512/canvas/b1/race.png.webp', None),
        )


class BoardThumbnailEndToEndTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(
            id=uuid4(), email='thumb@example.test', name='Thumb',
            role='admin', password_hash='x', password_salt='', created_at=1,
        )
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.storage = StorageService(FileSystemAdapter(self.temp.name))
        self.client.cookies['veevee_session'] = sign_session(self.user)
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'

    def test_media_route_serves_256_512_1280_and_full_with_immutable_cache(self):
        master = make_png((1800, 1200))
        key = f'canvas/{uuid4()}/img.png'
        self.storage.primary.put(key, master, 'image/png', 'private')

        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            r256 = self.client.get(f'/api/media/{key}?w=200')
            self.assertEqual(r256.status_code, 200)
            self.assertEqual(r256['Content-Type'], 'image/webp')
            self.assertEqual(r256['Cache-Control'], 'private, max-age=31536000, immutable')
            with Image.open(io.BytesIO(r256.content)) as img:
                self.assertEqual(img.width, 256)

            r1280 = self.client.get(f'/api/media/{key}?w=1024')
            self.assertEqual(r1280.status_code, 200)
            self.assertEqual(r1280['Content-Type'], 'image/webp')
            body1280 = b''.join(r1280.streaming_content) if r1280.streaming else r1280.content
            with Image.open(io.BytesIO(body1280)) as img:
                self.assertEqual(img.width, 1280)

            rfull = self.client.get(f'/api/media/{key}')
            self.assertEqual(rfull.status_code, 200)
            self.assertEqual(rfull['Content-Type'], 'image/png')
            full_bytes = b''.join(rfull.streaming_content) if rfull.streaming else rfull.content
            self.assertEqual(full_bytes, master)

    def test_board_upload_generates_thumbnails_while_preserving_master(self):
        board = CanvasBoard.objects.create(
            id=uuid4(), project_id=uuid4(), name='Upload Board',
            created_by=self.user.id, data={'version': 1, 'nodes': [], 'connectors': []},
            created_at=1, updated_at=1,
        )
        master = make_png((1600, 1000))
        upload_key = f'uploads/canvas/{self.user.id}-{uuid4()}'
        self.storage.primary.put(upload_key, master, 'image/png', 'private')
        session = UploadSession.objects.create(
            actor_id=self.user.id, key=upload_key, purpose='canvas',
            content_type='image/png', filename='shot.png', byte_size=len(master),
            expires_at=timezone.now() + timedelta(hours=1), finalized_at=timezone.now(), state='ready',
        )
        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            resp = self.client.post(
                f'/api/canvas-boards/{board.id}/upload',
                {'referenceId': str(session.id)},
                content_type='application/json',
            )
        self.assertEqual(resp.status_code, 200, resp.content)
        stored_key = resp.json()['url'][len('/api/media/'):]
        self.assertEqual(self.storage.read(stored_key), master)
        for width in THUMB_WIDTHS:
            self.assertTrue(self.storage.exists(derivative_key(stored_key, width)))

    def test_backfill_thumbnails_command_is_idempotent_and_preserves_masters(self):
        board_id = uuid4()
        project_id = uuid4()
        master_a = make_png((1500, 1000), (10, 20, 30))
        master_b = make_png((1500, 1000), (200, 150, 100))
        key_a = f'canvas/{board_id}/a.png'
        key_b = f'canvas/{board_id}/b.png'
        self.storage.primary.put(key_a, master_a, 'image/png', 'private')
        self.storage.primary.put(key_b, master_b, 'image/png', 'private')

        CanvasBoard.objects.create(
            id=board_id, project_id=project_id, name='Legacy Approval Board',
            created_by=self.user.id, created_at=1, updated_at=1,
            data={
                'version': 1,
                'nodes': [
                    {'id': 'n1', 'type': 'image', 'src': f'/api/media/{key_a}', 'x': 0, 'y': 0, 'w': 300, 'h': 200},
                    {'id': 'n2', 'type': 'image', 'src': f'/api/media/{key_b}', 'x': 350, 'y': 0, 'w': 300, 'h': 200},
                    {'id': 'n3', 'type': 'image', 'src': f'/api/media/{key_a}', 'x': 700, 'y': 0, 'w': 300, 'h': 200},
                ],
                'connectors': [],
            },
        )

        with override_settings(VEEVEE_MEDIA_STORAGE=self.storage):
            # Dry run reports missing keys without writing
            dry_out = io.StringIO()
            call_command('backfill_thumbnails', boards=[str(board_id)], dry_run=True, stdout=dry_out)
            dry = json.loads(dry_out.getvalue())
            self.assertEqual((dry['keys'], dry['missing_tier'], dry['generated']), (2, 2, 0))
            self.assertFalse(self.storage.exists(derivative_key(key_a, 256)))

            # Real run generates all 3 tiers for both unique keys
            run_out = io.StringIO()
            call_command('backfill_thumbnails', boards=[str(board_id)], workers=2, stdout=run_out)
            ran = json.loads(run_out.getvalue())
            self.assertEqual((ran['keys'], ran['generated'], ran['failed']), (2, 2, 0))
            for key in (key_a, key_b):
                for width in THUMB_WIDTHS:
                    self.assertTrue(self.storage.exists(derivative_key(key, width)))

            # Re-running is idempotent and skips everything
            second_out = io.StringIO()
            call_command('backfill_thumbnails', projects=[str(project_id)], workers=2, stdout=second_out)
            second = json.loads(second_out.getvalue())
            self.assertEqual((second['keys'], second['skipped'], second['generated']), (2, 2, 0))

        # Masters untouched
        self.assertEqual(self.storage.read(key_a), master_a)
        self.assertEqual(self.storage.read(key_b), master_b)


class GatewayMediaCacheTests(SimpleTestCase):
    def test_gateway_preserves_immutable_private_cache_only_for_200_media_gets(self):
        gateway_path = Path(__file__).resolve().parents[2] / 'deploy' / 'gateway.py'
        spec = importlib.util.spec_from_file_location('veevee_gateway_cache_test', gateway_path)
        gateway = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(gateway)
        secret = 'gateway-cache-test-secret-' + 'x' * 48

        class Upstream(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                if self.path.startswith('/api/media/cached.png'):
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/webp')
                    self.send_header('Cache-Control', 'private, max-age=31536000, immutable')
                    self.send_header('Content-Length', '4')
                    self.end_headers()
                    self.wfile.write(b'webp')
                elif self.path.startswith('/api/media/redirect.png'):
                    self.send_response(307)
                    self.send_header('Location', 'https://storage.invalid/signed')
                    self.send_header('Cache-Control', 'private, no-store')
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Cache-Control', 'private, max-age=31536000, immutable')
                    self.send_header('Content-Length', '2')
                    self.end_headers()
                    self.wfile.write(b'{}')

        upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
        server = ThreadingHTTPServer(('127.0.0.1', 0), gateway.handler(secret))
        for srv in (upstream, server):
            srv.daemon_threads = True
            t = threading.Thread(target=srv.serve_forever, daemon=True)
            t.start()
            self.addCleanup(srv.server_close)
            self.addCleanup(srv.shutdown)
        up_port = upstream.server_address[1]
        port = server.server_address[1]
        real_conn = http.client.HTTPConnection

        def connect(host, target, *args, **kwargs):
            return real_conn(host, up_port if target == 18080 else target, *args, **kwargs)

        with patch.object(http.client, 'HTTPConnection', connect):
            for path, expected_cc in (
                ('/api/media/cached.png?w=256', 'private, max-age=31536000, immutable'),
                ('/api/media/redirect.png', 'no-store'),
                ('/api/projects', 'no-store'),
            ):
                conn = real_conn('127.0.0.1', port, timeout=10)
                try:
                    conn.request('GET', path, headers={gateway.HEADER: secret})
                    resp = conn.getresponse()
                    resp.read()
                    self.assertEqual(resp.getheader('Cache-Control'), expected_cc, path)
                    self.assertEqual(resp.getheader('Vary'), 'Cookie', path)
                finally:
                    conn.close()
