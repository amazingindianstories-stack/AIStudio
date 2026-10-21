"""Portrait catalogue sync: list-only BytePlus inventory, readiness projection.

Ported from the production overlay. Reconcile imports missing remote
identities only (existing rows are immutable evidence) and projects remote
verification onto response copies. No remote writes happen here.
"""
import ast,hashlib,json,os,pathlib,time
def need(value):
 if not value:raise ValueError('Preview portrait pull-only HOLD')
class ListOnlyClient:
 def __init__(self,client):self._client=client
 @property
 def is_mock(self):return self._client.is_mock
 @property
 def available(self):return self._client.available
 def list_asset_groups(self,**kw):return self._client.list_asset_groups(**kw)
 def list_assets(self,**kw):return self._client.list_assets(**kw)
 def __getattr__(self,name):raise ValueError('Remote portrait write/interface forbidden')

def local_operation(asset):
 try:
  marker=json.loads(asset.get('statusMessage') or '{}')
  if not isinstance(marker,dict):marker={}
 except (ValueError,TypeError):marker={}
 status=asset.get('status') or ''
 if marker.get('operation')=='REMOTE_DELETE':
  return {'CLAIMED_ACK_UNCERTAIN':'deletion_pending','DELETE_UNKNOWN':'deletion_unknown','DELETE_FAILED':'deletion_failed'}.get(marker.get('state'))
 if status.startswith('RemoteDeletion'):return {'RemoteDeletionPending':'deletion_pending','RemoteDeletionUnknown':'deletion_unknown','RemoteDeletionFailed':'deletion_failed'}.get(status,'deletion_unknown')
 if status.startswith('Registration'):
  return 'registration_unknown' if 'Unknown' in status else 'registration_failed' if 'Failed' in status else 'registration_pending'
 if marker.get('state') in ('CLAIMED_ACK_UNCERTAIN','GROUP_CLAIMED_ACK_UNCERTAIN'):return 'registration_unknown' if marker.get('error_code') else 'registration_pending'
 if asset.get('statusMessage') in ('registration_outcome_unknown','group_registration_outcome_unknown'):return 'registration_unknown'
 return None

def group_operation_hold(asset):
 if (asset.get('status') or '').startswith(('Registration','RemoteDeletion')):return True
 if asset.get('statusMessage') in ('registration_outcome_unknown','group_registration_outcome_unknown'):return True
 try:marker=json.loads(asset.get('statusMessage') or '{}')
 except (ValueError,TypeError):return False
 if not isinstance(marker,dict):return False
 return marker.get('state') in ('CLAIMED_ACK_UNCERTAIN','GROUP_CLAIMED_ACK_UNCERTAIN','DELETE_UNKNOWN','DELETE_FAILED')

def project_readiness(result,remote_assets=None,verified_at=None,remote_groups=None):
 # Response copies only: originals, recorded status and tombstones are untouched.
 complete=remote_assets is not None
 remote={a['Id']:a for a in remote_assets} if complete else {}
 def asset(a):
  out=dict(a)
  if out.get('status')=='PreviewDeleted':return out
  identifier=out.get('byteplusAssetId');operation=local_operation(a)
  if operation:out['localOperation']=operation
  state='local_only' if not identifier else 'unverified'
  if identifier and complete:
   found=remote.get(identifier)
   state=({'Active':'active','Processing':'processing','Failed':'failed'}.get(found.get('Status'),'unverified') if found else 'absent')
   if found:out['remoteStatus']=found.get('Status')
   if state in ('active','processing','failed') and not operation:out['status']=found['Status']
   elif state=='absent':
    if not operation:out['status']='RemoteMissing'
    out['remoteVerificationMessage']='This historical asset ID is absent from the verified BytePlus default catalogue. Original local record and media are preserved.'
  if identifier and state=='unverified':
   if not operation:out['status']='RemoteUnverified'
   out['remoteVerificationMessage']='BytePlus registration could not be verified; local record and media are preserved.'
  out['remoteVerification']=state
  if complete:out['remoteVerifiedAt']=verified_at
  out['catalogueScope']={'projectName':'default','groupType':'AIGC','region':'ap-southeast-1'}
  return out
 out=dict(result);assets=[asset(a) for a in result.get('assets',[])];byid={a['id']:a for a in assets}
 if 'assets' in result:out['assets']=assets
 if 'groups' in result:
  present_groups={g['Id'] for g in remote_groups} if remote_groups is not None else None
  projected=[]
  for group in result['groups']:
   identifier=group.get('byteplusGroupId')
   eligible=group.get('projectName','default')=='default' and group.get('groupType','AIGC')=='AIGC'
   state='local_only' if not identifier else 'unverified' if present_groups is None or not eligible else 'present' if identifier in present_groups else 'absent'
   item={**group,'assets':[byid.get(a['id'],asset(a)) for a in group.get('assets',[])],'groupVerification':state,'remoteGroupMissing':state=='absent'}
   if present_groups is not None and eligible:item['groupVerifiedAt']=verified_at
   item['groupOperationHold']=any(group_operation_hold(a) for a in group.get('assets',[]))
   item['groupCatalogueScope']={'projectName':'default','groupType':'AIGC','region':'ap-southeast-1'}
   projected.append(item)
  out['groups']=projected
 return out

