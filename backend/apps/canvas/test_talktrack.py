"""Talktrack: registering a recording, trim and cut, viewers, reactions, transcript and the roles over each route."""
import shutil
import subprocess
import tempfile
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4
from django.test import override_settings
from django.utils import timezone
from apps.media.models import UploadSession
from apps.media.storage import FileSystemAdapter, MediaNotFoundError, StorageService
from . import services, talktrack
from .models import BoardMember, CanvasBoard, Talktrack, TalktrackMoment, TalktrackView
from .test_facilitation import BOARD, FacilitationBase

FFMPEG = shutil.which('ffmpeg')


def fake_ffmpeg(arguments, timeout=None):
    source = Path(arguments[arguments.index('-i') + 1])
    Path(arguments[-1]).write_bytes(b'out:' + source.read_bytes())


class TalktrackBase(FacilitationBase):
    def setUp(self):
        super().setUp()
        self.dee = __import__('apps.canvas.test_roles', fromlist=['make_user']).make_user('dee')
        BoardMember.objects.create(board_id=BOARD, user_id=self.ben.id, role='view', created_at=1, updated_at=1)
        BoardMember.objects.create(board_id=BOARD, user_id=self.cat.id, role='comment', created_at=1, updated_at=1)
        BoardMember.objects.create(board_id=BOARD, user_id=self.dee.id, role='edit', created_at=1, updated_at=1)
        CanvasBoard.objects.filter(pk=BOARD).update(team_role='view')
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.storage = StorageService(FileSystemAdapter(self.directory.name))
        patcher = patch('apps.media.storage.get_storage', return_value=self.storage)
        patcher.start()
        self.addCleanup(patcher.stop)

    def upload(self, user, data=b'webm-bytes', mime='video/webm'):
        key = f'uploads/talktrack/{user.id}-{uuid4()}'
        self.storage.primary.put(key, data, mime, 'private')
        session = UploadSession.objects.create(actor_id=user.id, key=key, purpose='talktrack', content_type=mime, byte_size=len(data),
                                               expires_at=timezone.now() + timedelta(hours=1), finalized_at=timezone.now(), state='ready')
        return str(session.id)

    def gone(self, key):
        with self.assertRaises(MediaNotFoundError):
            self.storage.read(key)

    def record(self, user=None, mime='video/webm', **extra):
        user = user or self.dee
        body = {'referenceId': self.upload(user, b'webm-bytes', mime), 'durationMs': 90000, 'title': 'Tour', **extra}
        return self.call(user, 'post', '/talktracks', body)['talktrack']


