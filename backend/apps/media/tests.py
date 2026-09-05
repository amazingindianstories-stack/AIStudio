from django.test import Client, TestCase, override_settings

from apps.common.test_utils import SECRET, _cookie_for, _make_user

from . import media_derivatives as md
from . import media_grant, storage
from .media_sniff import extension_from_bytes


class ParseRangeTests(TestCase):
    """Direct port of the parseRange() cases in storage.js — see that
    file's `_RANGE_RE`/parse_range for the byte-range grammar."""

    def test_simple_range(self):
        self.assertEqual(storage.parse_range("bytes=0-99", 1000), (0, 99))

    def test_open_ended_range(self):
        self.assertEqual(storage.parse_range("bytes=500-", 1000), (500, 999))

    def test_suffix_range(self):
        self.assertEqual(storage.parse_range("bytes=-100", 1000), (900, 999))

    def test_end_clamped_to_size(self):
        self.assertEqual(storage.parse_range("bytes=0-9999", 1000), (0, 999))

    def test_malformed_header_rejected(self):
        with self.assertRaises(storage.InvalidMediaRangeError):
            storage.parse_range("not-a-range", 1000)

    def test_start_past_size_rejected(self):
        with self.assertRaises(storage.InvalidMediaRangeError):
            storage.parse_range("bytes=2000-", 1000)

    def test_zero_size_rejected(self):
        with self.assertRaises(storage.InvalidMediaRangeError):
            storage.parse_range("bytes=0-10", 0)


class MediaDerivativesRoundTripTests(TestCase):
    def test_thumb_key_round_trips_through_original_key_from_thumb(self):
        original = "assets/abc-123.png"
        key = md.thumb_key(original, 512)
        self.assertEqual(md.original_key_from_thumb(key), {"key": original, "width": 512})

    def test_protected_prefix_detected_through_thumb_namespace(self):
        """thumbs/512/settings/token.json.webp starts with 'thumbs/', so a
        naive prefix check on the raw key would say 'allowed' — the object
        it names lives under settings/. is_protected_media_key must see
        through the thumbnail namespace, matching storage.js's isProtectedMediaKey."""
        self.assertTrue(storage.is_protected_media_key("settings/token.json"))
        self.assertTrue(storage.is_protected_media_key("thumbs/512/settings/token.json.webp"))
        self.assertTrue(storage.is_protected_media_key("migrations/dump.sql"))
        self.assertFalse(storage.is_protected_media_key("assets/abc-123.png"))
        self.assertFalse(storage.is_protected_media_key("thumbs/512/assets/abc-123.png.webp"))


@override_settings(AUTH_SECRET=SECRET)
class MediaGrantTests(TestCase):
    def test_round_trip(self):
        token = media_grant.sign_media_grant("assets/abc.png")
        self.assertEqual(media_grant.verify_media_grant(token), "assets/abc.png")

    def test_protected_prefix_refused_at_mint(self):
        with self.assertRaises(ValueError):
            media_grant.sign_media_grant("settings/token.json")

    def test_tampered_token_rejected(self):
        token = media_grant.sign_media_grant("assets/abc.png")
        parts = token.split(".")
        tampered = f"{parts[0]}.{parts[1]}.notarealsig"
        self.assertIsNone(media_grant.verify_media_grant(tampered))

    def test_expired_token_rejected(self):
        token = media_grant.sign_media_grant("assets/abc.png", ttl_seconds=-1)
        self.assertIsNone(media_grant.verify_media_grant(token))

    def test_none_and_malformed_rejected(self):
        self.assertIsNone(media_grant.verify_media_grant(None))
        self.assertIsNone(media_grant.verify_media_grant("not.enough.parts.here"))
        self.assertIsNone(media_grant.verify_media_grant(""))


@override_settings(AUTH_SECRET=SECRET)
class MediaRouteAuthTests(TestCase):
    """Auth/denylist behavior only — the happy-path object read is verified
    live against production S3 (see the backend/ section of CLAUDE.md),
    not re-mocked here."""

    def setUp(self):
        self.client = Client()
        self.user = _make_user()

    def test_unauthenticated_request_401s_before_any_storage_call(self):
        resp = self.client.get("/api/media/assets/whatever.png")
        self.assertEqual(resp.status_code, 401)

    def test_protected_prefix_404s_even_when_authenticated(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))
        resp = self.client.get("/api/media/settings/token.json")
        self.assertEqual(resp.status_code, 404)

    def test_media_grant_rejects_bad_token_without_auth(self):
        resp = self.client.get("/api/media-grant?t=garbage")
        self.assertEqual(resp.status_code, 403)


class ExtensionFromBytesTests(TestCase):
    """Port of src/lib/media-sniff.test.js — keep both in sync. Regression
    coverage for BUG-03: the download-zip route used to sniff nothing at all
    (a hardcoded None content-type) and fall through to guessing from the
    URL, which is ".bin" for the common case of an extensionless storage
    key."""

    def test_png_signature(self):
        b = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])
        self.assertEqual(extension_from_bytes(b, "https://x/abc123"), "png")

    def test_jpeg_signature(self):
        b = bytes([0xFF, 0xD8, 0xFF, 0xE0, 0, 0, 0, 0])
        self.assertEqual(extension_from_bytes(b, "https://x/abc123"), "jpg")

    def test_webp_signature(self):
        b = bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
        self.assertEqual(extension_from_bytes(b, "https://x/abc123"), "webp")

    def test_riff_non_webp_not_misdetected(self):
        b = bytes([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45])  # WAVE
        self.assertNotEqual(extension_from_bytes(b, "https://x/abc123"), "webp")

    def test_gif_signature(self):
        b = bytes([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0])
        self.assertEqual(extension_from_bytes(b, "https://x/abc123"), "gif")

    def test_avif_brand(self):
        b = bytes([0, 0, 0, 0x1C, 0x66, 0x74, 0x79, 0x70, 0x61, 0x76, 0x69, 0x66, 0, 0])
        self.assertEqual(extension_from_bytes(b, "https://x/abc123"), "avif")

    def test_extensionless_uuid_key_with_unrecognised_bytes_falls_back_to_bin(self):
        b = bytes([1, 2, 3, 4, 5, 6, 7, 8])
        self.assertEqual(
            extension_from_bytes(b, "https://x/media/9f2c-uuid-with-no-extension"), "bin"
        )

    def test_unrecognised_bytes_fall_back_to_real_url_extension(self):
        b = bytes([1, 2, 3, 4, 5, 6, 7, 8])
        self.assertEqual(
            extension_from_bytes(b, "https://x/media/thing.png?token=abc"), "png"
        )

    def test_too_short_buffer_never_raises(self):
        self.assertEqual(extension_from_bytes(b"", "https://x/abc"), "bin")
        self.assertEqual(extension_from_bytes(bytes([0x89]), "https://x/abc"), "bin")
