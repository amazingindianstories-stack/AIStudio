"""Native portrait upload registration with BytePlus, created exactly once.

Ported from the production overlay. The database row is the durable claim;
no transaction spans a provider call and uncertain outcomes are never
retried. Installed after tombstones.
"""
import hashlib,json,uuid,os,pathlib,ast

def at_stage(stage,call,*args,**kwargs):
 try:return call(*args,**kwargs)
 except Exception as exc:
  exc._portrait_registration_stage=stage
  raise

def safe_registration_error(exc):
 known={'invalid_image','file_too_large','decode_failed','unsupported_format','invalid_dimensions','invalid_aspect_ratio','dimensions_out_of_bounds','invalid_aspect_ratio','missing_configuration','NotFound.group_id','QuotaSharedPoolExceeded','network_error'}
 code=getattr(exc,'code',None)
 if code in known:return code
 stage=getattr(exc,'_portrait_registration_stage','client_setup')
 return {'reference_read':'registration_reference_read_failed','native_read':'registration_native_read_failed','native_validation':'registration_native_validation_failed','native_sign':'registration_native_sign_failed','group_lookup':'registration_group_lookup_failed','database_claim':'registration_database_claim_failed','client_setup':'registration_client_setup_failed'}.get(stage,'registration_validation_failed')

def registration_error_message(code):
 return {'dimensions_out_of_bounds':'Original saved. BytePlus requires image width and height between 300 and 6000 pixels.',
 'invalid_dimensions':'Original saved. BytePlus requires image width and height between 300 and 6000 pixels.',
 'invalid_aspect_ratio':'Original saved. BytePlus requires an image aspect ratio between 0.4 and 2.5.',
 'unsupported_format':'Original saved. This image format is not supported for BytePlus registration.',
 'file_too_large':'Original saved. BytePlus requires an image smaller than 30 MB.',
 'decode_failed':'Original saved. The image could not be decoded for BytePlus registration.',
 'registration_reference_read_failed':'Original saved. The verified BytePlus reference copy could not be read.',
 'registration_native_read_failed':'Original saved. Storage access failed while preparing BytePlus registration.',
 'registration_native_sign_failed':'Original saved. A secure download link could not be prepared for BytePlus.',
 'registration_group_lookup_failed':'Original saved. Its BytePlus group could not be verified.',
 'registration_database_claim_failed':'Original saved. Registration could not be recorded safely.',
 'registration_client_setup_failed':'Original saved. BytePlus registration configuration is unavailable.',
 'QuotaSharedPoolExceeded':'Original saved. BytePlus asset-library capacity is full.',
 'missing_configuration':'Original saved. BytePlus registration credentials are unavailable.'}.get(code,'Original saved. Registration could not be completed; no automatic retry will occur.')

NATIVE_SHA='f819dc688befd52a65969e55ce2e3ef280d65dd0429f2515e20e410b1d5bb5ca'
REFERENCE_SHA='4e37d0ac90b48c1a002c1d9cba24a973ae4bb20a0b47c4f67a1b26efbcae4d2f'
REFERENCE_PATH='portrait-registration-references/4744ffba-c1a2-4013-b8fa-ae60a0cecbdd/'+REFERENCE_SHA+'.png'
REFERENCE_GENERATION=1791810381177381

def load_exact_reference():
 from google.oauth2 import service_account
 from google.cloud import storage
 import datetime
 from django.conf import settings
 media=settings.VEEVEE_MEDIA_CONFIG;expected_identity=media.get('service_account_email')
 reference_key=media.get('prefix','')+REFERENCE_PATH
 cred=service_account.Credentials.from_service_account_file(os.environ['GOOGLE_APPLICATION_CREDENTIALS'])
 if expected_identity and cred.service_account_email!=expected_identity:raise ValueError('Exact registration ADC identity mismatch')
 client=storage.Client(project=media.get('project'),credentials=cred)
 blob=client.bucket(media['bucket']).blob(reference_key,generation=REFERENCE_GENERATION)
 blob.reload(retry=None,timeout=10)
 if str(blob.generation)!=str(REFERENCE_GENERATION) or int(blob.size)!=22600835 or blob.md5_hash!='jKcfFCPRAB+DHqOjlwbc8w==':raise ValueError('Exact reference generation metadata mismatch')
 data=blob.download_as_bytes(if_generation_match=REFERENCE_GENERATION,retry=None,timeout=20)
 if len(data)!=22600835 or hashlib.sha256(data).hexdigest()!=REFERENCE_SHA:raise ValueError('Exact reference native bytes mismatch')
 url=blob.generate_signed_url(version='v4',expiration=datetime.timedelta(minutes=10),method='GET',generation=REFERENCE_GENERATION)
 return {'bytes':data,'url':url,'provenance':{'source_sha256':NATIVE_SHA,'reference_sha256':REFERENCE_SHA,'bucket':media['bucket'],'key':reference_key,'generation':str(REFERENCE_GENERATION),'bytes':22600835,'original_bytes_changed':False}}

