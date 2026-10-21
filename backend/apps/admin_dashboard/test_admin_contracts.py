from testsupport.frozen_oracle import run as oracle_run
import csv
import io
import json
import subprocess
import time
import threading
from concurrent.futures import ThreadPoolExecutor
import uuid
from pathlib import Path
from unittest.mock import patch
from django.db import connection, transaction
from django.test import TransactionTestCase, SimpleTestCase, override_settings
from apps.admin_dashboard import tests as fixtures
from apps.authentication.models import User
from apps.authentication.password import verify_password
from apps.common.models import ActivityLog
from apps.generation.models import Generation
from apps.media.storage import MemoryAdapter, StorageService
from .models import AppSetting, Pricing, UserLimit
from . import runtime_audit, status


@override_settings(ROOT_URLCONF='apps.admin_dashboard.urls')
class AdminContractTests(TransactionTestCase):
    cookie=fixtures.SettingsTests.cookie
    def setUp(self):
        fixtures.SettingsTests.setUp(self)
        User.objects.filter(pk=fixtures.UID).update(role='admin')
        self.cookie()

    def post(self,path,data):
        return self.client.post('/api/admin/'+path,json.dumps(data),content_type='application/json')

    def create_user(self):
        response=self.post('users',{'email':' NEW@EXAMPLE.INVALID ','password':'fixture-password','name':' Person ','role':'other'})
        self.assertEqual(response.status_code,200)
        return response.json()['user']

    def generation(self,**values):
        fields={'id':uuid.uuid4(),'kind':'image','status':'succeeded','prompt':'fixture','model':'fixture','aspect_ratio':'1:1','user_id':fixtures.UID,'created_at':int(time.time()*1000),'updated_at':1}
        fields.update(values)
        return Generation.objects.create(**fields)

    def test_admin_gate_all_methods_and_intentional_retirement(self):
        User.objects.filter(pk=fixtures.UID).update(role='user')
        for method,path in [('get','data'),('get','logs'),('get','activity'),('get','status'),('post','users'),('patch','users'),('delete','users'),('post','limits'),('post','user-limits'),('post','pricing'),('post','set-token'),('post','audit/runtime'),('post','migrate-schema')]:
            response=getattr(self.client,method)('/api/admin/'+path)
            self.assertEqual((response.status_code,response.json()),(403,{'error':'FORBIDDEN'}))
        User.objects.filter(pk=fixtures.UID).update(role='admin')
        self.assertEqual(self.post('migrate-schema',{}).status_code,410)

    def test_admin_routes_answer_401_without_a_session(self):
        self.client.cookies.clear()
        for method,path in [('get','data'),('get','logs'),('get','activity'),('get','status'),('post','users'),('patch','users'),('delete','users'),('post','limits'),('post','user-limits'),('post','pricing'),('post','audit/runtime'),('post','migrate-schema')]:
            response=getattr(self.client,method)('/api/admin/'+path)
            self.assertEqual((response.status_code,response.json()),(401,{'error':'UNAUTHENTICATED'}),path)
        # Token seeding also accepts a setup secret instead of a session, so it keeps one refusal for both.
        response=self.client.post('/api/admin/set-token')
        self.assertEqual((response.status_code,response.json()),(403,{'error':'FORBIDDEN'}))

    def test_malformed_user_ids_are_not_found_instead_of_failing(self):
        for response in (self.client.delete('/api/admin/users?id=not-a-uuid'),
                         self.client.patch('/api/admin/users',json.dumps({'id':'not-a-uuid','name':'x'}),content_type='application/json'),
                         self.post('user-limits',{'userId':'not-a-uuid','key':'maxConcurrentJobs','value':2})):
            self.assertEqual((response.status_code,response.json()),(404,{'error':'User not found.'}))

    def test_users_safe_fields_uniqueness_self_protection_and_revocation(self):
        user=self.create_user()
        self.assertEqual((user['email'],user['name'],user['role']),('new@example.invalid','Person','user'))
        self.assertEqual(set(user),{'id','email','name','role','color','avatarUrl','isActive','createdAt'})
        self.assertTrue(verify_password('fixture-password',User.objects.get(pk=user['id']).password_hash,User.objects.get(pk=user['id']).password_salt))
        self.assertEqual(self.post('users',{'email':'new@example.invalid','password':'fixture-password'}).status_code,409)
        for change in [{'role':'user'},{'isActive':False},{'password':'reset-password'}]:
            response=self.client.patch('/api/admin/users',json.dumps({'id':fixtures.UID,**change}),content_type='application/json')
            self.assertEqual(response.status_code,400)
        self.assertEqual(self.client.delete('/api/admin/users?id='+fixtures.UID).status_code,400)
        response=self.client.patch('/api/admin/users',json.dumps({'id':user['id'],'isActive':False,'role':'admin','password':'reset-password'}),content_type='application/json')
        self.assertEqual(response.status_code,200)
        target=User.objects.get(pk=user['id'])
        self.assertEqual(target.auth_version,1)
        self.assertFalse(target.is_active)
        self.assertEqual(ActivityLog.objects.get(action='admin_user_updated').detail['changedFields'],['role','isActive','password'])
        with patch('apps.media.avatars.delete_avatar_image') as delete:
            self.assertEqual(self.client.delete('/api/admin/users?id='+user['id']).json(),{'ok':True})
            delete.assert_called_once_with(None)
        self.assertFalse(User.objects.filter(pk=user['id']).exists())

    def test_limits_coercion_rounding_personal_types_and_clearing(self):
        self.assertEqual(self.post('limits',{'key':'maxConcurrentJobs','value':'2.5'}).json(),{'ok':True})
        self.assertEqual(AppSetting.objects.get(pk='maxConcurrentJobs').value,'3')
        self.assertEqual(self.post('limits',{'key':'maxConcurrentJobs','value':8.5}).status_code,400)
        base={'userId':fixtures.UID,'key':'maxConcurrentJobs'}
        for raw in ['2',True,{},8.1]: self.assertEqual(self.post('user-limits',{**base,'value':raw}).status_code,400)
        self.assertEqual(self.post('user-limits',{**base,'key':'seedanceConcurrency','value':5}).status_code,400,'account-wide limits have no per-user override')
        self.assertEqual(self.post('limits',{'key':'seedanceConcurrency','value':10}).json(),{'ok':True})
        self.assertEqual(self.post('limits',{'key':'seedanceConcurrency','value':51}).status_code,400)
        self.assertEqual(self.post('user-limits',{**base,'value':2.5}).status_code,200)
        self.assertEqual(UserLimit.objects.get(user_id=fixtures.UID,key='maxConcurrentJobs').value,'3')
        self.assertEqual(self.post('user-limits',{**base,'value':None}).status_code,200)
        self.assertFalse(UserLimit.objects.exists())
        self.assertEqual(ActivityLog.objects.filter(action='admin_user_limit_updated').count(),2)

    def test_pricing_upsert_preserves_notes_and_validates_units(self):
        Pricing.objects.create(model='fixture',unit_cost_cents=3,unit='per_image',notes='keep')
        self.assertEqual(self.post('pricing',{'model':' fixture ','unitCostCents':'-Infinity','unit':'per_image'}).status_code,200)
        row=Pricing.objects.get(pk='fixture')
        self.assertEqual((row.unit_cost_cents,row.notes),(0,'keep'))
        self.assertEqual(self.post('pricing',{'model':'fixture','unitCostCents':'1.5','unit':'per_image'}).status_code,200)
        self.assertEqual(Pricing.objects.get(pk='fixture').unit_cost_cents,2)
        self.assertEqual(self.post('pricing',{'model':'fixture','unitCostCents':1,'unit':'image'}).json(),{'error':'Invalid pricing unit.'})
        self.assertEqual(self.post('pricing',{'model':'fixture','unit':'per_image'}).status_code,400)

    def test_dashboard_aggregates_every_row_and_lazy_pricing_never_overwrites(self):
        self.generation(cost_cents=30,cost_basis='reconciled')
        self.generation(cost_cents=20,cost_basis='estimated',kind='video')
        self.generation(cost_cents=900,status='failed',prompt='private'*2000)
        self.generation(cost_cents=800,status='queued',kind='depth')
        Pricing.objects.create(model='Nano Banana Pro',unit_cost_cents=777,unit='per_image',notes='custom')
        result=self.client.get('/api/admin/data').json()
        self.assertEqual((result['stats']['totalGenerations'],result['stats']['totalCostCents'],result['stats']['reconciledCostCents'],result['stats']['estimatedCostCents']),(4,50,30,20))
        self.assertEqual(result['users'][0]['genCount'],4)
        self.assertEqual(result['users'][0]['costCents'],50)
        self.assertEqual(result['limits'],{'maxPromptLength':30000,'maxConcurrentJobs':8,'seedanceConcurrency':3})
        self.assertEqual(len(result['pricing']),29)  # 23 frozen rows + 4 Magnific video rows + Nano Banana 2.1 + Gemini Omni Flash 1.1
        self.assertNotIn('private',json.dumps(result))
        self.assertEqual(Pricing.objects.get(pk='Nano Banana Pro').unit_cost_cents,777)

    def test_logs_sql_preview_keyset_totals_and_csv_evidence(self):
        moment=1700000000000
        for i in range(3): self.generation(id=uuid.UUID(int=i+1),created_at=moment,prompt='x'*305+' literal %_\\',cost_cents=5,flagged=True,flagged_at=moment,flag_reason='reason,"quoted"\rline',judge_score={'identity':42})
        self.generation(status='failed',cost_cents=999,created_at=moment)
        response=self.client.get('/api/admin/logs?flagged=1&limit=2')
        self.assertEqual(response.status_code,200)
        first=response.json()
        self.assertEqual((len(first['rows']),first['total'],first['totalCostCents']),(2,3,15))
        self.assertEqual(len(first['rows'][0]['prompt']),300)
        self.assertTrue(first['rows'][0]['promptTruncated'])
        self.assertEqual(first['rows'][0]['judgeScore'],{'identity':42})
        second=self.client.get('/api/admin/logs',{'flagged':'1','cursor':first['nextCursor'],'limit':'2'}).json()
        self.assertEqual(len(second['rows']),1)
        self.assertEqual(second['nextCursor'],None)
        self.assertEqual(self.client.get('/api/admin/logs',{'q':'literal %_\\'}).json()['total'],3)
        exported=self.client.get('/api/admin/logs?flagged=1&format=csv')
        rows=list(csv.DictReader(io.StringIO(exported.content.decode())))
        self.assertEqual(len(rows),3)
        self.assertTrue(rows[0]['prompt'].endswith('literal %_\\'))
        self.assertEqual(rows[0]['judge_score'],'{"identity":42}')
        self.assertEqual(rows[0]['flag_reason'],'reason,"quoted"\rline')
        self.assertEqual(exported['X-Logs-Truncated'],'false')
        self.assertEqual(exported['Cache-Control'],'no-store')

    def test_activity_initial_action_inventory_and_followup_keyset(self):
        for i in range(3): ActivityLog.objects.create(id=uuid.UUID(int=i+1),action='fixture',detail={'n':i},created_at=10)
        ActivityLog.objects.create(id=uuid.uuid4(),action='older',detail=None,created_at=1)
        first=self.client.get('/api/admin/activity?action=fixture&limit=2').json()
        self.assertEqual((first['total'],first['actions']),(3,['fixture','older']))
        self.assertEqual(first['rows'][0]['detail'],{'n':2})
        second=self.client.get('/api/admin/activity',{'action':'fixture','limit':2,'cursor':first['nextCursor']}).json()
        self.assertNotIn('actions',second)
        self.assertEqual(len(second['rows']),1)

    def test_setup_token_private_write_no_secret_audit_and_session_or_secret(self):
        storage=StorageService(MemoryAdapter())
        token={'access_token':'synthetic-access','refresh_token':'synthetic-refresh','client_id':'synthetic-client'}
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch.dict('os.environ',{'SET_TOKEN_SECRET':'synthetic-setup'}):
            self.client.cookies.clear()
            response=self.client.post('/api/admin/set-token',json.dumps(token),content_type='application/json',HTTP_X_SETUP_SECRET='synthetic-setup')
            self.assertEqual(response.status_code,200)
            stored=json.loads(storage.read_private_buffer('settings/higgsfield-mcp-token.json'))
            self.assertEqual(stored['expires_in'],86399)
            self.assertIn('obtained_at',stored)
            row=ActivityLog.objects.get(action='set_higgsfield_token')
            self.assertIsNone(row.user_id)
            self.assertEqual(row.detail,{'via':'setup-secret'})
            self.assertNotIn('synthetic-access',json.dumps(row.detail))

    def test_runtime_cooldown_and_real_diagnostics_are_honest(self):
        with patch('apps.admin_dashboard.runtime_audit.run_runtime_audit',return_value={'checks':[]}):
            self.assertEqual(self.post('audit/runtime',{}).status_code,200)
            denied=self.post('audit/runtime',{})
        self.assertEqual((denied.status_code,denied['Retry-After']),(429,'60'))
        result=runtime_audit.run_runtime_audit(uuid.UUID(fixtures.UID),checks={'MIG-04':lambda:'controlled fixture'})
        self.assertEqual([row['id'] for row in result['checks']],runtime_audit.CHECK_IDS)
        for row in result['checks']:
            if row['id'] in ('ARCH-04','VER-08','VER-10'): self.assertEqual(row['status'],'unknown')
        for identifier in ('ARCH-03','QUAL-03','REL-02','REL-03','COST-05','REL-07'):
            row=next(row for row in result['checks'] if row['id']==identifier)
            self.assertEqual(row['status'],'ok',row)
        self.assertEqual(Generation.objects.count(),0)
        self.assertEqual(User.objects.count(),1)

    def test_database_health_checks_and_token_freshness_do_not_refresh(self):
        self.assertEqual(status.generation_indexes()['status'],'ok')
        self.assertEqual(status.stuck_generations()['status'],'ok')
        self.generation(status='running',updated_at=1)
        self.assertEqual(status.stuck_generations()['status'],'error')
        storage=StorageService(MemoryAdapter())
        storage.write_private_buffer(json.dumps({'access_token':'synthetic','obtained_at':int(time.time()*1000),'expires_in':3600}).encode(),'settings/higgsfield-mcp-token.json','application/json')
        with override_settings(VEEVEE_MEDIA_STORAGE=storage): self.assertEqual(status.higgsfield()['status'],'ok')


