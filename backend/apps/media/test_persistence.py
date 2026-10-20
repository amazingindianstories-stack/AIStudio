import base64
import io
import tracemalloc
import tempfile
import hashlib
import socket
import threading
import time
import http.client
from unittest.mock import Mock, patch
from django.test import SimpleTestCase, override_settings
from apps.integrations.remote import validated_target, SafeMediaFetcher, UnsafeMediaURL, PinnedHTTPSConnection
from .storage import StorageService, MemoryAdapter, FileSystemAdapter
from .persistence import save_buffer_with_metadata, save_from_url_with_metadata, nearest_supported_aspect_ratio


def resolver(host,port,**kwargs):
    return [(2,1,6,'',('93.184.216.34',port))]


class ProviderPersistenceTests(SimpleTestCase):
    def test_actual_tls_success_and_hostname_validation_with_owned_raw_descriptor(self):
        import ssl
        from pathlib import Path
        from datetime import datetime,timedelta,timezone
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes,serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
        key=ec.generate_private_key(ec.SECP256R1())
        name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'fixture.invalid')])
        now=datetime.now(timezone.utc)
        cert=(x509.CertificateBuilder().subject_name(name).issuer_name(name)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(hours=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName('fixture.invalid')]),False)
            .add_extension(x509.BasicConstraints(ca=True,path_length=None),True).sign(key,hashes.SHA256()))
        with tempfile.TemporaryDirectory() as directory:
            cert_file=Path(directory)/'cert.pem';key_file=Path(directory)/'key.pem'
            cert_file.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
            key_file.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
            server=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server.load_cert_chain(cert_file,key_file)
            client=ssl.create_default_context(cafile=str(cert_file))
            for host in ('fixture.invalid','wrong.invalid'):
                with self.subTest(host=host):
                    left,right=socket.socketpair();right.settimeout(1)
                    requests=[]
                    def peer():
                        try:
                            with server.wrap_socket(right,server_side=True) as secured:
                                data=b''
                                while b'\r\n\r\n' not in data:
                                    part=secured.recv(4096)
                                    if not part:return
                                    data+=part
                                requests.append(data)
                                secured.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: video/quicktime\r\n\r\noriginal')
                        except (OSError,ssl.SSLError):pass
                        finally:right.close()
                    thread=threading.Thread(target=peer)
                    thread.start()
                    try:
                        with patch('apps.integrations.remote.socket.create_connection',return_value=left), patch(
                                'apps.integrations.remote.ssl.create_default_context',return_value=client), patch(
                                'ssl.SSLSocket.dup',side_effect=AssertionError('TLS socket must not be duplicated')) as duplicate:
                            fetch=SafeMediaFetcher([host],resolver=resolver,total_timeout=1)
                            if host=='fixture.invalid':
                                self.assertEqual(fetch('https://'+host+'/a.mov'),(b'original','video/quicktime'))
                            else:
                                with self.assertRaises(ssl.SSLCertVerificationError):fetch('https://'+host+'/a.mov')
                            duplicate.assert_not_called()
                        self.assertEqual(bool(requests),host=='fixture.invalid')
                    finally:
                        left.close();right.close();thread.join(1)
                        self.assertFalse(thread.is_alive())

    def test_completed_spool_outlives_network_deadline_without_live_timer(self):
        reader,writer = socket.socketpair()
        payload = b'original'
        writer.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: video/quicktime\r\n\r\n'+payload)
        writer.close()
        guards = []
        from apps.integrations.request_deadline import SocketDeadline
        def guard(deadline):
            result = SocketDeadline(deadline)
            guards.append(result)
            return result
        class Connection(PinnedHTTPSConnection):
            def __init__(self,*args):self.sock=reader;self.response=None
            def request(self,*args,**kwargs):pass
            def getresponse(self):
                self.response=http.client.HTTPResponse(reader)
                self.response.begin()
                return self.response
            def close(self):
                if self.response is not None:self.response.close()
                reader.close()
        try:
            with patch('apps.integrations.remote.SocketDeadline',side_effect=guard):
                fetch = SafeMediaFetcher(['media.example'],resolver=resolver,connection=Connection,total_timeout=.1)
                with fetch.open_file('https://media.example/a.mov') as (stream,mime):
                    self.assertTrue(guards)
                    self.assertTrue(all(not item.timer.is_alive() and item.socket is None for item in guards))
                    time.sleep(.12)
                    self.assertEqual((stream.read(),mime),(payload,'video/quicktime'))
            self.assertEqual(reader.fileno(),-1)
        finally:reader.close()

    def test_real_tls_handshake_stall_is_interrupted_and_timer_finishes(self):
        reader,writer = socket.socketpair()
        timers = []
        from apps.integrations.request_deadline import SocketDeadline
        def guard(deadline):
            result = SocketDeadline(deadline)
            timers.append(result.timer)
            return result
        began = time.monotonic()
        try:
            with patch('apps.integrations.remote.socket.create_connection',return_value=reader), patch('apps.integrations.remote.SocketDeadline',side_effect=guard):
                with self.assertRaises(TimeoutError):
                    SafeMediaFetcher(['media.example'],resolver=resolver,total_timeout=.1)(
                        'https://media.example/a.mov')
            self.assertLess(time.monotonic()-began,1)
            self.assertEqual(reader.fileno(),-1)
            self.assertTrue(timers)
            self.assertTrue(all(not timer.is_alive() for timer in timers))
        finally:
            reader.close()
            writer.close()

    def test_trickling_headers_are_interrupted_by_total_deadline(self):
        reader,writer = socket.socketpair()
        stopped = threading.Event()
        def send():
            try:
                writer.sendall(b'HTTP/1.1 200 OK\r\nX-Slow: ')
                while not stopped.wait(.01):writer.sendall(b'x')
            except OSError:pass
            finally:writer.close()
        class Connection(PinnedHTTPSConnection):
            def __init__(self,*args):
                self.sock=reader
                self.response=None
            def request(self,*args,**kwargs):pass
            def getresponse(self):
                self.response=http.client.HTTPResponse(reader)
                self.response.begin()
                return self.response
            def close(self):
                if self.response is not None:self.response.close()
                reader.close()
        thread=threading.Thread(target=send)
        thread.start()
        began=time.monotonic()
        try:
            with self.assertRaises(TimeoutError):
                SafeMediaFetcher(['media.example'],resolver=resolver,connection=Connection,
                    total_timeout=.1)('https://media.example/a.mov')
            self.assertLess(time.monotonic()-began,1)
            self.assertEqual(reader.fileno(),-1)
        finally:
            stopped.set()
            reader.close()
            thread.join(1)
            self.assertFalse(thread.is_alive())

    def test_real_chunked_socket_trickle_cannot_reset_total_download_deadline(self):
        reader, writer = socket.socketpair()
        stopped = threading.Event()
        def send():
            try:
                writer.sendall(b'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Type: video/quicktime\r\n\r\n')
                while not stopped.wait(.02):
                    writer.sendall(b'1\r\nx\r\n')
            except OSError:
                pass
            finally:
                writer.close()
        class Connection(PinnedHTTPSConnection):
            def __init__(self, host, address, timeout):
                self.sock = reader
                reader.settimeout(timeout)
                self.response = None
            def request(self, *args, **kwargs): pass
            def getresponse(self):
                self.response = http.client.HTTPResponse(reader)
                self.response.begin()
                return self.response
            def close(self):
                if self.response is not None: self.response.close()
                reader.close()
        thread = threading.Thread(target=send)
        thread.start()
        began = time.monotonic()
        try:
            fetch = SafeMediaFetcher(['media.example'],resolver=resolver,connection=Connection,
                                     timeout=1,total_timeout=.12)
            with self.assertRaises(TimeoutError):
                fetch('https://media.example/trickling.mov')
            self.assertLess(time.monotonic()-began,1)
            self.assertEqual(reader.fileno(),-1)
        finally:
            stopped.set()
            reader.close()
            thread.join(1)
            self.assertFalse(thread.is_alive())

    def test_total_download_budget_rejects_trickling_source_and_closes_connection(self):
        clock = [0.0]
        response = Mock(status=200)
        response.getheader.return_value = None
        def trickle(amount):
            clock[0] += 2
            return b'x'
        response.read.side_effect = trickle
        connection = Mock()
        connection.getresponse.return_value = response
        fetch = SafeMediaFetcher(['media.example'],resolver=resolver,connection=Mock(return_value=connection),
                                 total_timeout=3,clock=lambda:clock[0])
        with self.assertRaisesRegex(TimeoutError,'total deadline'):
            fetch('https://media.example/movie.mov')
        self.assertEqual(response.read.call_count,2)
        connection.close.assert_called_once()

    def test_native_video_download_persists_original_with_bounded_memory(self):
        header = b'\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  '
        size = 8 * 1024 * 1024
        class Response:
            status = 200
            offset = 0
            def getheader(self, name):
                return str(size) if name == 'Content-Length' else 'video/quicktime'
            def read(self, amount):
                take = min(amount, size-self.offset)
                data = (header[self.offset:self.offset+take] if self.offset < len(header) else b'')
                data += b'x' * (take-len(data))
                self.offset += take
                return data
        connection = Mock()
        connection.getresponse.return_value = Response()
        fetch = SafeMediaFetcher(['media.example'], resolver=resolver, connection=Mock(return_value=connection))
        with tempfile.TemporaryDirectory() as directory:
            storage = StorageService(FileSystemAdapter(directory))
            with override_settings(VEEVEE_MEDIA_STORAGE=storage), patch('apps.media.persistence._run_ffmpeg',side_effect=ValueError('metadata unavailable')):
                tracemalloc.start()
                try:
                    result = save_from_url_with_metadata('https://media.example/master.mov','mov','stream',
                        {'kind':'video','requestedAspectRatio':'16:9'},fetcher=fetch)
                    _,peak = tracemalloc.get_traced_memory()
                finally:
                    tracemalloc.stop()
            self.assertLess(peak, 2 * 1024 * 1024)
            self.assertEqual(result, {'url':'/api/media/generations/stream.mov','aspectRatio':'16:9'})
            media = storage.open('generations/stream.mov')
            try:
                actual = hashlib.sha256()
                for chunk in media.stream: actual.update(chunk)
                expected = hashlib.sha256(header)
                remaining = size-len(header)
                while remaining:
                    take = min(256*1024,remaining)
                    expected.update(b'x'*take)
                    remaining -= take
                self.assertEqual(actual.digest(),expected.digest())
                self.assertEqual((media.content_type,media.content_length),('video/quicktime',size))
            finally:
                media.stream.close()
        connection.close.assert_called_once()

    def test_remote_spools_without_retaining_two_payloads_and_closes_file(self):
        size = 8 * 1024 * 1024
        class Response:
            status = 200
            remaining = size
            def getheader(self, name):
                return str(size) if name == 'Content-Length' else 'video/quicktime'
            def read(self, amount):
                take = min(amount, self.remaining)
                self.remaining -= take
                return b'x' * take
        connection = Mock()
        connection.getresponse.return_value = Response()
        fetch = SafeMediaFetcher(['media.example'], resolver=resolver, connection=Mock(return_value=connection))
        tracemalloc.start()
        try:
            data, mime = fetch('https://media.example/movie.mov')
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual((len(data), mime), (size, 'video/quicktime'))
        self.assertLess(peak, size * 1.25)
        connection.getresponse.return_value = Response()
        with fetch.open_file('https://media.example/movie.mov') as (stream, mime):
            self.assertEqual(stream.read(7), b'x' * 7)
        self.assertTrue(stream.closed)
        self.assertEqual(connection.close.call_count, 2)

    def test_remote_rejects_unsafe_hosts_ports_credentials_and_dns(self):
        for url in ('http://media.example/a','https://media.example:8443/a',
                    'https://user:pass@media.example/a','https://attacker.example/a'):
            with self.assertRaises(UnsafeMediaURL):
                validated_target(url,['media.example'],resolver)
        for address in ('127.0.0.1','10.1.2.3','169.254.169.254','::1','fc00::1','192.0.2.1'):
            with self.assertRaises(UnsafeMediaURL):
                validated_target('https://media.example/a',['media.example'],lambda *a,**k:[(2,1,6,'',(address,443))])

    def test_wildcard_hosts_are_boundary_scoped(self):
        self.assertEqual(validated_target('https://cdn.media.example/a',['*.media.example'],resolver)[0],'cdn.media.example')
        for host in ('media.example','evilmedia.example','media.example.attacker.example'):
            with self.assertRaises(UnsafeMediaURL):
                validated_target('https://'+host+'/a',['*.media.example'],resolver)

    def test_fetch_pins_checked_address_and_preserves_bytes(self):
        raw=b'\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  original'
        response=Mock(status=200)
        response.getheader.side_effect=lambda name: {'Content-Length':str(len(raw)),'Content-Type':'video/quicktime'}.get(name)
        response.read.side_effect=[raw,b'']
        connection=Mock()
        connection.getresponse.return_value=response
        factory=Mock(return_value=connection)
        self.assertEqual(SafeMediaFetcher(['media.example'],resolver=resolver,connection=factory)('https://media.example/v.mov'),
                         (raw,'video/quicktime'))
        factory.assert_called_once_with('media.example','93.184.216.34',30)
        self.assertEqual(connection.request.call_args.args,('GET','/v.mov'))
        connection.close.assert_called_once()

    def test_redirect_is_revalidated_and_credentials_never_forwarded(self):
        response=Mock(status=302)
        response.getheader.return_value='http://169.254.169.254/token'
        connection=Mock()
        connection.getresponse.return_value=response
        with self.assertRaises(UnsafeMediaURL):
            SafeMediaFetcher(['media.example'],resolver=resolver,connection=Mock(return_value=connection))('https://media.example/a')
        connection.close.assert_called_once()

    def test_remote_size_and_truncation_limits_close_connection(self):
        for declared,chunks,message in [('100',[], 'limit'),('4',[b'12',b''],'declared length'),(None,[b'12345'],'limit')]:
            response=Mock(status=200)
            response.getheader.side_effect=lambda name:declared if name == 'Content-Length' else None
            response.read.side_effect=chunks
            connection=Mock()
            connection.getresponse.return_value=response
            with self.assertRaisesRegex((ValueError,IOError),message):
                SafeMediaFetcher(['media.example'],max_bytes=4,resolver=resolver,connection=Mock(return_value=connection))('https://media.example/a')
            connection.close.assert_called_once()

    def test_native_mov_master_is_original_and_downloaded_once(self):
        raw=b'\x00\x00\x00\x14ftypqt  \x00\x00\x00\x00qt  original'
        storage=StorageService(MemoryAdapter())
        fetch=Mock(return_value=(raw,'video/quicktime'))
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch('apps.media.persistence.inspect_video_dimensions',side_effect=ValueError('bad metadata')):
            result=save_from_url_with_metadata('https://provider.invalid/v.mov','mov','test',
                {'kind':'video','requestedAspectRatio':'16:9'},fetcher=fetch)
        fetch.assert_called_once()
        self.assertEqual(result,{'url':'/api/media/generations/test.mov','aspectRatio':'16:9'})
        self.assertEqual(storage.read('generations/test.mov'),raw)
        self.assertEqual(storage.primary.objects['generations/test.mov'][1],'video/quicktime')

    def test_mp4_bytes_cannot_be_renamed_mov(self):
        storage=StorageService(MemoryAdapter())
        for raw in (b'\x00\x00\x00\x14ftypisom\x00\x00\x00\x00mp42',
                    b'\x00\x00\x00\x08free\x00\x00\x00\x14ftypisom\x00\x00\x00\x00qt  ',
                    b'not a media container'):
            with override_settings(VEEVEE_MEDIA_STORAGE=storage),self.assertRaisesRegex(ValueError,'non-MOV'):
                save_buffer_with_metadata(raw,'mov','test')
        self.assertEqual(storage.primary.objects,{})

    def test_image_metadata_matches_shape_without_altering_master(self):
        from PIL import Image
        source=io.BytesIO()
        Image.new('RGB',(160,90),'blue').save(source,format='PNG')
        raw=source.getvalue()
        storage=StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            result=save_buffer_with_metadata(raw,'png','test',{'kind':'image','requestedAspectRatio':'1:1'})
        self.assertEqual((result['width'],result['height'],result['aspectRatio']),(160,90,'16:9'))
        self.assertEqual(storage.read('generations/test.png'),raw)
        self.assertIn('thumbs/512/generations/test.png.webp',storage.primary.objects)

    def test_ratio_invalid_dimensions_fail_open(self):
        self.assertIsNone(nearest_supported_aspect_ratio(float('nan'),10,['1:1']))
        self.assertIsNone(nearest_supported_aspect_ratio(10,0,['1:1']))
        self.assertEqual(nearest_supported_aspect_ratio(1200,1600,['invalid','1:0','3:4','16:9']),'3:4')

    def test_private_storage_cannot_be_read_via_public_interface(self):
        from .keys import InvalidMediaKey
        storage=StorageService(MemoryAdapter())
        storage.write_private_buffer(b'token','settings/higgsfield-mcp-token.json','application/json')
        self.assertEqual(storage.read_private_buffer('settings/higgsfield-mcp-token.json'),b'token')
        with self.assertRaises(InvalidMediaKey):
            storage.read('settings/higgsfield-mcp-token.json')
        self.assertTrue(storage.check_connectivity())

    def test_zip_stream_upload(self):
        import tempfile
        from .storage import FileSystemAdapter
        raw=b'zip-archive'*100000
        with tempfile.TemporaryDirectory() as root:
            storage=StorageService(FileSystemAdapter(root))
            self.assertEqual(storage.upload_stream(io.BytesIO(raw),'exports/job.zip'),len(raw))
            self.assertEqual(storage.read('exports/job.zip'),raw)

    def test_real_ffmpeg_mov_inspection_and_frame_extraction(self):
        import subprocess
        import tempfile
        from pathlib import Path
        from PIL import Image
        from .persistence import inspect_video_dimensions, extract_last_frame
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'native.mov'
            subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-f','lavfi',
                '-i','color=c=blue:s=160x90:r=10','-t','1.2','-c:v','mpeg4','-f','mov',str(path)],
                check=True,capture_output=True,timeout=30)
            original=path.read_bytes()
        self.assertEqual(inspect_video_dimensions(original,'mov'),(160,90))
        frame=extract_last_frame(original)
        self.assertEqual(frame['mimeType'],'image/jpeg')
        with Image.open(io.BytesIO(base64.b64decode(frame['data']))) as image:
            self.assertEqual(image.size,(160,90))
        storage=StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            result=save_buffer_with_metadata(original,'mov','native',{'kind':'video','requestedAspectRatio':'16:9'})
        self.assertEqual(storage.read('generations/native.mov'),original)
        self.assertEqual(result['aspectRatio'],'16:9')
