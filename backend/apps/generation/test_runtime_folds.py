"""Behaviour folded into source from production launcher overlays."""
import io
import json
from contextlib import redirect_stdout
from unittest.mock import patch
from django.test import SimpleTestCase
from .providers import seedance, seedream
from .services.video_execution import to_provider_data_urls


class Signal:
    def check(self):
        pass


def body(code, message='rejected'):
    return json.dumps({'error': {'code': code, 'message': message}})


class SeedancePolicyMessageTests(SimpleTestCase):
    def test_text_privacy_and_neutral_policy_messages(self):
        text = seedance.friendly_error(400, body('InputTextSensitiveContentDetected.PolicyViolation', 'sensitive content'))
        self.assertEqual(str(text), seedance.TEXT_POLICY_MESSAGE)
        privacy = seedance.friendly_error(400, body('InputImageSensitiveContentDetected.PrivacyInformation', 'privacy information'))
        self.assertEqual(str(privacy), seedance.MODERATION_MESSAGE)
        self.assertEqual(privacy.code, 'moderation')

    def test_not_found_and_ordinary_errors_keep_their_messages(self):
        missing = seedance.friendly_error(404, body('InvalidEndpointOrModel.NotFound', 'model not found'))
        self.assertIn('404', str(missing))
        ordinary = seedance.friendly_error(400, body('InvalidParameter', 'bad duration'))
        self.assertIn('bad duration', str(ordinary))
        self.assertEqual(ordinary.code, 'seedance_error')


class PortraitRegistrationGuardTests(SimpleTestCase):
    def convert(self, refs, lookup):
        read = lambda ref: {'mimeType': 'image/png', 'data': 'AAAA'}  # noqa: E731
        prepare = lambda mime, data: {'mimeType': mime, 'data': data}  # noqa: E731
        return to_provider_data_urls(refs, Signal(), read=read, prepare=prepare, portrait_lookup=lookup)

    def test_active_portrait_becomes_a_registered_asset(self):
        lookup = lambda ref: {'byteplusAssetId': 'asset-1', 'status': 'Active'}  # noqa: E731
        self.assertEqual(self.convert(['/api/media/uploads/portrait/a'], lookup), ['asset://asset-1'])

    def test_unregistered_portrait_stops_before_provider_submission(self):
        lookup = lambda ref: {'byteplusAssetId': None, 'status': 'Processing'}  # noqa: E731
        with self.assertRaisesRegex(ValueError, 'is not ready for video yet.*not charged'):
            self.convert(['/api/media/uploads/portrait/a'], lookup)
        deleted = lambda ref: {'byteplusAssetId': 'asset-1', 'status': 'PreviewDeleted', 'name': 'R01_SC008'}  # noqa: E731
        with self.assertRaisesRegex(ValueError, 'Portrait "R01_SC008" was removed from the Portrait Gallery'):
            self.convert(['/api/media/uploads/portrait/a'], deleted)

    def test_lookup_failure_stops_submission(self):
        def lookup(ref):
            raise RuntimeError('database unavailable')
        with self.assertRaisesRegex(ValueError, 'lookup unavailable'):
            self.convert(['/api/media/uploads/image-reference/a'], lookup)

    def test_plain_images_are_sent_as_data(self):
        self.assertEqual(self.convert(['/api/media/uploads/image-reference/a'], lambda ref: None), ['data:image/png;base64,AAAA'])


class SeedreamTransportTests(SimpleTestCase):
    def test_long_timeout_and_bounded_failure_diagnostic(self):
        created = {}

        class Transport:
            def __init__(self, *, allowed_hosts, timeout=60, **kwargs):
                created['timeout'] = timeout
                raise TimeoutError('read timed out')
        output = io.StringIO()
        with patch.object(seedream, 'HttpTransport', Transport), redirect_stdout(output):
            with self.assertRaises(TimeoutError):
                seedream.generate_image({'prompt': 'a quiet forest'}, env={'ARK_API_KEY': 'fixture'})
        self.assertEqual(created.get('timeout'), seedream.SEEDREAM_TIMEOUT_SECONDS)
        event = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(event['event'], 'SEEDREAM_OPERATIONAL_FAILURE')
        self.assertEqual(event['causes'][0], {'class': 'TimeoutError', 'code': 'OTHER'})
        self.assertNotIn('fixture', output.getvalue())


