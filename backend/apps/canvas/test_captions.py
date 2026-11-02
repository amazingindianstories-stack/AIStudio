"""Board video captions: WebVTT conversion, the quote that comes before any spend, the generate route's roles,
guard and failure path, a run that outlives its request, a run that fails or expires, and same-origin VTT serving."""
import shutil
import tempfile
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from django.test import SimpleTestCase, TestCase
from apps.generation.models import Generation
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
        self.assertIn('00:00:04.500 --> 00:00:09.000\nHere is the --&gt; roadmap.', vtt)
        self.assertIn('00:00:10.000 --> 00:00:12.000\nShort.', vtt)

    def test_cue_text_cannot_become_markup(self):
        vtt = captions.vtt_from_segments([{'startMs': 0, 'endMs': 1000, 'speaker': 'A<b>', 'text': '<laughs> a < b & c'}])
        self.assertIn('\nA&lt;b&gt;: &lt;laughs&gt; a &lt; b &amp; c\n', vtt)

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
        for target, value in (('apps.media.storage.get_storage', self.storage),
                              ('apps.canvas.captions.transcription_available', True),
                              ('apps.canvas.captions._audio_reference', 'data:audio/mp4;base64,AAAA'),
                              ('apps.media.audio_inputs.capture_audio_input', {'source': '/api/media/references/x'})):
            patcher = patch(target, return_value=value)
            patcher.start()
            self.addCleanup(patcher.stop)
        from apps.generation.services import audio_submission
        persist = patch('apps.generation.services.audio_submission.persist_audio_intent', wraps=audio_submission.persist_audio_intent)
        self.persist = persist.start()
        self.addCleanup(persist.stop)

    def generate(self, user, expect=200, src=SRC):
        return self.call(user, 'post', '/captions', {'src': src}, expect)

    def quote(self, user=None):
        return self.call(user or self.dee, 'get', f'/captions?src={SRC}')['captions']

    def test_roles_only_editors_generate_everyone_can_quote_and_read(self):
        with patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt=TEXT)):
            for user in (self.ben, self.cat):
                self.generate(user, 403)
            self.assertEqual(self.persist.call_count, 0)
            self.generate(self.dee)
        for user in (self.ben, self.cat, self.dee):
            self.assertTrue(self.quote(user)['exists'])
            self.client.cookies['veevee_session'] = __import__('apps.authentication.session', fromlist=['x']).sign_session(user)
            response = self.client.get(f'/api/canvas-boards/{BOARD}/captions/vtt?src={SRC}')
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response['Content-Type'].startswith('text/vtt'))
            self.assertTrue(response.content.startswith(b'WEBVTT'))

    def test_quote_shows_the_cost_and_starts_nothing(self):
        quote = self.quote(self.ben)
        self.assertEqual((quote['exists'], quote['pending'], quote['failure'], quote['available'], quote['costCents'], quote['format']),
                         (False, False, '', True, 0, 'webvtt'))
        self.assertTrue(quote['model'].startswith('Gemini ('))
        self.persist.assert_not_called()
        self.assertEqual(BoardCaption.objects.count(), 0)

    def test_generating_runs_the_paid_guard_path_once(self):
        with patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt=TEXT)) as wait:
            self.assertEqual(self.generate(self.dee)['captions']['exists'], True)
            self.generate(self.dee)
        self.assertEqual((self.persist.call_count, wait.call_count), (1, 1))
        intent = self.persist.call_args.args[0]
        self.assertEqual((intent['user_id'], intent['cost_cents'], intent['kind']), (self.dee.id, 0, 'audio'))
        row = BoardCaption.objects.get(board_id=BOARD)
        self.assertEqual((row.media_key, row.generation_id), ('uploads/clip.mp4', intent['id']))

    def test_a_run_that_outlives_its_request_is_finished_later_and_never_submitted_again(self):
        with patch('apps.media.audio_wait.wait_for_audio', side_effect=AudioResultPending('x')):
            self.assertEqual(self.generate(self.dee, 202)['captions'], {'exists': False, 'pending': True, 'createdAt': self.clock})
            self.generate(self.dee, 202)
        self.assertEqual(self.persist.call_count, 1)
        job = Generation.objects.get(pk=BoardCaption.objects.get(board_id=BOARD).generation_id)
        self.assertEqual((self.quote()['pending'], self.quote()['exists']), (True, False))
        self.call(self.dee, 'get', f'/captions/vtt?src={SRC}', expect=404)
        Generation.objects.filter(pk=job.pk).update(status='succeeded', provider_status='COMPLETED', prompt=TEXT)
        self.assertEqual((self.quote(self.ben)['pending'], self.quote(self.ben)['exists']), (False, True))
        self.client.cookies['veevee_session'] = __import__('apps.authentication.session', fromlist=['x']).sign_session(self.ben)
        self.assertIn(b'Ana: Welcome.', self.client.get(f'/api/canvas-boards/{BOARD}/captions/vtt?src={SRC}').content)
        self.assertEqual(self.persist.call_count, 1)

    def test_a_second_editor_starting_at_the_same_time_submits_nothing(self):
        winner = uuid4()

        def race(*args, **kwargs):
            Generation.objects.create(id=winner, kind='audio', status='queued', prompt='', model='Gemini (m)', aspect_ratio='audio',
                                      reference_audios=[], user_id=self.ana.id, cost_cents=0, cost_basis='estimated',
                                      created_at=1, updated_at=1, provider_status='READY', submission_input={})
            BoardCaption.objects.create(board_id=BOARD, actor_id=self.ana.id, media_key='uploads/clip.mp4', generation_id=winner,
                                        created_at=self.clock)
            return {'source': '/api/media/references/x'}
        with patch('apps.media.audio_inputs.capture_audio_input', side_effect=race), \
                patch('apps.media.audio_wait.wait_for_audio', side_effect=AudioResultPending('x')):
            self.assertTrue(self.generate(self.dee, 202)['captions']['pending'])
        self.assertEqual(list(Generation.objects.values_list('id', flat=True)), [winner])
        self.assertEqual(list(BoardCaption.objects.values_list('generation_id', flat=True)), [winner])

    def test_a_definite_failure_is_reported_and_the_next_run_takes_over(self):
        with patch('apps.media.audio_wait.wait_for_audio', side_effect=failed()):
            self.generate(self.dee, 502)
        first = BoardCaption.objects.get(board_id=BOARD)
        self.assertEqual((self.quote()['pending'], self.quote()['failure']), (False, 'The provider could not transcribe this audio.'))
        with patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt='no timestamps here')):
            self.generate(self.dee, 422)
        row = BoardCaption.objects.get(board_id=BOARD)
        self.assertNotEqual(row.generation_id, first.generation_id)
        self.assertEqual((row.vtt, row.error, self.persist.call_count), ('', 'No speech could be captioned in this video.', 2))
        self.call(self.dee, 'get', f'/captions/vtt?src={SRC}', expect=404)
        with patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt=TEXT)):
            self.assertTrue(self.generate(self.dee)['captions']['exists'])
        self.assertEqual((self.quote()['exists'], self.quote()['failure'], self.persist.call_count), (True, '', 3))

    def pending_run(self):
        with patch('apps.media.audio_wait.wait_for_audio', side_effect=AudioResultPending('x')):
            self.generate(self.dee, 202)
        return Generation.objects.filter(pk=BoardCaption.objects.get(board_id=BOARD).generation_id)

    def test_a_queued_job_never_expires_and_a_failed_one_clears_the_run(self):
        job = self.pending_run()
        self.tick(60 * 60 * 1000)
        self.assertEqual((self.quote()['pending'], self.quote()['failure']), (True, ''))
        self.assertTrue(self.generate(self.dee, 202)['captions']['pending'])
        job.update(status='running', provider_status='SUBMITTED')
        self.tick(60 * 60 * 1000)
        self.assertEqual(self.quote()['pending'], True)
        self.assertEqual(self.persist.call_count, 1)
        job.update(status='failed', provider_status='REJECTED', error='Gemini transcription failed (400).')
        quote = self.quote()
        self.assertEqual(quote['pending'], False)
        self.assertTrue(quote['failure'])
        with patch('apps.media.audio_wait.wait_for_audio', return_value=SimpleNamespace(prompt=TEXT)):
            self.assertTrue(self.generate(self.dee)['captions']['exists'])
        self.assertEqual((BoardCaption.objects.get(board_id=BOARD).error, self.persist.call_count), ('', 2))

    def test_a_cancelled_job_clears_the_run(self):
        self.pending_run().update(status='cancelled')
        self.assertEqual((self.quote()['pending'], self.quote()['failure']), (False, 'The caption run was cancelled.'))

    def test_an_uncertain_submission_fails_only_past_its_grace(self):
        self.pending_run().update(provider_status='SUBMISSION_UNCERTAIN', updated_at=self.clock - captions.UNCERTAIN_GRACE_MS)
        self.assertEqual((self.quote()['pending'], self.quote()['failure']), (True, ''))
        self.tick(1)
        self.assertEqual((self.quote()['pending'], self.quote()['failure']), (False, 'The caption run could not be confirmed.'))
        self.assertEqual(self.persist.call_count, 1)

    def test_unconfigured_provider_and_foreign_media_are_refused(self):
        with patch('apps.canvas.captions.transcription_available', return_value=False):
            self.generate(self.dee, 503)
        self.generate(self.dee, 404, src='/api/media/uploads/other.mp4')
        self.generate(self.dee, 404, src='https://example.com/a.mp4')
        self.persist.assert_not_called()


