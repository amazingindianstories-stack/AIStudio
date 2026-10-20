"""Official Higgsfield MCP transport and coordinated rotating OAuth tokens."""
import base64
import hashlib
import json
import os
from pathlib import Path
import random
import re
import threading
import time
from urllib.parse import urlencode
from uuid import uuid4
from apps.generation.model_registry import is_provider_model,provider_model_id
from apps.generation.prompting.shot_spec import parse_ref_roles
from apps.generation.prompting.video_directive import build_video_directive
from apps.generation.prompting.legacy_templates import T as LEGACY
from apps.media.storage import get_storage
from apps.integrations.remote import validated_target,PinnedHTTPSConnection
from apps.generation import provider_errors
from .transport import HttpTransport,HttpResult,ProviderError
from .seedance import legacy_directive
from apps.generation.services.deadline import Cancellation

MCP_URL = 'https://mcp.higgsfield.ai/mcp'
TOKEN_URL = 'https://mcp.higgsfield.ai/oauth2/token'
TOKEN_OBJECT_KEY = 'settings/higgsfield-mcp-token.json'
REFRESH_LEASE_KEY = 'lease:higgsfield-oauth-refresh'
ROTATION_STATE_KEY = 'state:higgsfield-oauth-rotation'
ROTATION_DEADLINE_MS = 25000
ROTATION_LEASE_MS = 30000
MODERATION = 'Higgsfield moderation flagged this generation (nsfw). Realistic-face moderation is probabilistic — try again or adjust the reference.'
UUID_PATTERN = r'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'


def mcp_model_id(name,env=None):
    return provider_model_id(name,env) if is_provider_model(name,'higgsfield') else None


def is_higgsfield_model(name):
    return is_provider_model(name,'higgsfield')


def is_fresh(token,now=None):
    now = int(time.time()*1000) if now is None else now
    return bool(token and token.get('access_token') and token.get('obtained_at') and token.get('expires_in')
        and now < token['obtained_at']+(token['expires_in']-300)*1000)


def parse_json_rpc_messages(text,content_type):
    if 'text/event-stream' not in content_type:
        try:
            return [json.loads(text)]
        except ValueError:
            return []
    result = []
    for event in re.split(r'\r?\n\r?\n',text):
        data = '\n'.join(line[5:].removeprefix(' ') for line in re.split(r'\r?\n',event) if line.startswith('data:')).strip()
        if data:
            try:
                result.append(json.loads(data))
            except ValueError:
                pass
    return result


def build_ref_roles(prompt,count):
    result = {}
    for tag,role in parse_ref_roles(prompt).items():
        match = re.fullmatch(r'@img([0-9]+)',tag)
        if match and 1 <= int(match[1]) <= count:
            result[int(match[1])] = role
    return result or None


def to_higgsfield_tags(prompt):
    return re.sub(r'@img([0-9]+)',lambda match:f'<<<image_{match[1]}>>>',prompt,flags=re.I)


def _tool_error_text(result):
    return ' '.join(part.get('text') or '' for part in result.get('content') or []).strip()


def preset_notice_id(result):
    text = '\n'.join(part.get('text') or '' for part in result.get('content') or [])
    match = re.search(r'Preset id:\s*'+UUID_PATTERN,text)
    return match[1] if match else None


def job_id_from(result):
    jobs = (result.get('structuredContent') or {}).get('results') or []
    if jobs and jobs[0].get('id'):
        return jobs[0]['id']
    text = '\n'.join(part.get('text') or '' for part in result.get('content') or [])
    match = re.search(r'^-\s*'+UUID_PATTERN,text,re.M)
    return match[1] if match else None


class AuthError(ProviderError):
    pass


