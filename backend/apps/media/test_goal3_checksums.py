"""Offline source-integrity metadata and overwrite-precondition contracts."""
import base64
import hashlib
import io
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock
from django.test import SimpleTestCase

from .storage import FileSystemAdapter, GCSAdapter, S3Adapter


class SourceChecksumTests(SimpleTestCase):
    def test_filesystem_expected_digest_survives_same_length_corruption_and_range_has_no_whole_digest(self):
        with TemporaryDirectory() as directory:
            storage = FileSystemAdapter(directory)
            original = b'native-MOV-original'
            storage.put_stream('generated/master.mov', io.BytesIO(original), 'video/quicktime', 'private')
            Path(directory, 'objects/generated/master.mov').write_bytes(b'X' * len(original))
            media = storage.open('generated/master.mov')
            self.assertEqual(media.sha256, hashlib.sha256(original).hexdigest())
            self.assertNotEqual(hashlib.sha256(b''.join(media.stream)).hexdigest(), media.sha256)
            part = storage.open('generated/master.mov', 'bytes=0-2')
            self.assertIsNone(part.sha256)
            part.stream.close()

    def test_gcs_full_checksum_from_reloaded_generation_and_no_range_false_comparison(self):
        blob = SimpleNamespace(size=6, content_type='video/quicktime', crc32c='crc-fixture',
                               reload=Mock(), open=Mock(side_effect=lambda *args, **kwargs: io.BytesIO(b'master')))
        client = Mock()
        client.bucket.return_value.blob.return_value = blob
        storage = GCSAdapter(client, 'private-fixture')
        media = storage.open('generated/master.mov')
        self.assertEqual(media.crc32c, 'crc-fixture')
        self.assertEqual(b''.join(media.stream), b'master')
        self.assertEqual(blob.reload.call_count, 1)
        part = storage.open('generated/master.mov', 'bytes=1-2')
        self.assertIsNone(part.crc32c)
        part.stream.close()

    def test_s3_generation_precondition_and_full_hash_never_treat_composite_as_whole_hash(self):
        data = b'legacy-native-MOV'
        digest = base64.b64encode(hashlib.sha256(data).digest()).decode()
        client = Mock()
        client.head_object.return_value = {'ContentLength':len(data), 'ETag':'"original-etag"'}
        client.get_object.side_effect = lambda **kwargs: {'Body':io.BytesIO(data),
            'ContentType':'video/quicktime', 'ChecksumType':'FULL_OBJECT', 'ChecksumSHA256':digest}
        storage = S3Adapter(client, 'legacy-fixture')
        media = storage.open('generated/master.mov')
        self.assertEqual(media.sha256, hashlib.sha256(data).hexdigest())
        self.assertEqual(b''.join(media.stream), data)
        client.get_object.assert_called_with(Bucket='legacy-fixture', Key='generated/master.mov', IfMatch='"original-etag"')
        client.head_object.return_value['VersionId'] = 'immutable-version'
        client.get_object.side_effect = lambda **kwargs: {'Body':io.BytesIO(data), 'ChecksumType':'COMPOSITE', 'ChecksumSHA256':digest}
        media = storage.open('generated/master.mov')
        self.assertIsNone(media.sha256)
        media.stream.close()
        client.get_object.assert_called_with(Bucket='legacy-fixture', Key='generated/master.mov', VersionId='immutable-version')
