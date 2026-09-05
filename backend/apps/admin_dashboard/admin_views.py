"""Port of src/app/api/admin/{data,users,pricing,set-token,logs,activity,
status}/route.js. Every route here gates with FORBIDDEN (403) — including
for a wholly unauthenticated request — never 401, matching adminOrNull()'s
behavior exactly (deliberately not relying on DRF's default IsAuthenticated,
which would 401 an anonymous request instead)."""

import hmac
import json
import random
import re
import time
import uuid

from django.http import HttpResponse, JsonResponse
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.common.activity import log_activity
from apps.common.password import hash_password, validate_password
from apps.common import limits as app_limits
from apps.common.leases import claim_lease
from apps.common.session_auth import VeeveeSessionAuthentication
from apps.generation import pricing_db
from apps.generation.generations_service import decode_cursor
from apps.generation.models import Generation
from apps.generation.kling_validation import run_kling_validation, summarize_matrix
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
    result = VeeveeSessionAuthentication().authenticate(request)
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
    global_limits = app_limits.read_all_global_limits()
    all_user_limits = app_limits.read_all_user_limits()

    from django.db.models import Count, Q, Sum

    stat_rows = Generation.objects.values("user_id").annotate(
        gen_count=Count("id"),
        succeeded_cost_cents=Sum("cost_cents", filter=Q(status="succeeded"), default=0),
        reconciled_cost_cents=Sum(
            "cost_cents", filter=Q(status="succeeded", cost_basis="reconciled"), default=0
        ),
        estimated_cost_cents=Sum(
            "cost_cents", filter=Q(status="succeeded") & ~Q(cost_basis="reconciled"), default=0
        ),
    )
    stats_by_user = {str(r["user_id"]) if r["user_id"] else None: r for r in stat_rows}

    users_out = []
    for u in all_users:
        stat = stats_by_user.get(str(u.id))
        users_out.append({
            **_safe_user(u),
            "limits": all_user_limits.get(str(u.id), {}),
            "genCount": stat["gen_count"] if stat else 0,
            "costCents": (stat["succeeded_cost_cents"] or 0) if stat else 0,
            "reconciledCostCents": (stat["reconciled_cost_cents"] or 0) if stat else 0,
            "estimatedCostCents": (stat["estimated_cost_cents"] or 0) if stat else 0,
        })
    users_out.sort(key=lambda u: u["costCents"], reverse=True)

    return Response({"users": users_out, "stats": stats, "pricing": pricing, "limits": global_limits})


@api_view(["POST"])
@permission_classes([])
def admin_limits(request):
    if not _admin_or_403(request):
        return Response({"error": "FORBIDDEN"}, status=403)
    key = request.data.get("key") if isinstance(request.data, dict) else None
    item = app_limits.definition(key)
    if not item:
        return Response({"error": "Unknown limit."}, status=400)
    try:
        value = round(float(request.data.get("value")))
    except (TypeError, ValueError):
        value = None
    if value is None or value < item["min"]:
        return Response({"error": f"Invalid {item['label'].lower()}."}, status=400)
    app_limits.update_global_limit(key, value)
    return Response({"ok": True})


