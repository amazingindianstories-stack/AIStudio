import io
import tempfile
import threading
from contextlib import contextmanager
from datetime import timedelta
from pathlib import Path
from uuid import uuid4
from unittest.mock import Mock, patch
from django.test import TestCase, SimpleTestCase
from django.utils import timezone
from apps.authentication.models import User
from apps.media.models import UploadSession
from apps.media.storage import StorageService, FileSystemAdapter
from .models import CanvasBoard, BoardMedia
from .media_files import safe_svg, process_media, queued_media
from .media_views import PreviewParser


class MediaHelperTests(SimpleTestCase):
    def test_svg_does_not_resolve_external_content(self):
        for content in [
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://127.0.0.1/x"/></svg>',
            '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg/>',
            '<svg><rect style="fill:url(https://example.test/x)"/></svg>',
            '<svg onload="alert(1)"/>', '<svg><script>alert(1)</script></svg>',
        ]:
            with self.subTest(content=content), self.assertRaises(ValueError):
                safe_svg(content.encode())
        self.assertIn(b'rect', safe_svg(b'<svg width="20" height="10"><rect width="20" height="10" fill="red"/></svg>'))

    def test_preview_parser_reads_metadata_as_plain_text(self):
        parser = PreviewParser()
        parser.feed('<title>Board &amp; notes</title><meta property="og:title" content="A title"><link rel="icon" href="/favicon.png">')
        self.assertEqual(parser.title, 'Board & notes')
        self.assertEqual(parser.meta['og:title'], 'A title')
        self.assertEqual(parser.icon, '/favicon.png')


