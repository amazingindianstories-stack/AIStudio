"""Enqueue responses for offered models stay byte-identical across the move into services.submission.

``testsupport/data/enqueue_golden.json`` holds the status, headers and body bytes the enqueue, finalize and upscale
routes answered at ``source_revision``, before the move, for the requests in ``CASES``. Ids and the clock are
pinned so every byte is reproducible; mock providers only. To record it again from another revision, run
``capture()`` there and write ``{'source_revision', 'responses'}``.
"""
import importlib.util
import itertools
import json
import uuid
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.media.storage import StorageService, MemoryAdapter
from .models import Generation
from .test_enqueue import data_url, picture

GOLDEN = Path(__file__).resolve().parents[2] / 'testsupport' / 'data' / 'enqueue_golden.json'
NOW = 1793145600000
DRAFT = '00000000-0000-4000-8000-00000000d4af'
UPSCALE = dict(model='Magnific Precision V2', image=data_url(picture(160, 90)),
               params=dict(scaleFactor='4x', flavor='photo', sharpen=7, smartGrain=7, ultraDetail=30))
# (method, path, body, idempotency key)
CASES = [
    ('POST', 'image', dict(prompt='lantern at dusk', model='Nano Banana Pro', aspectRatio='16:9', resolution='2K', seed=7), None),
    ('POST', 'image', dict(prompt='lantern @img1', model='Nano Banana 2.1', aspectRatio='4:5', resolution='1K', referenceImages=[data_url()]), None),
    ('POST', 'image', dict(prompt='harbour photo', model='Seedream 5.0 Pro', aspectRatio='3:4', projectId=None), None),
    ('POST', 'image', dict(prompt='paper boat', model='Kling Image 3.0', aspectRatio='1:1', resolution='2K'), None),
    ('POST', 'image', dict(prompt='paper boat', model='kling-image-21', aspectRatio='3:2', resolution='1K', referenceImages=[data_url()]), None),
    ('POST', 'video', dict(prompt='river at night', model='Seedance 2.0', aspectRatio='16:9', resolution='720p', duration=5,
                           generateAudio=True, bitrateMode='standard', seed=11), None),
    ('POST', 'video', dict(prompt='river at night', model='Seedance 2.5', aspectRatio='9:16', resolution='480p', duration=10, draftMode=True), None),
    ('POST', 'video', dict(prompt='edit the clip', model='seedance-25', aspectRatio='adaptive', resolution='1080p', videoTaskMode='edit',
                           referenceVideos=['uploads/native.mov']), None),
    ('POST', 'video', dict(prompt='river at night', model='Seedance 2.5', resolution='720p', duration=6, referenceImages=[data_url(picture(320, 400))],
                           firstFrame=data_url(picture(320, 320)), lastFrame=data_url(picture(400, 320))), None),
    ('POST', 'video', dict(prompt='river at night', model='Seedance 2.5', resolution='720p', duration=6, referenceImages=[data_url()]), None),
    ('POST', 'video', dict(prompt='lantern river', model='Gemini Omni Flash 1.1', aspectRatio='9:16', resolution='360p', duration=6), None),
    ('POST', 'image', dict(prompt='keyed lantern', model='Nano Banana Pro'), 'golden-key-0001'),
    ('POST', 'image', dict(prompt='keyed lantern', model='Nano Banana Pro'), 'golden-key-0001'),
    ('POST', 'image', dict(prompt='other lantern', model='Nano Banana Pro'), 'golden-key-0001'),
    ('POST', 'image', dict(prompt='keyed lantern', model='Nano Banana Pro'), 'bad key'),
    ('POST', 'image', dict(model='Nano Banana Pro'), None),
    ('POST', 'image', dict(prompt='x' * 30001, model='Nano Banana Pro'), None),
    ('POST', 'video', dict(prompt='river', model='Seedance 2.5', duration=31), None),
    ('POST', 'video', dict(prompt='river', model='Seedance 2.0', resolution='bad'), None),
    ('POST', 'video', dict(prompt='river', model='Seedance 2.5', draftMode=True, resolution='720p'), None),
    ('POST', 'video', dict(prompt='river', model='Gemini Omni Flash 1.1', aspectRatio='21:9', resolution='720p', duration=8), None),
    ('POST', 'video', dict(prompt='river', model='Gemini Omni Flash', resolution='720p', duration=8), None),
    ('POST', 'image', dict(prompt='upscale', model='Magnific Creative'), None),
    ('POST', 'image', dict(prompt='lantern', model='Nano Banana Pro', referenceImages=[{'referenceId': 'nope'}]), None),
    ('POST', 'video/finalize', dict(sourceGenerationId=DRAFT), None),
    ('POST', 'video/finalize', dict(sourceGenerationId=DRAFT), None),
    ('POST', 'video/finalize', dict(), None),
    ('POST', 'video/finalize', dict(sourceGenerationId='00000000-0000-4000-8000-000000000404'), None),
    ('POST', 'upscale', UPSCALE, None),
    ('POST', 'upscale', {**UPSCALE, 'image': 'https://evil.invalid/a.png'}, None),
    ('POST', 'upscale', {**UPSCALE, 'params': {**UPSCALE['params'], 'scaleFactor': '3x'}}, None),
]
HEADERS = ('Content-Type', 'Cache-Control', 'Retry-After', 'Set-Cookie')
# Pinned wherever the routes read the clock, before and after the move.
CLOCKS = ('apps.generation.enqueue_views.now_ms', 'apps.generation.services.submission.now_ms',
          'apps.generation.services.enqueue.now_ms', 'apps.library.services.idempotency.now_ms')