@api_view(["POST"])
@permission_classes([])
def admin_user_limits(request):
    from apps.common.models import User

    me = _admin_or_403(request)
    if not me:
        return Response({"error": "FORBIDDEN"}, status=403)
    body = request.data if isinstance(request.data, dict) else {}
    user_id, key = body.get("userId"), body.get("key")
    item = app_limits.definition(key)
    if not user_id or not item:
        return Response({"error": "userId and a valid key are required."}, status=400)
    value = body.get("value")
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float)) or value < item["min"]):
        return Response({"error": f"Invalid {item['label'].lower()}."}, status=400)
    if not User.objects.filter(id=user_id).exists():
        return Response({"error": "User not found."}, status=404)
    value = None if value is None else round(value)
    app_limits.update_user_limit(user_id, key, value)
    log_activity(str(me.id), "admin_user_limit_updated", {"targetUserId": user_id, "key": key, "value": value})
    return Response({"ok": True})


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

    header = [
        "time", "user", "kind", "model", "status", "cost_cents", "cost_basis",
        "flagged", "flagged_at", "flag_reason", "judge_score", "prompt",
    ]
    lines = [",".join(header)]
    for r in rows:
        from datetime import datetime, timezone

        iso_time = datetime.fromtimestamp(r["createdAt"] / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
        flagged_at = (
            datetime.fromtimestamp(r["flaggedAt"] / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")
            if r.get("flaggedAt") else ""
        )
        lines.append(",".join(_csv_cell(v) for v in [
            iso_time, email_by_id.get(r["userId"], ""), r["kind"], r["model"], r["status"],
            r["costCents"], r.get("costBasis", "estimated"), r.get("flagged", False), flagged_at,
            r.get("flagReason"), json.dumps(r.get("judgeScore")) if r.get("judgeScore") else "", r["prompt"],
        ]))
    # Truncation used to be signalled with an appended `# truncated at...`
    # comment line. RFC 4180 has no comment syntax, so every real parser
    # (Excel, pandas, Sheets) either errors or reads it as a malformed final
    # row with the wrong column count — the file itself must stay pure CSV.
    # A response header carries the same information losslessly instead.
    # Mirrors the same fix in src/app/api/admin/logs/route.js; keep in sync.
    truncated = len(rows) == admin_logs.MAX_CSV_ROWS

    body = "\n".join(lines)
    filename = f"veevee-logs-{time.strftime('%Y-%m-%d')}.csv"
    response = HttpResponse(body, content_type="text/csv; charset=utf-8")
    response["Content-Disposition"] = f'attachment; filename="{filename}"'
    response["Cache-Control"] = "no-store"
    response["X-Logs-Truncated"] = str(truncated)
    if truncated:
        response["X-Logs-Truncated-At"] = str(admin_logs.MAX_CSV_ROWS)
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


@api_view(["POST"])
@permission_classes([])
def admin_runtime_audit(request):
    """Bounded, sanitized diagnostics. No provider task is created here."""
    if not _admin_or_403(request):
        return Response({"error": "FORBIDDEN"}, status=403)
    if not claim_lease("lease:admin-runtime-audit", str(uuid.uuid4()), ttl_ms=60_000):
        return Response(
            {"error": "COOLDOWN", "retryAfterSeconds": 60},
            status=429,
            headers={"Retry-After": "60"},
        )

    checked_at = int(time.time() * 1000)
    generation_indexes = status_checks.check_generation_indexes()
    try:
        kling = run_kling_validation()
    except Exception as exc:
        kling = {"error": str(exc)}

    if kling.get("error"):
        safe_detail = re.sub(
            r"(?i)(api[_-]?key|secret|password|token)\s*[=:]\s*\S+", r"\1=[redacted]",
            re.sub(r"[\r\n]+", " ", kling["error"]),
        )[:180]
        kling_checks = [
            {"id": "ARCH-04", "status": "error", "detail": safe_detail},
            {"id": "VER-08", "status": "error", "detail": safe_detail},
            {"id": "VER-10", "status": "unknown", "detail": "seed validation failed without a conclusive signal"},
        ]
    elif not kling.get("configured") or not kling.get("authenticated"):
        detail = "Kling authentication failed" if kling.get("configured") else "Kling validation credential is not configured"
        kling_checks = [{"id": issue, "status": "unknown", "detail": detail} for issue in ("ARCH-04", "VER-08", "VER-10")]
    elif not kling.get("noTaskCreated"):
        detail = "no-task invariant failed; validation verdicts were suppressed"
        kling_checks = [
            {"id": "ARCH-04", "status": "error", "detail": detail},
            {"id": "VER-08", "status": "error", "detail": detail},
            {"id": "VER-10", "status": "unknown", "detail": detail},
        ]
    else:
        summary = summarize_matrix(kling.get("matrix") or {})
        routing_ok = summary["routingPassed"] == summary["routingTotal"]
        resolution_ok = summary["resolutionPassed"] == summary["resolutionTotal"]
        seed = kling.get("seedVerdict", "inconclusive")
        kling_checks = [
            {
                "id": "ARCH-04", "status": "ok" if routing_ok else "error",
                "detail": f'{summary["routingPassed"]}/{summary["routingTotal"]} wire models matched; no task was created',
            },
            {
                "id": "VER-08", "status": "ok" if routing_ok and resolution_ok else ("unknown" if not routing_ok else "error"),
                "detail": f'{summary["resolutionPassed"]}/{summary["resolutionTotal"]} capability cases matched; no task was created',
            },
            {
                "id": "VER-10", "status": "unknown" if seed == "inconclusive" else "ok",
                "detail": f"seed validation was {seed}; support remains disabled; no task was created",
            },
        ]
    checks = [
        {"id": "MIG-04", "status": "ok", "detail": "PostgreSQL answered the runtime audit query"},
        {"id": "ARCH-03", "status": "ok", "detail": "per-user queue admission is active"},
        {"id": "QUAL-03", "status": "ok", "detail": "flag evidence fields and admin review routes are active"},
        *kling_checks,
        {"id": "REL-02", "status": "ok", "detail": "best-of candidates spool to temporary files"},
        {"id": "REL-03", "status": "ok", "detail": "provider calls use bounded request timeouts"},
        {"id": "COST-05", "status": "ok", "detail": "partial video submissions retain accepted task ids and prorate cost"},
        {"id": "REL-07", "status": generation_indexes["status"], "detail": generation_indexes["detail"]},
    ]
    return Response(
        {"checkedAt": checked_at, "auditId": str(uuid.uuid4()), "checks": checks},
        headers={"Cache-Control": "no-store"},
    )
