"""Frozen 85 historical methods plus five reviewed Goal 2 additions; checks actual root routing after Node retirement."""
import inspect
import json
import os
import re
from contextlib import ExitStack
from unittest.mock import Mock, patch
from django.apps import apps
from django.db import connection
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.urls import resolve, get_resolver, URLResolver

# Authoritative migration inventory: 65 source routes, 85 explicit methods.
EXPECTED = {'/api/admin/activity': ['GET'],
 '/api/admin/audit/runtime': ['POST'],
 '/api/admin/data': ['GET'],
 '/api/admin/limits': ['POST'],
 '/api/admin/logs': ['GET'],
 '/api/admin/migrate-schema': ['POST'],
 '/api/admin/pricing': ['POST'],
 '/api/admin/set-token': ['POST'],
 '/api/admin/status': ['GET'],
 '/api/admin/user-limits': ['POST'],
 '/api/admin/users': ['POST', 'PATCH', 'DELETE'],
 '/api/agent-conversations/[id]/messages/[messageId]': ['PATCH'],
 '/api/agent-conversations/[id]/messages': ['POST'],
 '/api/agent-conversations/[id]': ['GET'],
 '/api/agent-conversations': ['GET', 'POST'],
 '/api/assets/portraits/[id]/assets': ['GET', 'POST', 'DELETE'],
 '/api/assets/portraits': ['GET', 'POST', 'PATCH', 'DELETE'],
 '/api/assets/portraits/upload': ['POST'],
 '/api/assets': ['GET', 'POST', 'DELETE'],
 '/api/audio/transcribe': ['POST'],
 '/api/auth/login': ['POST'],
 '/api/auth/logout': ['POST'],
 '/api/auth/me': ['GET', 'PATCH'],
 '/api/auth/password': ['PATCH'],
 '/api/canvas-boards/[id]': ['GET', 'PUT'],
 '/api/canvas-boards/[id]/upload': ['POST'],
 '/api/canvas-boards': ['GET', 'POST'],
 '/api/cron/depth-reconciliation': ['GET'],
 '/api/cron/login-attempts': ['GET'],
 '/api/cron/video-reconciliation': ['GET'],
 '/api/folders': ['GET', 'POST', 'PATCH', 'DELETE'],
 '/api/generate/depth': ['POST'],
 '/api/generate/depth/status': ['GET'],
 '/api/generate/image': ['POST'],
 '/api/generate/upscale': ['POST'],
 '/api/generate/upscale/status': ['GET'],
 '/api/generate/video/finalize': ['POST'],
 '/api/generate/video': ['POST'],
 '/api/generate/video/status': ['GET'],
 '/api/generations/[id]/download': ['GET', 'HEAD'],
 '/api/history/counts': ['GET'],
 '/api/history/exports/[id]/download': ['GET'],
 '/api/history/exports/[id]/finalize': ['POST'],
 '/api/history/exports/[id]/items': ['POST'],
 '/api/history/exports/[id]': ['GET'],
 '/api/history/exports': ['POST'],
 '/api/history/move': ['POST'],
 '/api/history': ['GET', 'PATCH', 'DELETE'],
 '/api/history/updates': ['GET'],
 '/api/media/[...path]': ['GET'],
 '/api/media-grant': ['GET'],
 '/api/projects': ['GET', 'POST'],
 '/api/queue/execute': ['POST'],
 '/api/queue/status': ['GET'],
 '/api/settings': ['GET'],
 '/api/uploads/presign': ['POST'],
 '/api/users': ['GET'],
 '/api/webhooks/seedance': ['POST'],
 '/api/worker/depth/claim': ['POST'],
 '/api/worker/depth/complete': ['POST'],
 '/api/worker/depth/heartbeat': ['POST'],
 '/api/worker/depth/progress': ['POST'],
 '/api/worker/depth/status': ['GET'],
 '/api/worker/depth/upload-url': ['POST'],
 '/api/worker/exports/access': ['POST']}


# Reviewed Goal 2 additions; historical production manifest remains frozen.
GOAL2_UPLOADS = {
 '/api/uploads/init': ['POST'],
 '/api/uploads/[id]/status': ['GET'],
 '/api/uploads/[id]/finalize': ['POST'],
 '/api/uploads/[id]/cancel': ['POST'],
 '/api/uploads/[id]/local': ['PUT'],
}
EXPECTED.update(GOAL2_UPLOADS)


