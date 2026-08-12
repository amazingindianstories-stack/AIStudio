"""Port of src/app/api/admin/{data,users,pricing,set-token,logs,activity,
status}/route.js. Every route here gates with FORBIDDEN (403) — including
for a wholly unauthenticated request — never 401, matching adminOrNull()'s
behavior exactly (deliberately not relying on DRF's default IsAuthenticated,
which would 401 an anonymous request instead)."""

import hmac
import random
import re
import time

from django.http import HttpResponse, JsonResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.common.activity import log_activity
from apps.common.password import hash_password, validate_password
from apps.common.session_auth import LuminaSessionAuthentication
from apps.generation import pricing_db
from apps.generation.generations_service import decode_cursor
from apps.generation.models import Generation
from apps.media.save_media import delete_avatar_image

from . import admin_activity, admin_logs, admin_stats, status_checks

COLORS = ["#34d399", "#60a5fa", "#f472b6", "#fbbf24", "#a78bfa", "#f87171", "#22d3ee", "#fb923c"]


def _admin_or_403(request):
    user = request.user
    if user and getattr(user, "role", None) == "admin":
        return user
    return None


def _admin_from_request(request):
    """For plain (non-@api_view) Django views, which don't get DRF's
    authentication classes run automatically — see admin_logs_view's
    docstring for why this route has to be a plain view."""
    result = LuminaSessionAuthentication().authenticate(request)
    if not result:
        return None
    user, _ = result
    return user if getattr(user, "role", None) == "admin" else None


def _safe_user(u) -> dict:
    return {
        "id": str(u.id), "email": u.email, "name": u.name, "role": u.role,
        "color": u.color, "avatarUrl": u.avatar_url, "isActive": u.is_active, "createdAt": u.created_at,
    }


@api_view(["GET"])
@permission_classes([])
def admin_data(request):
    from apps.common.models import User

    me = _admin_or_403(request)
    if not me:
        return Response({"error": "FORBIDDEN"}, status=403)

    all_users = list(User.objects.all())
    stats = admin_stats.read_admin_stats()
    pricing = pricing_db.read_pricing()

    from django.db.models import Count, Sum

    stat_rows = Generation.objects.values("user_id").annotate(gen_count=Count("id"), cost_cents=Sum("cost_cents"))
    stats_by_user = {str(r["user_id"]) if r["user_id"] else None: r for r in stat_rows}

    users_out = []
    for u in all_users:
        stat = stats_by_user.get(str(u.id))
        users_out.append({
            **_safe_user(u),
            "genCount": stat["gen_count"] if stat else 0,
            "costCents": (stat["cost_cents"] or 0) if stat else 0,
        })
    users_out.sort(key=lambda u: u["costCents"], reverse=True)

    return Response({"users": users_out, "stats": stats, "pricing": pricing})


