import hmac
import os

from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response

from apps.generation.video_reconciliation import run_video_reconciliation

from .login_throttle import cleanup_expired_login_attempts


def _authorized(request):
    expected = os.environ.get("CRON_SECRET")
    header = request.headers.get("Authorization", "")
    supplied = header[7:] if header.startswith("Bearer ") else ""
    return bool(expected and supplied and hmac.compare_digest(expected, supplied))


@api_view(["GET"])
@authentication_classes([])
@permission_classes([])
def cleanup_login_attempts(request):
    if not _authorized(request):
        return Response({"error": "UNAUTHORIZED"}, status=401)
    return Response({"ok": True, "deleted": cleanup_expired_login_attempts()})


@api_view(["GET"])
@authentication_classes([])
@permission_classes([])
def reconcile_videos(request):
    if not _authorized(request):
        return Response({"error": "UNAUTHORIZED"}, status=401)
    return Response(run_video_reconciliation(), headers={"Cache-Control": "no-store"})
