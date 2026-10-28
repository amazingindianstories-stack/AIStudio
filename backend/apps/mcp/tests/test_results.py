"""Milestone 2: the shared Generation/Output/GenerationResult shapes, links and their expiry, the video poster
derivative, the hold helper and get_generation over both protocol eras."""
import asyncio
import base64
import calendar
import hashlib
import io
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from django.db import connection
from django.test import SimpleTestCase, override_settings
from PIL import Image

from apps.generation.models import Generation
from apps.library.models import Folder
from apps.mcp import hold, results
from apps.mcp.registry import ToolCall
from apps.mcp.tools.generations import detail
from apps.mcp_auth import policy
from apps.mcp_auth.principal import authenticate_bearer
from apps.media.grants import verify_media_grant
from apps.media.keys import is_export_key, is_protected_key
from apps.media.posters import bounded_poster, poster_key
from apps.media.storage import FileSystemAdapter, StorageService
from apps.projects.models import Project
from .support import ERAS, SITE, McpCase

FORBIDDEN_FIELDS = ('workerLeaseId', 'depthClaimId', 'providerResponses', 'submissionInput', 'nextPollAt', 'taskId',
                    'pollAttempts', 'lastPollAt')


def png_bytes(width=600, height=400):
    out = io.BytesIO()
    Image.new('RGB', (width, height), (200, 40, 40)).save(out, format='PNG')
    return out.getvalue()


def mov_bytes():
    """A one-second 160x90 QuickTime clip made locally by ffmpeg."""
    with tempfile.TemporaryDirectory() as directory:
        target = Path(directory) / 'clip.mov'
        subprocess.run(['ffmpeg', '-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10',
                        '-t', '1', '-pix_fmt', 'yuv420p', '-y', str(target)], check=True, capture_output=True, timeout=30)
        return target.read_bytes()


def granted_key(url):
    """The object key a signed media grant URL reads."""
    parts = urlsplit(url)
    return verify_media_grant(parse_qs(parts.query)['t'][0])


class StorageMixin:
    def use_storage(self):
        directory = tempfile.mkdtemp(prefix='veevee-mcp-media-')
        self.addCleanup(shutil.rmtree, directory, True)
        self.storage = StorageService(FileSystemAdapter(directory))
        override = override_settings(VEEVEE_MEDIA_STORAGE=self.storage)
        override.enable()
        self.addCleanup(override.disable)

    def store(self, key, data, mime):
        self.storage.primary.put(key, data, mime, 'private, max-age=0')
        return '/api/media/' + key