class StalePortraitGuardTests(SimpleTestCase):
    def test_identity_parsing(self):
        from .services.enqueue import registered_portrait_ids
        item = {'firstFrame': 'https://tos.example/a.jpg#bp_asset_id=asset-2', 'lastFrame': None}
        body = {'referenceImages': ['asset://asset-1', '/api/media/uploads/image-reference/x', 'asset://asset-1']}
        self.assertEqual(registered_portrait_ids(item, body), ['asset-1', 'asset-2'])
        with self.assertRaises(ValueError):
            registered_portrait_ids({}, {'referenceImages': ['asset://bad id']})

    def test_verification_outcomes(self):
        from .services.enqueue import InvalidRequest, verify_registered_portraits

        class Client:
            def __init__(self, status='Active', fail=False):
                self.status, self.fail, self.calls = status, fail, []

            def get_asset(self, ref, project_name):
                self.calls.append(ref)
                if self.fail:
                    raise RuntimeError('provider down')
                return {'Id': ref, 'Status': self.status, 'ProjectName': 'default'}
        body = {'referenceImages': ['asset://asset-1']}
        active = Client()
        verify_registered_portraits({}, body, client_factory=lambda: active)
        self.assertEqual(active.calls, ['asset-1'])
        for client in (Client(status='Processing'), Client(fail=True)):
            with self.assertRaises(InvalidRequest):
                verify_registered_portraits({}, body, client_factory=lambda c=client: c)
        untouched = Client()
        verify_registered_portraits({}, {'referenceImages': ['/api/media/uploads/image-reference/x']}, client_factory=lambda: untouched)
        self.assertEqual(untouched.calls, [])

    def test_read_only_transport_only_allows_get_asset(self):
        import json as _json
        from apps.assets.byteplus_readonly import ReadOnlyGetAssetTransport
        transport = ReadOnlyGetAssetTransport(allowed_hosts={'ark.ap-southeast-1.byteplusapi.com'}, timeout=2)
        good_url = 'https://ark.ap-southeast-1.byteplusapi.com/?Action=GetAsset&Version=2024-01-01'
        for url, payload in (('https://ark.ap-southeast-1.byteplusapi.com/?Action=DeleteAsset&Version=2024-01-01', {'Id': 'a', 'ProjectName': 'default'}),
                             (good_url, {'Id': 'a', 'ProjectName': 'default', 'Extra': 1}),
                             (good_url, {'Id': 'a b', 'ProjectName': 'default'})):
            with self.assertRaises(ValueError):
                transport.request('POST', url, raw_body=_json.dumps(payload).encode())
        self.assertTrue(transport.paid_guard_exempt)


class ProviderProjectionTests(__import__('django.test', fromlist=['TransactionTestCase']).TransactionTestCase):
    def test_portrait_lookup_never_queries_users(self):
        import uuid
        from apps.assets.models import PortraitAsset, PortraitGroup
        from apps.assets.portrait_db import get_portrait_asset_by_image_url
        from apps.authentication.models import User
        user = User.objects.create(id=uuid.uuid4(), email='u@example.test', name='U', role='user', password_hash='x', password_salt='', created_at=1)
        group = PortraitGroup.objects.create(name='g', created_at=1, updated_at=1)
        PortraitAsset.objects.create(group=group, image_url='/api/media/uploads/portrait/p1', status='Active',
                                     byteplus_asset_id='asset-9', created_by_id=user.id, created_at=1, updated_at=1)
        with self.assertNumQueries(1):
            found = get_portrait_asset_by_image_url('/api/media/uploads/portrait/p1')
        self.assertEqual(found['byteplusAssetId'], 'asset-9')
        self.assertEqual(found['createdById'], str(user.id))
        self.assertNotIn('uploader', found)