class EnqueueGoldenTests(TransactionTestCase):
    setUp = session_fixtures.SettingsTests.setUp
    cookie = session_fixtures.SettingsTests.cookie

    def capture(self):
        self.cookie()
        Generation.objects.create(id=DRAFT, kind='video', status='succeeded', prompt='draft prompt', model='Seedance 2.5',
            aspect_ratio='16:9', resolution='480p', duration=8, draft_mode=True, task_id='golden-draft-task', bitrate_mode='high',
            generate_audio=True, user_id=session_fixtures.UID, created_at=NOW - 60000, updated_at=NOW - 60000)
        counter = itertools.count(1)
        responses = []
        with ExitStack() as stack:
            stack.enter_context(override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter()), VEEVEE_KLING=True,
                VEEVEE_GEMINI_OMNI=True, VEEVEE_MAGNIFIC_UPSCALE=True, VEEVEE_PAID_GUARD=None, PUBLIC_APP_URL='http://testserver'))
            stack.enter_context(patch('uuid.uuid4', side_effect=lambda: uuid.UUID(f'{next(counter):08x}-0000-4000-8000-000000000000')))
            for name in CLOCKS:
                module, attribute = name.rsplit('.', 1)
                if importlib.util.find_spec(module) and hasattr(importlib.import_module(module), attribute):
                    stack.enter_context(patch(name, return_value=NOW))
            for method, path, body, key in CASES:
                extra = {'HTTP_IDEMPOTENCY_KEY': key} if key else {}
                response = self.client.generic(method, '/api/generate/' + path, json.dumps(body), content_type='application/json', **extra)
                responses.append({'status': response.status_code, 'headers': {name: response[name] for name in HEADERS if response.has_header(name)},
                                  'body': response.content.decode()})
        return responses

    def test_responses_match_the_recorded_bytes(self):
        golden = json.loads(GOLDEN.read_text())
        self.assertEqual(len(golden['responses']), len(CASES))
        for case, actual, expected in zip(CASES, self.capture(), golden['responses']):
            with self.subTest(path=case[1], body=json.dumps(case[2])[:120], key=case[3]):
                self.assertEqual(actual, expected)
