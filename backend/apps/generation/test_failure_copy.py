from types import SimpleNamespace

from django.test import SimpleTestCase, override_settings

from apps.assets import managed_pool
from . import failure_copy as copy
from .image_limits import SEEDANCE_MESSAGE, SIZE_TAIL, WORKER_TAIL, seedance_message
from .providers import kling, seedance, seedream
from .services import portrait_prepare, video_execution

FORBIDDEN = ('arn:', 'amazonaws', 'googleapis', 'asset-20', 'ep-2', 'Request id', 'sk-', 'private-fixture', 'BytePlus', 'users')


def row(kind='video', model='Seedance 2.5', blocked=None):
    return SimpleNamespace(kind=kind, model=model, moderation_blocked=blocked)


GENERIC_VIDEO = copy.GENERIC['video']
SEEDANCE_CASES = (
    ("BytePlus rejected the reference image — its privacy / anti-deepfake filter flags photorealistic faces (it can't tell an AI-generated face from a real one).", copy.FACE_GALLERY),
    ('Seedance error (400 InputImageSensitiveContentDetected.PrivacyInformation): The request failed because the input image may contain real person. Request id: 0217abc', copy.FACE_GALLERY),
    ('The request failed because the output audio may be related to copyright restrictions. Request id: 0217abcdef', copy.COPYRIGHT),
    ('The request failed because the output video may be related to copyright restrictions.', copy.COPYRIGHT),
    ('permission denied for table users', GENERIC_VIDEO),
    ('Generation timed out — the server process was interrupted.', copy.INTERRUPTED),
    ("name 'provider_asset_projection' is not defined", GENERIC_VIDEO),
    ('Generation exceeded the 270-second internal deadline.', 'Generation exceeded the 270-second internal deadline.'),
    ("('Connection aborted.', TimeoutError('The write operation timed out'))", copy.DROPPED),
    ('This Gallery portrait is not registered and Active in BytePlus. Register and verify the existing portrait before Seedance submission; no generation was submitted', copy.PORTRAIT_UNREGISTERED),
    ('An error occurred (AccessDenied) when calling the PutObject operation: User: arn:aws:iam::123456789012:user/x is not authorized', GENERIC_VIDEO),
    ("Failed to parse: '[SENSITIVE]' is not a valid host or port", GENERIC_VIDEO),
    ('Omni status error (400).', GENERIC_VIDEO),
    ('Seedance error (404 InvalidEndpointOrModel.NotFound): The model or endpoint ep-20260101-abcde does not exist or you do not have access to it.', copy.UNAVAILABLE),
    ('Seedance error (400 InvalidParameter): The parameter `content[12].image_url.url` specified in the request is not valid: The specified asset asset-2026abcd is not found', copy.PORTRAIT_ASSET),
    ('Seedance error (400 InvalidParameter): the specified parameter draft is not supported for model ep-2026 in t2v', copy.DRAFT),
    ('The parameters `ratio` and `duration` specified in the request are not valid. Seedance identified your task as video editing ...', copy.RATIO_DURATION),
    ('Seedance error (400 InvalidParameter): The parameter `content[3]` specified in the request is not valid: the parameter audio duration (seconds) ...', copy.AUDIO),
    ('fetch failed', copy.DROPPED),
    ('request to https://storage.googleapis.com/bucket/x failed, reason: socket hang up', copy.DROPPED),
    ('Reauthentication is needed. Please run `gcloud auth application-default login` to reauthenticate.', copy.UNAVAILABLE),
    ('Kling /v1/images/generations failed (http 429, code 1102): Account balance not enough', copy.BUSY),
    ('Seedream rate limit reached. Try again later. (429, RateLimitExceeded)', copy.BUSY),
    ('Seedance error (400 InputTextSensitiveContentDetected): bad text', copy.POLICY),
    ('Provider response deadline exceeded.', copy.DROPPED),
    ('', GENERIC_VIDEO),
)
IMAGE_CASES = (
    ('Gemini image error (400): {"error": {"message": "API key not valid. Please pass a valid API key.", "reason": "API_KEY_INVALID"}}', copy.UNAVAILABLE),
    ('Gemini returned no image (PROHIBITED_CONTENT).', copy.POLICY),
    ('Gemini returned no image (no candidates).', copy.NO_IMAGE),
    ('Seedream rejected the request. Check reference files and content requirements. (400, OutputImageSensitiveContentDetected.PolicyViolation)', copy.POLICY),
    ('Seedream rejected the request. Check reference files and content requirements. (400, InvalidParameter)', copy.IMAGE_REJECTED),
    ('Seedream connection ended without a confirmed result. The request was not resubmitted.', copy.DROPPED),
    ('Something unexpected', copy.GENERIC['image']),
)