class RegisterTests(TalktrackBase):
    def test_register_copies_the_upload_into_the_boards_namespace_and_lists_it(self):
        made = self.record()
        self.assertTrue(made['url'].startswith(f'/api/media/talktrack/{BOARD}/'))
        self.assertEqual(self.storage.read(made['url'].removeprefix('/api/media/')), b'webm-bytes')
        self.assertEqual((made['title'], made['durationMs'], made['status'], made['hasAudio']), ('Tour', 90000, 'processing', False))
        listed = self.call(self.ben, 'get', '/talktracks')
        self.assertEqual([item['id'] for item in listed['talktracks']], [made['id']])
        self.assertEqual(listed['talktracks'][0]['viewerCount'], 0)
        self.assertNotIn('summary', made)

    def test_registering_spends_the_staged_uploads(self):
        video, audio = self.upload(self.dee), self.upload(self.dee, b'opus', 'audio/webm')
        staged = dict(UploadSession.objects.filter(pk__in=[video, audio]).values_list('id', 'key'))
        self.call(self.dee, 'post', '/talktracks', {'referenceId': video, 'audioReferenceId': audio, 'durationMs': 5000})
        for key in staged.values():
            self.gone(key)
        self.call(self.dee, 'post', '/talktracks', {'referenceId': video, 'durationMs': 5000}, 410)
        self.assertEqual(Talktrack.objects.count(), 1)

    def test_only_the_uploader_registers_an_upload(self):
        self.call(self.ana, 'post', '/talktracks', {'referenceId': self.upload(self.dee), 'durationMs': 1000}, 404)
        self.assertEqual(Talktrack.objects.count(), 0)

    def test_an_mp4_needs_no_remux_and_an_audio_track_is_kept_for_transcription(self):
        audio = self.upload(self.dee, b'opus', 'audio/webm')
        made = self.call(self.dee, 'post', '/talktracks', {'referenceId': self.upload(self.dee, b'mp4', 'video/mp4'),
                                                           'audioReferenceId': audio, 'durationMs': 5000})['talktrack']
        self.assertEqual((made['status'], made['hasAudio'], made['title']), ('ready', True, 'Talktrack'))

    def test_only_editors_record_and_bad_input_is_refused(self):
        for user, expect in ((self.ben, 403), (self.cat, 403)):
            self.call(user, 'post', '/talktracks', {'referenceId': self.upload(user), 'durationMs': 1000}, expect)
        self.call(self.dee, 'post', '/talktracks', {'durationMs': 1000}, 400)
        self.call(self.dee, 'post', '/talktracks', {'referenceId': self.upload(self.dee), 'durationMs': 0}, 400)
        self.call(self.dee, 'post', '/talktracks', {'referenceId': self.upload(self.dee, b'x', 'audio/webm'), 'durationMs': 1000}, 400)
        self.call(self.dee, 'post', '/talktracks', {'referenceId': str(uuid4()), 'durationMs': 1000}, 404)
        self.assertEqual(Talktrack.objects.count(), 0)

    def test_an_upload_of_another_purpose_is_refused(self):
        key = f'uploads/canvas/{self.dee.id}-{uuid4()}'
        self.storage.primary.put(key, b'png', 'image/png', 'private')
        other = UploadSession.objects.create(actor_id=self.dee.id, key=key, purpose='canvas', content_type='image/png', byte_size=3,
                                             expires_at=timezone.now() + timedelta(hours=1), finalized_at=timezone.now(), state='ready')
        self.call(self.dee, 'post', '/talktracks', {'referenceId': str(other.id), 'durationMs': 1000}, 403)


