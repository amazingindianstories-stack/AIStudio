"""Only a Seedance rejection of an input image as a real person teaches the face scan."""
import json

from django.test import SimpleTestCase

from .providers import seedance
from .services import portrait_prepare

IMAGE = 'InputImageSensitiveContentDetected.PrivacyInformation'


class PrivacyRejectionTests(SimpleTestCase):
    def test_the_input_image_privacy_code_decides(self):
        self.assertTrue(portrait_prepare.privacy_rejection('x', {'error': {'code': IMAGE}}))
        self.assertTrue(portrait_prepare.privacy_rejection(None, {'data': {'error': {'code': IMAGE, 'message': ''}}}))

    def test_other_codes_never_learn_whatever_their_wording_says(self):
        for code in ('OutputVideoSensitiveContentDetected', 'OutputAudioSensitiveContentDetected', 'InputAudioSensitiveContentDetected',
                     'InputTextSensitiveContentDetected.PrivacyInformation', 'InputImageSensitiveContentDetected', 'InternalServiceError'):
            with self.subTest(code=code):
                raw = {'error': {'code': code, 'message': 'The request failed because the input image may contain real person.'}}
                self.assertFalse(portrait_prepare.privacy_rejection('The request failed because the input image may contain real person.', raw))

    def test_without_a_code_only_the_input_image_wording_counts(self):
        self.assertTrue(portrait_prepare.privacy_rejection('The request failed because the input image may contain real person.'))
        self.assertTrue(portrait_prepare.privacy_rejection('The input image may violate privacy rules.', {'status': 'failed'}))
        for text in ('The request failed because the output video may contain real person.',
                     'The request failed because the output video may contain privacy information.',
                     'The request failed because the input audio may contain privacy information.',
                     'The request failed because the input text may contain sensitive information.',
                     'Portrait registration lookup unavailable; submission stopped before provider execution.',
                     'The portrait could not be prepared.', 'real person', 'privacy', ''):
            with self.subTest(text=text):
                self.assertFalse(portrait_prepare.privacy_rejection(text))

    def test_a_create_time_rejection_keeps_the_provider_code_for_learning(self):
        body = json.dumps({'error': {'code': IMAGE, 'message': 'The request failed because the input image may contain real person.'}})
        error = seedance.friendly_error(400, body)
        self.assertEqual((error.code, error.upstream_code), ('moderation', IMAGE))
        self.assertTrue(portrait_prepare.privacy_rejection(str(error), {'error': {'code': error.upstream_code}}))
        output = seedance.friendly_error(400, json.dumps({'error': {'code': 'OutputVideoSensitiveContentDetected', 'message': 'privacy'}}))
        self.assertFalse(portrait_prepare.privacy_rejection(str(output), {'error': {'code': output.upstream_code}}))
