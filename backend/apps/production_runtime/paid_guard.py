"""Paid-generation reservation and single-submit guard.

Ported from the production launcher overlay. The database schema it calls
(``goal4_preview_paid_budget``: ``reserve``/``transition``/``registered`` plus
row-level security that lets the worker role see only registered rows) is
already applied in production, so the API must register every new paid job
and the worker must claim each attempt and each provider POST exactly once.

Configured by ``settings.VEEVEE_PAID_GUARD``; no credentials, database access
or patching happens on import.
"""
import json,hashlib,threading,re,math,copy,base64
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
  if contract['kind']=='audio':
   return audio_quote(contract)
  from apps.generation.model_registry import model_definition
  definition=model_definition(contract['model']) or {};provider=definition.get('provider')
  if provider=='magnific':
   return magnific_quote(contract)
  if provider=='kling':
   return kling_quote(contract,definition)
  if contract['kind']=='image':
   require(provider in ('gemini','seedream'),'Only configured Gemini or Seedream image providers authorized')
   # Each Gemini image model is pinned to its own generateContent endpoint (registry model code).
   from apps.generation.providers import gemini
   endpoint=gemini.endpoint(contract['model']) if provider=='gemini' else 'https://ark.ap-southeast.bytepluses.com/api/v3/images/generations'
   return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[endpoint],'provider_payload_allowed_values':{}}
  if contract['kind']=='video' and provider=='omni':
   return omni_quote(contract)
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
def omni_quote(contract):
 """Gemini Omni Flash 1.1 (VEEVEE_GEMINI_OMNI, unlimited scope only): the one Interactions create endpoint, with the
 model code and this job's own ratio, size and length pinned in the payload. Retired Omni models are refused."""
 from apps.generation.availability import switched_on
 from apps.generation.model_registry import capability,provider_model_id
 from apps.generation.providers import omni
 require(switched_on('omni'),'Gemini Omni Flash 1.1 is not enabled')
 model=omni.submission_model(contract['model'])
 require(not contract['draft_task_id'],'New Omni generation only')
 for field,key in (('resolution','resolutions'),('duration','durations'),('aspect_ratio','aspectRatios')):
  require(contract.get(field) in capability(model['id'],key,[]),'Request outside the Omni contract')
 return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[omni.build_endpoint()],
  'provider_payload_allowed_values':{'model':[provider_model_id(model['id'],{})],'background':[True],'response_format.type':['video'],
   'response_format.aspect_ratio':[contract['aspect_ratio']],'response_format.resolution':[contract['resolution']],
   'response_format.duration':[str(contract['duration'])+'s']}}
def kling_quote(contract,definition):
 """Kling Image 3.0 / 2.1 (VEEVEE_KLING, unlimited scope only): the one create endpoint on the configured Kling host,
 with this job's registry model code, a single image and its own ratio and size pinned in the payload."""
 from apps.generation.availability import switched_on
 from apps.generation.providers import kling
 require(switched_on('kling'),definition['name']+' is not enabled. Choose another image model.')
 require(contract['kind']=='image' and not contract['draft_task_id'],'New Kling image generation only')
 resolution=contract.get('resolution') or '1K';aspect=contract.get('aspect_ratio') or '1:1'
 capabilities=definition.get('capabilities') or {}
 require(resolution in capabilities.get('resolutions',[]) and aspect in capabilities.get('aspectRatios',[]),'Request outside the Kling contract')
 try:endpoint=kling.create_url()
 except RuntimeError as error:raise ValueError(str(error)) from error
 return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[endpoint],
  'provider_payload_allowed_values':{'model_name':[definition['providerModelId']],'n':[1],'aspect_ratio':[aspect],'resolution':[resolution.lower()]}}
def audio_quote(contract):
 """Audio transcription (unlimited scope only): one generateContent call on the configured transcription model,
 for this job's own immutable snapshot. The exact request body is checked by audio_payload_matches."""
 from django.conf import settings
 from apps.media.audio import transcription_endpoint
 from apps.media.audio_inputs import AUDIO_EXTENSIONS,MAX_AUDIO_BYTES
 model=getattr(settings,'AUDIO_TRANSCRIPTION_MODEL',None);value=contract.get('submission_input')
 require(not contract['draft_task_id'] and isinstance(value,dict) and type(value.get('version')) is int and value['version']==2
  and value.get('operation')=='audio-transcription','New audio transcription only')
 require(isinstance(model,str) and re.fullmatch(r'gemini-[a-z0-9.-]{1,60}',model) is not None and value.get('model')==model
  and contract['model']==f'Gemini ({model})','Audio transcription outside the configured model')
 require(value.get('mimeType') in AUDIO_EXTENSIONS and type(value.get('byteLength')) is int and 0<=value['byteLength']<=MAX_AUDIO_BYTES
  and isinstance(value.get('sha256'),str) and re.fullmatch('[a-f0-9]{64}',value['sha256']) is not None,'Audio input outside the transcription contract')
 return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[transcription_endpoint(model)],'provider_payload_allowed_values':{}}