class HiggsfieldTransport(HttpTransport):
    """JSON, OAuth form and raw PUT support with pinned allowlisted TLS peers."""
    def __init__(self,upload_hosts=None):
        super().__init__(allowed_hosts=['mcp.higgsfield.ai'])
        self.hosts = ['mcp.higgsfield.ai',*(upload_hosts or ['*.amazonaws.com','storage.googleapis.com','*.googleapis.com','*.higgsfield.ai','*.cloudflarestorage.com'])]

    def request(self,method,url,*,headers=None,body=None,signal=None):
        if signal:
            signal.check()
        host,address,path = validated_target(url,self.hosts)
        timeout = min(60,signal.remaining()) if signal else 60
        connection = PinnedHTTPSConnection(host,address,timeout)
        raw = json.dumps(body,separators=(',',':')).encode() if isinstance(body,(dict,list)) else body
        try:
            connection.request(method,path,body=raw,headers=headers or {})
            response = connection.getresponse()
            chunks,total = [],0
            while chunk := response.read(65536):
                if signal:
                    signal.check()
                total += len(chunk)
                if total > 32*1024*1024:
                    raise ProviderError('Higgsfield response exceeds the configured limit.')
                chunks.append(chunk)
            return HttpResult(response.status,b''.join(chunks),dict(response.getheaders()))
        finally:
            connection.close()


class DatabaseLease:
    def _owned(self,owner,now):
        from apps.admin_dashboard.models import AppSetting
        row=AppSetting.objects.select_for_update().filter(key=REFRESH_LEASE_KEY).first()
        if row is None or row.value != owner or row.updated_at <= now:
            raise ProviderError('Higgsfield rotation lease lost.',code='oauth_rotation_uncertain')

    def reconcile_rotation(self,owner,token,now):
        from django.db import transaction
        from apps.admin_dashboard.models import AppSetting
        with transaction.atomic():
            self._owned(owner,now)
            row=AppSetting.objects.select_for_update().filter(key=ROTATION_STATE_KEY).first()
            if row is None:
                return
            previous=json.loads(row.value)
            identity=token_identity(token or {})
            changed=any(identity[field] != previous['previous'][field] for field in ('access','refresh'))
            if token and is_fresh(token,now) and changed and token.get('obtained_at',0) >= previous['startedAt']:
                row.delete()
                return
            raise ProviderError('Higgsfield OAuth rotation is uncertain; reconcile or reseed the stored token before retrying.',code='oauth_rotation_uncertain')

    def begin_rotation(self,owner,token,now):
        from django.db import transaction
        from apps.admin_dashboard.models import AppSetting
        with transaction.atomic():
            self._owned(owner,now)
            if AppSetting.objects.filter(key=ROTATION_STATE_KEY).exists():
                raise ProviderError('Higgsfield OAuth rotation is uncertain.',code='oauth_rotation_uncertain')
            AppSetting.objects.create(key=ROTATION_STATE_KEY,value=json.dumps({'owner':owner,'previous':token_identity(token),'startedAt':now}),updated_at=now)

    def persist_rotation(self,owner,now,write):
        # Hold the lease row lock through storage acknowledgment: another owner
        # cannot claim an expired lease while this owner is writing credentials.
        from django.db import transaction
        from apps.admin_dashboard.models import AppSetting
        with transaction.atomic():
            self._owned(owner,now)
            marker=AppSetting.objects.select_for_update().get(key=ROTATION_STATE_KEY)
            if json.loads(marker.value)['owner'] != owner:
                raise ProviderError('Higgsfield rotation ownership changed.',code='oauth_rotation_uncertain')
            write()
            marker.delete()

    def claim(self,key,owner,now,ttl):
        from django.db import connection
        if not key.startswith('lease:') or not owner:
            raise ValueError('Invalid distributed lease')
        with connection.cursor() as cursor:
            cursor.execute('''INSERT INTO settings(key,value,updated_at) VALUES(%s,%s,%s)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at
                WHERE settings.updated_at <= %s RETURNING key''',[key,owner,now+ttl,now])
            return cursor.fetchone() is not None

    def release(self,key,owner):
        from apps.admin_dashboard.models import AppSetting
        return bool(AppSetting.objects.filter(key=key,value=owner).delete()[0])