class EditTests(TalktrackBase):
    def test_rename_trim_and_delete_belong_to_the_recorder_or_a_manager(self):
        made = self.record()
        path = f'/talktracks/{made["id"]}'
        renamed = self.call(self.dee, 'patch', path, {'title': ' Walkthrough '})['talktrack']
        self.assertEqual(renamed['title'], 'Walkthrough')
        trimmed = self.call(self.dee, 'patch', path, {'trimStartMs': 5000, 'trimEndMs': 80000})['talktrack']
        self.assertEqual((trimmed['trimStartMs'], trimmed['trimEndMs'], trimmed['durationMs']), (5000, 80000, 90000))
        self.call(self.dee, 'patch', path, {'trimStartMs': 5000, 'trimEndMs': 5500}, 400)
        self.call(self.dee, 'patch', path, {'trimEndMs': 99999}, 400)
        for user in (self.ben, self.cat):
            self.call(user, 'patch', path, {'title': 'x'}, 403)
            self.call(user, 'delete', path, expect=403)
        other = self.call(self.ana, 'post', '/talktracks', {'referenceId': self.upload(self.ana), 'durationMs': 2000})['talktrack']
        # An editor cannot rename or delete someone else's recording; the board owner can.
        self.call(self.dee, 'patch', f'/talktracks/{other["id"]}', {'title': 'mine now'}, 403)
        self.call(self.ana, 'delete', f'/talktracks/{made["id"]}')
        self.assertFalse(Talktrack.objects.filter(pk=made['id']).exists())
        self.gone(made['url'].removeprefix('/api/media/'))
        self.call(self.ana, 'get', f'/talktracks/{made["id"]}', expect=404)

    def test_a_cut_is_queued_for_the_worker_and_validated(self):
        processing = self.record()
        self.call(self.dee, 'patch', f'/talktracks/{processing["id"]}', {'cut': {'startMs': 1000, 'endMs': 2000}}, 409)
        made = self.record(mime='video/mp4')
        path = f'/talktracks/{made["id"]}'
        queued = self.call(self.dee, 'patch', path, {'cut': {'startMs': 10000, 'endMs': 20000}})['talktrack']
        self.assertEqual(queued['status'], 'cutting')
        self.call(self.dee, 'patch', path, {'cut': {'startMs': 30000, 'endMs': 40000}}, 409)
        fresh = self.record(mime='video/mp4')
        for cut in ({'startMs': 20000, 'endMs': 10000}, {'startMs': 0, 'endMs': 90000}, {'startMs': 0, 'endMs': 89500}, 'no'):
            self.call(self.dee, 'patch', f'/talktracks/{fresh["id"]}', {'cut': cut}, 400)

    def test_cut_offsets_map_trim_marks_across_the_removed_span(self):
        self.assertEqual([talktrack._map_offset(value, 10, 20) for value in (5, 10, 15, 20, 30)], [5, 10, 10, 10, 20])

    def test_deleting_the_board_removes_its_recordings_and_their_files(self):
        made = self.record(audioReferenceId=self.upload(self.dee, b'opus', 'audio/webm'))
        self.call(self.ben, 'post', f'/talktracks/{made["id"]}/view', {'watchedMs': 1000})
        self.call(self.cat, 'post', f'/talktracks/{made["id"]}/moments', {'atMs': 1000, 'emoji': '👍'})
        row = Talktrack.objects.get(pk=made['id'])
        services.delete_board(BOARD)
        self.assertEqual((Talktrack.objects.count(), TalktrackView.objects.count(), TalktrackMoment.objects.count()), (0, 0, 0))
        self.gone(row.key)
        self.gone(row.audio_key)

    def test_cut_filter_keeps_both_sides_and_follows_the_container(self):
        arguments = talktrack.cut_arguments('in.mp4', 'out.mp4', 'video/mp4', 10000, 20000, 90000, True)
        graph = arguments[arguments.index('-filter_complex') + 1]
        self.assertIn('trim=start=0.0:end=10.0', graph)
        self.assertIn('trim=start=20.0:end=90.0', graph)
        self.assertIn('concat=n=2:v=1:a=1', graph)
        self.assertIn('libx264', arguments)
        silent = talktrack.cut_arguments('in.webm', 'out.webm', 'video/webm', 0, 20000, 90000, False)
        self.assertIn('concat=n=1:v=1:a=0', silent[silent.index('-filter_complex') + 1])
        self.assertIn('libvpx-vp9', silent)
        audio = talktrack.cut_arguments('in.m4a', 'out.m4a', 'audio/mp4', 10000, 20000, 90000, True)
        self.assertIn('concat=n=2:v=0:a=1[a]', audio[audio.index('-filter_complex') + 1])
        self.assertNotIn('[0:v]', audio[audio.index('-filter_complex') + 1])
        self.assertEqual((audio[audio.index('-map') + 1], audio[audio.index('-c:a') + 1]), ('[a]', 'aac'))
        self.assertNotIn('-c:v', audio)