def audio_payload_matches(body,contract):
 """Exactly the transcription request for this job: its own snapshot bytes and MIME, the fixed prompt, nothing else."""
 from apps.media.audio import TRANSCRIPTION_PROMPT
 value=contract['submission_input']
 try:
  (content,)=body['contents'];inline,text=content['parts'];data=inline['inlineData']
  decoded=base64.b64decode(data['data'],validate=True)
 except (KeyError,TypeError,ValueError):return False
 return (set(body)=={'contents','generationConfig'} and body['generationConfig']=={'temperature':0.1}
  and set(content)=={'role','parts'} and content['role']=='user' and set(inline)=={'inlineData'} and set(data)=={'mimeType','data'}
  and data['mimeType']==value['mimeType'] and text=={'text':TRANSCRIPTION_PROMPT}
  and len(decoded)==value['byteLength'] and hashlib.sha256(decoded).hexdigest()==value['sha256'])
def magnific_quote(contract):
 """Magnific upscales (VEEVEE_MAGNIFIC_UPSCALE): one exact create endpoint per model."""
 from apps.generation.availability import switched_on
 from apps.generation.providers import magnific
 require(switched_on('magnific'),'Magnific upscaling is not enabled')
 require(not contract['draft_task_id'] and isinstance(contract.get('submission_input'),dict),'New Magnific upscale only')
 if contract['kind']=='image':
  require(contract['model'] in magnific.MODELS,'Unknown Magnific image model')
  endpoint={'creative':'/v1/ai/image-upscaler','precision-v1':'/v1/ai/image-upscaler-precision','precision-v2':'/v1/ai/image-upscaler-precision-v2'}[magnific.resolve_variant(contract['model'])]
  return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[magnific.BASE_URL+endpoint],'provider_payload_allowed_values':{}}
 require(contract['kind']=='video' and contract['model'] in magnific.VIDEO_MODELS,'Unknown Magnific video model')
 allowed={} if contract['model']=='Magnific Video Topaz' else {'output_format':list(magnific.VIDEO_OUTPUT_FORMATS)}
 return {'maximum_cents':0,'pricing_status':'UNLIMITED_NEW_JOB_REGISTRATION_NOT_PRICE_GATE','allowed_paid_endpoints':[magnific.video_create_url(contract['model'])],'provider_payload_allowed_values':allowed}
def operator_quotes(pricing_evidence_sha256):
 base={'pricing_status':'OPERATOR_CONSERVATIVE_RESERVATION_NOT_HARD_CAP','pricing_evidence_sha256':pricing_evidence_sha256,'maximum_charge_verified':False}
 image={**base,'maximum_cents':600,'allowed_input_values':{'kind':['image'],'resolution':['1K','2K','4K']},'allowed_paid_endpoints':['https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image:generateContent'],'provider_payload_allowed_values':{'generationConfig.candidateCount':[1]},'provider_payload_numeric_maxima':{'generationConfig.maxOutputTokens':32768}}
 image_21={**image,'allowed_paid_endpoints':['https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1:generateContent']}
 video={**base,'maximum_cents':300,'reservation_formula':'seedance_current_token_estimate_times_two_floor_300','allowed_input_values':{'kind':['video'],'resolution':['480p','720p','1080p']},'allowed_paid_endpoints':['https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks'],'provider_payload_allowed_values':{'model':['dreamina-seedance-2-5-260628'],'output_format':['mov']},'provider_payload_numeric_maxima':{'duration':15}}
 return {'nano-banana-pro':image,'Nano Banana Pro':image,'nano-banana-2-1':image_21,'Nano Banana 2.1':image_21,'seedance-25':video,'Seedance 2.5':video}