def concrete(path):
    return re.sub(r'\[[^]]+\]',lambda match:'generated/fixture.png' if match[0]=='[...path]' else 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',path)


def implemented_methods(view):
    visited=set()
    while view and id(view) not in visited:
        visited.add(id(view))
        if hasattr(view,'cls'):
            return {method.upper() for method in view.cls.http_method_names}
        closure=inspect.getclosurevars(view).nonlocals
        if 'request_method_list' in closure:
            return set(closure['request_method_list'])
        view=getattr(view,'__wrapped__',None)
    raise AssertionError('HTTP methods are not declared on the resolved view')


def leaves(patterns,prefix=''):
    for pattern in patterns:
        route=prefix+str(pattern.pattern)
        if isinstance(pattern,URLResolver): yield from leaves(pattern.url_patterns,route)
        else: yield route


@override_settings(ROOT_URLCONF='config.urls')
class CompleteApiCoverageTests(SimpleTestCase):
    def test_all_90_explicit_methods_resolve_to_the_declared_python_handlers(self):
        self.assertEqual(len(EXPECTED),70)
        self.assertEqual(sum(map(len,EXPECTED.values())),90)
        resolved_routes=set()
        for path,methods in EXPECTED.items():
            with self.subTest(path=path):
                match=resolve(concrete(path))
                self.assertTrue(match.func.__module__.startswith('apps.'),match.func.__module__)
                actual=implemented_methods(match.func)
                self.assertLessEqual(set(methods),actual)
                # Implicit HEAD/OPTIONS are permitted, extra mutating methods are not.
                self.assertEqual(actual-{'HEAD','OPTIONS'},set(methods)-{'HEAD','OPTIONS'})
                resolved_routes.add(match.route)
        actual_routes=set(leaves(get_resolver().url_patterns))
        self.assertEqual(actual_routes-resolved_routes,{'api/health','api/uploads/local'})

    def test_retired_unsafe_admin_schema_and_browser_execution_still_have_explicit_handlers(self):
        self.assertEqual(resolve('/api/admin/migrate-schema').func.cls.__name__,'retired_schema_migration')
        self.assertEqual(resolve('/api/queue/execute').func.cls.__name__,'retired_queue_execute')


# Inspected auth contracts, independent of the responses under test. Public
# endpoints receive an empty body/query so validation remains side-effect free.
# Login with a wrong password intentionally records a throttle failure and is
# covered separately by authentication tests, not this no-mutation matrix.
NEGATIVE_STATUS = {
 '/api/admin/activity': {'GET':403},
 '/api/admin/audit/runtime': {'POST':403},
 '/api/admin/data': {'GET':403},
 '/api/admin/limits': {'POST':403},
 '/api/admin/logs': {'GET':403},
 '/api/admin/migrate-schema': {'POST':403},
 '/api/admin/pricing': {'POST':403},
 '/api/admin/set-token': {'POST':403},
 '/api/admin/status': {'GET':403},
 '/api/admin/user-limits': {'POST':403},
 '/api/admin/users': {'POST':403,'PATCH':403,'DELETE':403},
 '/api/agent-conversations/[id]/messages/[messageId]': {'PATCH':403},
 '/api/agent-conversations/[id]/messages': {'POST':403},
 '/api/agent-conversations/[id]': {'GET':403},
 '/api/agent-conversations': {'GET':403,'POST':403},
 '/api/assets/portraits/[id]/assets': {'GET':401,'POST':401,'DELETE':401},
 '/api/assets/portraits': {'GET':401,'POST':401,'PATCH':401,'DELETE':401},
 '/api/assets/portraits/upload': {'POST':401},
 '/api/assets': {'GET':401,'POST':401,'DELETE':401},
 '/api/audio/transcribe': {'POST':401},
 '/api/auth/login': {'POST':400},
 '/api/auth/logout': {'POST':200},
 '/api/auth/me': {'GET':200,'PATCH':401},
 '/api/auth/password': {'PATCH':401},
 '/api/canvas-boards/[id]': {'GET':401,'PUT':401},
 '/api/canvas-boards/[id]/upload': {'POST':401},
 '/api/canvas-boards': {'GET':401,'POST':401},
 '/api/cron/depth-reconciliation': {'GET':401},
 '/api/cron/login-attempts': {'GET':401},
 '/api/cron/video-reconciliation': {'GET':401},
 '/api/folders': {'GET':401,'POST':401,'PATCH':401,'DELETE':401},
 '/api/generate/depth': {'POST':401},
 '/api/generate/depth/status': {'GET':401},
 '/api/generate/image': {'POST':401},
 '/api/generate/upscale': {'POST':401},
 '/api/generate/upscale/status': {'GET':401},
 '/api/generate/video/finalize': {'POST':401},
 '/api/generate/video': {'POST':401},
 '/api/generate/video/status': {'GET':401},
 '/api/generations/[id]/download': {'GET':401,'HEAD':401},
 '/api/history/counts': {'GET':401},
 '/api/history/exports/[id]/download': {'GET':401},
 '/api/history/exports/[id]/finalize': {'POST':401},
 '/api/history/exports/[id]/items': {'POST':401},
 '/api/history/exports/[id]': {'GET':401},
 '/api/history/exports': {'POST':401},
 '/api/history/move': {'POST':401},
 '/api/history': {'GET':401,'PATCH':401,'DELETE':401},
 '/api/history/updates': {'GET':401},
 '/api/media/[...path]': {'GET':401},
 '/api/media-grant': {'GET':403},
 '/api/projects': {'GET':401,'POST':401},
 '/api/queue/execute': {'POST':401},
 '/api/queue/status': {'GET':401},
 '/api/settings': {'GET':401},
 '/api/uploads/presign': {'POST':401},
 '/api/users': {'GET':401},
 '/api/webhooks/seedance': {'POST':401},
 '/api/worker/depth/claim': {'POST':401},
 '/api/worker/depth/complete': {'POST':401},
 '/api/worker/depth/heartbeat': {'POST':401},
 '/api/worker/depth/progress': {'POST':401},
 '/api/worker/depth/status': {'GET':401},
 '/api/worker/depth/upload-url': {'POST':401},
 '/api/worker/exports/access': {'POST':403},
}

NEGATIVE_STATUS.update({path:{method:401 for method in methods} for path,methods in GOAL2_UPLOADS.items()})

@override_settings(ROOT_URLCONF='config.urls',VEEVEE_BROWSER_ORIGINS=('https://frontend.example',),
    DEPTH_WORKER_TOKEN='boundary-depth',CRON_SECRET='boundary-cron',
    GENERATION_WORKER_SECRET='boundary-worker',EXPORT_WORKER_SECRET='boundary-export',SEEDANCE_CALLBACK_SECRET='boundary-callback')
class CompleteApiNegativeBoundaryTests(TransactionTestCase):
    def setUp(self):
        from apps.authentication.models import User
        from apps.authentication.session import sign_session
        self.client.defaults['HTTP_SEC_FETCH_SITE'] = 'same-origin'
        self.actor=User.objects.create(email='boundary@example.invalid',name='Boundary admin',role='admin',
            password_hash='synthetic-unused',password_salt='synthetic-unused',created_at=1,auth_version=7)
        self.revoked=sign_session(self.actor)
        self.actor.auth_version=8
        self.actor.save(update_fields=['auth_version'])
        self.valid=sign_session(self.actor)
        payload,signature=self.valid.split('.')
        self.forged=payload+'.'+('A' if signature[0]!='A' else 'B')+signature[1:]
        self.tables=sorted({model._meta.db_table for model in apps.get_models() if model._meta.managed})
        self.assertEqual(len(self.tables),22)
        self.assertEqual({path:set(methods) for path,methods in EXPECTED.items()},
            {path:set(methods) for path,methods in NEGATIVE_STATUS.items()})

    def snapshot(self):
        result={}
        with connection.cursor() as cursor:
            for table in self.tables:
                cursor.execute(f'SELECT to_jsonb(row)::text FROM {connection.ops.quote_name(table)} row ORDER BY 1')
                result[table]=cursor.fetchall()
        return result

    def guard_effects(self,stack):
        self.write_attempts=[]
        def readonly(execute,sql,params,many,context):
            # These negative boundaries need only session SELECTs. Deny attempted
            # writes too, even if a view catches the error or rolls it back.
            if not sql.lstrip().upper().startswith('SELECT '):
                self.write_attempts.append(sql.split()[0])
                raise AssertionError('Negative HTTP request attempted a database write')
            return execute(sql,params,many,context)
        stack.enter_context(connection.execute_wrapper(readonly))
        self.storage=Mock(side_effect=AssertionError('Negative HTTP request reached storage'))
        stack.enter_context(override_settings(VEEVEE_MEDIA_STORAGE=self.storage))
        self.effects=[self.storage]
        for target in ('apps.generation.providers.transport.HttpTransport.request',
                       'apps.media.remote.SafeMediaFetcher.__call__',
                       'apps.media.remote.SafeMediaFetcher.open_file',
                       'apps.media.remote.PinnedHTTPSConnection.request',
                       'requests.sessions.Session.request'):
            self.effects.append(stack.enter_context(patch(target,side_effect=AssertionError('Negative HTTP request reached remote I/O'))))
        stack.enter_context(patch.dict(os.environ,{'SET_TOKEN_SECRET':'boundary-setup'}))

    def request(self,path,method,token=None,headers=None,query=''):
        self.client.cookies.clear()
        if token: self.client.cookies['veevee_session']=token
        response=self.client.generic(method,concrete(path)+query,
            data='' if method in ('GET','HEAD') else '{}',content_type='application/json',**(headers or {}))
        self.assertFalse(response.streaming,'Negative request unexpectedly opened a media stream')
        if method!='HEAD': self.assertIsInstance(json.loads(response.content),dict)
        return response

    def assert_no_effects(self,before):
        self.assertEqual(self.snapshot(),before,'Negative requests changed application rows')
        self.assertEqual(self.write_attempts,[])
        for effect in self.effects: effect.assert_not_called()

    def test_all_90_methods_match_negative_request_contract_without_effects(self):
        # Empty/malformed payload failures on public routes are not proof of
        # account-only authorization. Paid video now requires login; valid-payload
        # zero-effects and owner checks are covered by enqueue contract tests.
        before=self.snapshot()
        seen=set()
        with ExitStack() as stack:
            self.guard_effects(stack)
            for mode,token in [('missing',None),('forged',self.forged),('revoked',self.revoked)]:
                headers={} if mode=='missing' else {'HTTP_AUTHORIZATION':'Bearer wrong-boundary-token',
                    'HTTP_X_GENERATION_WORKER_SECRET':'wrong-boundary-token','HTTP_X_EXPORT_WORKER_SECRET':'wrong-boundary-token','HTTP_X_SETUP_SECRET':'wrong-boundary-token'}
                for path,methods in EXPECTED.items():
                    for method in methods:
                        with self.subTest(mode=mode,path=path,method=method):
                            query='?token=wrong-boundary-token' if mode!='missing' and path in ('/api/webhooks/seedance','/api/media-grant') else ''
                            response=self.request(path,method,token,headers,query)
                            self.assertEqual(response.status_code,NEGATIVE_STATUS[path][method])
                            if path=='/api/auth/me' and method=='GET': self.assertEqual(response.json(),{'user':None})
                            if path=='/api/auth/logout': self.assertEqual(response.json(),{'ok':True})
                            seen.add((mode,path,method))
            self.assertEqual(len(seen),3*90)
            self.assert_no_effects(before)

    def test_every_unsafe_method_rejects_hostile_origin_even_with_valid_credentials(self):
        before=self.snapshot()
        seen=set()
        with ExitStack() as stack:
            self.guard_effects(stack)
            for path,methods in EXPECTED.items():
                for method in methods:
                    if method in ('GET','HEAD','OPTIONS'): continue
                    with self.subTest(path=path,method=method):
                        headers={'HTTP_ORIGIN':'https://hostile.example','HTTP_SEC_FETCH_SITE':'cross-site',
                            'HTTP_AUTHORIZATION':'Bearer boundary-depth','HTTP_X_GENERATION_WORKER_SECRET':'boundary-worker','HTTP_X_EXPORT_WORKER_SECRET':'boundary-export',
                            'HTTP_X_SETUP_SECRET':'boundary-setup'}
                        response=self.request(path,method,self.valid,headers,'?token=boundary-callback')
                        self.assertEqual(response.status_code,403)
                        self.assertEqual(response.json(),{'error':'FORBIDDEN_ORIGIN'})
                        seen.add((path,method))
            self.assertEqual(seen,{(path,method) for path,methods in EXPECTED.items() for method in methods if method not in ('GET','HEAD','OPTIONS')})
            self.assert_no_effects(before)
