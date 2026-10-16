from django.test import RequestFactory, SimpleTestCase, override_settings
from django.http import JsonResponse
from .origin import BrowserOriginMiddleware


@override_settings(VEEVEE_BROWSER_ORIGINS=('https://frontend.example',))
class CookieOriginTests(SimpleTestCase):
    def test_cookie_mutations_need_trusted_origin_or_same_origin_metadata(self):
        calls=[]
        app=BrowserOriginMiddleware(lambda request:calls.append(request) or JsonResponse({'ok':True}))
        factory=RequestFactory()
        for headers,expected in [({},403),({'HTTP_SEC_FETCH_SITE':'none'},403),
            ({'HTTP_SEC_FETCH_SITE':'same-site'},403),({'HTTP_ORIGIN':'null'},403),
            ({'HTTP_SEC_FETCH_SITE':'same-origin'},200),({'HTTP_ORIGIN':'https://frontend.example'},200),
            ({'HTTP_ORIGIN':'https://hostile.example','HTTP_SEC_FETCH_SITE':'same-origin'},403)]:
            request=factory.post('/api/projects',{},**headers)
            request.COOKIES['veevee_session']='present-cookie'
            self.assertEqual(app(request).status_code,expected)
        self.assertEqual(len(calls),2)

    def test_headerless_machine_and_readonly_requests_still_reach_route_auth(self):
        calls=[]
        app=BrowserOriginMiddleware(lambda request:calls.append(request) or JsonResponse({'ok':True}))
        factory=RequestFactory()
        request=factory.post('/api/worker/exports/access',{},HTTP_X_EXPORT_WORKER_SECRET='synthetic')
        self.assertEqual(app(request).status_code,200)
        for method in ('get','head','options'):
            request=getattr(factory,method)('/api/projects')
            request.COOKIES['veevee_session']='present-cookie'
            self.assertEqual(app(request).status_code,200)
        self.assertEqual(len(calls),4)