class PosterTests(StorageMixin, SimpleTestCase):
    def setUp(self):
        self.use_storage()

    def test_poster_is_first_frame_webp_created_once_and_master_untouched(self):
        master = mov_bytes()
        self.store('generations/clip.mov', master, 'video/quicktime')
        target, fresh = bounded_poster(self.storage, 'generations/clip.mov')
        self.assertEqual(target, 'thumbs/poster/generations/clip.mov.webp')
        with Image.open(io.BytesIO(fresh)) as image:
            self.assertEqual((image.format, image.size), ('WEBP', (160, 90)))
        self.assertEqual(self.storage.read(target), fresh)
        self.assertEqual(bounded_poster(self.storage, 'generations/clip.mov'), (target, None))
        self.assertEqual(hashlib.sha256(self.storage.read('generations/clip.mov')).hexdigest(), hashlib.sha256(master).hexdigest())

    def test_failures_return_none_and_write_nothing(self):
        self.store('generations/broken.mov', b'not a video', 'video/quicktime')
        self.store('generations/still.png', png_bytes(), 'image/png')
        self.assertIsNone(bounded_poster(self.storage, 'generations/broken.mov'))
        self.assertFalse(self.storage.exists(poster_key('generations/broken.mov')))
        self.assertIsNone(bounded_poster(self.storage, 'generations/still.png'))
        self.assertIsNone(bounded_poster(self.storage, 'generations/missing.mov'))
        self.assertIsNone(bounded_poster(self.storage, 'exports/archive.mov'))

    def test_busy_gate_and_deadline_return_none(self):
        self.store('generations/clip.mov', mov_bytes(), 'video/quicktime')
        busy = threading.BoundedSemaphore(1)
        busy.acquire()
        self.assertIsNone(bounded_poster(self.storage, 'generations/clip.mov', gate=busy))

        def slow(source, protocols, timeout):
            raise subprocess.TimeoutExpired('ffmpeg', 15)
        self.assertIsNone(bounded_poster(self.storage, 'generations/clip.mov', frame=slow))
        self.assertFalse(self.storage.exists(poster_key('generations/clip.mov')))

    def test_with_no_time_left_an_existing_poster_is_used_and_none_is_made(self):
        self.store('generations/clip.mov', mov_bytes(), 'video/quicktime')
        ran = []

        def frame(source, protocols, timeout):
            ran.append(timeout)
            raise subprocess.TimeoutExpired('ffmpeg', timeout)
        self.assertIsNone(bounded_poster(self.storage, 'generations/clip.mov', frame=frame, seconds=0))
        self.assertEqual((ran, self.storage.exists(poster_key('generations/clip.mov'))), ([], False))
        target, _ = bounded_poster(self.storage, 'generations/clip.mov')
        self.assertEqual(bounded_poster(self.storage, 'generations/clip.mov', frame=frame, seconds=0), (target, None))
        self.store('generations/other.mov', mov_bytes(), 'video/quicktime')
        self.assertIsNone(bounded_poster(self.storage, 'generations/other.mov', frame=frame, seconds=7))
        self.assertEqual(ran, [7])                                             # ffmpeg gets the time that is left

    def test_poster_keys_unwrap_like_thumbnails(self):
        self.assertTrue(is_export_key('thumbs/poster/exports/a.mov.webp'))
        self.assertTrue(is_protected_key('thumbs/poster/settings/a.mov.webp'))
        self.assertFalse(is_export_key('thumbs/poster/generations/a.mov.webp'))


class ResultTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token()
        project = Project.objects.create(name='Winter', created_at=1, updated_at=1)
        parent = Folder.objects.create(project=project, name='Campaign', created_at=1)
        self.folder = Folder.objects.create(project=project, parent=parent, name='Hero shots', created_at=1)
        self.project = project

    def row(self, **fields):
        values = dict(id=uuid.uuid4(), kind='image', status='succeeded', prompt='red fox in snow', model='Nano Banana 2.1',
                      aspect_ratio='16:9', resolution='2K', user_id=self.user.id, cost_cents=6, created_at=1_793_000_000_000,
                      updated_at=1_793_000_000_000, completed_at=1_793_000_019_000, project=self.project, folder=self.folder,
                      worker_lease_id='lease-1', provider_responses=[{'private': 'diagnostic'}], submission_input={'secret': 1})
        values.update(fields)
        return Generation.objects.create(**values)

    def image_row(self, **fields):
        identifier = uuid.uuid4()
        data = png_bytes()
        return self.row(id=identifier, url=self.store(f'generations/{identifier}.png', data, 'image/png'),
                        permanent_name='FOX_013', **fields), data

    def get(self, identifier, mode='legacy', **arguments):
        return self.call(self.raw, 'get_generation', {'id': str(identifier), **arguments}, mode)

    def test_completed_image_in_both_eras(self):
        row, data = self.image_row()
        for era in ERAS:
            with self.subTest(era=era):
                result = self.get(row.id, era)
                self.assert_structured(result, results.RESULT_SCHEMA)
                body = result.structured_content
                self.assertEqual((body['outcome'], body['next'], body['quote']), ('completed', None, None))
                generation = body['generation']
                self.assertEqual({key: generation[key] for key in ('id', 'name', 'kind', 'model', 'modelName', 'status', 'favorite',
                                                                  'createdAt', 'completedAt', 'canCancel', 'error', 'createdVia')},
                                 {'id': str(row.id), 'name': 'FOX_013', 'kind': 'image', 'model': 'nano-banana-2-1',
                                  'modelName': 'Nano Banana 2.1', 'status': 'succeeded', 'favorite': False,
                                  'createdAt': '2026-10-26T07:33:20Z', 'completedAt': '2026-10-26T07:33:39Z',
                                  'canCancel': False, 'error': None, 'createdVia': 'web'})
                self.assertEqual(generation['cost'], {'cents': 6, 'display': '$0.06', 'basis': 'estimated',
                                                      'bookedCents': 0})     # web jobs count nothing against agent caps
                self.assertEqual(generation['params'], {'aspectRatio': '16:9', 'resolution': '2K'})
                self.assertEqual(generation['location'], {'projectId': str(self.project.id), 'projectName': 'Winter',
                                                          'folderId': str(self.folder.id), 'folderPath': 'Campaign/Hero shots'})
                self.assertEqual(generation['createdBy'], {'id': str(self.user.id), 'name': 'Artist'})
                self.assertEqual(generation['resourceUri'], f'veevee://generation/{row.id}')
                self.assertEqual(generation['references'], [])
                for field in FORBIDDEN_FIELDS:
                    self.assertNotIn(field, generation)
                self.assertNotIn('diagnostic', result.content[0].text)
                output, = generation['outputs']
                self.assertEqual({key: output[key] for key in ('role', 'filename', 'mimeType', 'width', 'height', 'bytes',
                                                               'durationSeconds', 'resourceUri')},
                                 {'role': 'primary', 'filename': 'FOX_013.png', 'mimeType': 'image/png', 'width': 600,
                                  'height': 400, 'bytes': len(data), 'durationSeconds': None,
                                  'resourceUri': f'veevee://generation/{row.id}/original'})
                urls = output['urls']
                self.assertTrue(all(urls[variant].startswith(SITE + '/api/media-grant?t=') for variant in ('original', 'preview', 'thumbnail')))
                self.assertEqual([granted_key(urls[variant]) for variant in ('original', 'preview', 'thumbnail')],
                                 [f'generations/{row.id}.png', f'thumbs/1280/generations/{row.id}.png.webp',
                                  f'thumbs/512/generations/{row.id}.png.webp'])
                self.assertIsNone(urls['poster'])
                image, link = result.content[1:]
                self.assertEqual((image.type, image.mime_type), ('image', 'image/webp'))
                with Image.open(io.BytesIO(base64.b64decode(image.data))) as preview:
                    self.assertEqual(preview.size, (512, 341))
                self.assertEqual((link.type, str(link.uri)), ('resource_link', f'veevee://generation/{row.id}'))

    def test_link_expiry_is_the_earliest_url(self):
        row, _ = self.image_row()
        before = time.time()
        output = self.get(row.id).structured_content['generation']['outputs'][0]
        expires = calendar.timegm(time.strptime(output['urlsExpireAt'], '%Y-%m-%dT%H:%M:%SZ'))
        self.assertLessEqual(abs(expires - (before + 300)), 2)        # the 5-minute original wins over 14-minute reads

    def test_video_uses_its_poster_and_streams_the_master(self):
        master = mov_bytes()
        identifier = uuid.uuid4()
        row = self.row(id=identifier, kind='video', model='Seedance 2.5', duration=5, generate_audio=True, draft_mode=False,
                       bitrate_mode='high', video_task_mode='generate', resolution='1080p',
                       url=self.store(f'generations/{identifier}.mov', master, 'video/quicktime'), permanent_name='FOX_014')
        result = self.get(row.id, '2026-07-28')
        self.assert_structured(result, results.RESULT_SCHEMA)
        generation = result.structured_content['generation']
        self.assertEqual(generation['params'], {'aspectRatio': '16:9', 'resolution': '1080p', 'durationSeconds': 5,
                                                'generateAudio': True, 'draft': False, 'bitrateMode': 'high', 'mode': 'generate'})
        output, = generation['outputs']
        self.assertEqual((output['filename'], output['mimeType'], output['durationSeconds'], output['bytes'], output['width']),
                         ('FOX_014.mov', 'video/quicktime', 5, len(master), None))
        poster = f'thumbs/poster/generations/{identifier}.mov.webp'
        self.assertEqual([granted_key(output['urls'][variant]) for variant in ('original', 'preview', 'thumbnail', 'poster')],
                         [f'generations/{identifier}.mov', f'generations/{identifier}.mov', poster, poster])
        self.assertEqual(base64.b64decode(result.content[1].data), self.storage.read(poster))
        self.assertEqual(self.storage.read(f'generations/{identifier}.mov'), master)

    def test_failed_and_cancelled_are_results_with_public_text(self):
        failed = self.row(status='failed', error='upstream 500 from host-17 with key sk-live-123', completed_at=None)
        cancelled = self.row(status='cancelled', cost_basis='cancelled_before_submission', completed_at=None)
        result = self.get(failed.id)
        self.assert_structured(result, results.RESULT_SCHEMA)
        body = result.structured_content
        self.assertEqual((body['outcome'], body['generation']['outputs'], body['next']), ('failed', [], None))
        self.assertEqual(body['generation']['error']['code'], 'GENERATION_FAILED')
        self.assertNotIn('sk-live', result.content[0].text)
        self.assertNotIn('host-17', result.content[0].text)
        self.assertEqual(len(result.content), 2)                    # no preview for a failure
        body = self.get(cancelled.id).structured_content
        self.assertEqual((body['outcome'], body['generation']['error'], body['generation']['cost']['basis']),
                         ('cancelled', None, 'cancelled_before_submission'))

    def test_running_names_the_call_that_keeps_waiting(self):
        running = self.row(status='running', progress_percent=40, progress_message='Rendering', completed_at=None, url=None)
        queued = self.row(status='queued', completed_at=None, url=None, created_via='mcp')
        body = self.get(running.id).structured_content
        self.assertEqual(body['outcome'], 'running')
        self.assertEqual(body['generation']['progress'], {'percent': 40, 'message': 'Rendering'})
        self.assertEqual(body['next'], {'tool': 'get_generation', 'arguments': {'id': str(running.id), 'wait': True},
                                        'afterSeconds': 0, 'why': 'Still rendering (40%). Call this to wait up to 45 s more.'})
        result = self.get(queued.id)
        self.assert_structured(result, results.RESULT_SCHEMA)
        generation = result.structured_content['generation']
        self.assertEqual((generation['status'], generation['createdVia'], generation['progress']), ('queued', 'mcp', None))
        self.assertEqual(set(generation['queue']), {'position', 'reason', 'retryAfterSeconds'})

    def test_draft_final_and_reference_links(self):
        draft, _ = self.image_row(model='Seedance 2.5', kind='video')
        final = self.row(source_generation_id=draft.id, status='queued', completed_at=None, url=None, model='Seedance 2.5',
                         kind='video', reference_images=[draft.url, '/api/media/references/elsewhere.png'])
        draft_generation = self.get(draft.id).structured_content['generation']
        final_generation = self.get(final.id).structured_content['generation']
        self.assertEqual(draft_generation['related'], {'draftId': None, 'finalIds': [str(final.id)], 'upscaleSourceId': None})
        self.assertEqual(final_generation['related']['draftId'], str(draft.id))
        # A web job counts nothing against the agent caps, but its estimate is still replaced by the provider's cost.
        self.assertEqual((final_generation['cost']['bookedCents'], final_generation['cost']['note']),
                         (0, 'Billed from provider tokens when it finishes.'))
        self.assertNotIn('note', draft_generation['cost'])
        self.assertEqual(final_generation['references'], [{'role': 'image', 'generationId': str(draft.id)},
                                                          {'role': 'image', 'generationId': None}])

    def test_a_generation_is_never_its_own_reference(self):
        # An upscale whose result kept its source's URL (mock jobs do this) still links to the source, never to itself.
        source, _ = self.image_row(model='Seedance 2.5', kind='video')
        upscale = self.row(model='Magnific Video Creative', kind='video', url=source.url, reference_videos=[source.url],
                           created_at=source.created_at + 1)
        alone = self.row(model='Magnific Creative', url='/api/media/references/copy.png', reference_images=['/api/media/references/copy.png'])
        generation = self.get(upscale.id).structured_content['generation']
        self.assertEqual((generation['related']['upscaleSourceId'], generation['references']),
                         (str(source.id), [{'role': 'video', 'generationId': str(source.id)}]))
        generation = self.get(alone.id).structured_content['generation']
        self.assertEqual((generation['related']['upscaleSourceId'], generation['references']),
                         (None, [{'role': 'image', 'generationId': None}]))
        # An upscale that recorded its source at submission links to it even through a reference copy.
        recorded = self.row(model='Magnific Creative', reference_images=['/api/media/references/kept.png'],
                            submission_input={'version': 1, 'source': '/api/media/references/kept.png', 'params': {},
                                              'sourceGenerationId': str(source.id)})
        generation = self.get(recorded.id).structured_content['generation']
        self.assertEqual((generation['related']['upscaleSourceId'], generation['references']),
                         (str(source.id), [{'role': 'image', 'generationId': str(source.id)}]))

    def test_summary_detail_keeps_lists_small(self):
        row, _ = self.image_row()
        from apps.generation.services import reads
        generation, = results.generations([reads.get_generation(row.id)], detail='summary')
        self.assertNotIn('references', generation)
        self.assertEqual(list(generation['outputs'][0]['urls']), ['thumbnail'])
        self.assertIsNone(generation['outputs'][0]['bytes'])
        self.assertEqual(granted_key(generation['outputs'][0]['urls']['thumbnail']), f'thumbs/512/generations/{row.id}.png.webp')
        from jsonschema import Draft202012Validator
        self.assertEqual(list(Draft202012Validator(results.GENERATION_SCHEMA).iter_errors(generation)), [])

    def test_unknown_and_malformed_ids(self):
        self.assert_tool_error(self.get(uuid.uuid4()), 'NOT_FOUND')
        self.assert_tool_error(self.get(uuid.uuid4(), wait=True), 'NOT_FOUND')
        self.assert_tool_error(self.get('not-a-uuid'), 'INVALID_INPUT')
        self.assert_tool_error(self.get(uuid.uuid4(), maxWaitSeconds=46), 'INVALID_INPUT')

    def test_wait_returns_when_the_job_finishes(self):
        row, _ = self.image_row()
        Generation.objects.filter(pk=row.pk).update(status='running')
        timer = threading.Timer(1.5, lambda: (Generation.objects.filter(pk=row.pk).update(status='succeeded'), connection.close()))
        timer.start()
        self.addCleanup(timer.cancel)
        began = time.monotonic()
        body = self.get(row.id, wait=True, maxWaitSeconds=10).structured_content
        self.assertEqual(body['outcome'], 'completed')
        self.assertLess(time.monotonic() - began, 6)
        self.assertEqual(self.hold_rows(), [])

    def test_wait_stops_at_max_wait_with_the_running_shape(self):
        row = self.row(status='running', completed_at=None, url=None)
        began = time.monotonic()
        waited = self.get(row.id, wait=True, maxWaitSeconds=1).structured_content
        self.assertGreaterEqual(time.monotonic() - began, 0.9)
        self.assertEqual(waited, self.get(row.id).structured_content)  # wait and no-wait give identical results

    def test_no_free_hold_slot_returns_at_once_with_a_note(self):
        row = self.row(status='running', completed_at=None, url=None)
        principal = authenticate_bearer(self.raw)
        with connection.cursor() as cursor:
            for slot in range(policy.HOLDS_PER_TOKEN):
                cursor.execute('INSERT INTO mcp_rate_windows (bucket, window_start, count, expires_at) VALUES (%s, %s, 1, %s)',
                               [f'hold:{principal.token_id}', slot, 10 ** 15])
        began = time.monotonic()
        body = self.get(row.id, wait=True).structured_content
        self.assertLess(time.monotonic() - began, 3)
        self.assertEqual((body['outcome'], body['note']), ('running', hold.BUSY_NOTE))

    def hold_rows(self):
        with connection.cursor() as cursor:
            cursor.execute("SELECT window_start FROM mcp_rate_windows WHERE bucket LIKE 'hold:%%' AND expires_at > 0")
            return cursor.fetchall()

    def test_detail_is_none_for_unknown_id(self):
        self.assertIsNone(detail(str(uuid.uuid4())))

    def test_reference_url_lookups_are_served_by_the_url_index(self):
        with connection.cursor() as cursor:
            cursor.execute("SELECT indexdef FROM pg_indexes WHERE indexname = 'generations_url_hash_idx'")
            self.assertIn('USING hash (url)', cursor.fetchone()[0])
            cursor.execute('SET enable_seqscan = off')
        self.addCleanup(lambda: connection.cursor().execute('RESET enable_seqscan'))
        plan = Generation.objects.filter(url__in=['/api/media/generations/a.png', '/api/media/generations/b.mov']).explain()
        self.assertIn('generations_url_hash_idx', plan)


