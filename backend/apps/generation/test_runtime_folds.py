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
        with self.assertRaisesRegex(ValueError, 'not registered and Active'):
            self.convert(['/api/media/uploads/portrait/a'], lookup)

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
