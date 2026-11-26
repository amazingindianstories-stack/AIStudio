"""Real media transport handoff with a fake bucket, never cloud credentials or a paid call."""
import base64
import copy
import json
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from apps.media.storage import GCSAdapter, PrefixedGCSAdapter, StorageService, MemoryAdapter
from apps.media.test_prefixed_storage import FakeClient
from apps.mcp.tests.test_results import png_bytes, mov_bytes
from apps.agents.test_media import wav_bytes
from apps.agents.media import audio_seconds
from . import google_media as media
from .transport import HttpTransport, HttpResult, ProviderError
from apps.generation.services.executor import submission_uncertain

VERTEX = 'https://aiplatform.googleapis.com/v1/projects/fixture-project/locations/global/publishers/google/models/gemini-3.8-flash:generateContent'
GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'


def inline(mime, data):
    return {'inlineData': {'mimeType': mime, 'data': base64.b64encode(data).decode()}}


def body(*parts):
    return {'contents': [{'role': 'user', 'parts': [*parts, {'text': 'Describe all the content.'}]}]}


class GoogleMediaTests(SimpleTestCase):
    def setUp(self):
        self.client = FakeClient()
        self.adapter = GCSAdapter(self.client, 'fixture-bucket')
        self.storage = StorageService(self.adapter)
        override = override_settings(VEEVEE_MEDIA_STORAGE=self.storage)
        override.enable()
        self.addCleanup(override.disable)

    def test_exact_file_and_aggregate_boundaries_and_original_payload_preserved(self):
        for sizes in ((media.INLINE_BYTES,), (3 * media.MB,) * 3):
            payload = body(*(inline('image/png', b'x' * size) for size in sizes))
            with media.prepared_request(VERTEX, payload) as sent:
                self.assertIs(sent, payload)
                self.assertEqual(self.client.objects, {})
        payload = body(*(inline('image/png', b'x' * size) for size in (4 * media.MB, 4 * media.MB, media.MB + 1)))
        original = copy.deepcopy(payload)
        with media.prepared_request(VERTEX, payload) as sent:
            parts = sent['contents'][0]['parts']
            self.assertIn('inlineData', parts[0])
            self.assertIn('inlineData', parts[1])
            self.assertTrue(parts[2]['fileData']['fileUri'].startswith('gs://fixture-bucket/ai-inputs/'))
            self.assertEqual(len(next(iter(self.client.objects.values()))[0]), media.MB + 1)
        self.assertEqual(payload, original)
        self.assertEqual(self.client.objects, {})

    def test_each_large_media_type_uses_original_bytes_and_cleans_up_on_failure(self):
        data = b'x' * (media.INLINE_BYTES + 1)
        for mime in ('image/png', 'audio/wav', 'video/quicktime', 'application/pdf'):
            with self.subTest(mime=mime), self.assertRaisesRegex(RuntimeError, 'provider failed'):
                with media.prepared_request(VERTEX, body(inline(mime, data))) as sent:
                    part = sent['contents'][0]['parts'][0]['fileData']
                    self.assertEqual(part['mimeType'], mime)
                    self.assertEqual(list(self.client.objects.values()), [(data, mime)])
                    raise RuntimeError('provider failed')
            self.assertEqual(self.client.objects, {})

    def test_gemini_api_and_omni_are_unchanged_even_above_the_vertex_threshold(self):
        payload = body(inline('audio/wav', b'x' * (media.INLINE_BYTES + 1)))
        for url in (GEMINI, VERTEX.replace(':generateContent', ':predictLongRunning')):
            with patch.object(media.MediaInputs, 'adapter', side_effect=AssertionError('storage touched')):
                with media.prepared_request(url, payload) as sent:
                    self.assertIs(sent, payload)

    def test_transport_authorizes_original_payload_then_stages_for_the_wire(self):
        payload = body(inline('audio/wav', b'x' * (media.INLINE_BYTES + 1)))
        original = copy.deepcopy(payload)
        transport = HttpTransport(allowed_hosts={'aiplatform.googleapis.com'})
        events = []

        def authorize(*args):
            self.assertEqual(args[-1], original)
            self.assertEqual(self.client.objects, {})
            events.append('authorized')

        def send(*args, **kwargs):
            self.assertEqual(events, ['authorized'])
            self.assertIn('fileData', kwargs['body']['contents'][0]['parts'][0])
            self.assertEqual(len(self.client.objects), 1)
            raise RuntimeError('provider failed')

        with patch('apps.generation.services.paid_guard.enabled', return_value=True), \
                patch('apps.generation.services.paid_guard.check_request', side_effect=authorize), \
                patch.object(transport, '_send', side_effect=send), self.assertRaises(RuntimeError):
            transport.request('POST', VERTEX, body=payload)
        self.assertEqual(payload, original)
        self.assertEqual(self.client.objects, {})
        with patch('apps.generation.services.paid_guard.enabled', return_value=True), \
                patch('apps.generation.services.paid_guard.check_request', side_effect=ProviderError('refused')), \
                patch.object(media.MediaInputs, 'part') as prepare, self.assertRaises(ProviderError):
            transport.request('POST', VERTEX, body=payload)
        prepare.assert_not_called()

    def test_image_generation_reference_prep_and_transcription_use_the_shared_handoff(self):
        from apps.generation.providers import gemini
        from apps.generation.prompting.image_prep import vision_request
        from apps.media.audio import configured_transcriber
        data = base64.b64encode(b'original-reference' * 8).decode()
        sent = []

        def send(transport, method, url, **arguments):
            parts = arguments['body']['contents'][0]['parts']
            self.assertTrue(any('fileData' in part for part in parts))
            self.assertTrue(self.client.objects)
            sent.append(url)
            return HttpResult(200, json.dumps({'candidates': [{'content': {'parts': [
                {'text': 'A transcript.'}, {'inlineData': {'mimeType': 'image/png', 'data': 'result'}}]}}]}).encode())

        with patch.dict('os.environ', GOOGLE_GENAI_BACKEND='vertex', GCP_PROJECT_ID='fixture-project'), \
                patch('apps.integrations.google_genai._access_token', return_value='fixture-token'), \
                patch('apps.generation.services.paid_guard.enabled', return_value=False), \
                patch.object(media, 'INLINE_BYTES', 32), patch.object(HttpTransport, '_send', send):
            gemini.generate_image({'assembled': {'groups': [{'header': 'Reference',
                'images': [{'mimeType': 'image/png', 'data': data}]}], 'instruction': 'Draw a fox.'}})
            self.assertEqual(self.client.objects, {})
            vision_request([{'inlineData': {'mimeType': 'image/png', 'data': data}}])
            self.assertEqual(self.client.objects, {})
            self.assertEqual(configured_transcriber().transcribe(data, 'audio/wav', 'gemini-3.8-flash'), 'A transcript.')
            self.assertEqual(self.client.objects, {})
        self.assertEqual(len(sent), 3)

    def test_originals_and_protected_objects_are_copied_never_referenced_in_both_storage_layouts(self):
        keys = ('uploads/original', 'generations/master.png', 'settings/secret', 'migrations/state', 'exports/archive.zip')
        for prefix in ('', 'private-fixture/'):
            adapter = PrefixedGCSAdapter(self.client, 'fixture-bucket', prefix=prefix) if prefix else self.adapter
            for key in keys:
                with self.subTest(prefix=prefix, key=key):
                    self.client.objects = {key: (b'original', 'image/png'), prefix + key: (b'original', 'image/png')}
                    stored = dict(self.client.objects)
                    inputs = media.MediaInputs(StorageService(adapter))
                    uri = inputs.part('image/png', b'original')['fileData']['fileUri']
                    self.assertRegex(uri, rf'^gs://fixture-bucket/{prefix}ai-inputs/[0-9a-f-]{{36}}$')
                    self.assertNotIn(key, uri)
                    self.assertEqual(self.client.objects[uri.removeprefix('gs://fixture-bucket/')], (b'original', 'image/png'))
                    inputs.release()
                    self.assertEqual(self.client.objects, stored)

    def test_upload_timeout_and_cancellation_release_staged_objects(self):
        payload = body(inline('image/png', b'x' * (media.INLINE_BYTES + 1)))
        put = self.adapter.put

        def timed_out(*args):
            put(*args)
            raise TimeoutError('upload answer lost')

        with patch.object(self.adapter, 'put', side_effect=timed_out), self.assertRaises(ProviderError) as raised:
            with media.prepared_request(VERTEX, payload):
                self.fail('request must not be submitted')
        self.assertEqual(self.client.objects, {})
        self.assertEqual(raised.exception.code, 'media_staging')
        self.assertIsInstance(raised.exception.__cause__, TimeoutError)
        self.assertFalse(submission_uncertain(raised.exception))

        transport = HttpTransport(allowed_hosts={'aiplatform.googleapis.com'})
        with patch('apps.generation.services.paid_guard.enabled', return_value=False), \
                patch.object(self.adapter, 'put', side_effect=PermissionError('bucket refused')), \
                patch.object(transport, '_send') as send, self.assertRaises(ProviderError) as raised:
            transport.request('POST', VERTEX, body=payload)
        send.assert_not_called()
        self.assertEqual((raised.exception.code, raised.exception.may_have_submitted), ('media_staging', False))

        class Cancelled:
            def check(inner):
                if self.client.objects:
                    raise RuntimeError('cancelled')

        with self.assertRaisesRegex(RuntimeError, 'cancelled'):
            with media.prepared_request(VERTEX, payload, Cancelled()):
                self.fail('request must not be submitted')
        self.assertEqual(self.client.objects, {})

    def test_preparation_failures_do_not_disclose_uploaded_file_content(self):
        from .google_media import shrink
        with self.assertRaises(ProviderError) as raised:
            shrink('audio/wav', b'#EXTM3U\nfile:///private/fixture-secret\n', 30000)
        self.assertNotIn('fixture-secret', str(raised.exception))
        self.assertFalse(raised.exception.may_have_submitted)

    def test_uri_limit_downscales_only_the_inference_copy(self):
        original = png_bytes(1600, 1600)
        inputs = media.MediaInputs(self.storage)
        with patch.object(media, 'URI_BYTES', 6000):
            result = inputs.part('image/png', original)
        self.assertEqual(result['fileData']['mimeType'], 'image/jpeg')
        self.assertLessEqual(len(next(iter(self.client.objects.values()))[0]), 6000)
        inputs.release()
        self.assertEqual(self.client.objects, {})

    def test_no_bucket_fallback_and_reencoding_preserve_the_entire_timeline(self):
        inputs = media.MediaInputs(StorageService(MemoryAdapter()))
        for mime, original in (('image/png', png_bytes(900, 600)), ('audio/wav', wav_bytes(2)),
                               ('video/quicktime', mov_bytes())):
            with self.subTest(mime=mime):
                result = inputs.part(mime, original, inline_budget=30000)['inlineData']
                converted = base64.b64decode(result['data'])
                self.assertLessEqual(len(converted), 30000)
                if mime.startswith(('audio/', 'video/')):
                    self.assertAlmostEqual(audio_seconds(converted), audio_seconds(original), delta=.15)
        with self.assertRaises(ProviderError):
            inputs.part('image/png', b'corrupt', inline_budget=10)

    def test_vertex_file_allowlist_accepts_only_task_scoped_copies_in_this_bucket(self):
        copy_id = '0f8e2b1c-3d4a-4b5c-8d6e-7f8091a2b3c4'
        with patch.dict('os.environ', GOOGLE_GENAI_BACKEND='vertex'):
            from apps.agents.loop_llm import _part_allowed
            for uri, allowed in ((f'gs://fixture-bucket/ai-inputs/{copy_id}', True),
                                 (f'gs://other-bucket/ai-inputs/{copy_id}', False),
                                 (f'gs://fixture-bucket/ai-inputs/{copy_id}?generation=1', False),
                                 ('gs://fixture-bucket/ai-inputs/not-a-copy', False),
                                 ('gs://fixture-bucket/ai-inputs/../settings/secret', False),
                                 ('gs://fixture-bucket/uploads/example', False),
                                 ('gs://fixture-bucket/generations/master.png', False),
                                 ('gs://fixture-bucket/settings/secret', False),
                                 ('gs://fixture-bucket/migrations/state', False),
                                 ('gs://fixture-bucket/exports/archive.zip', False)):
                with self.subTest(uri=uri):
                    self.assertEqual(_part_allowed('user', {'fileData': {'mimeType': 'image/png', 'fileUri': uri}}), allowed)
            prefixed = PrefixedGCSAdapter(self.client, 'fixture-bucket', prefix='private-fixture/')
            with override_settings(VEEVEE_MEDIA_STORAGE=StorageService(prefixed)):
                for uri, allowed in ((f'gs://fixture-bucket/private-fixture/ai-inputs/{copy_id}', True),
                                     (f'gs://fixture-bucket/ai-inputs/{copy_id}', False),
                                     ('gs://fixture-bucket/private-fixture/uploads/example', False)):
                    with self.subTest(uri=uri):
                        self.assertEqual(_part_allowed('user', {'fileData': {'mimeType': 'image/png', 'fileUri': uri}}), allowed)
