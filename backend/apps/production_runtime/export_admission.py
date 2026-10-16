"""Durable export admission (ported from the production launcher overlay).

The API records an admission receipt for every export it creates; the export
worker only sees exports with a valid receipt (read through the
``goal4_preview_worker_holds.new_export_registrations`` view available to the
worker role). Exports created before the Green cutover are never processed.
"""
import hashlib
import json
import uuid
PREFIX='g4preview:new-export:'
OPERATION='GOAL4_PREVIEW_NEW_EXPORT_ONLY'

def marker_key(identifier):
 return PREFIX+str(uuid.UUID(str(identifier)))

def install(component):
 if component not in ('api','worker'):raise ValueError('Preview export component')
 from django.db import transaction
 from django.db.models import Exists,OuterRef,Value,TextField
 from django.db.models.functions import Cast,Concat
 from apps.library.models import OrganizationIdempotencyKey as Receipt
 from apps.exports import services
 from apps.exports.models import MediaExport,MediaExportItem
 def markers():
  if component=='api':return Receipt.objects.filter(operation=OPERATION,status='completed',expires_at=0)
  from django.db import connection
  from types import SimpleNamespace
  class RegisteredRows:
   def iterator(self):
    with connection.cursor() as cursor:
     cursor.execute('SELECT key,actor_id,result,fingerprint FROM goal4_preview_worker_holds.new_export_registrations')
     while rows:=cursor.fetchmany(1000):
      for key,actor,result,fingerprint in rows:
       # Django's PostgreSQL raw cursor uses a no-op JSON loader.
       if isinstance(result,str):
        try:result=json.loads(result)
        except (ValueError,TypeError):continue
       yield SimpleNamespace(key=key,actor_id=actor,result=result,fingerprint=fingerprint)
  return RegisteredRows()
 def admitted(identifier,actor):
  key=marker_key(identifier)
  receipt=markers().filter(pk=key,actor_id=str(actor)).first()
  expected=hashlib.sha256((str(uuid.UUID(str(identifier)))+'\n'+str(actor)).encode()).hexdigest()
  return bool(receipt and receipt.fingerprint==expected and receipt.result=={'id':str(uuid.UUID(str(identifier)))})
 if component=='api':
  original_create=services.create_export
  def create(user_id,now=None):
   with transaction.atomic():
    result=original_create(user_id,now)
    identifier=str(uuid.UUID(result['id']));actor=str(user_id)
    Receipt.objects.create(key=marker_key(identifier),actor_id=actor,operation=OPERATION,
     fingerprint=hashlib.sha256((identifier+'\n'+actor).encode()).hexdigest(),status='completed',
     result={'id':identifier},created_at=services.now_ms() if now is None else now,expires_at=0)
    return result
  services.create_export=create
  for name in ('append_items','finalize_export'):
   original=getattr(services,name)
   def guarded(identifier,actor,*args,_original=original,**kwargs):
    if not admitted(identifier,actor):raise services.ExportError('EXPORT_NOT_FOUND')
    return _original(identifier,actor,*args,**kwargs)
   setattr(services,name,guarded)
 else:
  # Filter every export worker transition/cleanup, including related item reads.
  # Manager-instance overrides avoid changing Django's shared Manager class.
  import types
  from django.db.models import Q
  original_jobs=MediaExport.objects.get_queryset
  def registered_jobs(self):
   eligible=Q(pk__in=[])
   for receipt in markers().iterator():
    try:
     identifier=str(uuid.UUID(receipt.key.removeprefix(PREFIX)))
     actor=str(uuid.UUID(receipt.actor_id))
    except (ValueError,TypeError,AttributeError):continue
    digest=hashlib.sha256((identifier+'\n'+actor).encode()).hexdigest()
    if receipt.key!=marker_key(identifier) or receipt.result!={'id':identifier} or receipt.fingerprint!=digest:continue
    eligible|=Q(pk=identifier,user_id=actor)
   return original_jobs().filter(eligible)
  MediaExport.objects.get_queryset=types.MethodType(registered_jobs,MediaExport.objects)
  original_items=MediaExportItem.objects.get_queryset
  def registered_items(self):
   return original_items().filter(export_id__in=MediaExport.objects.values('id'))
  MediaExportItem.objects.get_queryset=types.MethodType(registered_items,MediaExportItem.objects)

 return {'scope':OPERATION,'component':component,'historical_exports_enabled':False,'paid_providers':False}