def compile_pull_only(source,namespace):
 tree=ast.parse(source);fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='reconcile')
 # Keep the complete two inventories and original import/update semantics;
 # remove the entire remote registration phase structurally, not by flags.
 start=next(i for i,n in enumerate(fn.body) if isinstance(n,ast.Assign) and any(isinstance(x,ast.Tuple) and [getattr(e,'id',None) for e in x.elts]==['groups','assets'] for x in n.targets))
 end=next(i for i,n in enumerate(fn.body) if isinstance(n,ast.Assign) and any(isinstance(x,ast.Tuple) and [getattr(e,'id',None) for e in x.elts]==['final_groups','final_assets'] for x in n.targets))
 fresh=next(n for n in fn.body[start:end] if isinstance(n,ast.Assign) and any(getattr(x,'id',None)=='fresh_urls' for x in n.targets))
 fn.body[start:end]=[fresh]
 # Import missing identities only. Existing copied rows are immutable evidence;
 # fresh URLs are projected in the existing final response loop, never saved.
 group_loop=next(n for n in fn.body if isinstance(n,ast.For) and getattr(n.target,'id',None)=='remote')
 group_condition=next(n for n in group_loop.body if isinstance(n,ast.If))
 group_condition.orelse=[]
 # The base's unlinked-name matching path updates an existing local row: remove it.
 group_condition.body=[n for n in group_condition.body if not (isinstance(n,ast.Assign) and any(getattr(t,'id',None)=='unlinked' for t in n.targets))]
 assignment=next(n for n in group_condition.body if isinstance(n,ast.Assign))
 need(isinstance(assignment.value,ast.IfExp));assignment.value=assignment.value.orelse
 asset_loop=next(n for n in fn.body if isinstance(n,ast.For) and n is not group_loop and getattr(n.target,'id',None)=='remote')
 asset_condition=next(n for n in asset_loop.body if isinstance(n,ast.If) and isinstance(n.test,ast.UnaryOp) and getattr(n.test.operand,'id',None)=='local_asset')
 asset_condition.orelse=[]
 inventory_check=ast.parse("if any(not asset.get('GroupId') or asset['GroupId'] not in {group['Id'] for group in remote_groups} for asset in remote_assets):\n raise ValueError('Incomplete remote portrait group inventory')").body[0]
 at=next(i for i,n in enumerate(fn.body) if isinstance(n,ast.For));fn.body.insert(at,inventory_check)
 calls=[n for n in ast.walk(fn) if isinstance(n,ast.Call) and isinstance(n.func,ast.Attribute) and isinstance(n.func.value,ast.Name) and n.func.value.id=='client']
 need(all(n.func.attr in ('list_asset_groups','list_assets') for n in calls))
 returns=[n for n in fn.body if isinstance(n,ast.Return)];need(len(returns)==1)
 returns[0].value=ast.Call(func=ast.Name(id='_project_readiness',ctx=ast.Load()),args=[returns[0].value,ast.Name(id='remote_assets',ctx=ast.Load()),ast.Call(func=ast.Name(id='_verified_now',ctx=ast.Load()),args=[],keywords=[])],keywords=[ast.keyword(arg='remote_groups',value=ast.Name(id='remote_groups',ctx=ast.Load()))])
 env={**namespace,'_project_readiness':project_readiness,'_verified_now':lambda:int(time.time()*1000)};exec(compile(ast.fix_missing_locations(ast.Module(body=[fn],type_ignores=[])),'<preview-portrait-pull-only>','exec'),env);return env['reconcile']

def list_transport(transport_module):
 class PortraitListTransport(transport_module.HttpTransport):
  paid_guard_exempt=True  # asset-library listing only; exact allowlist below
  def request(self,method,url,*,headers=None,body=None,raw_body=None,signal=None):
   from urllib.parse import urlsplit,parse_qs
   parsed=urlsplit(url);query=parse_qs(parsed.query,keep_blank_values=True)
   need(method=='POST' and parsed.scheme=='https' and parsed.netloc=='ark.ap-southeast-1.byteplusapi.com' and parsed.path=='/' and not parsed.fragment)
   need(set(query)=={'Action','Version'} and query['Action'] in (['ListAssetGroups'],['ListAssets']) and query['Version']==['2024-01-01'])
   need(body is None and isinstance(raw_body,bytes) and len(raw_body)<=32768)
   payload=json.loads(raw_body);need(isinstance(payload,dict) and set(payload)<={'ProjectName','Filter','MaxResults','NextToken'})
   need(payload.get('ProjectName')=='default' and payload.get('Filter')=={'GroupType':'AIGC'} and type(payload.get('MaxResults')) is int and 1<=payload['MaxResults']<=100)
   need('NextToken' not in payload or isinstance(payload['NextToken'],str) and len(payload['NextToken'])<=8192)
   return super().request(method,url,headers=headers,raw_body=raw_body,signal=signal)
 return PortraitListTransport(allowed_hosts={'ark.ap-southeast-1.byteplusapi.com'},timeout=45)

def install():
 from apps.assets import portrait_sync
 source=pathlib.Path(portrait_sync.__file__).read_bytes()
 original=compile_pull_only(source.decode(),portrait_sync.__dict__)
 def guarded(project_id,client):
  return original(project_id,ListOnlyClient(client))
 from apps.integrations import byteplus
 def read_client():
  config=byteplus.config_from_env();config['is_mock']=False
  from apps.integrations import transport
  return ListOnlyClient(byteplus.BytePlusClient(config=config,transport=list_transport(transport)))
 old_local_result=portrait_sync.local_result
 def unverified_local_result(*args,**kwargs):return project_readiness(old_local_result(*args,**kwargs))
 portrait_sync.local_result=unverified_local_result
 portrait_sync.get_client=read_client
 portrait_sync.reconcile=guarded
 return {'status':'INSTALLED_PREVIEW_PORTRAIT_PULL_ONLY','remote_writes_authorized':False}