class SubmitTimePortraitCheckTests(SimpleTestCase):
    def body(self, *refs):
        return {'referenceImages': list(refs)}

    def test_deleted_or_unready_portraits_are_refused_before_queueing(self):
        from .services.enqueue import InvalidRequest, verify_portrait_references
        portraits = {'/api/media/uploads/portrait/gone': {'byteplusAssetId': 'a1', 'status': 'PreviewDeleted', 'name': 'R01_SC008_0008 (1)'},
                     '/api/media/uploads/portrait/new': {'byteplusAssetId': None, 'status': 'Processing'},
                     '/api/media/uploads/portrait/ok': {'byteplusAssetId': 'a2', 'status': 'Active'}}
        lookup = portraits.get
        item = {'model': 'Seedance 2.5'}
        verify_portrait_references(item, self.body('/api/media/uploads/image-reference/x', '/api/media/uploads/portrait/ok',
                                                   'asset://a3', 'data:image/png;base64,AA'), lookup=lookup)
        with self.assertRaisesRegex(InvalidRequest, r'^Reference 3 \("R01_SC008_0008 \(1\)"\) was removed from the Portrait Gallery'):
            verify_portrait_references(item, self.body('/x', '/api/media/uploads/portrait/ok', '/api/media/uploads/portrait/gone'), lookup=lookup)
        with self.assertRaisesRegex(InvalidRequest, '^The first frame is not ready for video yet'):
            verify_portrait_references({**item, 'firstFrame': '/api/media/uploads/portrait/new'}, self.body(), lookup=lookup)

    def test_lookup_failure_refuses_and_other_providers_are_untouched(self):
        from .services.enqueue import InvalidRequest, verify_portrait_references
        def broken(ref):
            raise RuntimeError('db down')
        with self.assertRaisesRegex(InvalidRequest, 'could not be checked'):
            verify_portrait_references({'model': 'Seedance 2.5'}, self.body('/api/media/uploads/portrait/a'), lookup=broken)
        verify_portrait_references({'model': 'Higgsfield Seedance 2.0'}, self.body('/api/media/uploads/portrait/a'), lookup=broken)


class WorkerAssetReadTests(__import__('django.test', fromlist=['TransactionTestCase']).TransactionTestCase):
    """The worker path that loads @asset references must run for real (regression: missing import)."""

    def test_video_and_image_read_assets_return_projections(self):
        import uuid
        from apps.assets.models import Asset
        from apps.projects.models import Project
        from .services import image_execution, video_execution
        project = Project.objects.create(id=uuid.uuid4(), name='P', created_at=1, updated_at=1)
        Asset.objects.create(id=uuid.uuid4(), kind='character', name='Sati', slug='sati', images=['/api/media/a.png'],
                             project_id=project.id, created_at=1, updated_at=1)
        for module in (video_execution, image_execution):
            with self.subTest(module=module.__name__):
                rows = module.read_assets(project.id)
                self.assertEqual([(r['slug'], r['images']) for r in rows], [('sati', ['/api/media/a.png'])])
                self.assertEqual(module.read_assets(None)[0]['slug'], 'sati')


class RealVideoDependencyWiringTests(__import__('django.test', fromlist=['TransactionTestCase']).TransactionTestCase):
    """Runs submit_video with the real Dependencies up to the provider call; no key, no network."""

    def test_seedance_path_reaches_the_provider_boundary(self):
        import os
        import uuid
        from types import SimpleNamespace
        from unittest.mock import patch
        from apps.assets.models import Asset
        from apps.projects.models import Project
        from .providers.transport import HttpTransport, ProviderError
        from .services.deadline import Cancellation
        from .services.video_execution import submit_video
        project = Project.objects.create(id=uuid.uuid4(), name='P', created_at=1, updated_at=1)
        Asset.objects.create(id=uuid.uuid4(), kind='character', name='Sati', slug='sati', images=[], project_id=project.id, created_at=1, updated_at=1)
        item = SimpleNamespace(id=uuid.uuid4(), task_id=None, draft_task_id=None, model='Seedance 2.5', prompt='a quiet courtyard at dawn',
            aspect_ratio='16:9', duration=5, resolution='480p', project_id=project.id, user_id=None, reference_images=[], reference_videos=[],
            reference_audios=[], continuation_frame_url=None, last_frame_url=None, generate_audio=False, draft_mode=True, seed=None,
            bitrate_mode='high', video_task_mode=None, track_characters=False)
        env = {k: v for k, v in os.environ.items() if k not in ('ARK_API_KEY', 'MOCK_GENERATION')}
        def no_network(*args, **kwargs):
            raise AssertionError('test must not reach the network')
        from django.test import override_settings
        from apps.media.storage import MemoryAdapter, StorageService
        with patch.dict(os.environ, env, clear=True), patch.object(HttpTransport, 'request', no_network), \
                override_settings(VEEVEE_MEDIA_STORAGE=StorageService(MemoryAdapter())):
            with self.assertRaises((ProviderError, ValueError)) as caught:
                submit_video(item, signal=Cancellation(), on_task=lambda *a: None, env={})
        self.assertNotIsInstance(caught.exception, NameError)
        self.assertIn('ARK_API_KEY', str(caught.exception))