@override_settings(FFMPEG_BINARY=FFMPEG or 'ffmpeg')
class WorkerTests(TalktrackBase):
    def make_clip(self, seconds=4):
        target = Path(self.directory.name) / 'clip.mp4'
        subprocess.run([FFMPEG, '-nostdin', '-y', '-f', 'lavfi', '-i', f'testsrc=duration={seconds}:size=160x120:rate=10',
                        '-f', 'lavfi', '-i', f'sine=duration={seconds}', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
                        '-shortest', str(target)], capture_output=True, check=True)
        return target.read_bytes()

    @staticmethod
    def seconds(data):
        with tempfile.NamedTemporaryFile(suffix='.mp4') as handle:
            handle.write(data)
            handle.flush()
            probe = subprocess.run([FFMPEG, '-nostdin', '-i', handle.name], capture_output=True).stderr.decode()
        stamp = probe.split('Duration: ')[1].split(',')[0]
        hours, minutes, secs = stamp.split(':')
        return int(hours) * 3600 + int(minutes) * 60 + float(secs)

    def test_the_worker_cuts_the_middle_and_replaces_the_file(self):
        if not FFMPEG:
            self.skipTest('ffmpeg is not installed')
        clip = self.make_clip(4)
        made = self.call(self.dee, 'post', '/talktracks', {'referenceId': self.upload(self.dee, clip, 'video/mp4'), 'durationMs': 4000})['talktrack']
        self.call(self.dee, 'patch', f'/talktracks/{made["id"]}', {'trimStartMs': 2500, 'cut': {'startMs': 1000, 'endMs': 2000}})
        self.assertEqual(talktrack.process_jobs(), {'done': 1, 'failed': 0})
        row = Talktrack.objects.get(pk=made['id'])
        self.assertEqual((row.status, row.duration_ms, row.trim_start_ms, row.cut_start_ms), ('ready', 3000, 1500, None))
        self.assertNotEqual(f'/api/media/{row.key}', made['url'])
        self.assertAlmostEqual(self.seconds(self.storage.read(row.key)), 3.0, delta=.4)
        self.assertEqual(talktrack.process_jobs(), {'done': 0, 'failed': 0})

    def make_audio(self, seconds=4):
        target = Path(self.directory.name) / 'voice.m4a'
        subprocess.run([FFMPEG, '-nostdin', '-y', '-f', 'lavfi', '-i', f'sine=duration={seconds}', '-c:a', 'aac', str(target)],
                       capture_output=True, check=True)
        return target.read_bytes()

    def test_a_cut_is_made_in_the_audio_twin_too(self):
        if not FFMPEG:
            self.skipTest('ffmpeg is not installed')
        made = self.call(self.dee, 'post', '/talktracks', {'referenceId': self.upload(self.dee, self.make_clip(4), 'video/mp4'),
                                                           'audioReferenceId': self.upload(self.dee, self.make_audio(4), 'audio/mp4'),
                                                           'durationMs': 4000})['talktrack']
        before = Talktrack.objects.get(pk=made['id'])
        self.call(self.dee, 'patch', f'/talktracks/{made["id"]}', {'cut': {'startMs': 1000, 'endMs': 2000}})
        self.assertEqual(talktrack.process_jobs(), {'done': 1, 'failed': 0})
        row = Talktrack.objects.get(pk=made['id'])
        self.assertTrue(row.audio_key.endswith('.m4a'))
        self.assertNotEqual(row.audio_key, before.audio_key)
        self.assertAlmostEqual(self.seconds(self.storage.read(row.audio_key)), 3.0, delta=.4)
        self.gone(before.key)
        self.gone(before.audio_key)

    def test_a_remux_keeps_the_audio_twin_and_replaces_the_original(self):
        made = self.record(audioReferenceId=self.upload(self.dee, b'opus', 'audio/webm'))
        before = Talktrack.objects.get(pk=made['id'])
        with patch('apps.canvas.talktrack._ffmpeg', side_effect=fake_ffmpeg):
            self.assertEqual(talktrack.process_jobs(), {'done': 1, 'failed': 0})
        row = Talktrack.objects.get(pk=made['id'])
        self.assertEqual((row.status, row.audio_key, self.storage.read(row.key)), ('ready', before.audio_key, b'out:webm-bytes'))
        self.gone(before.key)

    def run_job_with(self, during):
        """Run one job, calling `during` while it runs; returns the fields the job made."""
        made, real = {}, talktrack._process

        def process(row, now):
            made.update(real(row, now))
            during()
            return made
        with patch('apps.canvas.talktrack._ffmpeg', side_effect=fake_ffmpeg), \
                patch('apps.canvas.talktrack._has_audio', return_value=False), \
                patch('apps.canvas.talktrack._process', side_effect=process):
            talktrack.process_jobs()
        return made

    def test_a_trim_set_while_a_cut_runs_is_kept(self):
        made = self.record(mime='video/mp4')
        path = f'/talktracks/{made["id"]}'
        self.call(self.dee, 'patch', path, {'cut': {'startMs': 10000, 'endMs': 20000}})
        self.run_job_with(lambda: self.call(self.dee, 'patch', path, {'trimStartMs': 30000, 'trimEndMs': 80000}))
        row = Talktrack.objects.get(pk=made['id'])
        self.assertEqual((row.status, row.duration_ms, row.trim_start_ms, row.trim_end_ms), ('ready', 80000, 20000, 70000))

    def test_a_recording_deleted_while_its_job_runs_leaves_no_files(self):
        made = self.record(mime='video/mp4', audioReferenceId=self.upload(self.dee, b'opus', 'audio/webm'))
        path = f'/talktracks/{made["id"]}'
        self.call(self.dee, 'patch', path, {'cut': {'startMs': 10000, 'endMs': 20000}})
        fields = self.run_job_with(lambda: self.call(self.dee, 'delete', path))
        self.assertFalse(Talktrack.objects.filter(pk=made['id']).exists())
        self.gone(fields['key'])
        self.gone(fields['audio_key'])

    def test_a_cut_moves_reactions_comments_and_view_progress_with_the_timeline(self):
        made = self.record(mime='video/mp4')
        base = f'/talktracks/{made["id"]}'
        for at in (5000, 15000, 85000):
            self.call(self.cat, 'post', base + '/moments', {'atMs': at, 'text': f'at {at}'})
        for user, watched in ((self.ben, 85000), (self.cat, 15000), (self.dee, 5000)):
            self.call(user, 'post', base + '/view', {'watchedMs': watched})
        self.call(self.dee, 'patch', base, {'cut': {'startMs': 10000, 'endMs': 20000}})
        self.run_job_with(lambda: None)
        self.assertEqual(Talktrack.objects.get(pk=made['id']).duration_ms, 80000)
        moments = self.call(self.ben, 'get', base + '/moments')['moments']
        self.assertEqual([(item['atMs'], item['text']) for item in moments], [(5000, 'at 5000'), (10000, 'at 15000'), (75000, 'at 85000')])
        watched = dict(TalktrackView.objects.filter(talktrack_id=made['id']).values_list('user_id', 'watched_ms'))
        self.assertEqual(watched, {self.ben.id: 75000, self.cat.id: 10000, self.dee.id: 5000})

    def test_the_scheduler_runs_one_job_at_a_time_without_holding_up_its_other_handlers(self):
        import threading
        from apps.workers import scheduler
        entered, release = threading.Event(), threading.Event()

        def job():
            entered.set()
            release.wait(5)

        def join():
            for thread in threading.enumerate():
                if thread.name == 'talktrack-jobs':
                    thread.join(5)
        handlers = {'talktracks': scheduler.process_talktracks, 'depth': lambda: 'ran'}
        with patch('apps.canvas.talktrack.process_jobs', side_effect=job) as jobs:
            first = scheduler.tick(now=0, handlers=handlers)
            self.assertTrue(entered.wait(5))
            busy = scheduler.tick(now=60000, handlers=handlers)
            release.set()
            join()
            again = scheduler.tick(now=120000, handlers=handlers)
            join()
        self.assertEqual(first, {'depth': 'ran', 'talktracks': {'ok': True, 'started': True}})
        self.assertEqual(busy, {'depth': 'ran', 'talktracks': {'ok': True, 'started': False}})
        self.assertEqual(again['talktracks'], {'ok': True, 'started': True})
        self.assertEqual(jobs.call_count, 2)
        self.assertIs(scheduler.default_handlers()['talktracks'], scheduler.process_talktracks)
        self.assertGreater(talktrack.STALE_JOB_MS, 2 * talktrack.FFMPEG_TIMEOUT_S * 1000)

    def test_a_job_that_fails_keeps_the_original_and_can_be_retried(self):
        made = self.record(mime='video/mp4')
        self.call(self.dee, 'patch', f'/talktracks/{made["id"]}', {'cut': {'startMs': 1000, 'endMs': 2000}})
        with patch('apps.canvas.talktrack._ffmpeg', side_effect=subprocess.CalledProcessError(1, 'ffmpeg')):
            self.assertEqual(talktrack.process_jobs(), {'done': 0, 'failed': 1})
        row = Talktrack.objects.get(pk=made['id'])
        self.assertEqual((row.status, row.cut_start_ms), ('failed', None))
        self.assertEqual(self.storage.read(row.key), b'webm-bytes')
        self.call(self.dee, 'patch', f'/talktracks/{made["id"]}', {'cut': {'startMs': 1000, 'endMs': 2000}})

    def test_a_stale_working_job_is_queued_again(self):
        made = self.record(mime='video/mp4')
        Talktrack.objects.filter(pk=made['id']).update(status='working:cutting', cut_start_ms=1, cut_end_ms=2000, updated_at=1)
        with patch('apps.canvas.talktrack._process', side_effect=RuntimeError('stop')):
            talktrack.process_jobs()
        self.assertEqual(Talktrack.objects.get(pk=made['id']).status, 'failed')


