"""Paid-generation reservation and single-submit guard.

Ported from the production launcher overlay. The database schema it calls
(``goal4_preview_paid_budget``: ``reserve``/``transition``/``registered`` plus
row-level security that lets the worker role see only registered rows) is
already applied in production, so the API must register every new paid job
and the worker must claim each attempt and each provider POST exactly once.

Configured by ``settings.VEEVEE_PAID_GUARD``; no credentials, database access
or patching happens on import.
"""
import json,hashlib,threading,re,math,copy
LIMITED_SCOPE='GOAL4_EXISTING_GREEN_PREVIEW_NEW_IMAGE_AND_SEEDANCE_PAID_ONLY'
UNLIMITED_SCOPE='GOAL4_EXISTING_GREEN_PREVIEW_UNLIMITED_NEW_IMAGE_AND_SEEDANCE_20_25_PAID_ONLY'
SCOPE=LIMITED_SCOPE;SCHEMA='goal4_preview_paid_budget';CAP=2000
STATE=threading.local()
def require(v,m='Paid Preview budget guard rejected'):
 if not v:raise ValueError(m)
def fingerprint(v):return hashlib.sha256(json.dumps(v,sort_keys=True,separators=(',',':'),default=str).encode()).hexdigest()
def execution_contract(item):
 names=('id','user_id','kind','model','duration','resolution','generate_audio','draft_mode','draft_task_id','bitrate_mode','video_task_mode','aspect_ratio','prompt','submission_input','reference_images','reference_videos','reference_audios','continuation_frame_url','last_frame_url','project_id','folder_id','track_characters','width','height')
 return {n:getattr(item,n,None) for n in names}
def quote_for(contract,config):
 if config['approved_scope']==UNLIMITED_SCOPE:
  require(config.get('unlimited_new_jobs') is True,'Unlimited new-job authority required')
  # Seedance draft finals are admitted (owner decision 2026-10-13); the worker
  # still claims exactly one submission for the new final row.
  draft_final=bool(contract['draft_task_id']) and contract['kind']=='video'
  require(contract['user_id'] is not None and (not contract['draft_task_id'] or draft_final),'New authenticated initial jobs only')
  from apps.generation.model_registry import model_definition
  definition=model_definition(contract['model']) or {};provider=definition.get('provider')
  if contract['kind']=='image':
   require(provider in ('gemini','seedream'),'Only configured Gemini or Seedream image providers authorized')
   endpoint='https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent' if provider=='gemini' else 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations'
   return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[endpoint],'provider_payload_allowed_values':{}}
  require(contract['kind']=='video' and definition.get('id') in ('seedance','seedance-25'),'Only Seedance 2.0 or 2.5 video authorized')
  return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':['https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'],'provider_payload_allowed_values':{'output_format':['mov']} if definition.get('id')=='seedance-25' else {}}
 require(config['approved_scope']==SCOPE and config['maximum_total_cents']==CAP)
 quotes=config['reviewed_maximum_quotes'];quote=copy.deepcopy(quotes.get(contract['model']));require(quote is not None,'No verified maximum charge quote for this model')
 if quote['pricing_status']=='OPERATOR_CONSERVATIVE_RESERVATION_NOT_HARD_CAP':
  require(config.get('operator_budget_uncertainty_accepted') is True,'Operator budget uncertainty not authorized')
 else:require(quote['maximum_charge_verified'] is True and quote['pricing_status']=='VERIFIED_PROVIDER_MAXIMUM_NOT_ESTIMATE','Missing reviewed charge basis')
 if quote.get('reservation_formula')=='seedance_current_token_estimate_times_two_floor_300':
  require(type(contract.get('duration')) is int and 3<=contract['duration']<=15,'Unpriced Seedance duration')
  require(contract.get('resolution') in ('480p','720p','1080p'),'Unpriced Seedance resolution')
  pixels={'480p':864*480,'720p':1440*810,'1080p':2560*1440}[contract['resolution']]
  video_input=bool(contract.get('reference_videos'));seconds=contract['duration']+(30 if video_input else 0)
  rate=(7.0 if video_input else 11.7) if contract['resolution']=='1080p' else (6.4 if video_input else 10.7)
  estimate=pixels*24*seconds/1024/1000000*rate*100
  quote['maximum_cents']=max(300,math.ceil(estimate*2));quote['operator_estimate_cents']=math.ceil(estimate);quote['operator_reference_seconds_reserved']=30 if video_input else 0
 require(type(quote['maximum_cents']) is int and 0<quote['maximum_cents']<=CAP,'Conservative paid reservation exceeds the twenty dollar budget; requested quality was preserved')
 require(re.fullmatch('[a-f0-9]{64}',quote['pricing_evidence_sha256']) is not None)
 for name,values in quote['allowed_input_values'].items():require(contract.get(name) in values,'Request outside priced maximum contract')
 require(contract['kind'] in ('image','video') and contract['user_id'] is not None and not contract['draft_task_id'],'New authenticated generation only; finalization separately held')
 if contract['kind']=='video':require(quote.get('provider_payload_allowed_values',{}).get('output_format')==['mov'],'Native MOV payload guard required')
 return quote
