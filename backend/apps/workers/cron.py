from apps.canvas.views import node_route, reply, failure
from .auth import cron_authorized
from . import maintenance


@node_route(['GET'])
def cron(request, operation):
    if not cron_authorized(request): return reply(request, {'error': 'UNAUTHORIZED'}, 401)
    try:
        handler = {'depth-reconciliation': maintenance.reconcile_depth,
                   'video-reconciliation': maintenance.reconcile_videos,
                   'login-attempts': maintenance.cleanup_login_attempts}[operation]
        response = reply(request, handler())
        if operation != 'login-attempts': response['Cache-Control'] = 'no-store'
        return response
    except Exception:
        return failure()