class FailureCopyTests(SimpleTestCase):
    def check(self, item, diagnostic, expected):
        message = copy.public_message(item, diagnostic)
        self.assertEqual(message, diagnostic if expected is None else expected)
        for fragment in FORBIDDEN:
            self.assertNotIn(fragment, message)
        self.assertNotIn('—', message)

    def test_seedance_failures_become_plain_copy(self):
        for diagnostic, expected in SEEDANCE_CASES:
            with self.subTest(diagnostic=diagnostic[:60]):
                self.check(row(), diagnostic, expected)

    def test_image_failures_become_plain_copy(self):
        for diagnostic, expected in IMAGE_CASES:
            with self.subTest(diagnostic=diagnostic[:60]):
                self.check(row('image', 'Nano Banana Pro'), diagnostic, expected)

    def test_retry_promise_only_when_the_face_was_learned(self):
        diagnostic = 'Seedance error (400 InputImageSensitiveContentDetected.PrivacyInformation): real person'
        for managed in (True, False):
            with self.subTest(managed=managed), override_settings(VEEVEE_MANAGED_PORTRAITS=managed):
                self.assertEqual(copy.public_message(row(), diagnostic), copy.FACE_GALLERY)
                self.assertEqual(copy.public_message(row(), seedance.MODERATION_MESSAGE), copy.FACE_GALLERY)
                self.assertEqual(copy.public_message(row(), portrait_prepare.REJECTED_MESSAGE), portrait_prepare.REJECTED_MESSAGE)

    def test_curated_messages_pass_through_verbatim(self):
        for message in (
            portrait_prepare.REJECTED_MESSAGE, seedance.TEXT_POLICY_MESSAGE, seedance.NEUTRAL_POLICY_MESSAGE,
            seedream.AMBIGUOUS_MESSAGE, seedream.DOWNLOAD_FAILED_MESSAGE, seedream.NO_RESULT_MESSAGE,
            video_execution.FACE_NOT_READY, video_execution.LOOKUP_UNAVAILABLE,
            managed_pool.PORTRAIT_UNPREPARED + managed_pool.NOT_CHARGED,
            managed_pool.PORTRAIT_REFUSED + managed_pool.NOT_CHARGED, managed_pool.PORTRAIT_MISSING,
            managed_pool.PORTRAIT_BUSY.format(minutes=10),
            'Portrait "Ana" was removed from the Portrait Gallery. ' + video_execution.PORTRAIT_REMOVE_TAIL,
            'A Gallery portrait is not ready for video yet. ' + video_execution.PORTRAIT_REMOVE_TAIL,
            'Reference image could not be converted to JPEG for Seedance (was image/heic).',
            'Provider reported success but returned no video.', 'All candidates failed to generate.',
            "Kling Image 3.0 accepts 1 reference image, but this prompt resolved to 3 (@img1, @img2, @img3). Kling's multi-reference mode is a different model (kling-v3-omni) that is not available here - use Nano Banana Pro for multi-reference prompts, or reduce this one to a single reference.",
            'Too many reference images: 15. Nano Banana Pro accepts at most 14 images per prompt - remove 1.',
            seedance_message('@img2', 200, 900, SIZE_TAIL), seedance_message('The first frame', 200, 900, WORKER_TAIL),
        ):
            with self.subTest(message=message[:60]):
                self.assertEqual(copy.public_message(row(), message), message)

    def test_no_public_message_names_the_provider_company(self):
        exact, _ = copy._curated()
        for message in sorted(exact):
            with self.subTest(message=message[:60]):
                self.assertNotIn('BytePlus', copy.public_message(row(), message))
        for name, value in vars(copy).items():
            if isinstance(value, str) and name.isupper():
                self.assertNotIn('BytePlus', value, name)
        for value in copy.GENERIC.values():
            self.assertNotIn('BytePlus', value)
        for message in (seedance.TEXT_POLICY_MESSAGE, seedance.NEUTRAL_POLICY_MESSAGE):
            self.assertNotIn('BytePlus', message)
            self.assertEqual(copy.public_message(row(), message), message)

    def test_gemini_omni_flash_1_1_failures(self):
        omni = row('video', 'Gemini Omni Flash 1.1')
        for diagnostic, expected in (
            ('Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.', None),
            ('Gemini Omni Flash 1.1 supports 360p/720p only (got 1080p).', GENERIC_VIDEO),
            ('Omni create error (429): {"error": {"code": 429, "message": "Resource exhausted.", "status": "RESOURCE_EXHAUSTED"}}', copy.BUSY),
            ('Omni create error (400): {"error": {"code": 400, "message": "Request contains an invalid argument.", "status": "INVALID_ARGUMENT"}}', GENERIC_VIDEO),
            ('Omni create error (403): {"error": {"message": "Method doesn\'t allow unregistered callers", "status": "PERMISSION_DENIED"}}', copy.UNAVAILABLE),
            ('The prompt was blocked by safety filters.', copy.POLICY),
            ('Omni generation ended with status "budget_exceeded".', GENERIC_VIDEO),
            ('Omni completed but returned no video (no inline data or uri).', copy.NO_VIDEO),
            ('Too many reference images: 15. Gemini Omni Flash 1.1 accepts at most 14 images per prompt \u2014 remove 1.',
             'Too many reference images: 15. Gemini Omni Flash 1.1 accepts at most 14 images per prompt - remove 1.'),
        ):
            with self.subTest(diagnostic=diagnostic[:60]):
                self.check(omni, diagnostic, expected)

    def test_em_dash_in_adapter_messages_is_shown_as_a_plain_dash(self):
        text = 'Too many reference images: 15. Nano Banana Pro accepts at most 14 images per prompt \u2014 remove 1.'
        self.assertEqual(copy.public_message(row('image', 'Nano Banana Pro'), text), text.replace('\u2014', '-'))
        kling_text = ('Kling Image 3.0 cannot render 2K from a reference image \u2014 Kling rejects it with "resolution value \'2k\' is not supported". Drop to 1K.')
        self.assertNotIn('\u2014', copy.public_message(row('image', 'Kling Image 3.0'), kling_text))
        self.assertTrue(copy.public_message(row('image', 'Kling Image 3.0'), kling_text).startswith('Kling Image 3.0 cannot render 2K'))

    def test_real_provider_validation_messages_are_allowlisted(self):
        for build in (
            lambda: kling.prep_reference('image/png', _png(240, 180)),
            lambda: kling.prep_reference('image/png', _png(1000, 200)),
        ):
            with self.assertRaises(ValueError) as raised:
                build()
            self.assertEqual(copy.public_message(row('image', 'Kling Image 3.0'), str(raised.exception)), str(raised.exception))

    def test_moderation_blocked_without_a_classifiable_diagnostic(self):
        message = copy.public_message(row(blocked=True), 'private-fixture-token')
        self.assertEqual(message, copy.MODERATION_BLOCKED)
        self.assertIn('provider moderation', message)

    def test_kinds_get_their_own_generic_copy(self):
        for item, expected in ((row('depth', 'Depth Anything (Local)'), copy.GENERIC['depth']),
                               (row('audio', 'Gemini (gemini-2.5-flash)'), copy.GENERIC['audio']),
                               (row('image', 'Magnific Precision V2'), copy.UPSCALE_FAILED)):
            self.assertEqual(copy.public_message(item, 'name error NameError x'), expected)
        self.assertEqual(copy.public_message(row('image', 'Magnific Precision V2'), 'Upscaler precision failed — creative: terminal_failure — 400 x'), copy.UPSCALE_FAILED)
        self.assertEqual(copy.public_message(row('image', 'Magnific Precision V2'), 'permission denied for table users'), copy.GENERIC['upscale'])

    def test_curated_copy_has_no_em_dash_and_seedance_pattern_is_anchored(self):
        for value in (*vars(copy).values(),):
            if isinstance(value, str):
                self.assertNotIn('—', value)
        self.assertIsNone(SEEDANCE_MESSAGE.fullmatch('x is 1 x 2 px. Seedance something else. ' + SIZE_TAIL))


def _png(width, height):
    import base64
    import io
    from PIL import Image
    out = io.BytesIO()
    Image.new('RGB', (width, height)).save(out, format='PNG')
    return base64.b64encode(out.getvalue()).decode()
