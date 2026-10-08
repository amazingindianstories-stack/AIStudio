"""Ephemeral loopback TLS front door for isolated browser qualification only."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
from threading import Thread

HOP_HEADERS = {'connection','transfer-encoding','keep-alive','proxy-authenticate',
               'proxy-authorization','te','trailer','upgrade','content-length'}


@contextmanager
def loopback_https(upstream_port):
    if os.environ.get('MIGRATION_TEST_ISOLATED') != '1':
        raise RuntimeError('Isolated runner required')
    class Proxy(BaseHTTPRequestHandler):
        def do_GET(self):
            upstream = http.client.HTTPConnection('127.0.0.1',upstream_port,timeout=20)
            try:
                headers = {key:value for key,value in self.headers.items() if key.lower() not in HOP_HEADERS}
                headers['X-Forwarded-Proto'] = 'https'
                upstream.request('GET',self.path,headers=headers)
                response = upstream.getresponse()
                body = response.read()
                self.send_response(response.status)
                for key,value in response.getheaders():
                    if key.lower() not in HOP_HEADERS:
                        self.send_header(key,value)
                self.send_header('Content-Length',str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            finally:
                upstream.close()
        def log_message(self,*args):
            pass
    with tempfile.TemporaryDirectory(prefix='browser-loopback-tls-',dir=os.environ['TMPDIR']) as directory:
        certificate,key = Path(directory)/'cert.pem',Path(directory)/'key.pem'
        subprocess.run(['openssl','req','-x509','-newkey','rsa:2048','-nodes','-days','1',
                        '-subj','/CN=127.0.0.1','-keyout',str(key),'-out',str(certificate)],
                       check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate,key)
        server = ThreadingHTTPServer(('127.0.0.1',0),Proxy)
        server.socket = context.wrap_socket(server.socket,server_side=True)
        worker = Thread(target=server.serve_forever,daemon=True)
        worker.start()
        try:
            yield f'https://127.0.0.1:{server.server_port}'
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=5)
