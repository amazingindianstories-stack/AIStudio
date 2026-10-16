"""Response and audit primitives shared by Django domain services."""
import time
import uuid

from django.conf import settings

SESSION_COOKIE = 'veevee_session'
SESSION_MAX_AGE = 30 * 24 * 60 * 60


def set_session(response, token, max_age=SESSION_MAX_AGE):
    response.set_cookie(SESSION_COOKIE, token, max_age=max_age, httponly=True,
                        samesite='Lax', secure=settings.SESSION_COOKIE_SECURE, path='/')
    return response


def clear_session(response):
    return set_session(response, '', max_age=0)


def renew_session(request, response):
    if getattr(response, 'skip_session_renewal', False):
        return response
    token = getattr(request, 'renewed_session', None)
    if token and SESSION_COOKIE not in response.cookies:
        set_session(response, token)
    return response


def public_user(user):
    return {'id': str(user.id), 'email': user.email, 'name': user.name,
            'role': user.role, 'color': user.color, 'avatarUrl': user.avatar_url}


def can_manage(user, owner_id):
    return bool(user and (user.role == 'admin' or
                         (owner_id and str(user.id) == str(owner_id))))


def log_activity(user_id, action, detail=None):
    # Match the existing best-effort audit contract, using a savepoint so a
    # failed audit insert cannot poison the caller's transaction.
    from django.db import transaction
    from .models import ActivityLog
    try:
        with transaction.atomic():
            ActivityLog.objects.create(id=uuid.uuid4(), user_id=user_id,
                                      action=action, detail=detail,
                                      created_at=int(time.time() * 1000))
    except Exception:
        pass
