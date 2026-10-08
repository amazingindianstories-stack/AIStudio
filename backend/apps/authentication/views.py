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