class FakeClock:
    def __init__(self):
        self.now, self.sleeps = 0.0, []

    def __call__(self):
        return self.now

    async def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class HoldTests(McpCase):
    def setUp(self):
        super().setUp()
        self.principal = authenticate_bearer(self.token())

    def run_hold(self, statuses, max_wait=None, cap=45):
        clock = FakeClock()
        reads = iter(statuses)
        call = ToolCall(principal=self.principal, arguments={}, request_id='r', protocol_version='2025-11-25', started=0.0)
        with override_settings(MCP_MAX_HOLD_SECONDS=cap):
            note = asyncio.run(hold.hold(call, 'id', max_wait_seconds=max_wait, clock=clock, sleep=clock.sleep,
                                         read=lambda _: next(reads, 'running')))
        return note, clock

    def test_polls_every_second_then_every_two_and_stops_at_45_seconds(self):
        note, clock = self.run_hold([])
        self.assertIsNone(note)
        self.assertEqual(clock.now, 45)
        self.assertEqual(clock.sleeps, [1.0] * 10 + [2.0] * 17 + [1.0])

    def test_returns_when_terminal(self):
        note, clock = self.run_hold(['running', 'running', 'running', 'succeeded'])
        self.assertEqual((note, clock.now), (None, 3))

    def test_already_terminal_does_not_wait_or_take_a_slot(self):
        with patch.object(hold, 'hold_slot') as slot:
            note, clock = self.run_hold(['failed'])
        self.assertEqual((note, clock.now), (None, 0))
        slot.assert_not_called()

    def test_max_wait_and_server_cap(self):
        self.assertEqual(self.run_hold([], max_wait=5)[1].now, 5)
        self.assertEqual(self.run_hold([], max_wait=40, cap=12)[1].now, 12)

    def test_cut_off_counts_from_the_start_of_the_call(self):
        clock = FakeClock()
        clock.now = 30.0                                            # submission already took 30 s of the call
        call = ToolCall(principal=self.principal, arguments={}, request_id='r', protocol_version='2025-11-25', started=0.0)
        asyncio.run(hold.hold(call, 'id', clock=clock, sleep=clock.sleep, read=lambda _: 'running'))
        self.assertEqual(clock.now, 45)

    def test_slot_is_released_when_the_client_goes_away(self):
        call = ToolCall(principal=self.principal, arguments={}, request_id='r', protocol_version='2025-11-25')

        async def abandon():
            task = asyncio.create_task(hold.hold(call, 'id', read=lambda _: 'running'))
            await asyncio.sleep(0.5)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            await asyncio.sleep(0.2)
        asyncio.run(abandon())
        with connection.cursor() as cursor:
            cursor.execute("SELECT count(*) FROM mcp_rate_windows WHERE bucket = %s AND expires_at > 0", [f'hold:{self.principal.token_id}'])
            self.assertEqual(cursor.fetchone()[0], 0)