def install_paid_guard(config):
 """Call after django.setup, before API routes/worker imports. Never patch source files."""
 from django.db import connection,transaction
 from apps.generation.services import enqueue,executor
 from apps.generation.providers.transport import HttpTransport,ProviderError
 require(config['approved_scope'] in (LIMITED_SCOPE,UNLIMITED_SCOPE))
 unlimited=config['approved_scope']==UNLIMITED_SCOPE
 require(config.get('unlimited_new_jobs') is True if unlimited else config['maximum_total_cents']==CAP)
 require(not getattr(enqueue,'_goal4_paid_guard_installed',False),'Duplicate paid guard install')
 from apps.generation.services import upscale_submission,audio_submission
 persist_original=enqueue.persist;execute_original=executor.execute_admitted;request_original=HttpTransport.request
 upscale_original=upscale_submission.submit_claimed_upscale
 audio_persist_original=audio_submission.persist_audio_intent;audio_transcribe_original=audio_submission.transcribe_claimed
 def register(row):
  row.refresh_from_db();contract=execution_contract(row)
  try:quote=quote_for(contract,config)
  except ValueError as error:STATE.api_error=str(error);raise
  try:
   with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.reserve(%s,%s,%s,%s,%s)',[row.id,row.user_id,quote['maximum_cents'],fingerprint(quote),fingerprint(contract)])
  except Exception:STATE.api_error='Paid Preview budget unavailable or exhausted; no provider submission occurred.';raise
  return row
 def persist(item):
  with transaction.atomic():return register(persist_original(item))
 def persist_audio(fields):
  # The audio view creates its intent directly; register it in the same transaction as enqueue.persist does.
  with transaction.atomic():return register(audio_persist_original(fields))
 def execute(item,**kwargs):
  contract=execution_contract(item);quote=quote_for(contract,config)
  if getattr(item,'task_id',None):
   # A row holding an accepted task (a Kling image whose poll or download was interrupted) only resumes polling:
   # its one claim was spent on that task, so it runs with no claim and every POST is refused.
   require(not getattr(STATE,'active',None),'Nested paid execution denied')
   return execute_original(item,**kwargs)
  require(connection.get_autocommit(),'Paid one-shot transition must commit before provider I/O')
  with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.transition(%s,%s,%s,%s)',[item.id,fingerprint(contract),'RESERVED','ATTEMPTING'])
  require(not getattr(STATE,'active',None),'Nested paid execution denied')
  STATE.active={'id':item.id,'contract':contract,'quote':quote}
  try:return execute_original(item,**kwargs)
  finally:STATE.active=None
 def submit_upscale(item,**kwargs):
  # Magnific bypasses execute_admitted; claim the same one-shot attempt first.
  contract=execution_contract(item);quote=quote_for(contract,config)
  require(connection.get_autocommit(),'Paid one-shot transition must commit before provider I/O')
  with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.transition(%s,%s,%s,%s)',[item.id,fingerprint(contract),'RESERVED','ATTEMPTING'])
  require(not getattr(STATE,'active',None),'Nested paid execution denied')
  STATE.active={'id':item.id,'contract':contract,'quote':quote}
  try:return upscale_original(item,**kwargs)
  finally:STATE.active=None
 def transcribe_audio(claimed,*args,**kwargs):
  # Audio bypasses execute_admitted. Its claim follows the committed SUBMISSION_PENDING fence (never replayed), so a
  # refused claim here provably sent nothing and process_audio ends the row instead of holding it uncertain.
  try:
   require(not getattr(STATE,'active',None),'Nested paid execution denied')
   contract=execution_contract(claimed);quote=quote_for(contract,config)
   require(connection.get_autocommit(),'Paid one-shot transition must commit before provider I/O')
   with connection.cursor() as cursor:cursor.execute('SELECT goal4_preview_paid_budget.transition(%s,%s,%s,%s)',[claimed.id,fingerprint(contract),'RESERVED','ATTEMPTING'])
  except Exception as error:
   raise ProviderError('Paid Preview claim refused for this transcription; nothing was sent.',code='preview_paid_scope',may_have_submitted=False) from error
  STATE.active={'id':claimed.id,'contract':contract,'quote':quote}
  try:return audio_transcribe_original(claimed,*args,**kwargs)
  finally:STATE.active=None
 def request(self,method,url,**kwargs):
  # BytePlus asset-library transports (GetAsset, list, create/delete asset) are
  # not generation and each enforces its own exact endpoint/payload allowlist.
  if getattr(self,'paid_guard_exempt',False) is True:return request_original(self,method,url,**kwargs)
  if method.upper() not in ('GET','HEAD'):
   active=getattr(STATE,'active',None)
   if not active or method.upper()!='POST' or url not in active['quote']['allowed_paid_endpoints']:
    raise ProviderError('Paid Preview endpoint is outside the reserved scope.',code='preview_paid_scope',may_have_submitted=False)
   body=kwargs.get('body');require(isinstance(body,dict),'Quoted JSON payload required')
   if active['contract']['kind']=='audio' and not audio_payload_matches(body,active['contract']):
    raise ProviderError('Transcription payload is outside the reserved scope.',code='preview_paid_scope',may_have_submitted=False)
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
 upscale_submission.submit_claimed_upscale=submit_upscale
 audio_submission.persist_audio_intent=persist_audio;audio_submission.transcribe_claimed=transcribe_audio
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
