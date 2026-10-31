import io
import tempfile
from datetime import timedelta
from uuid import uuid4
from unittest.mock import patch
from django.test import TestCase, SimpleTestCase
from django.utils import timezone
from apps.authentication.models import User
from apps.media.models import UploadSession
from apps.media.storage import StorageService, FileSystemAdapter
from .models import CanvasBoard, BoardMedia
from .media_files import safe_svg, process_media
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

    def test_viewer_cannot_import_or_upload(self):
        viewer = User.objects.create(id=uuid4(), email='viewer-media@example.test', name='Viewer', role='user', password_hash='x', password_salt='', created_at=1)
        self.board.team_role = 'view'; self.board.save(update_fields=['team_role'])
        with patch('apps.canvas.media_views.lookup', return_value=viewer), patch('apps.canvas.views.lookup', return_value=viewer):
            for suffix, data in [('upload', {'referenceId': str(uuid4())}), ('import-url', {'url': 'https://example.test'})]:
                self.assertEqual(self.client.post(f'/api/canvas-boards/{self.board.id}/{suffix}', data, content_type='application/json').status_code, 403)

    def test_embed_import_never_fetches_markup_or_untrusted_scripts(self):
        with patch('apps.canvas.media_views.fetcher') as fetch:
            response = self.client.post(f'/api/canvas-boards/{self.board.id}/import-url',
                {'url': '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ" onload="evil()"></iframe>'}, content_type='application/json')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['node']['src'], 'https://www.youtube.com/embed/dQw4w9WgXcQ')
        fetch.assert_not_called()

    def test_private_url_import_refused_without_connection(self):
        response = self.client.post(f'/api/canvas-boards/{self.board.id}/import-url', {'url': 'https://127.0.0.1/private'}, content_type='application/json')
        self.assertEqual(response.status_code, 400)