def prepare_registration_source(raw,ref,actor_id,*,validate,sign_native,load_reference=load_exact_reference):
 if not isinstance(raw,bytes):raise ValueError('Native portrait reader must return bytes')
 if hashlib.sha256(raw).hexdigest()==NATIVE_SHA:
  if len(raw)!=9608407:raise ValueError('Exact native reference source byte count mismatch')
  selected=at_stage('reference_read',load_reference)
  if not isinstance(selected['bytes'],bytes) or len(selected['bytes'])!=22600835 or hashlib.sha256(selected['bytes']).hexdigest()!=REFERENCE_SHA:raise ValueError('Exact reference derivative identity mismatch')
  info=at_stage('native_validation',validate,selected['bytes'])
  if info.get('format')!='png' or [info.get('width'),info.get('height')]!=[6000,2545]:raise ValueError('Exact reference pixel bounds mismatch')
  return selected['url'],selected['provenance']
 at_stage('native_validation',validate,raw)
 return at_stage('native_sign',sign_native,ref,actor_id=actor_id),None

def register_once(asset,actor_id,*,store,read_native,sign_native,client,validate):
 # Existing table state is the durable claim; no transaction spans a provider call.
 if str(asset.get('createdById'))!=str(actor_id):raise ValueError('Portrait actor mismatch')
 if asset.get('byteplusAssetId'):return asset
 if asset.get('status') not in ('LocalOnly','Active'):return asset
 group=store.group(asset['groupId'])
 raw=at_stage('native_read',read_native,asset['imageUrl'])
 signed,reference_provenance=prepare_registration_source(raw,asset['imageUrl'],actor_id,validate=validate,sign_native=sign_native)
 if not signed or signed.startswith('data:'):raise ValueError('Native private signed reference unavailable')
 # Only this explicit new upload can create/replace its missing remote group.
 group_receipt=None
 if group.get('byteplusGroupId'):
  try:
   remote_group=at_stage('group_lookup',client.get_asset_group,group['byteplusGroupId'],project_name=group.get('projectName') or 'default')
   if remote_group.get('Id')!=group['byteplusGroupId']:raise ValueError('Remote group identity mismatch')
  except Exception as exc:
   if getattr(exc,'code',None)!='NotFound.group_id' or getattr(exc,'status',None)!=404 or not isinstance(getattr(exc,'details',None),dict):raise
   remote_group=None
 else:remote_group=None
 if remote_group is None:
  group_marker={'version':1,'attempt':str(uuid.uuid4()),'state':'GROUP_CLAIMED_ACK_UNCERTAIN','local_group_id':str(asset['groupId']),'previous_remote_group_id':group.get('byteplusGroupId'),'source_sha256':hashlib.sha256(raw).hexdigest()}
  if hasattr(store,'assert_committed_context'):store.assert_committed_context()
  if not at_stage('database_claim',store.claim_group,asset,group_marker):return store.get(asset['id'])
  if hasattr(store,'assert_committed_context'):store.assert_committed_context()
  try:remote_group=client.create_asset_group((group.get('name') or 'Portrait')[:64],(group.get('description') or '')[:300],group_type='AIGC',project_name='default')
  except Exception as exc:
   return store.group_failure(asset['id'],group_marker,getattr(exc,'code',None) or 'group_registration_outcome_unknown')
  if not isinstance(remote_group,dict) or not isinstance(remote_group.get('Id'),str) or not remote_group['Id']:return store.group_failure(asset['id'],group_marker,'group_registration_outcome_unknown')
  asset=store.group_ack(asset['id'],group_marker,remote_group['Id']);group=store.group(asset['groupId']);group_receipt={**group_marker,'state':'GROUP_ACKNOWLEDGED','remote_group_id':remote_group['Id']}
 marker={'version':1,'attempt':str(uuid.uuid4()),'source_sha256':hashlib.sha256(raw).hexdigest(),'remote_group_id':group['byteplusGroupId'],'state':'CLAIMED_ACK_UNCERTAIN','group_receipt':group_receipt,'reference_provenance':reference_provenance}
 if hasattr(store,'assert_committed_context'):store.assert_committed_context()
 if not at_stage('database_claim',store.claim,asset,marker):return store.get(asset['id'])
 if hasattr(store,'assert_committed_context'):store.assert_committed_context()
 try:
  response=client.create_asset(group['byteplusGroupId'],signed,name=(asset.get('name') or 'Portrait')[:64],asset_type='Image',project_name=group.get('projectName') or 'default')
 except Exception as exc:
  # A captured explicit API rejection is not a successful acknowledgement.
  code=getattr(exc,'code',None);http=getattr(exc,'status',None)
  definite=code and type(http) is int and 400<=http<500 and http not in (408,) and isinstance(getattr(exc,'details',None),dict)
  return store.failure(asset['id'],marker,code if definite else 'registration_outcome_unknown',definite)
 if not isinstance(response,dict) or not response.get('Id'):
  return store.failure(asset['id'],marker,'registration_outcome_unknown',False)
 return store.ack(asset['id'],marker,response)