def token_identity(token):
    return {'access':hashlib.sha256(str(token.get('access_token') or '').encode()).hexdigest(),
        'refresh':hashlib.sha256(str(token.get('refresh_token') or '').encode()).hexdigest(),
        'obtainedAt':token.get('obtained_at')}


class RotationCancellation(Cancellation):
    def __init__(self,parent):
        super().__init__(ROTATION_DEADLINE_MS)
        self.parent=parent

    def check(self):
        if self.parent:
            self.parent.check()
        super().check()

    def remaining(self):
        remaining=super().remaining()
        return min(remaining,self.parent.remaining()) if self.parent else remaining


class HiggsfieldClient:
    def __init__(self,*,transport=None,storage=None,lease=None,env=None,now=None,wait=None,request_id=None):
        self.env = os.environ if env is None else env
        hosts = [host for host in self.env.get('HIGGSFIELD_UPLOAD_HOSTS','').split(',') if host]
        self.transport = transport or HiggsfieldTransport(hosts or None)
        self.storage = storage
        self.lease = lease or DatabaseLease()
        self.now = now or (lambda:int(time.time()*1000))
        self.wait = wait or (lambda ms:time.sleep(ms/1000))
        self.request_id = request_id or (lambda:random.randrange(1_000_000_000))
        self.token,self.session = None,None
        self.refresh_lock = threading.Lock()

    def _storage(self):
        return self.storage or get_storage()

    def read_stored_token(self):
        try:
            token = json.loads(self._storage().read_private_buffer(TOKEN_OBJECT_KEY))
            return token if isinstance(token,dict) else None
        except Exception:
            return None

    def load_token(self):
        if self.token:
            return self.token
        stored = self.read_stored_token()
        if stored:
            self.token = stored
        elif self.env.get('HIGGSFIELD_MCP_REFRESH_TOKEN') and self.env.get('HIGGSFIELD_MCP_CLIENT_ID'):
            self.token = {'access_token':'','refresh_token':self.env['HIGGSFIELD_MCP_REFRESH_TOKEN'],'client_id':self.env['HIGGSFIELD_MCP_CLIENT_ID']}
        elif self.env.get('HIGGSFIELD_MCP_TOKEN_FILE'):
            raw = json.loads(Path(self.env['HIGGSFIELD_MCP_TOKEN_FILE']).read_text())
            self.token = {**raw,'obtained_at':raw.get('obtained_at') or self.now()}
        else:
            raise ProviderError('No Higgsfield MCP token found in storage, env vars, or a configured local file.')
        return self.token

    def _refresh_once(self,refresh_token,client_id,signal=None):
        response = self.transport.request('POST',TOKEN_URL,headers={'Content-Type':'application/x-www-form-urlencoded'},
            body=urlencode({'grant_type':'refresh_token','refresh_token':refresh_token,'client_id':client_id}),signal=signal)
        return response.json()

    def _refresh_under_lease(self,owner,signal=None):
        token = self.load_token()
        self.lease.begin_rotation(owner,token,self.now())
        result = self._refresh_once(token.get('refresh_token'),token.get('client_id'),signal)
        if not result.get('access_token'):
            stored = self.read_stored_token()
            if stored and stored.get('refresh_token') != token.get('refresh_token'):
                if is_fresh(stored,self.now()):
                    self.token,self.session = stored,None
                    self.lease.reconcile_rotation(owner,stored,self.now())
                    return
                result = self._refresh_once(stored.get('refresh_token'),stored.get('client_id'),signal)
        if not result.get('access_token'):
            refresh = self.env.get('HIGGSFIELD_MCP_REFRESH_TOKEN')
            if refresh and refresh != token.get('refresh_token'):
                result = self._refresh_once(refresh,self.env.get('HIGGSFIELD_MCP_CLIENT_ID') or token.get('client_id'),signal)
        if not result.get('access_token'):
            raise ProviderError('Higgsfield MCP token refresh failed — the OAuth token family is dead. Reauthenticate and re-seed via POST /api/admin/set-token (or the Admin → Higgsfield token card).')
        self.token = {'access_token':result['access_token'],'refresh_token':result.get('refresh_token') or token.get('refresh_token'),
            'client_id':token.get('client_id'),'expires_in':result.get('expires_in'),'obtained_at':self.now()}
        def write():
            for attempt in range(3):
                signal.check()
                try:
                    self._storage().write_private_buffer(json.dumps(self.token,separators=(',',':')).encode(),TOKEN_OBJECT_KEY,'application/json')
                    return
                except Exception as error:
                    stored=self.read_stored_token()
                    if stored and token_identity(stored)==token_identity(self.token):
                        return
                    if attempt==2:
                        raise ProviderError('Higgsfield rotated token could not be durably stored; reconcile before retrying.',code='oauth_rotation_uncertain') from error
        signal.check()
        self.lease.persist_rotation(owner,self.now(),write)
        if self.env.get('HIGGSFIELD_MCP_TOKEN_FILE'):
            try:
                Path(self.env['HIGGSFIELD_MCP_TOKEN_FILE']).write_text(json.dumps(self.token))
            except OSError:
                pass
        self.session = None

    def refresh_token(self,signal=None):
        with self.refresh_lock:
            owner = str(uuid4())
            deadline = self.now()+35000
            starting = self.load_token()
            while self.now() < deadline:
                if signal:
                    signal.check()
                if self.lease.claim(REFRESH_LEASE_KEY,owner,self.now(),ROTATION_LEASE_MS):
                    try:
                        stored = self.read_stored_token()
                        self.lease.reconcile_rotation(owner,stored,self.now())
                        if stored and is_fresh(stored,self.now()):
                            self.token,self.session = stored,None
                            return
                        self._refresh_under_lease(owner,RotationCancellation(signal))
                        return
                    finally:
                        try:
                            self.lease.release(REFRESH_LEASE_KEY,owner)
                        except Exception:
                            pass
                (signal.wait if signal else self.wait)(250)
                stored = self.read_stored_token()
                if stored and is_fresh(stored,self.now()) and (stored.get('refresh_token') != starting.get('refresh_token') or stored.get('obtained_at') != starting.get('obtained_at')):
                    self.token,self.session = stored,None
                    return
            raise ProviderError('Timed out waiting for the coordinated Higgsfield token refresh.')

    def access_token(self,signal=None):
        token = self.load_token()
        if not is_fresh(token,self.now()):
            try:
                self.refresh_token(signal)
            except Exception:
                self.token = None
                raise
        return self.token['access_token']

    def rpc(self,method,params,notification=False,signal=None):
        headers = {'Content-Type':'application/json','Accept':'application/json, text/event-stream',
            'Authorization':'Bearer '+self.access_token(signal)}
        if self.session:
            headers['Mcp-Session-Id'] = self.session
        body = {'jsonrpc':'2.0','method':method,'params':params}
        identifier = None if notification else self.request_id()
        if not notification:
            body['id'] = identifier
        response = self.transport.request('POST',MCP_URL,headers=headers,body=body,signal=signal)
        response_headers = {key.lower():value for key,value in response.headers.items()}
        if response_headers.get('mcp-session-id'):
            self.session = response_headers['mcp-session-id']
        if notification:
            return None
        if response.status == 401:
            raise AuthError('Higgsfield authorization expired.',status=401)
        if not response.ok:
            raise ProviderError(f'MCP {method} {response.status}: {response.text[:300]}',provider_response=provider_errors.capture(
                'higgsfield',phase=method,status=response.status,body=response.text,headers=response.headers))
        messages = parse_json_rpc_messages(response.text,response_headers.get('content-type',''))
        answer = next((message for message in messages if isinstance(message,dict) and type(message.get('id')) is type(identifier) and message.get('id') == identifier),None)
        if answer is None:
            raise ProviderError(f'MCP {method}: no response matching request id in stream — {response.text[:200]}')
        return answer

    def ensure_session(self,signal=None):
        if self.session:
            return
        self.rpc('initialize',{'protocolVersion':'2025-06-18','capabilities':{},'clientInfo':{'name':'veevee','version':'0.1'}},signal=signal)
        self.rpc('notifications/initialized',{},notification=True,signal=signal)

    def call_tool(self,name,args,*,signal=None,tolerate_error=False):
        for attempt in range(2):
            try:
                self.ensure_session(signal)
                response = self.rpc('tools/call',{'name':name,'arguments':args},signal=signal)
                if response.get('error'):
                    raise ProviderError(f'{name}: {json.dumps(response["error"],separators=(",",":"))[:300]}',
                        provider_response=provider_errors.capture('higgsfield',phase=name,body=json.dumps({'error':response['error']})))
                result = response.get('result') or {}
                if result.get('isError') and not tolerate_error:
                    raise ProviderError(f'Higgsfield {name}: {_tool_error_text(result)[:300] or "tool error"}',
                        provider_response=provider_errors.capture('higgsfield',phase=name,code='tool_error',message=_tool_error_text(result) or 'tool error'))
                return result
            except AuthError:
                if attempt:
                    raise
                self.refresh_token(signal)

    def upload_image(self,data,content_type='image/png',*,signal=None):
        mime = content_type.lower()
        ext = 'jpg' if 'jpeg' in mime or 'jpg' in mime else 'webp' if 'webp' in mime else 'png'
        result = self.call_tool('media_upload',{'method':'upload_url','filename':'ref.'+ext,'content_type':content_type},signal=signal)
        uploads = (result.get('structuredContent') or {}).get('uploads') or []
        item = uploads[0] if uploads else {}
        if not item.get('upload_url') or not item.get('media_id'):
            raise ProviderError('Higgsfield media_upload: no presigned url returned — '+json.dumps(result)[:300])
        response = self.transport.request('PUT',item['upload_url'],headers={'Content-Type':content_type},body=base64.b64decode(data),signal=signal)
        if not response.ok:
            raise ProviderError(f'Higgsfield CDN upload failed ({response.status}).')
        self.call_tool('media_confirm',{'type':'image','media_id':item['media_id']},signal=signal)
        return item['media_id']

    def call_generate(self,tool,params,signal=None):
        result = self.call_tool(tool,{'params':params},signal=signal)
        preset = preset_notice_id(result)
        if preset and not (result.get('structuredContent') or {}).get('results'):
            result = self.call_tool(tool,{'params':{**params,'declined_preset_id':preset}},signal=signal)
        return result

    def generate_video(self,input,signal=None):
        params = video_payload(input,self.env)
        result = self.call_generate('generate_video',params,signal or input.get('signal'))
        identifier = job_id_from(result)
        if not identifier:
            raise ProviderError('Higgsfield generate_video: no job id returned — '+json.dumps(result)[:300])
        return identifier

    def generate_image(self,input,signal=None):
        params = image_payload(input,self.env)
        result = self.call_generate('generate_image',params,signal or input.get('signal'))
        identifier = job_id_from(result)
        if not identifier:
            raise ProviderError('Higgsfield generate_image: no job id returned — '+json.dumps(result)[:300])
        return identifier

    def job_status(self,job_id,signal=None):
        result = self.call_tool('job_status',{'jobId':job_id,'sync':False},signal=signal,tolerate_error=True)
        def failed(message,code):
            return {'status':'failed','error':message,'providerError':provider_errors.capture('higgsfield',phase='task',code=code,
                message=message,task_id=job_id)}
        if result.get('isError'):
            message = 'Higgsfield job_status: '+(_tool_error_text(result)[:200] or 'error')
            if (result.get('structuredContent') or {}).get('retryable') is False:
                return failed(message,'tool_error')
            raise ProviderError(message,provider_response=provider_errors.capture('higgsfield',phase='status',code='tool_error',
                message=message,task_id=job_id))
        generation = (result.get('structuredContent') or {}).get('generation') or {}
        status = generation.get('status')
        if status == 'completed':
            media = generation.get('results') or {}
            return {'status':'succeeded','url':media.get('rawUrl') or media.get('minUrl')}
        if status in ('failed','canceled'):
            return failed('Higgsfield generation failed.',status)
        if status == 'nsfw':
            return failed(MODERATION,status)
        if status in ('ip_detected','ip_detect'):
            return failed('Higgsfield flagged possible IP in the content.',status)
        return {'status':'running' if status == 'in_progress' else 'queued'}

    def await_job(self,job_id,options=None,signal=None):
        options = {'timeoutMs':options} if isinstance(options,(int,float)) else options or {}
        signal = signal or options.get('signal')
        deadline = self.now()+options.get('timeoutMs',240000)
        while self.now() < deadline:
            result = self.job_status(job_id,signal)
            if result['status'] in ('succeeded','failed'):
                return result
            (signal.wait if signal else self.wait)(4000)
        return {'status':'failed','error':'Higgsfield generation timed out.','providerError':provider_errors.local('higgsfield','timeout',
            'Higgsfield generation timed out.',phase='timeout',task_id=job_id)}


