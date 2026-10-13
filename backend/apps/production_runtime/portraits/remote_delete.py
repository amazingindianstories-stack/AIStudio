"""Remote-first portrait deletion with a durable claim and verified ACK.

Ported from the production overlay; installed after registration. BytePlus
is asked to delete first; an unverified outcome keeps the portrait and is
never retried automatically.
"""
import ast,hashlib,json,os,pathlib,uuid
class DeleteHold(Exception):pass

def marker_of(asset):
 try:
  value=json.loads(asset.get('statusMessage') or '{}')
  return value if isinstance(value,dict) else {}
 except (ValueError,TypeError):return {}

def delete_once(asset,actor_id,*,project_id,group_id,store,client,allow_archived=False):
 group=store.group(asset['groupId'])
 if not group or str(asset['groupId'])!=str(group_id) or (group.get('projectId') and str(group['projectId'])!=str(project_id)) or group.get('projectName','default')!='default':raise DeleteHold('Portrait is outside the requested character/project scope.')
 previous=marker_of(asset)
 uncertain_states={'CLAIMED_ACK_UNCERTAIN','GROUP_CLAIMED_ACK_UNCERTAIN','SUBMISSION_UNCERTAIN','REGISTRATION_UNKNOWN'}
 nested=previous.get('group_receipt') if isinstance(previous.get('group_receipt'),dict) else {}
 if previous.get('operation')!='REMOTE_DELETE' and (previous.get('state') in uncertain_states or nested.get('state') in uncertain_states or asset.get('statusMessage') in ('registration_outcome_unknown','group_registration_outcome_unknown')):raise DeleteHold('Uncertain registration must be reconciled before deletion.')
 if previous.get('operation')=='REMOTE_DELETE' and previous.get('state') in ('CLAIMED_ACK_UNCERTAIN','DELETE_FAILED','DELETE_UNKNOWN'):raise DeleteHold('Deletion outcome requires reconciliation; no automatic retry.')
 if asset['status']=='PreviewDeleted' and not allow_archived:
  if asset.get('byteplusAssetId') and not (previous.get('operation')=='REMOTE_DELETE' and previous.get('state')=='ACKNOWLEDGED'):raise DeleteHold('Portrait was archived locally; remote deletion needs the exact reviewed cleanup operation.')
  return {'ok':True,'assetId':asset['id'],'groupId':asset['groupId'],'remoteDeletion':'already_archived'}
 if asset['status'].startswith('Registration') or asset['status'] in ('RemoteDeletionPending','RemoteDeletionUnknown','RemoteDeletionFailed'):raise DeleteHold('Pending or uncertain registration/deletion requires reconciliation first.')
 remote_id=asset.get('byteplusAssetId');receipt=None
 if remote_id:
  remote=client.get_asset(remote_id,project_name='default')
  if remote is not None and (remote.get('Id')!=remote_id or remote.get('GroupId')!=group.get('byteplusGroupId')):raise DeleteHold('BytePlus asset identity/group does not match this portrait.')
  if remote is None:
   receipt=client.last_receipt
   if not receipt:raise DeleteHold('Remote absence was not acknowledged; no deletion attempted.')
 marker={'version':1,'operation':'REMOTE_DELETE','attempt':str(uuid.uuid4()),'state':'CLAIMED_ACK_UNCERTAIN','actor_id':str(actor_id),'asset_id':asset['id'],'local_group_id':asset['groupId'],'remote_asset_id':remote_id,'remote_group_id':group.get('byteplusGroupId'),'project_name':'default','project_id':group.get('projectId'),'source_ref_sha256':hashlib.sha256(asset['imageUrl'].encode()).hexdigest(),'previous_status':asset['status'],'previous_status_message':asset.get('statusMessage'),'archived_cleanup':bool(allow_archived)}
 if not store.claim(asset,marker):raise DeleteHold('Portrait changed or another deletion is pending; no remote request was repeated.')
 if not remote_id:outcome='not_registered'
 elif receipt:outcome='already_absent'
 else:
  try:
   outcome,receipt=client.delete_asset(remote_id,project_name='default')
  except Exception:
   store.unknown(asset['id'],marker)
   raise DeleteHold('BytePlus deletion did not return a verified acknowledgement. Portrait retained; reconcile without retry.') from None
 store.archive(asset['id'],marker,receipt,outcome)
 return {'ok':True,'assetId':asset['id'],'groupId':asset['groupId'],'remoteDeletion':outcome}