@api_view(["POST", "PATCH", "DELETE"])
@permission_classes([])
def admin_users(request):
    from apps.common.models import User

    me = _admin_or_403(request)
    if not me:
        return Response({"error": "FORBIDDEN"}, status=403)

    if request.method == "POST":
        body = request.data or {}
        email = str(body.get("email") or "").lower().strip()
        password = body.get("password")
        name = str(body.get("name") or "").strip() or (email.split("@")[0] if email else "")
        role = "admin" if body.get("role") == "admin" else "user"
        if not email:
            return Response({"error": "Email is required."}, status=400)
        password_error = validate_password(password)
        if password_error:
            return Response({"error": password_error}, status=400)
        if User.objects.filter(email=email).exists():
            return Response({"error": "A user with that email already exists."}, status=409)

        hashed = hash_password(password)
        try:
            row = User.objects.create(
                email=email, password_hash=hashed["hash"], password_salt=hashed["salt"], name=name, role=role,
                color=random.choice(COLORS), avatar_url=None, is_active=True, auth_version=0,
                created_at=int(time.time() * 1000),
            )
        except Exception:
            if User.objects.filter(email=email).exists():
                return Response({"error": "A user with that email already exists."}, status=409)
            raise
        log_activity(str(me.id), "admin_user_created", {"targetUserId": str(row.id), "email": row.email, "role": row.role})
        return Response({"user": _safe_user(row)})

    if request.method == "PATCH":
        body = request.data or {}
        user_id = body.get("id") if isinstance(body.get("id"), str) else ""
        if not user_id:
            return Response({"error": "Missing id."}, status=400)
        target = User.objects.filter(id=user_id).first()
        if not target:
            return Response({"error": "User not found."}, status=404)

        if "role" in body and body["role"] not in (None, "admin", "user"):
            return Response({"error": "Invalid role."}, status=400)
        if "isActive" in body and body["isActive"] is not None and not isinstance(body["isActive"], bool):
            return Response({"error": "Invalid account status."}, status=400)
        if user_id == str(me.id) and body.get("role") == "user":
            return Response({"error": "You can't demote your own account."}, status=400)
        if user_id == str(me.id) and body.get("isActive") is False:
            return Response({"error": "You can't disable your own account."}, status=400)
        if user_id == str(me.id) and "password" in body:
            return Response({"error": "Change your own password from Account settings."}, status=400)
        if "password" in body:
            password_error = validate_password(body.get("password"))
            if password_error:
                return Response({"error": password_error}, status=400)

        changed_fields = []
        revoke_sessions = False
        update_fields = {}

        if isinstance(body.get("name"), str):
            name = body["name"].strip()
            if not name:
                return Response({"error": "Name cannot be empty."}, status=400)
            if name != target.name:
                update_fields["name"] = name
                changed_fields.append("name")
        if body.get("role") in ("admin", "user") and body["role"] != target.role:
            update_fields["role"] = body["role"]
            changed_fields.append("role")
            revoke_sessions = True
        if isinstance(body.get("isActive"), bool) and body["isActive"] != target.is_active:
            update_fields["is_active"] = body["isActive"]
            changed_fields.append("isActive")
            revoke_sessions = True
        if "password" in body:
            hashed = hash_password(body["password"])
            update_fields["password_hash"] = hashed["hash"]
            update_fields["password_salt"] = hashed["salt"]
            changed_fields.append("password")
            revoke_sessions = True

        if not changed_fields:
            return Response({"error": "Nothing to update."}, status=400)
        if revoke_sessions:
            update_fields["auth_version"] = target.auth_version + 1

        User.objects.filter(id=user_id).update(**update_fields)
        updated = User.objects.get(id=user_id)

        action = "admin_user_updated"
        if changed_fields == ["password"]:
            action = "admin_password_reset"
        elif changed_fields == ["isActive"]:
            action = "admin_user_enabled" if updated.is_active else "admin_user_disabled"
        log_activity(str(me.id), action, {"targetUserId": str(updated.id), "changedFields": changed_fields})
        return Response({"user": _safe_user(updated)})

    # DELETE
    user_id = request.query_params.get("id")
    if not user_id:
        return Response({"error": "Missing id."}, status=400)
    if user_id == str(me.id):
        return Response({"error": "You can't delete your own account."}, status=400)
    target = User.objects.filter(id=user_id).first()
    if not target:
        return Response({"error": "User not found."}, status=404)

    User.objects.filter(id=user_id).delete()
    delete_avatar_image(target.avatar_url)
    log_activity(str(me.id), "admin_user_deleted", {"targetUserId": str(target.id), "email": target.email})
    return Response({"ok": True})


@api_view(["POST"])
@permission_classes([])
def admin_pricing(request):
    me = _admin_or_403(request)
    if not me:
        return Response({"error": "FORBIDDEN"}, status=403)

    body = request.data or {}
    model = str(body.get("model") or "").strip()
    try:
        unit_cost_cents = max(0, round(float(body.get("unitCostCents"))))
        valid = True
    except (TypeError, ValueError):
        unit_cost_cents = 0
        valid = False
    unit = "per_second" if body.get("unit") == "per_second" else "per_image"
    if not model or not valid:
        return Response({"error": "Invalid pricing."}, status=400)
    pricing_db.update_pricing(model, unit_cost_cents, unit)
    return Response({"ok": True})


def _secret_ok(request) -> bool:
    import os

    expected = os.environ.get("SET_TOKEN_SECRET")
    got = request.headers.get("x-setup-secret")
    if not expected or not got:
        return False
    return len(got) == len(expected) and hmac.compare_digest(got, expected)