class DjangoStore:
 def __init__(self):
  from apps.assets import portrait_db
  from apps.assets.models import PortraitAsset,PortraitGroup
  self.db=portrait_db;self.Asset=PortraitAsset;self.Group=PortraitGroup
 def group(self,id):return self.db.get_portrait_group(id)
 def get(self,id):return self.db.get_portrait_asset(id)
 def local_error(self,id,code):
  from django.db import transaction
  with transaction.atomic():
   row=self.Asset.objects.select_for_update().get(pk=id)
   if not row.byteplus_asset_id and row.status in ('LocalOnly','Active'):row.status='LocalOnly';row.status_message=code;row.save(update_fields=['status','status_message'])
  return self.get(id)
 def claim_group(self,asset,marker):
  from django.db import transaction
  self.assert_committed_context()
  with transaction.atomic():
   group=self.Group.objects.select_for_update().get(pk=asset['groupId']);row=self.Asset.objects.select_for_update().get(pk=asset['id'])
   if row.status not in ('LocalOnly','Active') or row.byteplus_asset_id or str(row.group_id)!=str(asset['groupId']) or group.project_name!='default' or str(row.created_by_id)!=str(asset['createdById']) or row.image_url!=asset['imageUrl'] or group.byteplus_group_id!=marker['previous_remote_group_id']:return False
   if self.Asset.objects.filter(group_id=group.id,status__in=['RegistrationGroupPending','RegistrationGroupUnknown']).exclude(pk=row.id).exists():return False
   row.status='RegistrationGroupPending';row.status_message=json.dumps(marker,sort_keys=True);row.save(update_fields=['status','status_message'])
  return True
 def group_failure(self,id,marker,code):
  from django.db import transaction
  with transaction.atomic():
   row=self.Asset.objects.select_for_update().get(pk=id)
   if row.status!='RegistrationGroupPending' or row.status_message!=json.dumps(marker,sort_keys=True):raise ValueError('Group outcome state mismatch')
   row.status='RegistrationGroupUnknown';row.status_message=json.dumps({**marker,'error_code':code},sort_keys=True);row.save(update_fields=['status','status_message'])
  return self.get(id)
 def group_ack(self,id,marker,remote_id):
  from django.db import transaction
  with transaction.atomic():
   group=self.Group.objects.select_for_update().get(pk=marker['local_group_id']);row=self.Asset.objects.select_for_update().get(pk=id)
   if row.status!='RegistrationGroupPending' or row.status_message!=json.dumps(marker,sort_keys=True) or str(row.group_id)!=marker['local_group_id'] or group.project_name!='default' or group.byteplus_group_id!=marker['previous_remote_group_id']:raise ValueError('Group ACK state mismatch; reconcile without retry')
   group.byteplus_group_id=remote_id;group.save(update_fields=['byteplus_group_id'])
   row.status='LocalOnly';row.status_message=json.dumps({**marker,'state':'GROUP_ACKNOWLEDGED','remote_group_id':remote_id},sort_keys=True);row.save(update_fields=['status','status_message'])
  return self.get(id)
 def assert_committed_context(self):
  from django.db import connection
  if not connection.get_autocommit() or connection.in_atomic_block:raise ValueError('Registration requires independently committed claim')
 def claim(self,asset,marker):
  from django.db import transaction
  from apps.common.leases import now_ms
  self.assert_committed_context()
  with transaction.atomic():
   group=self.Group.objects.select_for_update().get(pk=asset['groupId']);row=self.Asset.objects.select_for_update().get(pk=asset['id'])
   if row.byteplus_asset_id or row.status not in ('LocalOnly','Active') or str(row.created_by_id)!=str(asset['createdById']) or str(row.group_id)!=str(asset['groupId']) or row.image_url!=asset['imageUrl'] or group.project_name!='default' or group.byteplus_group_id!=marker['remote_group_id']:return False
   row.status='RegistrationPending';row.status_message=json.dumps(marker,sort_keys=True);row.updated_at=now_ms();row.save(update_fields=['status','status_message','updated_at'])
  return True
 def finish(self,id,marker,*,status,message,remote_id=None):
  from django.db import transaction
  from apps.common.leases import now_ms
  with transaction.atomic():
   row=self.Asset.objects.select_for_update().get(pk=id)
   if row.status!='RegistrationPending' or row.status_message!=json.dumps(marker,sort_keys=True) or row.byteplus_asset_id:raise ValueError('Registration ACK state mismatch; reconcile without retry')
   row.status=status;row.status_message=message;row.updated_at=now_ms()
   if remote_id:row.byteplus_asset_id=remote_id
   row.save(update_fields=['status','status_message','updated_at','byteplus_asset_id'])
  return self.get(id)
 def failure(self,id,marker,code,definite):
  failure={**marker,'state':'REJECTED' if definite else 'CLAIMED_ACK_UNCERTAIN','error_code':code}
  return self.finish(id,marker,status='RegistrationFailed' if definite else 'RegistrationUnknown',message=json.dumps(failure,sort_keys=True))
 def ack(self,id,marker,response):
  ack={**marker,'state':'ACKNOWLEDGED','remote_id':response['Id']}
  return self.finish(id,marker,status='Active' if response.get('Status')=='Active' else 'Processing',message=json.dumps(ack,sort_keys=True),remote_id=response['Id'])
 def confirm_own(self,asset):
  from django.db import transaction
  with transaction.atomic():
   row=self.Asset.objects.select_for_update().get(pk=asset['id'])
   try:marker=json.loads(row.status_message or '{}')
   except (TypeError,ValueError):return
   if row.status!='Processing' or marker.get('version')!=1 or marker.get('state')!='ACKNOWLEDGED' or marker.get('remote_id')!=row.byteplus_asset_id:return
   group=self.Group.objects.get(pk=row.group_id)
   if group.byteplus_group_id!=marker.get('remote_group_id') or asset.get('byteplusAssetId')!=row.byteplus_asset_id:return
   if asset.get('remoteVerification') not in ('active','failed'):return
   row.status='Active' if asset['remoteVerification']=='active' else 'Failed';row.save(update_fields=['status'])


