"""Board video captions: WebVTT conversion, the quote that comes before any spend, the generate route's roles,
guard and failure path, and same-origin VTT serving."""
import shutil
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from django.test import SimpleTestCase
from apps.media.audio_wait import AudioFailed, AudioResultPending
from apps.media.storage import FileSystemAdapter, StorageService
from . import captions
from .models import BoardCaption, BoardMember, CanvasBoard
from .test_facilitation import BOARD, FacilitationBase, graph

SRC = '/api/media/uploads/clip.mp4'
TEXT = '[00:00.000 - 00:04.000] Ana: Welcome.\n[00:04.500 - 00:09.000] Here is the --> roadmap.\n[00:10.000 - 00:10.000] Short.'


def failed():
    error = AudioFailed.__new__(AudioFailed)
    RuntimeError.__init__(error, 'The provider could not transcribe this audio.')
    error.identifier, error.busy = 'x', False
    return error


class VttTests(SimpleTestCase):
    def test_transcript_becomes_webvtt(self):
        vtt = captions.vtt_from_transcript(TEXT)
        self.assertTrue(vtt.startswith('WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nAna: Welcome.\n'))
        self.assertIn('00:00:04.500 --> 00:00:09.000\nHere is the -> roadmap.', vtt)
        self.assertIn('00:00:10.000 --> 00:00:12.000\nShort.', vtt)

    def test_nothing_timed_gives_no_file(self):
        self.assertEqual(captions.vtt_from_transcript(''), '')
        self.assertEqual(captions.vtt_from_segments([{'startMs': 0, 'endMs': 0, 'speaker': '', 'text': 'loose'}]), '')


class CaptionRouteTests(FacilitationBase):
    def setUp(self):
        super().setUp()
        from apps.canvas.test_roles import make_user
        self.dee = make_user('dee')
        for user, role in ((self.ben, 'view'), (self.cat, 'comment'), (self.dee, 'edit')):
            BoardMember.objects.create(board_id=BOARD, user_id=user.id, role=role, created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view', data=graph({'id': 'v', 'type': 'video', 'x': 0, 'y': 0, 'w': 320, 'h': 180, 'src': SRC}))
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.storage = StorageService(FileSystemAdapter(directory))
        self.storage.primary.put('uploads/clip.mp4', b'mp4', 'video/mp4', 'private')
        for target in ('apps.media.storage.get_storage',):
            patcher = patch(target, return_value=self.storage)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.available = patch('apps.canvas.captions.transcription_available', return_value=True)
        self.available.start()
        self.addCleanup(self.available.stop)
        audio = patch('apps.canvas.captions._audio_reference', return_value='data:audio/mp4;base64,AAAA')
        audio.start()
        self.addCleanup(audio.stop)
        capture = patch('apps.media.audio_inputs.capture_audio_input', return_value={'source': '/api/media/references/x'})
        capture.start()
        self.addCleanup(capture.stop)

    def generate(self, user, expect=200, src=SRC):
        return self.call(user, 'post', '/captions', {'src': src}, expect)

    def test_roles_only_editors_generate_everyone_can_quote_and_read(self):
        with patch('apps.generation.services.audio_submission.persist_audio_intent', return_value='i') as persist, \
                patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt=TEXT)):
            for user in (self.ben, self.cat):
                self.generate(user, 403)
            self.assertEqual(persist.call_count, 0)
            self.generate(self.dee)
        for user in (self.ben, self.cat, self.dee):
            self.assertTrue(self.call(user, 'get', f'/captions?src={SRC}')['captions']['exists'])
            self.client.cookies['veevee_session'] = __import__('apps.authentication.session', fromlist=['x']).sign_session(user)
            response = self.client.get(f'/api/canvas-boards/{BOARD}/captions/vtt?src={SRC}')
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response['Content-Type'].startswith('text/vtt'))
            self.assertTrue(response.content.startswith(b'WEBVTT'))

    def test_quote_shows_the_cost_and_starts_nothing(self):
        with patch('apps.generation.services.audio_submission.persist_audio_intent') as persist:
            quote = self.call(self.ben, 'get', f'/captions?src={SRC}')['captions']
        self.assertEqual((quote['exists'], quote['available'], quote['costCents'], quote['format']), (False, True, 0, 'webvtt'))
        self.assertTrue(quote['model'].startswith('Gemini ('))
        persist.assert_not_called()
        self.assertEqual(BoardCaption.objects.count(), 0)

    def test_generating_runs_the_paid_guard_path_once(self):
        with patch('apps.generation.services.audio_submission.persist_audio_intent', return_value='i') as persist, \
                patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt=TEXT)) as wait:
            self.generate(self.dee)
            self.generate(self.dee)
        self.assertEqual((persist.call_count, wait.call_count), (1, 1))
        intent = persist.call_args.args[0]
        self.assertEqual((intent['user_id'], intent['cost_cents'], intent['kind']), (self.dee.id, 0, 'audio'))
        self.assertEqual(BoardCaption.objects.get(board_id=BOARD).media_key, 'uploads/clip.mp4')

    def test_failures_store_nothing(self):
        with patch('apps.generation.services.audio_submission.persist_audio_intent', return_value='i'):
            with patch('apps.media.audio_wait.wait_for_audio', side_effect=failed()):
                self.generate(self.dee, 502)
            with patch('apps.media.audio_wait.wait_for_audio', side_effect=AudioResultPending('x')):
                self.generate(self.dee, 504)
            with patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt='no timestamps here')):
                self.generate(self.dee, 422)
        self.assertEqual(BoardCaption.objects.count(), 0)
        self.call(self.dee, 'get', f'/captions/vtt?src={SRC}', expect=404)

    def test_unconfigured_provider_and_foreign_media_are_refused(self):
        with patch('apps.canvas.captions.transcription_available', return_value=False):
            self.generate(self.dee, 503)
        self.generate(self.dee, 404, src='/api/media/uploads/other.mp4')
        self.generate(self.dee, 404, src='https://example.com/a.mp4')
