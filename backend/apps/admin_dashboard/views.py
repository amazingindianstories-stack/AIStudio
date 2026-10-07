import re
import math
from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.authentication.session import lookup
from .models import AppSetting, UserLimit

LIMITS = {'maxPromptLength': (30000, 1, None), 'maxConcurrentJobs': (4, 1, 4)}

def parse(raw, definition):
    fallback, minimum, maximum = definition
    # ECMAScript TrimString includes BOM and Unicode separators; digits remain
    # ASCII. parseInt then converts to IEEE-754 Number, including overflow.
    whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'
    match = re.match(r'^([+-]?[0-9]+)', (raw or '').lstrip(whitespace))
    try:
        numeric = float(match[1]) if match else float('nan')
        value = int(numeric) if math.isfinite(numeric) else fallback
    except (ValueError, OverflowError):
        value = fallback
    if value < minimum:
        return fallback
    return value if maximum is None else min(value, maximum)

@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def effective_settings(request):
    user = lookup(request)
    if user is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    globals = dict(AppSetting.objects.values_list('key', 'value'))
    overrides = dict(UserLimit.objects.filter(user_id=user.id).values_list('key', 'value'))
    response = Response({key: parse(overrides[key] if key in overrides else globals.get(key), definition) for key, definition in LIMITS.items()})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=30*24*60*60, httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response
