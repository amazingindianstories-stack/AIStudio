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