def video_payload(input,env=None):
    model = mcp_model_id(input['model'],env)
    if not model:
        raise ValueError('Unknown Higgsfield model: '+input['model'])
    media = input.get('mediaIds') or []
    params = {'model':model,'medias':[{'value':identifier,'role':'image_references'} for identifier in media]}
    if input.get('prompt'):
        prompt = to_higgsfield_tags(input['prompt'])
        params['prompt'] = (LEGACY['higgsfield'] if media else '')+prompt if legacy_directive(env) else build_video_directive({
            'prompt':prompt,'refCount':len(media),'tagSyntax':'angle','refRoles':build_ref_roles(input['prompt'],len(media))})
    for source,target in [('aspectRatio','aspect_ratio'),('duration','duration'),('resolution','resolution')]:
        if input.get(source):
            params[target] = input[source].lower() if source == 'resolution' else input[source]
    return params


def image_payload(input,env=None):
    model = mcp_model_id(input['model'],env)
    if not model:
        raise ValueError('Unknown Higgsfield model: '+input['model'])
    params = {'model':model,'prompt':to_higgsfield_tags(input['prompt'])}
    for source,target in [('aspectRatio','aspect_ratio'),('quality','quality'),('resolution','resolution')]:
        if input.get(source):
            params[target] = input[source]
    if input.get('mediaIds'):
        params['medias'] = [{'value':identifier,'role':'image'} for identifier in input['mediaIds']]
    return params


_default_client = None
_client_lock = threading.Lock()


def get_client():
    global _default_client
    with _client_lock:
        if _default_client is None:
            _default_client = HiggsfieldClient()
        return _default_client


def mcp_upload_image(data,content_type='image/png',options=None,*,client=None,signal=None):
    return (client or get_client()).upload_image(data,content_type,signal=signal or (options or {}).get('signal'))


def mcp_generate_video(input,*,client=None,signal=None):
    return (client or get_client()).generate_video(input,signal)


def mcp_generate_image(input,*,client=None,signal=None):
    return (client or get_client()).generate_image(input,signal)


def mcp_job_status(job_id,options=None,*,client=None,signal=None):
    return (client or get_client()).job_status(job_id,signal or (options or {}).get('signal'))


def mcp_await_job(job_id,options=None,*,client=None,signal=None):
    return (client or get_client()).await_job(job_id,options,signal)


job_status = mcp_job_status
generate_video = mcp_generate_video
generate_image = mcp_generate_image
upload_image = mcp_upload_image
await_job = mcp_await_job
