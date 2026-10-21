import json
from unittest.mock import patch
from django.test import SimpleTestCase, TransactionTestCase
from apps.authentication.models import User
from apps.generation.models import Generation
from apps.library.models import NamingCounter, GenerationNaming
from apps.integrations.transport import HttpResult
from . import kling_validation, runtime_audit


class ValidationTransport:
    def __init__(self,*,auth=True,unsafe=False,changed=False,seed='supported',routing=False):
        self.calls=[]; self.auth=auth; self.unsafe=unsafe; self.changed=changed; self.seed=seed; self.routing=routing

    def request(self,method,url,*,headers,body,signal):
        signal.check()
        self.calls.append((method,url,body))
        if method=='GET':
            if not self.auth: return HttpResult(401,b'{"code":1001}')
            tasks=[{'task_id':'preexisting'}]
            if self.changed and len(self.calls)>1: tasks.append({'taskId':'new-task'})
            return HttpResult(200,json.dumps({'code':0,'data':{'tasks':tasks}}).encode())
        if body['n'] != 99: raise AssertionError('Diagnostic request could create a valid task')
        if self.unsafe: return HttpResult(200,b'{"code":0,"data":{"task_id":"unexpected"}}')
        message='n must be between 1 and 9'
        if self.routing: message='unknown model'
        elif body.get('model_name')=='kling-v2-1' and body.get('resolution')=='2k' and body.get('image'): message="resolution '2k' is not supported"
        elif body.get('seed')=='not-a-number' and self.seed=='supported': message='seed must be a number'
        elif body.get('seed')=='not-a-number' and self.seed=='unsupported': message='unknown parameter seed'
        return HttpResult(400,json.dumps({'code':1003,'message':message}).encode())


class KlingRuntimeTests(SimpleTestCase):
    def test_safe_matrix_proves_rejection_and_task_list_stability(self):
        transport=ValidationTransport()
        result=kling_validation.run(env={'KLING_API':'synthetic'},transport=transport)
        self.assertEqual(len(transport.calls),13)
        self.assertTrue(result['noTaskCreated'])
        self.assertEqual(result['seedVerdict'],'supported')
        self.assertEqual([row['status'] for row in kling_validation.results(result)],['ok','ok','ok'])
        posts=[body for method,url,body in transport.calls if method=='POST']
        self.assertEqual(len(posts),11)
        self.assertTrue(all(body['n']==99 for body in posts))
        self.assertTrue(any('image' in body for body in posts))

    def test_absent_credentials_auth_failure_and_unsafe_results_never_pass(self):
        transport=ValidationTransport()
        self.assertEqual(kling_validation.run(env={},transport=transport),{'configured':False})
        self.assertFalse(transport.calls)
        for options,statuses in [({'auth':False},['unknown']*3),({'unsafe':True},['error','error','unknown']),
                                ({'changed':True},['error','error','unknown']),({'routing':True},['error','unknown','unknown'])]:
            result=kling_validation.run(env={'KLING_API':'synthetic'},transport=ValidationTransport(**options))
            self.assertEqual([row['status'] for row in kling_validation.results(result)],statuses)
        for seed in ('unsupported','inconclusive'):
            result=kling_validation.run(env={'KLING_API':'synthetic'},transport=ValidationTransport(seed=seed))
            self.assertEqual(result['seedVerdict'],seed)
            self.assertEqual(kling_validation.results(result)[2]['status'],'unknown' if seed=='inconclusive' else 'ok')


class ActualDiagnosticTests(TransactionTestCase):
    def test_pipeline_checks_do_not_call_providers_and_leave_no_database_residue(self):
        user=User.objects.create(email='audit@example.invalid',name='Audit',role='admin',password_hash='synthetic',password_salt='synthetic',created_at=1)
        unrelated=Generation.objects.create(kind='video',status='running',prompt='Keep',model='Seedance 2.5',aspect_ratio='16:9',task_id='untouched',created_at=1,updated_at=1)
        before=(Generation.objects.count(),GenerationNaming.objects.count(),NamingCounter.objects.count())
        with patch('apps.integrations.transport.HttpTransport.request',side_effect=AssertionError('No provider calls in qualification')):
            result=runtime_audit.run_runtime_audit(user.id,checks={'MIG-04':lambda:'isolated PostgreSQL'},kling_env={})
        for check in result['checks']:
            self.assertEqual(check['status'],'unknown' if check['id'] in ('ARCH-04','VER-08','VER-10') else 'ok',check)
        self.assertEqual((Generation.objects.count(),GenerationNaming.objects.count(),NamingCounter.objects.count()),before)
        unrelated.refresh_from_db()
        self.assertEqual((unrelated.status,unrelated.updated_at,unrelated.poll_error_count),('running',1,0))

    def test_provider_timeout_suppresses_seed_verdict_and_sanitizes_detail(self):
        checks={identifier:lambda:'controlled local check' for identifier in runtime_audit.CHECK_IDS if identifier not in ('ARCH-04','VER-08','VER-10')}
        with patch('apps.admin_dashboard.kling_validation.run',side_effect=TimeoutError('token=secret Bearer hidden')):
            result=runtime_audit.run_runtime_audit(None,checks=checks)
        values={row['id']:row for row in result['checks']}
        self.assertEqual(values['ARCH-04']['status'],'error')
        self.assertEqual(values['VER-08']['status'],'error')
        self.assertEqual(values['VER-10']['status'],'unknown')
        self.assertNotIn('secret',values['ARCH-04']['detail'])
        self.assertNotIn('hidden',values['ARCH-04']['detail'])