def operator_quotes(pricing_evidence_sha256):
 base={'pricing_status':'OPERATOR_CONSERVATIVE_RESERVATION_NOT_HARD_CAP','pricing_evidence_sha256':pricing_evidence_sha256,'maximum_charge_verified':False}
 image={**base,'maximum_cents':600,'allowed_input_values':{'kind':['image'],'resolution':['1K','2K','4K']},'allowed_paid_endpoints':['https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent'],'provider_payload_allowed_values':{'generationConfig.candidateCount':[1]},'provider_payload_numeric_maxima':{'generationConfig.maxOutputTokens':32768}}
 video={**base,'maximum_cents':300,'reservation_formula':'seedance_current_token_estimate_times_two_floor_300','allowed_input_values':{'kind':['video'],'resolution':['480p','720p','1080p']},'allowed_paid_endpoints':['https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'],'provider_payload_allowed_values':{'model':['dreamina-seedance-2-5-260628'],'output_format':['mov']},'provider_payload_numeric_maxima':{'duration':15}}
 return {'nano-banana-pro':image,'Nano Banana Pro':image,'seedance-25':video,'Seedance 2.5':video}

def install_paid_guard(config):
 """Call after django.setup, before API routes/worker imports. Never patch source files."""
 from django.db import connection,transaction
 from apps.generation.services import enqueue,executor
 from apps.generation.providers.transport import HttpTransport,ProviderError
 require(config['approved_scope'] in (LIMITED_SCOPE,UNLIMITED_SCOPE))
 unlimited=config['approved_scope']==UNLIMITED_SCOPE
 require(config.get('unlimited_new_jobs') is True if unlimited else config['maximum_total_cents']==CAP)
 require(not getattr(enqueue,'_goal4_paid_guard_installed',False),'Duplicate paid guard install')
 persist_original=enqueue.persist;execute_original=executor.execute_admitted;request_original=HttpTransport.request
 def persist(item):
  with transaction.atomic():
   row=persist_original(item);row.refresh_from_db();contract=execution_contract(row)
   try:quote=quote_for(contract,config)
   except ValueError as error:STATE.api_error=str(error);raise
   try:
    with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.reserve(%s,%s,%s,%s,%s)',[row.id,row.user_id,quote['maximum_cents'],fingerprint(quote),fingerprint(contract)])
   except Exception:STATE.api_error='Paid Preview budget unavailable or exhausted; no provider submission occurred.';raise
   return row
 def execute(item,**kwargs):
  contract=execution_contract(item);quote=quote_for(contract,config)
  require(connection.get_autocommit(),'Paid one-shot transition must commit before provider I/O')
  with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.transition(%s,%s,%s,%s)',[item.id,fingerprint(contract),'RESERVED','ATTEMPTING'])
  require(not getattr(STATE,'active',None),'Nested paid execution denied')
  STATE.active={'id':item.id,'contract':contract,'quote':quote}
  try:return execute_original(item,**kwargs)
  finally:STATE.active=None
 def request(self,method,url,**kwargs):
  if method.upper() not in ('GET','HEAD'):
   active=getattr(STATE,'active',None)
   if not active or method.upper()!='POST' or url not in active['quote']['allowed_paid_endpoints']:
    raise ProviderError('Paid Preview endpoint is outside the reserved scope.',code='preview_paid_scope',may_have_submitted=False)
   body=kwargs.get('body');require(isinstance(body,dict),'Quoted JSON payload required')
   if active['contract']['kind']=='image' and not unlimited:
    require(not body.get('tools'),'Paid grounding/tool calls not authorized')
    generation=body.setdefault('generationConfig',{});generation.setdefault('maxOutputTokens',32768);generation.setdefault('candidateCount',1)
   for key,values in active['quote'].get('provider_payload_allowed_values',{}).items():
    value=body
    for part in key.split('.'):value=value.get(part) if isinstance(value,dict) else None
    require(value in values,'Provider payload outside quote')
   for path,maximum in active['quote'].get('provider_payload_numeric_maxima',{}).items():
    value=body
    for part in path.split('.'):value=value.get(part) if isinstance(value,dict) else None
    require(type(value) in (int,float) and 0<=value<=maximum,'Missing or excessive priced token/output bound')
   require(connection.get_autocommit(),'Paid submit claim must be durable')
   with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.transition(%s,%s,%s,%s)',[active['id'],fingerprint(active['contract']),'ATTEMPTING','SUBMITTING'])
  return request_original(self,method,url,**kwargs)
 enqueue.persist=persist;executor.execute_admitted=execute;HttpTransport.request=request;enqueue._goal4_paid_guard_installed=True
 return {'status':'INSTALLED_FAIL_CLOSED_SHARED_NEW_JOB_ONE_SHOT_GUARD','maximum_total_cents':None if unlimited else CAP,'reservations_released_automatically':False,'provider_billing_cap_measured':False}
def wrap_wsgi(application):
 def guarded(environ,start_response):
  STATE.api_error=None;captured={}
  def capture(status,headers,exc_info=None):captured.update(status=status,headers=headers,exc_info=exc_info);return lambda data:None
  result=application(environ,capture)
  if STATE.api_error:
   if hasattr(result,'close'):result.close()
   data=json.dumps({'error':STATE.api_error,'code':'PREVIEW_PAID_BUDGET_HOLD'}).encode();start_response('409 Conflict',[('Content-Type','application/json'),('Content-Length',str(len(data))),('Cache-Control','no-store')]);return [data]
  start_response(captured['status'],captured['headers'],captured.get('exc_info'));return result
 return guarded
