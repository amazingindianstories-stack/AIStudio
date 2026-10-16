"""Private archives cannot acquire shared-media capabilities or paid jobs."""
import json
import uuid
from unittest.mock import patch
from django.test import TransactionTestCase

from apps.authentication.models import User
from apps.authentication.session import sign_session
from apps.generation.models import Generation
from apps.generation.references import resolve_submission_references, InvalidReference
from .keys import is_export_key
from .grants import _encode, _signature, verify_media_grant


class PrivateExportBoundaryTests(TransactionTestCase):
    def test_encoded_cloud_and_thumbnail_archive_references_fail_before_queue_or_storage(self):
        actor = User.objects.create(email='archive-boundary@example.test', name='Fixture',
                                   role='user', password_hash='fixture', created_at=1)
        self.client.cookies['veevee_session'] = sign_session(actor)
        key = f'exports/{uuid.uuid4()}/{uuid.uuid4()}/1-private.zip'
        refs = ['/api/media/' + key, '/api/media/' + key.replace('exports', '%2565xports'),
                '/api/media/thumbs/512/' + key + '.webp',
                'https://storage.googleapis.com/private-fixture/' + key]
        for ref in refs:
            with self.subTest(ref=ref):
                with self.assertRaises(InvalidReference):
                    resolve_submission_references({'referenceVideos': [ref]}, actor.id)
                for kind in ('image', 'video'):
                    body = {'model': 'Seedance 2.5' if kind == 'video' else 'Nano Banana Pro',
                            'prompt': 'A harmless literal scene', 'resolution': '1080p',
                            'duration': 5, 'referenceVideos': [ref]}
                    with patch('apps.generation.enqueue_views.get_storage', side_effect=AssertionError('Storage reached before denial')):
                        response = self.client.post('/api/generate/' + kind, json.dumps(body), content_type='application/json',
                                                    HTTP_SEC_FETCH_SITE='same-origin')
                    self.assertEqual(response.status_code, 400)
                    self.assertEqual(Generation.objects.count(), 0)

    def test_prior_signed_archive_grant_is_not_an_authority_bypass(self):
        for key in ('exports/foreign/private.zip', 'thumbs/512/exports/foreign/private.zip.webp',
                    '%2565xports/foreign/private.zip', 'EXPORTS/foreign/private.zip'):
            self.assertTrue(is_export_key(key))
            payload = _encode(key.encode()) + '.9999999999999'
            token = payload + '.' + _signature(payload)
            self.assertIsNone(verify_media_grant(token, now=1000))
        self.assertFalse(is_export_key('generated/studio-shared.mov'))
