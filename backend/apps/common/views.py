from django.db import connection
from rest_framework.decorators import api_view, authentication_classes, permission_classes
from rest_framework.response import Response

from .models import User


@api_view(["GET"])
def list_users(request):
    """Public (logged-in) list of users for attribution display — no secrets."""
    rows = User.objects.all().values("id", "email", "name", "color", "avatar_url")
    return Response(
        {
            "users": [
                {
                    "id": str(r["id"]),
                    "email": r["email"],
                    "name": r["name"],
                    "color": r["color"],
                    "avatarUrl": r["avatar_url"],
                }
                for r in rows
            ]
        }
    )


@api_view(["GET"])
@authentication_classes([])
@permission_classes([])
def health(request):
    """Unauthenticated liveness + DB-connectivity check for Railway."""
    db_ok = True
    try:
        with connection.cursor() as cursor:
            cursor.execute("SELECT 1")
    except Exception:
        db_ok = False
    return Response({"status": "ok" if db_ok else "degraded", "db": db_ok})


@api_view(["GET"])
def whoami(request):
    """Pilot endpoint proving the ported session-auth path end to end —
    an authenticated request should echo back the user Next.js's session
    cookie resolves to. Superseded by the real /api/auth/me port (task #9)."""
    u = request.user
    return Response(
        {
            "id": str(u.id),
            "email": u.email,
            "name": u.name,
            "role": u.role,
        }
    )
