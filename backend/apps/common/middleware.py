"""Port of auth.js's getSession() rolling-renewal behavior, as Django
middleware rather than duplicated per-view logic. In the TS app every
getSession() call implicitly renews the cookie once it's more than
SESSION_RENEW_AFTER_MS old; replicating that per-route in Django would
mean adding the same three lines to every authenticated view, so it runs
once here instead, after every request.
"""

from django.conf import settings

from .models import User
from .session_auth import session_cookie_kwargs, should_renew_session, sign_session, verify_session_token


class SessionRenewalMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        response = self.get_response(request)

        # A view that already set/cleared this cookie on ITS OWN response
        # (login issuing a fresh one, password-change reissuing after an
        # auth_version bump, logout clearing it) must never be second-
        # guessed here. Without this check, a request whose *incoming*
        # cookie happened to be old enough to qualify for renewal would
        # have this middleware re-add a live session cookie right after
        # logout cleared it — effectively undoing the logout. Caught by
        # test_logout_clears_cookie.
        if settings.LUMINA_SESSION_COOKIE in response.cookies:
            return response

        token = request.COOKIES.get(settings.LUMINA_SESSION_COOKIE)
        if not token:
            return response

        session = verify_session_token(token)
        if not session or not should_renew_session(session["exp"]):
            return response

        try:
            user = User.objects.get(pk=session["user_id"], is_active=True, auth_version=session["auth_version"])
        except User.DoesNotExist:
            return response

        response.set_cookie(
            settings.LUMINA_SESSION_COOKIE, sign_session(str(user.id), user.auth_version), **session_cookie_kwargs()
        )
        return response
