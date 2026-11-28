import hashlib
import io
import json
import shutil
import tempfile
from unittest.mock import patch
from uuid import uuid4

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TestCase, override_settings
from PIL import Image

from apps.media import posters
from apps.media.storage import FileSystemAdapter, StorageService
from .models import Generation
from .services import poller, video_posters


def frame(source, protocols, *, timeout=0):
    out = io.BytesIO()
    Image.new('RGB', (160, 90), (30, 90, 160)).save(out, format='PNG')
    return out.getvalue()


class PosterFixture:
    def use_storage(self):
        directory = tempfile.mkdtemp(prefix='veevee-poster-backfill-')
        self.addCleanup(shutil.rmtree, directory, True)
        self.storage = StorageService(FileSystemAdapter(directory))
        for context in (override_settings(VEEVEE_MEDIA_STORAGE=self.storage), patch.object(posters, 'first_frame', frame)):
            context.__enter__()
            self.addCleanup(context.__exit__, None, None, None)

    def master(self, name, data=b'native mov bytes'):
        self.storage.primary.put(f'generations/{name}.mov', data, 'video/quicktime', 'private')
        return f'/api/media/generations/{name}.mov'

    def video(self, created_at, url, **values):
        return Generation.objects.create(**{'kind': 'video', 'status': 'succeeded', 'model': 'Seedance 2.5', 'prompt': 'fixture',
            'aspect_ratio': '16:9', 'url': url, 'created_at': created_at, 'updated_at': created_at, **values})

    def run_command(self, **options):
        out = io.StringIO()
        call_command('backfill_video_posters', stdout=out, **options)
        return json.loads(out.getvalue())


class PosterOnSuccessTests(PosterFixture, TestCase):
    def setUp(self):
        self.use_storage()

    def advance(self, item, save, **extra):
        deps = poller.Dependencies(now=lambda: 10000, mock=lambda: False, publish=lambda row: None,
            get_video=lambda *args, **kwargs: {'status': 'succeeded', 'videoUrl': 'https://fixture.invalid/master.mov'}, save_url=save, **extra)
        return poller.advance(item, dependencies=deps)

    def running(self, **values):
        return Generation.objects.create(**{'kind': 'video', 'status': 'running', 'model': 'Seedance 2.5', 'prompt': 'fixture',
            'aspect_ratio': '16:9', 'task_id': 'task-1', 'created_at': 100, 'updated_at': 200, **values})

    def test_poster_is_stored_with_the_master_and_the_master_is_untouched(self):
        item, url = self.running(), self.master('done')
        outcome = self.advance(item, lambda *args: {'url': url})
        self.assertEqual((outcome['kind'], outcome['item'].poster), ('succeeded', '/api/media/thumbs/poster/generations/done.mov.webp'))
        with Image.open(io.BytesIO(self.storage.read('thumbs/poster/generations/done.mov.webp'))) as image:
            self.assertEqual(image.format, 'WEBP')
        self.assertEqual(self.storage.read('generations/done.mov'), b'native mov bytes')

    def test_omni_video_gets_a_poster_too(self):
        item, url = self.running(model='Gemini Omni Flash 1.2'), self.master('omni')
        import base64
        deps = poller.Dependencies(now=lambda: 10000, mock=lambda: False, publish=lambda row: None,
            get_omni=lambda *args, **kwargs: {'status': 'succeeded', 'videoBase64': base64.b64encode(b'x').decode(), 'mimeType': 'video/mp4'},
            save_base64=lambda *args: {'url': url})
        self.assertEqual(poller.advance(item, dependencies=deps)['item'].poster, '/api/media/thumbs/poster/generations/omni.mov.webp')

    def test_poster_failure_never_holds_the_result_and_images_get_none(self):
        item = self.running()
        self.assertEqual(self.advance(item, lambda *args: {'url': '/api/media/generations/absent.mov'})['item'].poster, None)
        image = self.running(kind='image', task_id='task-2')
        deps = poller.Dependencies(now=lambda: 10000, mock=lambda: False, publish=lambda row: None,
            make_poster=lambda url: self.fail('images never get a video poster'))
        self.assertEqual(poller._terminal(image, {'status': 'succeeded', 'url': '/api/media/generations/a.png'}, deps,
                                          poller.Cancellation(30000), None, {})['kind'], 'succeeded')


