"""Browser unsafe-method protection for the same-origin proxy architecture.

Origin-less machine clients remain subject to each route's token/session checks.
Never trust forwarded Host/Origin headers as an allowlist; deployment explicitly
configures frontend origins. This adds no cross-origin browser API architecture.
"""
from django.conf import settings
from django.http import JsonResponse

class BrowserOriginMiddleware:
    def __init__(self,get_response):
        self.get_response=get_response

    def __call__(self,request):
        if request.path.startswith('/api/') and request.method not in ('GET','HEAD','OPTIONS'):
            origin=request.headers.get('Origin')
            trusted=getattr(settings,'VEEVEE_BROWSER_ORIGINS',())
            if origin is not None:
                if origin not in trusted:
                    return JsonResponse({'error':'FORBIDDEN_ORIGIN'},status=403)
            elif request.headers.get('Sec-Fetch-Site') in ('cross-site','same-site'):
                return JsonResponse({'error':'FORBIDDEN_ORIGIN'},status=403)
            elif request.COOKIES.get('veevee_session') and request.headers.get('Sec-Fetch-Site') != 'same-origin':
                # Cookie-authenticated mutations need explicit browser origin
                # evidence. Headerless machines must use route token auth.
                return JsonResponse({'error':'FORBIDDEN_ORIGIN'},status=403)
        return self.get_response(request)
