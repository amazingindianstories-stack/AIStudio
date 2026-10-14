#!/usr/bin/env python3
"""Private ingress gateway in front of gunicorn (ported from the production launcher).

Only requests carrying the server-only ingress header (set by the Vercel
middleware) reach Django, and only allowlisted routes. ``/__g4_readiness`` is
the Railway health check. Configuration, including the secret, arrives as JSON
on stdin so it never appears in process arguments.
"""
import hmac, http.client, json, os, re, time, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
HEADER='x-veevee-g4-ingress'
MAX_BODY=8*1024*1024
MAX_OPERATIONS=128
MAX_TOTAL_BYTES=16*1024*1024
SAFE_READ=re.compile(r'^/api/[^?]+$')
SAFE_POST=re.compile(r'^/api/(?:auth/(?:login|logout)|uploads/init|uploads/[0-9a-f-]{36}/(?:finalize|cancel))$')
SAFE_PUT=re.compile(r'^/api/uploads/[0-9a-f-]{36}/local$')
ADMIN_READ_PATHS=frozenset(('/api/admin/data','/api/admin/logs','/api/admin/activity'))
DEPTH_POST_ROUTES=frozenset(('/api/generate/depth','/api/worker/depth/claim','/api/worker/depth/heartbeat','/api/worker/depth/progress','/api/worker/depth/upload-url','/api/worker/depth/complete'))
def allowed(method,path,paid_initial_routes=False,new_exports=False):
    # Exact DB-backed Django admin reads; Django still checks the session role.
    # Status contacts external dependencies; runtime audit takes leases and writes fixtures.
    if method in ('GET','HEAD') and path in ADMIN_READ_PATHS:return True
    # Managed portrait pool settings (Django requires an admin session for both methods).
    if method in ('GET','HEAD','POST') and path=='/api/admin/portrait-settings':return True
    if new_exports and method=="POST" and re.fullmatch(r"/api/history/exports(?:/[0-9a-f-]{36}/(?:items|finalize))?",path):return True
    # Everything else under /api is allowed except provider execution, internal worker/callback ingress and export scheduling.
    if paid_initial_routes and method=='POST' and path in ('/api/generate/image','/api/generate/video','/api/generate/video/finalize'):return True
    if method in ('GET','HEAD') and path=='/api/generate/video/status':return True
    # Depth maps: artist enqueue/status and the external GPU worker protocol
    # (Django authenticates the worker with DEPTH_WORKER_TOKEN).
    if method in ('GET','HEAD') and path=='/api/generate/depth/status':return True
    if method=='POST' and path in DEPTH_POST_ROUTES:return True
    if method=='GET' and path=='/api/worker/depth/status':return True
    if not path.startswith('/api/') or path.startswith(('/api/generate/','/api/admin/','/api/worker/','/api/workers/','/api/webhooks/','/api/depth/','/api/audio/transcribe','/api/queue/execute')):return False
    if method not in ('GET','HEAD') and (path.startswith('/api/agent-conversations/') and path.endswith('/messages') or path.startswith('/api/history/exports')):return False
    return method in ('GET','HEAD','POST','PUT','PATCH','DELETE')
