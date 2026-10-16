"""New upload manifests cannot bypass actor, purpose or finalization gates."""
from datetime import timedelta
from uuid import uuid4

from django.test import TransactionTestCase
from django.utils import timezone

from apps.assets.models import Asset
from apps.generation.references import resolve_submission_references, InvalidReference
from apps.media.models import UploadSession
from apps.media.uploads import UploadError


class Goal2UploadManifestTests(TransactionTestCase):
    def session(self, actor, purpose='image-reference', ready=True):
        identifier = uuid4()
        return UploadSession.objects.create(id=identifier, actor_id=actor,
            key=f'uploads/{purpose}/{actor}-{identifier}', purpose=purpose,
            content_type='image/png' if purpose in ('image-reference', 'material') else 'video/quicktime',
            byte_size=20, expires_at=timezone.now() + timedelta(hours=1),
            finalized_at=timezone.now() if ready else None, state='ready' if ready else 'uploading')

    def test_same_actor_ready_manifest_and_url_both_resolve(self):
        actor = uuid4()
        row = self.session(actor)
        canonical = '/api/media/' + row.key
        for value in ({'referenceId': str(row.id)}, canonical):
            result = resolve_submission_references({'referenceImages': [value], 'firstFrame': value, 'image': value}, actor)
            self.assertEqual(result, {'referenceImages': [canonical], 'firstFrame': canonical, 'image': canonical})

    def test_other_actor_ready_upload_is_a_shared_reference(self):
        # Shared studio policy: any signed-in user may reference a READY upload.
        row = self.session(uuid4())
        canonical = '/api/media/' + row.key
        for value in ({'referenceId': str(row.id)}, canonical):
            self.assertEqual(resolve_submission_references({'referenceImages': [value]}, uuid4()), {'referenceImages': [canonical]})

    def test_other_actor_unready_or_wrong_purpose_upload_still_rejected(self):
        unready = self.session(uuid4(), ready=False)
        with self.assertRaises(UploadError) as caught:
            resolve_submission_references({'referenceImages': [{'referenceId': str(unready.id)}]}, uuid4())
        self.assertEqual(caught.exception.code, 'UPLOAD_NOT_READY')
        video = self.session(uuid4(), purpose='video-reference')
        with self.assertRaises(UploadError) as caught:
            resolve_submission_references({'referenceImages': [{'referenceId': str(video.id)}]}, uuid4())
        self.assertEqual(caught.exception.code, 'UPLOAD_PURPOSE_MISMATCH')

    def test_not_ready_and_wrong_media_purpose_fail(self):
        actor = uuid4()
        row = self.session(actor, ready=False)
        with self.assertRaises(UploadError) as caught:
            resolve_submission_references({'referenceImages': [{'referenceId': str(row.id)}]}, actor)
        self.assertEqual(caught.exception.code, 'UPLOAD_NOT_READY')
        row = self.session(actor, purpose='video-reference')
        with self.assertRaises(UploadError) as caught:
            resolve_submission_references({'referenceImages': ['/api/media/' + row.key]}, actor)
        self.assertEqual(caught.exception.code, 'UPLOAD_PURPOSE_MISMATCH')

    def test_published_shared_material_remains_readable_by_other_actor(self):
        actor = uuid4()
        row = self.session(actor, purpose='material')
        canonical = '/api/media/' + row.key
        Asset.objects.create(kind='style', name='Shared fixture', slug='shared-fixture',
            images=[canonical], created_at=1, updated_at=1)
        self.assertEqual(resolve_submission_references({'referenceImages': [canonical]}, uuid4()), {'referenceImages': [canonical]})
        # READY uploads are shared references whether passed by manifest or URL.
        self.assertEqual(resolve_submission_references({'referenceImages': [{'referenceId': str(row.id)}]}, uuid4()), {'referenceImages': [canonical]})

    def test_legacy_shared_reference_unchanged_and_invalid_manifest_actionable(self):
        actor = uuid4()
        original = {'referenceImages': ['/api/media/assets/legacy.png'], 'referenceVideos': ['/api/media/generated/legacy.mov']}
        self.assertEqual(resolve_submission_references(original, actor), original)
        for value in ({}, {'referenceId': 'bad'}):
            with self.assertRaises(InvalidReference):
                resolve_submission_references({'referenceImages': [value]}, actor)
