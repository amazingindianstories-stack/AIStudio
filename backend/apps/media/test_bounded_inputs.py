import base64
from unittest.mock import Mock, patch
from django.test import SimpleTestCase
from .storage import StorageService, MemoryAdapter, MediaObject, MediaTooLargeError


class BoundedInputTests(SimpleTestCase):
    def test_byte_reader_preserves_original_without_encoding_and_retains_limits(self):
        data = b'\x00\xfforiginal'
        encoded = base64.b64encode(data).decode()
        store = StorageService(MemoryAdapter())
        ref = store.upload_buffer(data,'uploads/reference.png','png')
        for source in (ref,'data:image/png;base64,'+encoded):
            with self.subTest(source=source), patch('apps.media.storage.base64.b64encode',side_effect=AssertionError('must not encode')):
                self.assertEqual(store.read_reference_bytes(source,max_bytes=len(data)),{'mimeType':'image/png','bytes':data})
                with self.assertRaises(MediaTooLargeError):
                    store.read_reference_bytes(source,max_bytes=len(data)-1)
        self.assertEqual(store.read_as_base64(ref),{'mimeType':'image/png','data':encoded})

    def test_byte_reader_closes_declared_and_actual_oversize_streams(self):
        for declared in (6,1):
            with self.subTest(declared=declared):
                visited,closed = [],[]
                class Stream:
                    def __iter__(self):
                        visited.append(True)
                        yield b'abcdef'
                    def close(self):closed.append(True)
                adapter = Mock()
                adapter.open.return_value = MediaObject(Stream(),'image/png',declared)
                with self.assertRaises(MediaTooLargeError):
                    StorageService(adapter).read_reference_bytes('/api/media/uploads/reference.png',max_bytes=5)
                self.assertEqual(closed,[True])
                self.assertEqual(visited,[] if declared==6 else [True])

    def test_declared_oversize_is_rejected_before_iteration_and_closed(self):
        stream=Mock()
        adapter=Mock()
        adapter.open.return_value=MediaObject(stream,'audio/wav',16*1024*1024)
        with self.assertRaises(MediaTooLargeError):
            StorageService(adapter).read_as_base64('/api/media/uploads/large.wav',max_bytes=15*1024*1024)
        stream.close.assert_called_once()
        self.assertFalse(stream.mock_calls[:-1])

    def test_actual_bytes_enforce_limit_even_when_declared_length_is_false(self):
        closed=[]
        class Stream:
            def __iter__(self):yield b'abc';yield b'def'
            def close(self):closed.append(True)
        adapter=Mock()
        adapter.open.return_value=MediaObject(Stream(),'image/png',3)
        with self.assertRaises(MediaTooLargeError):
            StorageService(adapter).read_as_base64('/api/media/uploads/large.png',max_bytes=5)
        self.assertEqual(closed,[True])

    def test_exact_data_url_limit_and_oversize_reject_before_decode(self):
        store=StorageService(Mock())
        self.assertEqual(store.read_as_base64('data:audio/wav;base64,YWJj',max_bytes=3)['data'],'YWJj')
        from unittest.mock import patch
        with patch('apps.media.storage.base64.b64decode') as decode:
            with self.assertRaises(MediaTooLargeError):
                store.read_as_base64('data:audio/wav;base64,YWJjZA==',max_bytes=3)
            decode.assert_not_called()

    def test_remote_per_read_cap_rejects_headers_and_chunks_without_lowering_default(self):
        from apps.integrations.remote import SafeMediaFetcher
        response=Mock(status=200)
        connection=Mock()
        connection.getresponse.return_value=response
        resolver=lambda *args,**kwargs:[(None,None,None,None,('93.184.216.34',443))]
        fetch=SafeMediaFetcher(['media.example'],max_bytes=64,resolver=resolver,connection=Mock(return_value=connection))
        response.getheader.side_effect=lambda name:'6' if name=='Content-Length' else 'image/png'
        with self.assertRaises(ValueError):
            with fetch.open_file('https://media.example/image.png',max_bytes=4):pass
        response.read.assert_not_called()
        connection.close.assert_called_once()
        response.getheader.side_effect=lambda name:None if name=='Content-Length' else 'image/png'
        response.read.side_effect=[b'abc',b'def',b'']
        with self.assertRaises(ValueError):
            with fetch.open_file('https://media.example/image.png',max_bytes=4):pass
        response.read.side_effect=[b'abcdef',b'']
        self.assertEqual(fetch('https://media.example/image.png'),(b'abcdef','image/png'))
        self.assertEqual(fetch.max_bytes,64)