class SubmitTimeReferenceAudioCheckTests(SimpleTestCase):
    def check(self, model, *seconds, prompt='shot'):
        from .services.enqueue import verify_reference_audio_durations
        refs = [f'/api/media/uploads/audio-reference/{index}' for index in range(len(seconds))]
        lengths = dict(zip(refs, seconds))
        verify_reference_audio_durations({'model': model, 'prompt': prompt, 'referenceAudios': refs}, measure=lengths.get)

    def test_clips_outside_the_model_limits_are_refused_with_their_index(self):
        from .services.enqueue import ReferenceAudioRejected
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^@audio1 is 34\.6s long\. Seedance 2\.5 accepts reference audio clips of 2-30s each and 30s in total\. Trim it') as caught:
            self.check('Seedance 2.5', 34.6)
        self.assertEqual(caught.exception.audio_index, 1)
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^@audio2 is only 1\.2s long') as caught:
            self.check('Seedance 2.5', 10.0, 1.2)
        self.assertEqual(caught.exception.audio_index, 2)
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^@audio1 is 16\.0s long\. Seedance 2\.0 accepts reference audio clips of 2-15s each and 15s in total'):
            self.check('Seedance 2.0', 16.0)

    def test_combined_length_is_limited_per_request(self):
        from .services.enqueue import ReferenceAudioRejected
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^The reference audio adds up to 40\.0s\.') as caught:
            self.check('Seedance 2.5', 20.0, 20.0)
        self.assertIsNone(caught.exception.audio_index)
        self.check('Seedance 2.0 Mini', 7.5, 7.5)

    def test_only_the_clips_the_prompt_sends_are_checked(self):
        from .services.enqueue import ReferenceAudioRejected
        # The worker sends only the @audioN clips the prompt names (resolve_references).
        self.check('Seedance 2.5', 1.0, 12.0, 12.0, 12.0, prompt='she says @audio2 then @audio4')
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^@audio3 is only 1\.0s long') as caught:
            self.check('Seedance 2.5', 12.0, 12.0, 1.0, prompt='@audio3 over @Audio1')
        self.assertEqual(caught.exception.audio_index, 3)
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^The reference audio adds up to 32\.0s\.'):
            self.check('Seedance 2.5', 16.0, 1.0, 16.0, prompt='@audio1 and @audio3')
        # A tag beyond the staged clips names none of them, so every clip is sent.
        with self.assertRaisesRegex(ReferenceAudioRejected, r'^@audio1 is only 1\.0s long'):
            self.check('Seedance 2.5', 1.0, 12.0, prompt='@audio9 and @audio1x')

    def test_provider_tolerance_and_valid_clips_pass(self):
        self.check('Seedance 2.5', 30.15)
        self.check('Seedance 2.5', 2.0, 28.0)
        self.check('Seedance 2.0', 1.9)

    def test_unmeasurable_clips_and_other_models_are_left_to_the_provider(self):
        from .services.enqueue import ReferenceAudioRejected
        self.check('Seedance 2.5', None)
        self.check('Seedance 2.5', 25.0, None, 25.0)
        with self.assertRaises(ReferenceAudioRejected):
            self.check('Seedance 2.5', None, 31.0)
        self.check('Higgsfield Seedance 2.0', 60.0)
        self.check('Seedance 2.5')


class AudioDurationProbeTests(SimpleTestCase):
    def wav(self, seconds, rate=8000):
        import wave
        buffer = io.BytesIO()
        with wave.open(buffer, 'wb') as out:
            out.setnchannels(1)
            out.setsampwidth(2)
            out.setframerate(rate)
            out.writeframes(b'\0\0' * int(seconds * rate))
        return buffer.getvalue()

    def test_measures_real_audio_and_reports_unknown_for_junk(self):
        import shutil
        from apps.media.audio_duration import audio_seconds
        if not shutil.which('ffprobe'):
            self.skipTest('ffprobe is not installed (the production image has it)')
        self.assertAlmostEqual(audio_seconds(self.wav(31.5)), 31.5, places=2)
        self.assertIsNone(audio_seconds(b'not audio at all'))
        self.assertIsNone(audio_seconds(b''))

    def test_missing_ffprobe_means_unknown(self):
        from apps.media.audio_duration import audio_seconds
        with patch('apps.media.audio_duration.shutil.which', return_value=None):
            self.assertIsNone(audio_seconds(self.wav(1)))