class BoardMediaTests(TestCase):
    def setUp(self):
        self.actor = User.objects.create(id=uuid4(), email='media@example.test', name='Media', role='user', password_hash='x', password_salt='', created_at=1)
        self.board = CanvasBoard.objects.create(id=uuid4(), project_id=uuid4(), name='Board', created_by=self.actor.id, data={}, created_at=1, updated_at=1)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = StorageService(FileSystemAdapter(self.directory.name))
        patcher = patch('apps.media.storage.get_storage', return_value=self.storage)
        patcher.start(); self.addCleanup(patcher.stop)
        patcher = patch('apps.canvas.media_files.get_storage', return_value=self.storage)
        patcher.start(); self.addCleanup(patcher.stop)
        for name in ('apps.canvas.views.lookup', 'apps.canvas.media_views.lookup', 'apps.media.views.lookup'):
            patcher = patch(name, return_value=self.actor)
            patcher.start(); self.addCleanup(patcher.stop)

    def upload(self, data, mime, filename='file'):
        key = f'uploads/canvas/{self.actor.id}-{uuid4()}'
        self.storage.primary.put(key, data, mime, 'private')
        session = UploadSession.objects.create(actor_id=self.actor.id, key=key, purpose='canvas', content_type=mime,
            filename=filename, byte_size=len(data), expires_at=timezone.now()+timedelta(hours=1), finalized_at=timezone.now(), state='ready')
        result = self.client.post(f'/api/canvas-boards/{self.board.id}/upload', {'referenceId': str(session.id)}, content_type='application/json')
        return result, session

    def test_video_master_unchanged_and_library_reusable(self):
        master = b'fixture-native-MOV-master'
        response, session = self.upload(master, 'video/quicktime', 'Master.mov')
        self.assertEqual(response.status_code, 200)
        media = response.json()
        self.assertTrue(media['url'].endswith('.mov'))
        self.assertEqual(self.storage.read(media['url'][11:]), master)
        again = self.client.post(f'/api/canvas-boards/{self.board.id}/upload', {'referenceId': str(session.id)}, content_type='application/json')
        self.assertEqual(again.json()['id'], media['id'])
        library = self.client.get(f'/api/canvas-boards/{self.board.id}/media').json()
        self.assertEqual(library['files'][0]['id'], media['id'])

    def test_svg_only_publishes_raster_and_original_is_hidden(self):
        response, session = self.upload(b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><rect width="20" height="10" fill="red"/></svg>', 'image/svg+xml')
        self.assertEqual(response.status_code, 202)
        self.assertEqual(process_media(response.json()['id']), 'media_ready')
        row = BoardMedia.objects.get(pk=response.json()['id'])
        self.assertTrue(self.storage.read(row.key).startswith(b'\x89PNG'))
        self.assertEqual((row.width, row.height), (20, 10))
        self.assertEqual(self.client.get('/api/media/' + session.key).status_code, 404)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{self.board.id}/media/{row.id}').json()['state'], 'ready')

    def test_pdf_pages_and_original(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new('RGB', (40, 60), 'red').save(output, format='PDF', save_all=True,
            append_images=[Image.new('RGB', (40, 60), 'blue')])
        response, _ = self.upload(output.getvalue(), 'application/pdf')
        self.assertEqual(process_media(response.json()['id']), 'media_ready')
        row = BoardMedia.objects.get(pk=response.json()['id'])
        self.assertEqual(row.pages, 2)
        self.assertEqual(self.storage.read(row.key), output.getvalue())
        for page in (1, 2):
            self.assertTrue(self.storage.read(f'{row.key}.pages/{page}.png').startswith(b'\x89PNG'))

    def test_job_that_kills_worker_fails_after_three_claims(self):
        response, _ = self.upload(b'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"/>', 'image/svg+xml')
        identifier = response.json()['id']
        for attempt in (1, 2, 3):
            self.assertEqual(queued_media().id, BoardMedia.objects.get(pk=identifier).id)
            with patch('apps.canvas.media_files.get_storage', side_effect=SystemExit), self.assertRaises(SystemExit):
                process_media(identifier)
            row = BoardMedia.objects.get(pk=identifier)
            self.assertEqual((row.state, row.attempts), ('running', attempt))
            BoardMedia.objects.filter(pk=identifier).update(lease_until=0)
        self.assertEqual(process_media(identifier), 'media_failed')
        row = BoardMedia.objects.get(pk=identifier)
        self.assertEqual((row.state, row.attempts), ('failed', 3))
        self.assertIn('after 3 attempts', row.error)
        self.assertIsNone(queued_media())
        self.assertEqual(self.client.get(f'/api/canvas-boards/{self.board.id}/media/{row.id}').json()['error'], row.error)

    def test_flattened_psd_publishes_png(self):
        psd = b'8BPS' + bytes([0, 1, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 1, 0, 0, 0, 1, 0, 8, 0, 3]) + bytes(12) + bytes([0, 0, 0xcc, 0x33, 0x33])
        response, _ = self.upload(psd, 'image/vnd.adobe.photoshop', 'layers.psd')
        self.assertEqual(response.status_code, 202)
        self.assertEqual(process_media(response.json()['id']), 'media_ready')
        row = BoardMedia.objects.get(pk=response.json()['id'])
        self.assertTrue(self.storage.read(row.key).startswith(b'\x89PNG'))
        self.assertEqual((row.width, row.height), (1, 1))

    def test_worker_stop_requeues_conversion_without_spending_an_attempt(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new('RGB', (40, 60), 'red').save(output, format='PDF')
        response, _ = self.upload(output.getvalue(), 'application/pdf')
        identifier = response.json()['id']
        stopped = threading.Event()
        stopped.set()
        self.assertEqual(process_media(identifier, stopped), 'stopped')
        self.assertEqual(BoardMedia.objects.get(pk=identifier).attempts, 0)
        mid_conversion = Mock()
        mid_conversion.is_set.side_effect = [False, True]
        self.assertEqual(process_media(identifier, mid_conversion), 'stopped')
        row = BoardMedia.objects.get(pk=identifier)
        self.assertEqual((row.state, row.attempts, row.error, row.lease_token), ('queued', 0, '', None))
        self.assertTrue(self.storage.exists(row.source_key))
        self.assertEqual(queued_media().id, row.id)
        self.assertEqual(process_media(identifier), 'media_ready')

    def import_url(self, data, mime, url='https://files.example.test/clip.png'):
        @contextmanager
        def open_file(*args, **kwargs):
            yield io.BytesIO(data), mime
        with patch('apps.canvas.media_views.fetcher') as fetch, patch('apps.canvas.media_views.get_storage', return_value=self.storage):
            fetch.return_value.open_file = open_file
            return self.client.post(f'/api/canvas-boards/{self.board.id}/import-url', {'url': url}, content_type='application/json')

    def test_url_import_refuses_bytes_that_do_not_match_their_declared_type(self):
        response = self.import_url(b'<!doctype html><title>Not found</title>', 'image/png')
        self.assertEqual(response.status_code, 400)
        self.assertFalse(BoardMedia.objects.exists())
        self.assertEqual(list(Path(self.directory.name).rglob('*canvas-imports*')), [])

    def test_url_import_keeps_one_stored_copy(self):
        png = b'\x89PNG\r\n\x1a\n' + b'fixture'
        response = self.import_url(png, 'image/png')
        self.assertEqual(response.status_code, 200)
        row = BoardMedia.objects.get(pk=response.json()['id'])
        self.assertEqual((row.state, self.storage.read(row.key)), ('ready', png))
        self.assertTrue(row.source_key.startswith('canvas-imports/'))
        self.assertFalse(self.storage.exists(row.source_key))

    def test_imported_pdf_original_is_removed_once_published(self):
        from PIL import Image
        output = io.BytesIO()
        Image.new('RGB', (40, 60), 'red').save(output, format='PDF')
        response = self.import_url(output.getvalue(), 'application/pdf', 'https://files.example.test/deck.pdf')
        self.assertEqual(response.status_code, 202)
        row = BoardMedia.objects.get(pk=response.json()['id'])
        self.assertTrue(self.storage.exists(row.source_key))
        self.assertEqual(process_media(row.id), 'media_ready')
        self.assertFalse(self.storage.exists(row.source_key))
        row.refresh_from_db()
        self.assertEqual((row.state, row.lease_token, self.storage.read(row.key)), ('ready', None, output.getvalue()))
        self.assertTrue(self.storage.read(f'{row.key}.pages/1.png').startswith(b'\x89PNG'))

    def test_imported_original_is_removed_when_conversion_fails_for_good(self):
        svg = b'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.test/x.png"/></svg>'
        response = self.import_url(svg, 'image/svg+xml', 'https://files.example.test/logo.svg')
        self.assertEqual(response.status_code, 202)
        row = BoardMedia.objects.get(pk=response.json()['id'])
        self.assertEqual(process_media(row.id), 'media_failed')
        self.assertEqual(BoardMedia.objects.get(pk=row.id).state, 'failed')
        self.assertFalse(self.storage.exists(row.source_key))
        response = self.import_url(svg, 'image/svg+xml', 'https://files.example.test/logo.svg')
        row = BoardMedia.objects.get(pk=response.json()['id'])
        BoardMedia.objects.filter(pk=row.id).update(attempts=3)
        with self.captureOnCommitCallbacks(execute=True):
            self.assertEqual(process_media(row.id), 'media_failed')
        self.assertIn('after 3 attempts', BoardMedia.objects.get(pk=row.id).error)
        self.assertFalse(self.storage.exists(row.source_key))

    def test_url_import_removes_staged_original_when_registration_fails(self):
        with patch('apps.canvas.media_views.register', side_effect=OSError):
            response = self.import_url(b'%PDF-1.4 fixture', 'application/pdf', 'https://files.example.test/deck.pdf')
        self.assertEqual(response.status_code, 400)
        self.assertEqual([path for path in Path(self.directory.name).rglob('*') if path.is_file()], [])

    def test_malformed_file_ids_are_bad_requests(self):
        self.assertEqual(self.client.get(f'/api/canvas-boards/{self.board.id}/media/not-a-uuid').status_code, 400)
        self.assertEqual(self.client.get(f'/api/canvas-boards/{self.board.id}/media?before=not-a-uuid').status_code, 400)

    def test_viewer_cannot_import_or_upload(self):
        viewer = User.objects.create(id=uuid4(), email='viewer-media@example.test', name='Viewer', role='user', password_hash='x', password_salt='', created_at=1)
        self.board.team_role = 'view'; self.board.save(update_fields=['team_role'])
        with patch('apps.canvas.media_views.lookup', return_value=viewer), patch('apps.canvas.views.lookup', return_value=viewer):
            for suffix, data in [('upload', {'referenceId': str(uuid4())}), ('import-url', {'url': 'https://example.test'})]:
                self.assertEqual(self.client.post(f'/api/canvas-boards/{self.board.id}/{suffix}', data, content_type='application/json').status_code, 403)

    def test_url_import_refuses_iframe_code_without_fetching(self):
        with patch('apps.canvas.media_views.fetcher') as fetch:
            response = self.client.post(f'/api/canvas-boards/{self.board.id}/import-url',
                {'url': '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" onload="evil()"></iframe>'}, content_type='application/json')
        self.assertEqual(response.status_code, 400)
        fetch.assert_not_called()

    def test_library_pages_hold_only_readable_files(self):
        other = CanvasBoard.objects.create(id=uuid4(), project_id=uuid4(), name='Private', created_by=uuid4(), data={}, created_at=1, updated_at=1)
        mine = BoardMedia.objects.create(board=self.board, actor_id=self.actor.id, name='Mine', content_type='image/png',
            source_key='s', key='canvas/mine.png', state='ready', created_at=1)
        BoardMedia.objects.bulk_create([BoardMedia(board=other, actor_id=other.created_by, name=f'Private {n}', content_type='image/png',
            source_key='s', key=f'canvas/{n}.png', state='ready', created_at=2 + n) for n in range(100)])
        url = f'/api/canvas-boards/{self.board.id}/media'
        self.assertEqual(len(self.client.get(url).json()['files']), 100)
        with patch.dict('apps.canvas.access.BOARD_LEVELS', {'view': 0, 'comment': 0, 'edit': 0}):
            library = self.client.get(url).json()
        self.assertEqual(([row['id'] for row in library['files']], library['next']), ([str(mine.id)], None))

    def test_private_url_import_refused_without_connection(self):
        response = self.client.post(f'/api/canvas-boards/{self.board.id}/import-url', {'url': 'https://127.0.0.1/private'}, content_type='application/json')
        self.assertEqual(response.status_code, 400)