class ViewerTests(TalktrackBase):
    def test_views_keep_the_furthest_point_and_totals_are_aggregates(self):
        made = self.record()
        base = f'/talktracks/{made["id"]}'
        self.call(self.ben, 'post', base + '/view', {'watchedMs': 30000})
        self.call(self.ben, 'post', base + '/view', {'watchedMs': 10000})
        reply = self.call(self.ben, 'post', base + '/view', {'watchedMs': 14400000}, 200)
        self.assertEqual(reply['watchedMs'], 90000)
        self.call(self.cat, 'post', base + '/view', {'watchedMs': 5000, 'completed': True})
        report = self.call(self.dee, 'get', base + '/viewers')
        self.assertEqual(report['totals'], {'viewers': 2, 'completed': 1, 'watchedMs': 95000})
        self.assertEqual({item['name'] for item in report['viewers']}, {self.ben.name, self.cat.name})
        self.call(self.ben, 'get', base + '/viewers', expect=403)
        self.assertEqual(self.call(self.ben, 'get', '/talktracks')['talktracks'][0]['myWatchedMs'], 90000)
        self.assertEqual(self.call(self.ben, 'get', '/talktracks')['talktracks'][0]['viewerCount'], 2)


class MomentTests(TalktrackBase):
    def test_reactions_and_comments_sit_on_the_timeline_and_need_comment_access(self):
        made = self.record()
        base = f'/talktracks/{made["id"]}/moments'
        self.call(self.ben, 'post', base, {'atMs': 1000, 'emoji': '👍'}, 403)
        mine = self.call(self.cat, 'post', base, {'atMs': 45000, 'emoji': '🎉'})['moment']
        self.call(self.dee, 'post', base, {'atMs': 2000, 'text': ' nice intro '})
        for bad in ({'atMs': 1000}, {'atMs': 1000, 'emoji': '👍', 'text': 'x'}, {'atMs': 1000, 'emoji': 'zz'}, {'atMs': 999999, 'emoji': '👍'}):
            self.call(self.cat, 'post', base, bad, 400)
        listed = self.call(self.ben, 'get', base)['moments']
        self.assertEqual([(item['atMs'], item['emoji'], item['text']) for item in listed], [(2000, '', 'nice intro'), (45000, '🎉', '')])
        self.call(self.ben, 'delete', f'{base}/{mine["id"]}', expect=403)
        self.call(self.ana, 'delete', f'{base}/{mine["id"]}')
        self.call(self.cat, 'delete', f'{base}/{listed[0]["id"]}', expect=403)
        self.assertEqual(len(self.call(self.ben, 'get', base)['moments']), 1)