@api_view(["POST"])
@permission_classes([])
def admin_set_token(request):
    from apps.media import storage

    admin = _admin_or_403(request)
    if not admin and not _secret_ok(request):
        return Response({"error": "FORBIDDEN"}, status=403)

    body = request.data
    if (
        not isinstance(body, dict)
        or not body.get("access_token") or not isinstance(body.get("access_token"), str)
        or not body.get("refresh_token") or not isinstance(body.get("refresh_token"), str)
        or not body.get("client_id") or not isinstance(body.get("client_id"), str)
    ):
        return Response(
            {"error": "Body must be the hf:login token JSON (access_token, refresh_token, client_id)."}, status=400
        )

    import json

    token_data = {
        "access_token": body["access_token"],
        "refresh_token": body["refresh_token"],
        "client_id": body["client_id"],
        "expires_in": body.get("expires_in") if isinstance(body.get("expires_in"), (int, float)) else 86399,
        "obtained_at": body.get("obtained_at") if isinstance(body.get("obtained_at"), (int, float)) else int(time.time() * 1000),
    }
    storage.write_private_buffer(
        json.dumps(token_data).encode("utf-8"), "settings/higgsfield-mcp-token.json", "application/json"
    )
    log_activity(str(admin.id) if admin else None, "set_higgsfield_token", {"via": "admin-session" if admin else "setup-secret"})
    return Response({"ok": True})


def admin_logs_view(request):
    """Deliberately a PLAIN Django view, not @api_view — DRF's content
    negotiation treats a `?format=` query param as its own renderer-
    selection mechanism, which collides with this route's `?format=csv`
    convention (a bare `?format=csv` 404s under DRF's negotiation before
    this function ever runs, since no CSV renderer is registered). Auth is
    done by hand for the same reason: DRF's authentication classes only
    run inside APIView's dispatch."""
    if request.method != "GET":
        return JsonResponse({"error": "Method not allowed."}, status=405)

    me = _admin_from_request(request)
    if not me:
        return JsonResponse({"error": "FORBIDDEN"}, status=403)

    params = request.GET
    filter = admin_logs.parse_admin_log_filter(params)

    if params.get("format") == "csv":
        return _csv_response(filter)

    try:
        limit = int(params.get("limit")) or 100
    except (TypeError, ValueError):
        limit = 100
    page = admin_logs.query_admin_logs(filter, decode_cursor(params.get("cursor")), limit)
    return JsonResponse(page)


def _csv_cell(value) -> str:
    s = "" if value is None else str(value)
    return '"' + s.replace('"', '""') + '"' if re.search(r'[",\n\r]', s) else s


def _csv_response(filter: dict):
    from apps.common.models import User

    rows = admin_logs.read_admin_logs_for_export(filter)
    email_by_id = {str(u.id): u.email for u in User.objects.all()}

    header = ["time", "user", "kind", "model", "status", "cost_cents", "prompt"]
    lines = [",".join(header)]
    for r in rows:
        from datetime import datetime, timezone

        iso_time = datetime.fromtimestamp(r["createdAt"] / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        lines.append(",".join(_csv_cell(v) for v in [
            iso_time, email_by_id.get(r["userId"], ""), r["kind"], r["model"], r["status"], r["costCents"], r["prompt"],
        ]))
    if len(rows) == admin_logs.MAX_CSV_ROWS:
        lines.append(f"# truncated at {admin_logs.MAX_CSV_ROWS} rows — narrow the filter for the rest")

    body = "\n".join(lines)
    filename = f"veevee-logs-{time.strftime('%Y-%m-%d')}.csv"
    response = HttpResponse(body, content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "no-store"
    return response


@api_view(["GET"])
@permission_classes([])
def admin_activity_view(request):
    me = _admin_or_403(request)
    if not me:
        return Response({"error": "FORBIDDEN"}, status=403)

    params = request.query_params
    filter = admin_activity.parse_admin_activity_filter(params)
    try:
        limit = int(params.get("limit")) or admin_activity.ACTIVITY_PAGE_SIZE
    except (TypeError, ValueError):
        limit = admin_activity.ACTIVITY_PAGE_SIZE

    page = admin_activity.query_activity(filter, decode_cursor(params.get("cursor")), limit)
    return Response(page)


@api_view(["GET"])
@permission_classes([])
def admin_status_view(request):
    me = _admin_or_403(request)
    if not me:
        return Response({"error": "FORBIDDEN"}, status=403)
    return Response(status_checks.run_all_checks())
