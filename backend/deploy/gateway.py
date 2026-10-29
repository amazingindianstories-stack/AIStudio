#!/usr/bin/env python3
"""Private ingress gateway in front of gunicorn (ported from the production launcher).

Only requests carrying the server-only ingress header (set by the Vercel
middleware) reach Django, and only allowlisted routes. ``/__g4_readiness`` is
the Railway health check. Configuration, including the secret, arrives as JSON
on stdin so it never appears in process arguments.

In ``mcp`` mode the same gateway fronts the MCP service (uvicorn on 18082) and
passes only ``/mcp``: POST, plus GET and DELETE, which the service answers 405.
"""
import hmac, http.client, json, re, socket
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit
HEADER='x-veevee-g4-ingress'
MAX_BODY=8*1024*1024
MAX_OPERATIONS=128
MAX_TOTAL_BYTES=16*1024*1024
SAFE_READ=re.compile(r'^/api/[^?]+$')
SAFE_POST=re.compile(r'^/api/(?:auth/(?:login|logout)|uploads/init|uploads/[0-9a-f-]{36}/(?:finalize|cancel))$')
SAFE_PUT=re.compile(r'^/api/uploads/[0-9a-f-]{36}/local$')
ADMIN_READ_PATHS=frozenset(('/api/admin/data','/api/admin/logs','/api/admin/errors','/api/admin/activity','/api/admin/status'))
# Admin data mutations (Django answers 401 without a session and 403 for a non-admin).
ADMIN_MUTATIONS={'/api/admin/users':('POST','PATCH','DELETE'),'/api/admin/pricing':('POST',),'/api/admin/limits':('POST',),'/api/admin/user-limits':('POST',),
                 '/api/admin/agent-access':('POST',),'/api/admin/agent-access/revoke':('POST',)}
# CORS preflights for the OAuth endpoints browser-based agent clients call (Django answers them).
OAUTH_PREFLIGHT=frozenset(('/api/oauth/authorization-server','/api/oauth/protected-resource','/api/oauth/register','/api/oauth/token','/api/oauth/revoke'))
AGENT_MESSAGES=re.compile(r'/api/agent-conversations/[0-9a-f-]{36}/messages')
# Board "Create with AI" submissions queue paid generations, so they open only with the other paid initial routes.
BOARD_AI_JOBS=re.compile(r'/api/canvas-boards/[0-9a-f-]{36}/ai-jobs')
DEPTH_POST_ROUTES=frozenset(('/api/generate/depth','/api/worker/depth/claim','/api/worker/depth/heartbeat','/api/worker/depth/progress','/api/worker/depth/upload-url','/api/worker/depth/complete'))
# Response-header waits beyond the default 25 s: enqueue may normalize large references, transcription
# waits for its worker result (Django answers 504 itself after 120 s), an agent turn runs a short tool loop.
LONG_POSTS={'/api/generate/cancel':55,'/api/generate/image':120,'/api/generate/video':120,'/api/audio/transcribe':125}
# Upstream (port, readiness path) per mode. An MCP tool call holds at most 45 s, so its answer arrives within 55 s.
UPSTREAMS={'api':(18080,'/api/health'),'mcp':(18082,'/healthz')}
MCP_WAIT=55
def upstream_wait(method,path,mode='api'):
    if mode=='mcp':return MCP_WAIT if method=='POST' else 25
    if method!='POST':return 25
    return LONG_POSTS.get(path,120 if AGENT_MESSAGES.fullmatch(path) or BOARD_AI_JOBS.fullmatch(path) else 25)
def allowed_mcp(method,path):
    return path=='/mcp' and method in ('POST','GET','DELETE')
