from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from .session import lookup

@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def current_user(request):
    user = lookup(request)
    if user is None:
        response = Response({'user': None})
        response.set_cookie('veevee_session', '', max_age=0, httponly=True,
                            samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
        return response
    response = Response({'user': {'id': str(user.id), 'email': user.email,
                                 'name': user.name, 'role': user.role,
                                 'color': user.color, 'avatarUrl': user.avatar_url}})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
                            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response

@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def login(request):
    import json
    import math
    import time
    import uuid
    from .models import User
    from .password import verify_password
    from .session import sign_session
    from .throttle import check, record_failure
    from apps.common.models import ActivityLog
    try:
        body=json.loads(request.body)
    except (ValueError, UnicodeError):
        body={}
    if not isinstance(body,dict):
        return Response({'error':'Email and password are required.'},status=400)
    email,password=body.get('email'),body.get('password')
    if not email or not password:
        return Response({'error':'Email and password are required.'},status=400)
    throttle=check(email)
    if not throttle['allowed']:
        return Response({'error':'Too many failed attempts. Try again later.'},status=429,
                        headers={'Retry-After':str(math.ceil(throttle['retryAfterMs']/1000))})
    user=User.objects.filter(email=str(email).lower().strip()).first()
    if user is None or not user.is_active or not verify_password(str(password),user.password_hash,user.password_salt):
        record_failure(email)
        return Response({'error':'Invalid email or password.'},status=401)
    response=Response({'user':{'id':str(user.id),'email':user.email,'name':user.name,
                               'role':user.role,'color':user.color,'avatarUrl':user.avatar_url}})
    response.set_cookie('veevee_session',sign_session(user),max_age=2592000,
                        httponly=True,samesite='Lax',secure=settings.SESSION_COOKIE_SECURE,path='/')
    try:
        ActivityLog.objects.create(id=uuid.uuid4(),user_id=user.id,action='login',detail=None,created_at=int(time.time()*1000))
    except Exception:
        # Current activity logging is best effort and must not fail login.
        pass
    return response