class DjangoDeleteStore:
 def __init__(self):
  from apps.assets import portrait_db
  from apps.assets.models import PortraitAsset,PortraitGroup
  self.db=portrait_db;self.Asset=PortraitAsset;self.Group=PortraitGroup
 def group(self,id):return self.db.get_portrait_group(id)
 def get(self,id):return self.db.get_portrait_asset(id)
 def context(self):
  from django.db import connection
  if not connection.get_autocommit() or connection.in_atomic_block:raise DeleteHold('Deletion requires an independently committed claim.')
 def claim(self,asset,marker):
  from django.db import transaction
  from apps.common.leases import now_ms
  self.context()
  with transaction.atomic():
   group=self.Group.objects.select_for_update().get(pk=asset['groupId']);row=self.Asset.objects.select_for_update().get(pk=asset['id'])
   if str(row.group_id)!=str(asset['groupId']) or row.status!=asset['status'] or row.status_message!=asset.get('statusMessage') or row.byteplus_asset_id!=asset.get('byteplusAssetId') or hashlib.sha256(row.image_url.encode()).hexdigest()!=marker['source_ref_sha256'] or group.byteplus_group_id!=marker['remote_group_id'] or group.project_name!='default' or (str(group.project_id) if group.project_id else None)!=marker['project_id']:return False
   row.status='PreviewDeleted' if marker['archived_cleanup'] else 'RemoteDeletionPending';row.status_message=json.dumps(marker,sort_keys=True);row.updated_at=now_ms();row.save(update_fields=['status','status_message','updated_at'])
  self.context();return True
 def finish(self,id,marker,state,receipt=None,outcome=None):
  from django.db import transaction
  from apps.common.leases import now_ms
  self.context()
  with transaction.atomic():
   group=self.Group.objects.select_for_update().get(pk=marker['local_group_id']);row=self.Asset.objects.select_for_update().get(pk=id)
   if str(row.group_id)!=marker['local_group_id'] or row.status_message!=json.dumps(marker,sort_keys=True) or row.byteplus_asset_id!=marker['remote_asset_id'] or hashlib.sha256(row.image_url.encode()).hexdigest()!=marker['source_ref_sha256'] or group.byteplus_group_id!=marker['remote_group_id'] or (str(group.project_id) if group.project_id else None)!=marker['project_id'] or group.project_name!='default':raise DeleteHold('Remote outcome/local commit mismatch; reconcile without retry.')
   row.status='PreviewDeleted' if state=='ACKNOWLEDGED' or marker['archived_cleanup'] else 'RemoteDeletionUnknown';row.status_message=json.dumps({**marker,'state':state,'receipt':receipt,'outcome':outcome},sort_keys=True);row.updated_at=now_ms();row.save(update_fields=['status','status_message','updated_at'])
 def unknown(self,id,marker):self.finish(id,marker,'DELETE_UNKNOWN')
 def archive(self,id,marker,receipt,outcome):self.finish(id,marker,'ACKNOWLEDGED',receipt,outcome)

class ExactDeleteClient:
 def __init__(self,client):self.client=client;self.last_receipt=None
 def get_asset(self,id,project_name):
  try:return self.client.get_asset(id,project_name=project_name)
  except Exception as exc:
   if getattr(exc,'code',None)=='NotFound.asset_id' and getattr(exc,'status',None)==404 and isinstance(getattr(exc,'details',None),dict):
    meta=exc.details.get('ResponseMetadata',{})
    if meta.get('Action')=='GetAsset' and meta.get('Version')=='2024-01-01' and bool(meta.get('RequestId')) and meta.get('Error',{}).get('Code')=='NotFound.asset_id':self.last_receipt={'action':'GetAsset','http_status':404,'error_code':'NotFound.asset_id','request_id':meta.get('RequestId')};return None
   raise
 def delete_asset(self,id,project_name):
  self.client.transport.receipt=None
  try:
   result=self.client.delete_asset(id,project_name=project_name)
  except Exception as exc:
   if getattr(exc,'code',None)=='NotFound.asset_id' and getattr(exc,'status',None)==404 and isinstance(getattr(exc,'details',None),dict):
    meta=exc.details.get('ResponseMetadata',{})
    if meta.get('Action')=='DeleteAsset' and meta.get('Version')=='2024-01-01' and bool(meta.get('RequestId')) and meta.get('Error',{}).get('Code')=='NotFound.asset_id':return 'already_absent',{'action':'DeleteAsset','http_status':404,'error_code':'NotFound.asset_id','request_id':meta.get('RequestId')}
   raise
  if result!={} or not self.client.transport.receipt:raise DeleteHold('Malformed BytePlus deletion acknowledgement.')
  return 'confirmed',self.client.transport.receipt

