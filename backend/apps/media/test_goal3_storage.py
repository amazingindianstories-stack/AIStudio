"""Offline SDK signing and transport boundary regressions; no cloud clients."""
from datetime import timedelta
from unittest.mock import Mock
from django.test import SimpleTestCase
from .storage import (attachment_disposition, validate_gcs_session_uri, StorageService,
    GCSAdapter, S3Adapter, FileSystemAdapter, MemoryAdapter, MediaNotFoundError)
import tempfile


class ExportAttachmentTests(SimpleTestCase):
    def test_sdk_overrides_have_matching_disposition_and_five_minute_lifetime(self):
        name = 'Veevee_项目_é.zip'
        header = attachment_disposition(name)
        self.assertIn('filename="Veevee_', header)
        self.assertIn("filename*=UTF-8''Veevee_%E9%A1%B9%E7%9B%AE_%C3%A9.zip", header)
        client = Mock()
        blob = client.bucket.return_value.blob.return_value
        blob.generate_signed_url.return_value = 'https://storage.invalid/signed'
        StorageService(GCSAdapter(client, 'private')).signed_export_download_url('exports/job.zip', name)
        blob.generate_signed_url.assert_called_once_with(version='v4', expiration=timedelta(minutes=5),
            method='GET', response_disposition=header)
        s3 = Mock()
        StorageService(S3Adapter(s3, 'private')).signed_export_download_url('exports/job.zip', name)
        s3.generate_presigned_url.assert_called_once_with('get_object', Params={'Bucket':'private',
            'Key':'exports/job.zip', 'ResponseContentDisposition':header}, ExpiresIn=300)

    def test_invalid_names_never_reach_signer(self):
        adapter = Mock()
        for name in ('', '../x.zip', 'a/b.zip', 'a\\b.zip', 'x\r\nHeader: bad', 'x'*256):
            with self.assertRaises(ValueError):
                StorageService(adapter).signed_export_download_url('exports/job.zip', name)
        adapter.signed_download_url.assert_not_called()
        self.assertNotIn('"evil"', attachment_disposition('"evil".zip'))

    def test_filesystem_uses_local_attachment_and_preserves_original_bytes(self):
        with tempfile.TemporaryDirectory() as root:
            storage = StorageService(FileSystemAdapter(root))
            original = b'\x00\x00\x00\x18ftypqt  original-native-MOV'
            storage.upload_stream(__import__('io').BytesIO(original), 'exports/job.zip')
            self.assertIsNone(storage.signed_export_download_url('exports/job.zip', 'Veevee.zip'))
            self.assertEqual(storage.read('exports/job.zip'), original)

    def test_missing_only_fallback_and_ordinary_signer_contract(self):
        primary, fallback = Mock(), Mock()
        primary.open.side_effect = MediaNotFoundError()
        storage = StorageService(primary, fallback)
        storage.signed_export_download_url('exports/job.zip', 'Veevee.zip')
        fallback.signed_download_url.assert_called_once_with('exports/job.zip', 'Veevee.zip',
            attachment_disposition('Veevee.zip'))
        for error in (PermissionError(), TimeoutError()):
            primary.open.side_effect = error
            with self.assertRaises(type(error)):
                storage.signed_export_download_url('exports/job.zip', 'Veevee.zip')
        fallback.signed_download_url.reset_mock()
        storage = StorageService(fallback)
        storage.signed_download_url('generated/master.mov', 'master.mov', 'inline')
        fallback.signed_download_url.assert_called_once_with('generated/master.mov', 'master.mov', 'inline')

    def test_native_session_authority_is_checked_without_fetch(self):
        self.assertEqual(validate_gcs_session_uri('https://storage.googleapis.com/upload?id=opaque'),
            'https://storage.googleapis.com/upload?id=opaque')
        for url in ('http://storage.googleapis.com/x', 'https://attacker.example/x',
                    'https://storage.googleapis.com@attacker.example/x',
                    'https://storage.googleapis.com:444/x', 'https://storage.googleapis.com/x#fragment'):
            with self.assertRaises(ValueError):
                validate_gcs_session_uri(url)
