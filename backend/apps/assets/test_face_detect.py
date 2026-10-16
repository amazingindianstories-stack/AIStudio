"""Local face detector: real face found, no face in a landscape, failures fail closed."""
import io
from pathlib import Path

from django.test import SimpleTestCase
from PIL import Image, ImageDraw

from . import face_detect

FACE = (Path(__file__).resolve().parents[2] / 'testsupport' / 'data' / 'face_public_domain.jpg').read_bytes()


def png(draw=None, size=(800, 500)):
    image = Image.new('RGB', size, (90, 130, 170))
    if draw:
        draw(ImageDraw.Draw(image))
    out = io.BytesIO()
    image.save(out, format='PNG')
    return out.getvalue()


class FaceDetectTests(SimpleTestCase):
    def test_public_domain_portrait_has_a_face(self):
        result = face_detect.scan(FACE)
        self.assertEqual((result['has_face'], result['faces'], result['error']), (True, 1, None))

    def test_landscape_has_no_face(self):
        self.assertEqual(face_detect.scan(png(lambda d: d.rectangle((100, 300, 700, 480), fill=(60, 90, 40))))['has_face'], False)

    def test_unreadable_or_oversized_input_fails_closed(self):
        self.assertTrue(face_detect.scan(b'not an image')['has_face'])
        self.assertTrue(face_detect.scan(b'')['has_face'])

    def test_model_checksum_is_enforced(self):
        face_detect._verified = False
        original = face_detect.MODEL_SHA256
        try:
            face_detect.MODEL_SHA256 = '0' * 64
            self.assertTrue(face_detect.scan(FACE)['error'])   # refuses an unexpected model, fails closed
        finally:
            face_detect.MODEL_SHA256 = original
            face_detect._verified = False

    def test_generation_worker_refuses_to_start_without_the_packaged_model(self):
        from django.test import override_settings
        from apps.generation.services import portrait_prepare
        self.assertTrue(face_detect.MODEL_PATH.is_file(), 'the model ships with the code (Dockerfile.dockerignore)')
        face_detect._verified = False
        original = face_detect.MODEL_SHA256
        try:
            face_detect.MODEL_SHA256 = '0' * 64
            with override_settings(VEEVEE_MANAGED_PORTRAITS=False):
                portrait_prepare.check_ready()          # flag off: no requirement
            with override_settings(VEEVEE_MANAGED_PORTRAITS=True), self.assertRaises(RuntimeError):
                portrait_prepare.check_ready()
        finally:
            face_detect.MODEL_SHA256 = original
            face_detect._verified = False
        with override_settings(VEEVEE_MANAGED_PORTRAITS=True):
            portrait_prepare.check_ready()