def install(route,client_factory):
 """Install after local-only upload and tombstone overlays. READY upload only."""
 def identity():return None
 identity()
 old=route.upload.cls.post
 def post(view,request,*args,**kwargs):
  identity()
  actor=route.lookup(request)
  if actor is None:return old(view,request,*args,**kwargs)
  body=route.body_or_empty(request);store=DjangoStore()
  if body.get('groupId'):
   group=store.group(body['groupId'])
   if not group or (group.get('projectId') and str(group['projectId'])!=str(body.get('projectId'))):
    from rest_framework.response import Response
    return Response({'error':'Portrait group is outside the requested project scope.'},status=403)
  # Native resumable READY identity is reused after an uncertain HTTP response.
  if body.get('referenceId'):
   ready=route.resolve_ready_upload(actor.id,body['referenceId'],purposes={'portrait'})
   ref='/api/media/'+ready.key
   query=store.Asset.objects.filter(created_by_id=actor.id,image_url=ref).exclude(status='PreviewDeleted')
   if body.get('groupId'):query=query.filter(group_id=body['groupId'])
   prior=list(query[:2])
   if len(prior)==1:
    from rest_framework.response import Response
    return route.renew_session(request,Response({'ok':True,'asset':store.db.asset_json(prior[0]),'registrationReused':True}))
   if len(prior)>1:
    from rest_framework.response import Response
    return Response({'error':'Ambiguous existing portrait identity; reconcile without registration retry.'},status=409)
  response=old(view,request,*args,**kwargs)
  if response.status_code>=400 or not isinstance(response.data,dict) or not response.data.get('asset'):return response
  asset=response.data['asset']
  if not body.get('referenceId'):response.data['registrationError']='Use a verified native upload to register this local image.';return response
  from apps.media.storage import get_storage
  from apps.assets.byteplus import validate_portrait_image,MAX_FILE_BYTES
  try:
   asset=register_once(asset,actor.id,store=store,read_native=lambda ref:get_storage().read_reference_bytes(ref,max_bytes=MAX_FILE_BYTES)['bytes'],sign_native=route.sign_stored_ref,client=client_factory(),validate=validate_portrait_image)
   asset={**asset,'remoteVerification':('active' if asset.get('status')=='Active' and asset.get('byteplusAssetId') else 'processing' if asset.get('byteplusAssetId') and asset.get('status')=='Processing' else 'failed' if asset.get('status')=='RegistrationFailed' else 'unverified' if asset.get('status') in ('RegistrationUnknown','RegistrationPending','RegistrationGroupPending','RegistrationGroupUnknown') else 'local_only')}
   response.data['asset']=asset
   if asset['status'] in ('RegistrationFailed','RegistrationUnknown','RegistrationGroupUnknown','LocalOnly'):
    message=asset.get('statusMessage') or 'Registration unavailable'
    try:message=json.loads(message).get('error_code') or message
    except (TypeError,ValueError):pass
    response.data['registrationError']=message
  except Exception as exc:
   code=safe_registration_error(exc)
   # Only an unclaimed LocalOnly row is changed; pending/unknown provenance stays.
   current=store.local_error(asset['id'],code)
   response.data['asset']={**current,'remoteVerification':'local_only' if current.get('status')=='LocalOnly' else 'unverified'}
   response.data['registrationErrorCode']=code
   response.data['registrationError']=registration_error_message(code)
  return response
 route.upload.cls.post=post
 # Complete inventory may advance only our durable acknowledged Processing rows.
 from apps.assets import portrait_sync
 old_reconcile=portrait_sync.reconcile
 def reconcile(*args,**kwargs):
  identity();result=old_reconcile(*args,**kwargs);store=DjangoStore()
  for asset in result.get('assets',[]):
   if asset.get('remoteVerification') in ('active','failed'):store.confirm_own(asset)
  return result
 portrait_sync.reconcile=reconcile
 return {'status':'INSTALLED_NATIVE_UPLOAD_CREATE_ONCE','remote_group_creation':'explicit-new-upload-only-create-once','schema_changes':False}