class AudioReferenceTests(TestCase):
    def setUp(self):
        directory = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, directory, True)
        self.storage = StorageService(FileSystemAdapter(directory))

    def reference(self, key, data, mime):
        self.storage.primary.put(key, data, mime, 'private')
        return captions._audio_reference(self.storage, key, __import__('time').monotonic() + 60)

    def test_media_the_read_policy_hides_is_not_found(self):
        from datetime import timedelta
        from django.utils import timezone
        from apps.media.models import UploadSession
        UploadSession.objects.create(actor_id=uuid4(), key='uploads/staged.mp4', purpose='canvas', content_type='video/mp4',
                                     byte_size=3, expires_at=timezone.now() + timedelta(hours=1))
        self.storage.primary.put('uploads/staged.mp4', b'mp4', 'video/mp4', 'private')
        for key in ('uploads/staged.mp4', 'exports/a.zip', 'uploads/%2e%2e/clip.mp4'):
            with patch('subprocess.run') as run, self.assertRaises(captions.FacilitationError) as raised:
                captions._audio_reference(self.storage, key, __import__('time').monotonic() + 60)
            self.assertEqual(raised.exception.status, 404)
            run.assert_not_called()

    def test_only_video_is_extracted(self):
        for key, data, mime in (('uploads/a.mp3', b'ID3', 'audio/mpeg'), ('uploads/a.png', b'png', 'image/png')):
            with patch('subprocess.run') as run, self.assertRaises(captions.FacilitationError) as raised:
                self.reference(key, data, mime)
            self.assertEqual(raised.exception.status, 400)
            run.assert_not_called()

    def test_a_video_over_the_limit_is_refused_before_ffmpeg(self):
        from apps.media.errors import MediaTooLargeError
        with patch.object(captions, 'MAX_VIDEO_BYTES', 2), patch('subprocess.run') as run, self.assertRaises(MediaTooLargeError):
            self.reference('uploads/big.mp4', b'mp4', 'video/mp4')
        run.assert_not_called()