def allowed(method,path,paid_initial_routes=False,new_exports=False,magnific_upscale=False):
    # Exact DB-backed Django admin reads plus the read-only dependency status; Django still checks the session role.
    # Runtime audit stays closed: it writes (rolled-back) fixtures into the live database and runs the executor.
    # Higgsfield token seeding stays closed: no offered model uses it, and it stores a provider credential.
    if method in ('GET','HEAD') and path in ADMIN_READ_PATHS:return True
    if method in ADMIN_MUTATIONS.get(path,()):return True
    if method=='OPTIONS' and path in OAUTH_PREFLIGHT:return True
    # Managed portrait pool settings (Django requires an admin session for both methods).
    if method in ('GET','HEAD','POST') and path=='/api/admin/portrait-settings':return True
    if new_exports and method=="POST" and re.fullmatch(r"/api/history/exports(?:/[0-9a-f-]{36}/(?:items|finalize))?",path):return True
    # Everything else under /api is allowed except provider execution, internal worker/callback ingress and export scheduling.
    if method=='POST' and path=='/api/generate/cancel':return True
    if paid_initial_routes and method=='POST' and path in ('/api/generate/image','/api/generate/video','/api/generate/video/finalize'):return True
    if paid_initial_routes and magnific_upscale and method=='POST' and path=='/api/generate/upscale':return True
    # Audio transcription: the paid guard registers the job and claims its one Gemini call in the worker.
    if paid_initial_routes and method=='POST' and path=='/api/audio/transcribe':return True
    # Admin agent chat: its Gemini calls go through the agent transport's exact endpoint and payload allowlist.
    if paid_initial_routes and method=='POST' and AGENT_MESSAGES.fullmatch(path):return True
    # Board AI: the submission is a paid initial route (an image or text generation); quotes, reads and placement are not.
    if method=='POST' and BOARD_AI_JOBS.fullmatch(path):return paid_initial_routes
    if method in ('GET','HEAD') and path=='/api/generate/video/status':return True
    # Depth maps: artist enqueue/status and the external GPU worker protocol
    # (Django authenticates the worker with DEPTH_WORKER_TOKEN).
    if method in ('GET','HEAD') and path=='/api/generate/depth/status':return True
    if method=='POST' and path in DEPTH_POST_ROUTES:return True
    if method=='GET' and path=='/api/worker/depth/status':return True
    if not path.startswith('/api/') or path.startswith(('/api/generate/','/api/admin/','/api/worker/','/api/workers/','/api/webhooks/','/api/depth/','/api/audio/transcribe','/api/queue/execute')):return False
    if method not in ('GET','HEAD') and (path.startswith('/api/agent-conversations/') and path.endswith('/messages') or path.startswith('/api/history/exports')):return False
    return method in ('GET','HEAD','POST','PUT','PATCH','DELETE')
def handler(secret,paid_initial_routes=False,new_exports=False,magnific_upscale=False,mode='api'):
    upstream_port,readiness_path=UPSTREAMS[mode]
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
                conn=http.client.HTTPConnection('127.0.0.1',upstream_port,timeout=2)
                ready=False
                try:
                    conn.request('GET',readiness_path,headers={'Host':f'127.0.0.1:{upstream_port}','Accept':'application/json'})
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
            if not (allowed_mcp(self.command,path) if mode=='mcp' else allowed(self.command,path,paid_initial_routes,new_exports,magnific_upscale)):
                paid=mode=='api' and (path.startswith(('/api/generate/','/api/audio/transcribe')) or (path.startswith('/api/agent-conversations/') and path.endswith('/messages') and self.command not in ('GET','HEAD')))
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
            headers['Host']=f'127.0.0.1:{upstream_port}'
            conn=http.client.HTTPConnection('127.0.0.1',upstream_port,timeout=25)
            headers_sent=False
            try:
                conn.request(self.command,path + ('?' + target.query if target.query else ''),body=body,headers=headers)
                upstream_socket=conn.sock
                # Only response headers get the longer wait; streaming the body stays on 25 s.
                upstream_socket.settimeout(upstream_wait(self.command,path,mode))
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
                    submission=self.command=='POST' and (path in LONG_POSTS or mode=='mcp')
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

def serve(secret,port,paid_initial_routes=False,new_exports=False,magnific_upscale=False,mode='api'):
    if mode not in UPSTREAMS:raise ValueError('Gateway mode rejected')
    if len(secret)<48 or not (1024<=int(port)<=65535) or int(port) in {upstream for upstream,_ in UPSTREAMS.values()}:raise ValueError('Ingress binding invalid')
    server=ThreadingHTTPServer(('0.0.0.0',port),handler(secret,paid_initial_routes,new_exports,magnific_upscale,mode))
    server.daemon_threads=True
    import sys
    print(json.dumps({'event':'gateway_listening','port':int(port),'mode':mode,'paid_routes':paid_initial_routes,'new_exports':new_exports,'magnific_upscale':magnific_upscale}),file=sys.stderr,flush=True)
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
        magnific=value.get('magnific_upscale',False)
        if type(magnific) is not bool:raise ValueError('Magnific activation rejected')
        mode=value.get('mode','api')
        if mode not in UPSTREAMS:raise ValueError('Gateway mode rejected')
        serve(value['secret'],value['port'],paid,exports,magnific,mode)