def native_delete_client():
 from apps.assets.byteplus import BytePlusClient,config_from_env
 from apps.generation.providers import transport
 from urllib.parse import urlsplit,parse_qs
 class DeleteGetTransport(transport.HttpTransport):
  paid_guard_exempt=True  # asset-library GetAsset/DeleteAsset only; exact allowlist below
  receipt=None
  def request(self,method,url,**kw):
   u=urlsplit(url);q=parse_qs(u.query)
   if method!='POST' or u.scheme!='https' or u.netloc!='ark.ap-southeast-1.byteplusapi.com' or u.path!='/' or u.fragment or set(q)!={'Action','Version'} or q.get('Version')!=['2024-01-01'] or q.get('Action') not in (['GetAsset'],['DeleteAsset']):raise DeleteHold('Exact deletion endpoint mismatch')
   body=json.loads(kw.get('raw_body') or b'{}')
   if set(body)!={'Id','ProjectName'} or not isinstance(body['Id'],str) or not body['Id'] or body['ProjectName']!='default':raise DeleteHold('Exact deletion payload mismatch')
   result=super().request(method,url,**kw)
   if q['Action']==['DeleteAsset'] and result.ok:
    payload=result.json();meta=payload.get('ResponseMetadata',{})
    if payload.get('Result')!={} or meta.get('Error') or meta.get('Action')!='DeleteAsset' or meta.get('Version')!='2024-01-01' or not meta.get('RequestId'):raise DeleteHold('Malformed deletion ACK; reconcile without retry')
    self.receipt={'action':'DeleteAsset','http_status':result.status,'request_id':meta['RequestId']}
   return result
 cfg=config_from_env();cfg['is_mock']=False
 return ExactDeleteClient(BytePlusClient(config=cfg,transport=DeleteGetTransport(allowed_hosts={'ark.ap-southeast-1.byteplusapi.com'},timeout=45)))

def install(route):
 def identity():return None
 identity()
 def handle(request,path_group=None):
  from rest_framework.response import Response
  identity();actor=route.lookup(request)
  if actor is None:return Response({'error':'UNAUTHENTICATED'},status=401)
  asset_id=route.first(request,'assetId')
  if not asset_id:return Response({'error':'assetId is required; character-group deletion remains unavailable.'},status=400)
  store=DjangoDeleteStore();asset=store.get(asset_id)
  if not asset:return Response({'ok':False,'error':'Portrait no longer exists; refresh Gallery before retrying.'},status=404)
  requested_group=path_group or route.first(request,'groupId')
  if not requested_group:return Response({'ok':False,'error':'Character identity is required.'},status=400)
  try:
   result=delete_once(asset,actor.id,project_id=route.first(request,'projectId'),group_id=requested_group,store=store,client=native_delete_client())
   route.log_activity(actor.id,'delete_portrait_asset',{'id':asset['id'],'groupId':asset['groupId'],'remoteDeletion':result['remoteDeletion']})
   return route.renew_session(request,Response(result))
  except DeleteHold as exc:return Response({'ok':False,'error':str(exc)},status=409)
  except Exception:return Response({'ok':False,'error':'BytePlus deletion could not be verified. Portrait retained; no automatic retry.'},status=502)
 def delete(self,request,*args,**kwargs):return handle(request)
 def group_delete(self,request,id,*args,**kwargs):return handle(request,id)
 route.portraits.cls.delete=delete;route.group_assets.cls.delete=group_delete
 return {'status':'INSTALLED_REMOTE_FIRST_GALLERY_DELETE','media_deletions':0,'group_deletions':0}
