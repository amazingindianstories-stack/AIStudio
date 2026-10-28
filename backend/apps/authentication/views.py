from django.conf import settings
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response
from apps.generation.availability import availability
from .session import lookup

@api_view(['GET', 'PATCH'])
@authentication_classes([])
@permission_classes([])
def current_user(request):
    if request.method == 'PATCH':
        from .profile import update_profile
        return update_profile(request)
    user = lookup(request)
    if user is None:
        response = Response({'user': None})
        response.set_cookie('veevee_session', '', max_age=0, httponly=True,
                            samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
        return response
    # The composer's pickers offer only what a new job may use right now; enqueue still refuses the rest.
    response = Response({'user': {'id': str(user.id), 'email': user.email,
                                 'name': user.name, 'role': user.role,
                                 'color': user.color, 'avatarUrl': user.avatar_url},
                         'availability': availability()})
    if hasattr(request, 'renewed_session'):
        response.set_cookie('veevee_session', request.renewed_session, max_age=2592000,
                            httponly=True, samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response


@api_view(['GET'])
@authentication_classes([])
@permission_classes([])
def list_users(request):
    from .models import User
    from apps.common.responses import renew_session
    if lookup(request) is None:
        return Response({'error': 'UNAUTHENTICATED'}, status=401)
    rows = User.objects.values('id', 'email', 'name', 'color', 'avatar_url')
    return renew_session(request, Response({'users': [
        {'id': str(row['id']), 'email': row['email'], 'name': row['name'],
         'color': row['color'], 'avatarUrl': row['avatar_url']} for row in rows]}))

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
    # Equalize the expensive password work for nonexistent/disabled accounts;
    # the throttle still runs first. This hardens timing without changing JSON.
    active = user is not None and user.is_active
    verified = verify_password(str(password), user.password_hash if active else '00' * 64,
                               user.password_salt if active else 'veevee-dummy-scrypt-salt')
    if not active or not verified:
        record_failure(email)
        return Response({'error':'Invalid email or password.'},status=401)
    getattr(request, '_request', request).validated_actor_id = str(user.id)
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

@api_view(['POST'])
@authentication_classes([])
@permission_classes([])
def logout(request):
    import time
    import uuid
    from apps.common.models import ActivityLog
    user=lookup(request)
    if user:
        try:
            ActivityLog.objects.create(id=uuid.uuid4(),user_id=user.id,action='logout',detail=None,created_at=int(time.time()*1000))
        except Exception:
            pass
    response=Response({'ok':True})
    # Match the current logout cookie exactly; do not carry renewal through.
    response.set_cookie('veevee_session','',max_age=0,httponly=True,path='/',samesite=None)
    return response

@api_view(['PATCH'])
@authentication_classes([])
@permission_classes([])
def change_password(request):
    import json
    import time
    import uuid
    from django.db.models import F
    from .models import User
    from .password import validate_password, verify_password, hash_password
    from .session import sign_session
    from apps.common.models import ActivityLog
    def cleared(message,status):
        response=Response({'error':message},status=status)
        response.set_cookie('veevee_session','',max_age=0,httponly=True,samesite='Lax',secure=settings.SESSION_COOKIE_SECURE,path='/')
        return response
    session=lookup(request)
    if session is None:
        return cleared('UNAUTHENTICATED',401)
    try:
        body=json.loads(request.body)
    except (ValueError,UnicodeError):
        body={}
    if not isinstance(body,dict):
        body={}
    current,new=body.get('currentPassword'),body.get('newPassword')
    if not isinstance(current,str) or not current or len(current.encode('utf-16-le',errors='surrogatepass'))//2>1024:
        return Response({'error':'Current password is required.'},status=400)
    error=validate_password(new)
    if error:
        return Response({'error':error},status=400)
    account=User.objects.filter(id=session.id).first()
    if account is None or not account.is_active or account.auth_version!=session.auth_version:
        return cleared('UNAUTHENTICATED',401)
    if not verify_password(current,account.password_hash,account.password_salt):
        return Response({'error':'Current password is incorrect.'},status=401)
    credentials=hash_password(new)
    updated=User.objects.filter(id=account.id,is_active=True,auth_version=account.auth_version).update(
        password_hash=credentials['hash'],password_salt=credentials['salt'],auth_version=F('auth_version')+1)
    if not updated:
        return cleared('Your session changed. Sign in and try again.',409)
    session.auth_version=account.auth_version+1
    from apps.mcp_auth.tokens import revoke_all_for_user
    revoke_all_for_user(account.id)
    response=Response({'ok':True})
    response.set_cookie('veevee_session',sign_session(session),max_age=2592000,
                        httponly=True,samesite='Lax',secure=settings.SESSION_COOKIE_SECURE,path='/')
    try:
        ActivityLog.objects.create(id=uuid.uuid4(),user_id=session.id,action='password_changed',detail=None,created_at=int(time.time()*1000))
    except Exception:
        pass
    return response