class AdminPureParityTests(SimpleTestCase):
    def test_timed_out_probes_hold_capacity_across_requests_until_finished(self):
        gate = threading.Event()
        started = threading.Event()
        calls = []
        def blocked():
            calls.append(1)
            started.set()
            gate.wait(2)
            return {'status': 'ok', 'detail': 'released'}
        executor = ThreadPoolExecutor(max_workers=1)
        capacity = threading.BoundedSemaphore(1)
        try:
            with patch.object(status, '_probe_executor', executor), patch.object(status, '_probe_capacity', capacity):
                first = status.run_all_checks([('probe', 'Probe', blocked)], timeout_ms=10)
                self.assertTrue(started.wait(1))
                self.assertEqual(first['checks'][0]['detail'], 'Timed out after 10ms')
                for _ in range(8):
                    result = status.run_all_checks([('probe', 'Probe', blocked)], timeout_ms=10)
                    self.assertEqual(result['checks'][0]['detail'], 'Diagnostic capacity busy')
                self.assertEqual(len(calls), 1)
                gate.set()
                executor.shutdown(wait=True)
                self.assertTrue(capacity.acquire(blocking=False))
                capacity.release()
        finally:
            gate.set()
            executor.shutdown(wait=True)

    def test_default_pricing_matches_current_node_source(self):
        code='import {DEFAULT_PRICING} from "./src/lib/pricing.js";console.log(JSON.stringify(DEFAULT_PRICING));'
        result=oracle_run(['node','--import','tsx','--input-type=module','-e',code],capture_output=True,text=True,check=True,cwd=Path(__file__).resolve().parents[3])
        from .default_pricing import DEFAULT_PRICING
        # Magnific video upscaler rates (2026-10-14), Nano Banana 2.1 (2026-10-16) and Gemini Omni Flash 1.1 (2026-10-18)
        # postdate the frozen Node table. The retired Gemini Omni Flash row stays for its historical rows.
        added = [row for row in DEFAULT_PRICING if row['unit'] == 'per_1000_frames' or row['model'] in ('Nano Banana 2.1', 'Gemini Omni Flash 1.1')]
        self.assertEqual([row['model'] for row in added], ['Nano Banana 2.1', 'Gemini Omni Flash 1.1', 'Magnific Video Creative',
                                                           'Magnific Video Creative Turbo', 'Magnific Video Precision', 'Magnific Video Topaz'])
        self.assertEqual(json.loads(result.stdout), [row for row in DEFAULT_PRICING if row not in added])
        omni = next(row for row in added if row['model'] == 'Gemini Omni Flash 1.1')
        self.assertEqual((omni['unitCostCents'], omni['unit']), (11, 'per_second'))

    def test_kling_status_names_where_the_key_lives(self):
        from django.test import override_settings
        with patch.dict('os.environ', {'KLING_API': 'fixture'}):
            self.assertEqual(status.kling(), {'status': 'ok', 'detail': 'KLING_API set (config-presence only)'})
        with patch.dict('os.environ', {}, clear=True):
            self.assertEqual(status.kling(), {'status': 'unknown', 'detail': 'KLING_API not set'})
            with override_settings(VEEVEE_KLING=True):
                # Production: the API serves this page; only the generation worker holds the key.
                self.assertEqual(status.kling(), {'status': 'unknown',
                                                  'detail': 'Enabled (VEEVEE_KLING); KLING_API is held by the generation worker, not this API process'})
        self.assertIn(('kling', 'KlingAI Image', status.kling), status.CHECKS)

    def test_gemini_status_probes_read_each_image_model_without_generating(self):
        seen=[]
        def transport(url,headers):
            seen.append((url,headers))
            return 404 if url.endswith('2.1') else 200
        with patch.dict('os.environ',{'GOOGLE_API_KEY':'fixture'}):
            self.assertEqual(status.gemini(transport),{'status':'ok','detail':'HTTP 200'})
            self.assertEqual(status.gemini(transport,model='Nano Banana 2.1'),{'status':'error','detail':'HTTP 404'})
        self.assertEqual(seen,[('https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image',{'x-goog-api-key':'fixture'}),
                               ('https://generativelanguage.googleapis.com/v1beta/models/gemini-nano-banana-2.1',{'x-goog-api-key':'fixture'})])
        with patch.dict('os.environ',{},clear=True):
            self.assertEqual(status.gemini(transport,model='Nano Banana 2.1')['status'],'unknown')
        self.assertEqual([(key,name) for key,name,_ in status.CHECKS[:2]],
                         [('gemini','Gemini / Nano Banana Pro'),('gemini-nano-banana-2-1','Gemini / Nano Banana 2.1')])

    def test_gemini_status_probe_is_a_provider_transport_get(self):
        from apps.integrations.transport import HttpResult, HttpTransport
        seen=[]
        def request(transport,method,url,**kwargs):
            seen.append((method,url,kwargs.get('headers'),transport.allowed_hosts))
            return HttpResult(200,b'{}')
        with patch.object(HttpTransport,'request',request),patch.dict('os.environ',{'GOOGLE_API_KEY':'fixture'}):
            self.assertEqual(status.gemini(),{'status':'ok','detail':'HTTP 200'})
        self.assertEqual(seen,[('GET','https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro-image',{'x-goog-api-key':'fixture'},
                                frozenset({'generativelanguage.googleapis.com'}))])

    def test_status_timeout_error_and_fixed_shape_without_external_calls(self):
        checks=[('success','Success',lambda:{'status':'ok','detail':'fixture'}),('slow','Slow',lambda:time.sleep(.04))]
        result=status.run_all_checks(checks,timeout_ms=5)
        self.assertEqual(result['checks'][0]['status'],'ok')
        self.assertEqual(result['checks'][1]['detail'],'Timed out after 5ms')
        value=runtime_audit.sanitize('Bearer sensitive token=secret https://example.invalid/media?signature=secret')
        self.assertNotIn('sensitive',value)
        self.assertNotIn('signature=secret',value)
