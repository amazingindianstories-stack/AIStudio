"""PrefixedGCSAdapter: namespaced writes, legacy-compatible reads, signed URL cache."""
import io
from django.test import SimpleTestCase
from .storage import MediaNotFoundError, PrefixedGCSAdapter

PREFIX = 'private-namespace-0001/'


class Missing(Exception):
    code = 404


class FakeBlob:
    def __init__(self, store, name):
        self.store, self.name = store, name
        self.cache_control = None
        self.content_type = None
        self.size = None
        self.crc32c = None

    def reload(self, timeout=None):
        if self.name not in self.store.objects:
            raise Missing(self.name)
        data, content_type = self.store.objects[self.name]
        self.size, self.content_type = len(data), content_type

    def open(self, mode, chunk_size=None, timeout=None):
        return io.BytesIO(self.store.objects[self.name][0])

    def upload_from_string(self, data, content_type=None, checksum=None, timeout=None, if_generation_match=None):
        if if_generation_match == 0 and self.name in self.store.objects:
            error = Exception('exists')
            error.code = 412
            raise error
        self.store.objects[self.name] = (bytes(data), content_type)

    def delete(self, timeout=None):
        self.store.objects.pop(self.name, None)

    def generate_signed_url(self, **options):
        self.store.signed += 1
        return f"https://storage.invalid/{self.name}?expires={options['expiration'].total_seconds():.0f}&n={self.store.signed}"


class FakeClient:
    def __init__(self):
        self.objects = {}
        self.signed = 0
        self._credentials = object()

    def bucket(self, name):
        client = self

        class Bucket:
            def blob(self, key):
                return FakeBlob(client, key)
        return Bucket()


class PrefixedStorageTests(SimpleTestCase):
    def adapter(self):
        client = FakeClient()
        return client, PrefixedGCSAdapter(client, 'bucket', prefix=PREFIX)

    def test_writes_are_namespaced_and_reads_fall_back_from_legacy_keys(self):
        client, adapter = self.adapter()
        client.objects['generated/legacy.mov'] = (b'legacy-mov', 'video/quicktime')
        adapter.put('generated/new.png', b'new', 'image/png', 'private')
        self.assertIn(PREFIX + 'generated/new.png', client.objects)
        self.assertNotIn('generated/new.png', client.objects)
        legacy = adapter.open('generated/legacy.mov')
        self.assertEqual(b''.join(legacy.stream), b'legacy-mov')
        self.assertEqual(legacy.content_type, 'video/quicktime')
        self.assertEqual(b''.join(adapter.open('generated/new.png').stream), b'new')
        self.assertEqual(adapter.read_key('generated/legacy.mov'), 'generated/legacy.mov')
        self.assertEqual(adapter.read_key('generated/new.png'), PREFIX + 'generated/new.png')
        with self.assertRaises(MediaNotFoundError):
            adapter.open('generated/missing.png')

    def test_create_only_and_invalid_keys(self):
        client, adapter = self.adapter()
        self.assertTrue(adapter.put_create_only('thumbs/512/a.png.webp', b'x', 'image/webp', 'private'))
        self.assertFalse(adapter.put_create_only('thumbs/512/a.png.webp', b'y', 'image/webp', 'private'))
        self.assertEqual(client.objects[PREFIX + 'thumbs/512/a.png.webp'][0], b'x')
        for bad in ('/abs', 'a/../b', 'a//b', 'a/./b'):
            with self.assertRaises(ValueError):
                adapter.private_key(bad)

    def test_browser_urls_are_short_lived_and_briefly_cached(self):
        client, adapter = self.adapter()
        client.objects[PREFIX + 'generated/a.png'] = (b'a', 'image/png')
        first = adapter.browser_url('generated/a.png')
        self.assertEqual(adapter.browser_url('generated/a.png'), first)
        self.assertIn('expires=900', first)
        self.assertIn(PREFIX + 'generated/a.png', first)
        self.assertEqual(client.signed, 1)
        adapter._read_cache.clear()
        self.assertNotEqual(adapter.browser_url('generated/a.png'), first)