def native_client():
 from apps.assets.byteplus import BytePlusClient,config_from_env
 from apps.generation.providers import transport
 HttpTransport=transport.HttpTransport
 from urllib.parse import urlsplit,parse_qs
 class CreateOnlyTransport(HttpTransport):
  paid_guard_exempt=True  # asset-library registration only; exact allowlist below
  def request(self,method,url,**kwargs):
   u=urlsplit(url);q=parse_qs(u.query)
   if method!='POST' or u.scheme!='https' or u.netloc!='ark.ap-southeast-1.byteplusapi.com' or u.path!='/' or q.get('Version')!=['2024-01-01'] or set(q)!={'Action','Version'} or q.get('Action') not in (['CreateAsset'],['GetAssetGroup'],['CreateAssetGroup']):raise ValueError('Native portrait CreateAsset target mismatch')
   p=json.loads(kwargs.get('raw_body') or b'{}')
   if q['Action']==['GetAssetGroup']:
    if set(p)!={'Id','ProjectName'} or not p['Id'] or p['ProjectName']!='default':raise ValueError('Group lookup payload mismatch')
    return super().request(method,url,**kwargs)
   if q['Action']==['CreateAssetGroup']:
    if set(p)!={'Name','Description','GroupType','ProjectName'} or p['GroupType']!='AIGC' or p['ProjectName']!='default':raise ValueError('Group creation payload mismatch')
    return super().request(method,url,**kwargs)
   source=urlsplit(p.get('URL',''))
   if set(p)!={'GroupId','URL','Name','AssetType','ProjectName','Moderation'} or not p['GroupId'] or p['AssetType']!='Image' or p['ProjectName']!='default' or p['Moderation']!={'Strategy':'Default'} or source.scheme!='https' or source.hostname!='storage.googleapis.com':raise ValueError('Native portrait registration payload mismatch')
   return super().request(method,url,**kwargs)
 c=config_from_env();c['is_mock']=False
 return BytePlusClient(config=c,transport=CreateOnlyTransport(allowed_hosts={'ark.ap-southeast-1.byteplusapi.com'},timeout=45))