class BackfillTests(PosterFixture, TestCase):
    def setUp(self):
        self.use_storage()

    def test_backfill_is_idempotent_skips_done_rows_and_keeps_masters(self):
        ids = [uuid4() for _ in range(3)]
        a, b = self.video(1, self.master('a'), id=ids[0]), self.video(2, self.master('b'), id=ids[1])
        done = self.video(3, self.master('c'), id=ids[2], poster='/api/media/thumbs/poster/generations/c.mov.webp')
        image = self.video(4, '/api/media/generations/x.png', kind='image')
        queued = self.video(5, self.master('q'), status='queued')
        before = {name: hashlib.sha256(self.storage.read(f'generations/{name}.mov')).hexdigest() for name in 'abc'}
        dry = self.run_command(dry_run=True)
        self.assertEqual((dry['dryRun'], dry['pending']), (True, 2))
        self.assertFalse(self.storage.exists('thumbs/poster/generations/a.mov.webp'))
        first = self.run_command()
        self.assertEqual((first['examined'], first['poster'], first['failed'], first['missing'], first['next']), (2, 2, 0, 0, None))
        for row in (a, b):
            row.refresh_from_db()
            self.assertEqual(row.poster, f'/api/media/thumbs/poster/generations/{row.url.rsplit("/", 1)[-1]}.webp')
        for row in (done, image, queued):
            row.refresh_from_db()
        self.assertEqual((done.poster, image.poster, queued.poster), ('/api/media/thumbs/poster/generations/c.mov.webp', None, None))
        self.assertFalse(self.storage.exists('thumbs/poster/generations/c.mov.webp'))
        self.assertEqual({name: hashlib.sha256(self.storage.read(f'generations/{name}.mov')).hexdigest() for name in 'abc'}, before)
        second = self.run_command()
        self.assertEqual((second['examined'], second['poster']), (0, 0))

    def test_limit_resumes_from_the_cursor_and_failures_are_logged_and_skipped(self):
        rows = [self.video(index, self.master(f'r{index}')) for index in range(1, 5)]
        missing = self.video(2, '/api/media/generations/gone.mov')
        self.video(6, self.master('bad'))
        def flaky(source, protocols, *, timeout=0):
            if 'bad' in str(source):
                raise RuntimeError('ffmpeg failed')
            return frame(source, protocols)
        with patch.object(posters, 'first_frame', flaky):
            first = self.run_command(limit=3, batch_size=2)
            self.assertEqual((first['examined'], first['poster'], first['missing']), (3, 2, 1))
            self.assertIsNotNone(first['next'])
            second = self.run_command(after=first['next'], limit=10, workers=2)
        self.assertEqual((second['examined'], second['poster'], second['failed'], second['next']), (3, 2, 1, None))
        missing.refresh_from_db()
        self.assertIsNone(missing.poster)
        self.assertEqual(Generation.objects.filter(kind='video', poster__isnull=True).count(), 2)
        with self.assertRaises(CommandError):
            self.run_command(after='nonsense')

    def test_rows_that_already_have_a_poster_object_are_only_linked(self):
        row = self.video(1, self.master('exists'))
        self.storage.primary.put('thumbs/poster/generations/exists.mov.webp', b'existing', 'image/webp', 'private')
        with patch.object(posters, 'first_frame', side_effect=AssertionError('must not re-encode')):
            self.assertEqual(self.run_command()['poster'], 1)
        row.refresh_from_db()
        self.assertEqual(row.poster, '/api/media/thumbs/poster/generations/exists.mov.webp')
        self.assertEqual(self.storage.read('thumbs/poster/generations/exists.mov.webp'), b'existing')
