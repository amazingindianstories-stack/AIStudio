import http.client
import socket
import threading
import time
from django.test import SimpleTestCase
from .providers.request_deadline import SocketDeadline, deadline_adapter
from .providers.transport import ProviderError, HttpTransport
from unittest.mock import patch


class SocketDeadlineTests(SimpleTestCase):
    def test_header_read_is_interrupted_and_owned_descriptor_closed(self):
        left,right=socket.socketpair()
        left.settimeout(1)
        try:
            start=time.monotonic()
            with SocketDeadline(start+.12) as guard:
                guard.bind(left)
                duplicate=guard.socket
                right.sendall(b'HTTP/1.1 200 OK\r\nX-Header: incomplete')
                response=http.client.HTTPResponse(left)
                try:
                    try:
                        response.begin()
                    except (OSError,http.client.HTTPException):
                        pass
                    with self.assertRaises(ProviderError):
                        guard.check()
                    self.assertTrue(guard.expired.is_set())
                    self.assertLess(time.monotonic()-start,.7)
                finally:
                    response.close()
            self.assertEqual(duplicate.fileno(),-1)
            self.assertFalse(guard.timer.is_alive())
        finally:
            left.close();right.close()

    def test_late_socket_rejected_and_adapter_does_not_change_global_pool(self):
        from urllib3.poolmanager import pool_classes_by_scheme
        original=pool_classes_by_scheme['https']
        left,right=socket.socketpair()
        try:
            with SocketDeadline(time.monotonic()-1) as guard:
                with self.assertRaises(ProviderError):guard.bind(left)
            with SocketDeadline(time.monotonic()+1) as guard:
                adapter=deadline_adapter(guard)
                self.assertIs(pool_classes_by_scheme['https'],original)
                self.assertIsNot(adapter.poolmanager.pool_classes_by_scheme['https'],original)
                self.assertEqual(adapter.max_retries.total,0)
                adapter.close()
        finally:
            left.close();right.close()

    def test_actual_tls_handshake_is_interrupted_without_paid_request_retry(self):
        left,right=socket.socketpair()
        right.settimeout(1)
        received=[]
        def peer():
            try:
                while True:
                    data=right.recv(65536)
                    if not data:break
                    received.append(data)
            except OSError:
                pass
            finally:
                right.close()
        thread=threading.Thread(target=peer)
        thread.start()
        try:
            start=time.monotonic()
            with patch('apps.generation.providers.request_deadline.connect_socket',return_value=left) as connect:
                with self.assertRaises(ProviderError) as failure:
                    HttpTransport(allowed_hosts=['fixture.invalid'],timeout=.15).request(
                        'POST','https://fixture.invalid/paid',body={'prompt':'never transmitted'})
                connect.assert_called_once()
            self.assertEqual(failure.exception.code,'request_deadline')
            self.assertLess(time.monotonic()-start,.8)
            thread.join(1)
            self.assertFalse(thread.is_alive())
            self.assertTrue(received)  # TLS ClientHello; peer never completes TLS.
            self.assertNotIn(b'never transmitted',b''.join(received))
        finally:
            left.close();right.close();thread.join(1)

    def test_timed_out_dns_retains_capacity_until_actual_completion(self):
        from .providers.request_deadline import BoundedResolver
        release=threading.Event()
        started=threading.Event()
        calls=[]
        def lookup(*args,**kwargs):
            calls.append(args)
            started.set()
            release.wait(2)
            return [('resolved',)]
        resolver=BoundedResolver(slots=1,lookup=lookup)
        try:
            with SocketDeadline(time.monotonic()+.08) as guard:
                with self.assertRaises(ProviderError) as failure:
                    resolver.resolve('fixture.invalid',443,guard)
            self.assertEqual(failure.exception.code,'request_deadline')
            self.assertTrue(started.is_set())
            for _ in range(8):
                with SocketDeadline(time.monotonic()+1) as guard:
                    with self.assertRaises(ProviderError) as busy:
                        resolver.resolve('fixture.invalid',443,guard)
                self.assertEqual(busy.exception.code,'dns_capacity_busy')
            self.assertEqual(len(calls),1)
        finally:
            release.set()
        until=time.monotonic()+1
        while time.monotonic()<until:
            if resolver.capacity.acquire(blocking=False):
                resolver.capacity.release()
                break
            time.sleep(.005)
        else:self.fail('Resolver slot not restored after actual completion')
        with SocketDeadline(time.monotonic()+1) as guard:
            self.assertEqual(resolver.resolve('fixture.invalid',443,guard),[('resolved',)])

    def test_actual_transport_dns_timeout_opens_no_connection(self):
        from .providers.request_deadline import BoundedResolver
        release=threading.Event()
        def lookup(*args,**kwargs):
            release.wait(2)
            return [(socket.AF_INET,socket.SOCK_STREAM,0,'',('127.0.0.1',443))]
        resolver=BoundedResolver(slots=1,lookup=lookup)
        try:
            with patch('apps.generation.providers.request_deadline.RESOLVER',resolver), patch(
                    'apps.generation.providers.request_deadline.socket.socket') as create:
                start=time.monotonic()
                with self.assertRaises(ProviderError) as failure:
                    HttpTransport(allowed_hosts=['fixture.invalid'],timeout=.08).request(
                        'POST','https://fixture.invalid/paid',body={'prompt':'never sent'})
                self.assertEqual(failure.exception.code,'request_deadline')
                self.assertLess(time.monotonic()-start,.7)
                create.assert_not_called()
                self.assertFalse(failure.exception.may_have_submitted)
        finally:
            release.set()

    def test_actual_tls_success_and_hostname_verification_preserved(self):
        import ssl
        import tempfile
        from pathlib import Path
        from datetime import datetime, timedelta, timezone
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
        import requests
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
            context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(cert_file,key_file)
            for phase in ['success','wrong-host','slow-header','slow-upload']:
                host='wrong.invalid' if phase=='wrong-host' else 'fixture.invalid'
                left,right=socket.socketpair();right.settimeout(1)
                requests_seen=[]
                def peer():
                    try:
                        with context.wrap_socket(right,server_side=True) as secured:
                            data=b''
                            while b'\r\n\r\n' not in data:
                                part=secured.recv(65536)
                                if not part:return
                                data+=part
                            headers,payload=data.split(b'\r\n\r\n',1)
                            length=int(next(line.split(b':',1)[1] for line in headers.split(b'\r\n') if line.lower().startswith(b'content-length:')))
                            if phase=='slow-upload':
                                requests_seen.append(payload)
                                time.sleep(.6)
                                return
                            while len(payload)<length:
                                part=secured.recv(65536)
                                if not part:return
                                payload+=part
                            requests_seen.append(payload)
                            if phase=='slow-header':
                                secured.sendall(b'HTTP/1.1 200 OK\r\nX-Header: ')
                                for _ in range(100):
                                    secured.sendall(b'x')
                                    time.sleep(.02)
                                return
                            secured.sendall(b'HTTP/1.1 200 OK\r\nContent-Length: 11\r\nConnection: close\r\n\r\n{"ok":true}')
                    except (OSError,ssl.SSLError):
                        pass
                thread=threading.Thread(target=peer);thread.start()
                try:
                    with patch('apps.generation.providers.request_deadline.connect_socket',return_value=left) as connect, patch(
                            'requests.adapters.DEFAULT_CA_BUNDLE_PATH',str(cert_file)):
                        transport=HttpTransport(allowed_hosts=[host],timeout=.3 if phase in ('slow-header','slow-upload') else 1)
                        start=time.monotonic()
                        if phase in ('slow-header','slow-upload'):
                            with self.assertRaises(ProviderError) as failure:
                                kwargs={'raw_body':b'x'*(4*1024*1024)} if phase=='slow-upload' else {'body':{'prompt':'fixture'}}
                                transport.request('POST','https://'+host+'/paid',**kwargs)
                            self.assertEqual(failure.exception.code,'request_deadline')
                            self.assertLess(time.monotonic()-start,1)
                        elif phase=='success':
                            self.assertEqual(transport.request('POST','https://'+host+'/paid',body={'prompt':'fixture'}).json(),{'ok':True})
                        else:
                            with self.assertRaises(requests.exceptions.SSLError):
                                transport.request('POST','https://'+host+'/paid',body={'prompt':'fixture'})
                        connect.assert_called_once()
                    thread.join(2)
                    self.assertFalse(thread.is_alive())
                    self.assertEqual(len(requests_seen),0 if phase=='wrong-host' else 1)
                    if requests_seen and phase!='slow-upload':
                        import json
                        self.assertEqual(json.loads(requests_seen[0]),{'prompt':'fixture'})
                finally:
                    left.close();right.close();thread.join(2)