def handler(secret,paid_initial_routes=False,new_exports=False):
    class Gate(BaseHTTPRequestHandler):
        operations=0
        total_bytes=0
        protocol_version='HTTP/1.0'
        def log_message(self,*args): pass
        def run(self):
            target=urlsplit(self.path)
            if target.scheme or target.netloc or not self.path.startswith("/") or self.path.startswith("//") or target.fragment:
                self.send_error(400);return
            path=target.path
            # Public readiness only: no credentials, customer data or paid operation.
            if (self.command=='GET' and path=='/__g4_readiness' and not target.query
                and self.headers.get('Content-Length') in (None,'0')
                and not self.headers.get('Transfer-Encoding')):
                conn=http.client.HTTPConnection('127.0.0.1',18080,timeout=2)
                ready=False
                try:
                    conn.request('GET','/api/health',headers={'Host':'127.0.0.1:18080','Accept':'application/json'})
                    response=conn.getresponse();data=response.read(513)
                    if response.status==200 and len(data)<=512:
                        value=json.loads(data)
                        ready=(isinstance(value,dict) and value.get('ok') is True
                               and value.get('django')=='ready' and value.get('database')=='ready')
                except (OSError,ValueError,http.client.HTTPException):
                    ready=False
                finally:
                    conn.close()
                data=json.dumps({'ok':ready},separators=(',',':')).encode()
                self.send_response(200 if ready else 503)
                self.send_header('Content-Type','application/json')
                self.send_header('Content-Length',str(len(data)))
                self.send_header('Cache-Control','no-store');self.end_headers()
                self.wfile.write(data);self.close_connection=True;return
            if not hmac.compare_digest(self.headers.get(HEADER,''),secret):
                self.send_error(403);return
            if not allowed(self.command,path,paid_initial_routes,new_exports):
                paid=path.startswith(('/api/generate/','/api/audio/transcribe')) or (path.startswith('/api/agent-conversations/') and path.endswith('/messages') and self.command not in ('GET','HEAD'))
                message='This generation route is not available.' if paid else 'This operation is not available.'
                data=json.dumps({'error':message,'code':'PREVIEW_PAID_PROVIDER_DISABLED' if paid else 'PREVIEW_OPERATION_DISABLED'}).encode()
                self.send_response(403);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('Vary','Cookie');self.end_headers()
                if self.command!='HEAD':self.wfile.write(data)
                self.close_connection=True;return
            if self.headers.get('Transfer-Encoding'): self.send_error(400);return
            try: n=int(self.headers.get('Content-Length','0'))
            except ValueError: self.send_error(400);return
            if n<0 or n>MAX_BODY: self.send_error(413);return
            self.connection.settimeout(25)
            body=self.rfile.read(n)
            if len(body)!=n: self.send_error(400);return
            headers={k:v for k,v in self.headers.items() if k.lower() not in {HEADER,'connection','transfer-encoding','content-length','host','upgrade','proxy-authorization','proxy-connection','x-vercel-protection-bypass','x-vercel-set-bypass-cookie'}}
            for key in list(headers):
                if key.lower()=='cookie':
                    headers[key]=';'.join(part for part in headers[key].split(';') if part.strip().split('=')[0] not in {'_vercel_jwt','_vercel_protection_bypass'})
            headers['Host']='127.0.0.1:18080'
            conn=http.client.HTTPConnection('127.0.0.1',18080,timeout=25)
            headers_sent=False
            try:
                conn.request(self.command,path + ('?' + target.query if target.query else ''),body=body,headers=headers)
                upstream_socket=conn.sock
                # Initial enqueue may normalize large references; only response headers get120s.
                if self.command=='POST' and path in ('/api/generate/image','/api/generate/video'):
                    upstream_socket.settimeout(120)
                response=conn.getresponse()
                if upstream_socket is not None:upstream_socket.settimeout(25)
                length=response.getheader('Content-Length')
                if length is not None and (not length.isdigit() or int(length)<0):self.send_error(502);return
                self.send_response(response.status)
                for k,v in response.getheaders():
                    if k.lower() not in {'connection','transfer-encoding','server','date','cache-control','vary',HEADER}: self.send_header(k,v)
                self.send_header('Cache-Control','no-store');self.send_header('Vary','Cookie');self.end_headers();headers_sent=True
                if self.command!='HEAD':
                    while True:
                        chunk=response.read(64*1024)
                        if not chunk:break
                        self.wfile.write(chunk)
                self.close_connection=True
            except socket.timeout:
                if not headers_sent:
                    submission=self.command=='POST' and path in ('/api/generate/image','/api/generate/video')
                    message=('The upstream request timed out and may still have been accepted. Check your library/status before trying again.' if submission else 'The upstream request timed out. Its completion could not be verified.')
                    data=json.dumps({'error':message,'code':'UPSTREAM_TIMEOUT_SUBMISSION_UNCERTAIN' if submission else 'UPSTREAM_TIMEOUT'}).encode()
                    self.send_response(502);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.send_header('Vary','Cookie');self.end_headers()
                    if self.command!='HEAD':self.wfile.write(data)
                self.close_connection=True
            except (OSError,http.client.HTTPException):
                # Once native bytes began, never append a second HTTP error body.
                if not headers_sent:self.send_error(502)
                self.close_connection=True
            finally: conn.close()
        do_GET=do_HEAD=do_POST=do_PUT=do_PATCH=do_DELETE=run
    return Gate

def serve(secret,port,paid_initial_routes=False,new_exports=False):
    if len(secret)<48 or not (1024<=int(port)<=65535) or int(port)==18080:raise ValueError('Ingress binding invalid')
    server=ThreadingHTTPServer(('0.0.0.0',port),handler(secret,paid_initial_routes,new_exports))
    server.daemon_threads=True
    import sys
    print(json.dumps({'event':'gateway_listening','port':int(port),'paid_routes':paid_initial_routes,'new_exports':new_exports}),file=sys.stderr,flush=True)
    try:server.serve_forever()
    finally:server.server_close()
if __name__=='__main__':
    import sys
    if sys.argv[1:]!=['--approved-private-stdin']:print(json.dumps({'status':'NOOP'}))
    else:
        value=json.loads(sys.stdin.buffer.read(4096));paid=value.get('paid_initial_routes',False)
        if type(paid) is not bool:raise ValueError('Paid route activation rejected')
        exports=value.get('new_exports',False)
        if type(exports) is not bool:raise ValueError('Export activation rejected')
        serve(value['secret'],value['port'],paid,exports)