class TranscriptTests(TalktrackBase):
    TEXT = '[00:00.000 - 00:04.000] Ana: Welcome to the tour.\n[00:04.500 - 01:10.000] Ana: Here is the roadmap.\ncontinued words\n[01:12.000 - 01:20.000] Here is the end.'

    def test_parse_and_chapters(self):
        segments = talktrack.parse_transcript(self.TEXT)
        self.assertEqual([(s['startMs'], s['endMs'], s['speaker']) for s in segments], [(0, 4000, 'Ana'), (4500, 70000, 'Ana'), (72000, 80000, '')])
        self.assertEqual(segments[1]['text'], 'Here is the roadmap. continued words')
        self.assertEqual(talktrack.chapters_from(segments), [{'startMs': 0, 'title': 'Welcome to the tour.'}, {'startMs': 72000, 'title': 'Here is the end.'}])

    def test_nothing_is_transcribed_without_a_request_an_audio_track_and_a_key(self):
        made = self.record()
        self.assertFalse(made['hasAudio'])
        self.assertIsNone(made['transcript'])
        with patch('apps.canvas.talktrack.transcription_available', return_value=True):
            self.call(self.dee, 'post', f'/talktracks/{made["id"]}/transcript', expect=409)
        with_audio = self.record(audioReferenceId=self.upload(self.dee, b'opus', 'audio/webm'))
        with patch('apps.canvas.talktrack.transcription_available', return_value=False):
            self.call(self.dee, 'post', f'/talktracks/{with_audio["id"]}/transcript', expect=503)
        self.call(self.cat, 'post', f'/talktracks/{with_audio["id"]}/transcript', expect=403)

    def test_a_requested_transcript_goes_through_the_audio_job_path_once(self):
        made = self.record(audioReferenceId=self.upload(self.dee, b'opus', 'audio/webm'))
        saved = SimpleNamespace(prompt=self.TEXT)
        with patch('apps.canvas.talktrack.transcription_available', return_value=True), \
                patch('apps.generation.services.audio_submission.persist_audio_intent', return_value='intent') as persist, \
                patch('apps.media.audio_wait.wait_for_audio', return_value=saved) as wait:
            first = self.call(self.dee, 'post', f'/talktracks/{made["id"]}/transcript')['talktrack']
            again = self.call(self.dee, 'post', f'/talktracks/{made["id"]}/transcript')['talktrack']
        self.assertEqual(persist.call_count, 1)
        self.assertEqual(wait.call_count, 1)
        self.assertEqual(persist.call_args.args[0]['user_id'], self.dee.id)
        self.assertEqual(len(first['transcript']), 3)
        self.assertEqual([chapter['startMs'] for chapter in first['chapters']], [0, 72000])
        self.assertEqual(again['transcript'], first['transcript'])


class DashboardTests(TalktrackBase):
    def test_your_recordings_lists_only_your_own_on_boards_you_can_open(self):
        mine = self.record()
        self.call(self.ana, 'post', '/talktracks', {'referenceId': self.upload(self.ana), 'durationMs': 3000})
        self.client.cookies['veevee_session'] = __import__('apps.authentication.session', fromlist=['sign_session']).sign_session(self.dee)
        listed = self.client.get('/api/my-talktracks').json()['talktracks']
        self.assertEqual([(item['id'], item['boardName']) for item in listed], [(mine['id'], 'Board')])
        BoardMember.objects.filter(user_id=self.dee.id).delete()
        self.assertEqual(self.client.get('/api/my-talktracks').json()['talktracks'][0]['id'], mine['id'])
