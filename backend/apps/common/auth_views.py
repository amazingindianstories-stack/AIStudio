"""Canonical Django auth endpoints for login, logout, profile, and password."""

import base64
import re

from django.conf import settings
from rest_framework.decorators import api_view, permission_classes
from rest_framework.response import Response

from apps.media.save_media import InvalidAvatarError, delete_avatar_image, save_avatar_image

from .activity import log_activity
from .login_throttle import check_login_throttle, record_login_failure
from .models import User
from .password import hash_password, validate_password, verify_password
from .responses import error, success
from .session_auth import session_cookie_kwargs, sign_session

ALLOWED_AVATAR_TYPES = {
    "image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif",
    "image/avif", "image/tiff", "image/heif", "image/heic",
}

_DATA_URL_RE = re.compile(r"^data:([^;,]+);base64,([a-zA-Z0-9+/]+={0,2})$", re.DOTALL)


def _public_user(u: User) -> dict:
    return {"id": str(u.id), "email": u.email, "name": u.name, "role": u.role, "color": u.color, "avatarUrl": u.avatar_url}


@api_view(["POST"])
@permission_classes([])
def login(request):
    body = request.data or {}
    email = body.get("email")
    password = body.get("password")
    if not email or not password:
        return error("VALIDATION_ERROR", "Email and password are required.", status=400)

    throttle = check_login_throttle(email)
    if not throttle["allowed"]:
        seconds = max(1, -(-throttle["retryAfterMs"] // 1000))
        return error(
            "RATE_LIMITED",
            "Too many failed attempts. Try again later.",
            status=429,
            headers={"Retry-After": str(seconds)},
        )

    user = User.objects.filter(email=str(email).lower().strip()).first()
    if not user or not user.is_active or not verify_password(str(password), user.password_hash, user.password_salt):
        record_login_failure(email)
        return error("INVALID_CREDENTIALS", "Invalid email or password.", status=401)

    response = success({"user": _public_user(user)})
    response.set_cookie(
        settings.VEEVEE_SESSION_COOKIE, sign_session(str(user.id), user.auth_version), **session_cookie_kwargs()
    )
    log_activity(str(user.id), "login")
    return response


@api_view(["POST"])
@permission_classes([])
def logout(request):
    user = request.user
    if user:
        log_activity(str(user.id), "logout")
    response = success(None)
    response.set_cookie(settings.VEEVEE_SESSION_COOKIE, "", httponly=True, samesite="None", secure=True, path="/", max_age=0)
    return response


def _clear_session(response):
    """Mirrors me.js/password.js's clearSession() exactly (not
    session_cookie_kwargs — that function hardcodes its own flags rather
    than reusing it, matching the TS source's own duplication)."""
    response.set_cookie(
        settings.VEEVEE_SESSION_COOKIE, "", httponly=True, samesite="None", secure=True, path="/", max_age=0
    )
    return response


@api_view(["GET", "PATCH"])
@permission_classes([])
def me(request):
    if request.method == "GET":
        user = request.user
        if not user:
            return _clear_session(success({"user": None}))
        return success({"user": _public_user(user)})

    # PATCH — profile update (name and/or avatar).
    session_user = request.user
    if not session_user:
        return _clear_session(error("UNAUTHENTICATED", "UNAUTHENTICATED", status=401))

    try:
        update = _read_profile_request(request)
    except InvalidAvatarError as e:
        return error("VALIDATION_ERROR", str(e), status=400)

    changed_fields = []
    update_fields = {}
    if update.get("name") is not None and update["name"] != session_user.name:
        update_fields["name"] = update["name"]
        changed_fields.append("name")

    uploaded_avatar_url = None
    try:
        avatar = update.get("avatar")
        if avatar and avatar["kind"] == "upload":
            uploaded_avatar_url = save_avatar_image(avatar["buffer"])
            update_fields["avatar_url"] = uploaded_avatar_url
            changed_fields.append("avatar")
        elif avatar and avatar["kind"] == "remove":
            update_fields["avatar_url"] = None
            if session_user.avatar_url is not None:
                changed_fields.append("avatar")

        if not changed_fields:
            return error("VALIDATION_ERROR", "Nothing to update.", status=400)

        updated_count = User.objects.filter(
            id=session_user.id, is_active=True, auth_version=session_user.auth_version
        ).update(**update_fields)

        if not updated_count:
            delete_avatar_image(uploaded_avatar_url)
            return _clear_session(error("UNAUTHENTICATED", "UNAUTHENTICATED", status=401))

        updated = User.objects.get(id=session_user.id)
        if avatar and session_user.avatar_url != updated.avatar_url:
            delete_avatar_image(session_user.avatar_url)
        log_activity(str(session_user.id), "profile_updated", {"changedFields": changed_fields})
        return success({"user": _public_user(updated)})
    except InvalidAvatarError as e:
        delete_avatar_image(uploaded_avatar_url)
        return error("VALIDATION_ERROR", str(e), status=400)
    except Exception:
        delete_avatar_image(uploaded_avatar_url)
        return error("INTERNAL_ERROR", "Could not update the profile.", status=500)


def _validate_name(value) -> str:
    if not isinstance(value, str):
        raise InvalidAvatarError("Name is required.")
    name = value.strip()
    if not name:
        raise InvalidAvatarError("Name cannot be empty.")
    if len(name) > 80:
        raise InvalidAvatarError("Name must be 80 characters or fewer.")
    if re.search(r"[\x00-\x1f\x7f]", name):
        raise InvalidAvatarError("Name cannot contain control characters.")
    return name


def _decode_data_url(input_str: str) -> bytes:
    from apps.media.save_media import MAX_AVATAR_UPLOAD_BYTES

    if len(input_str) > ((MAX_AVATAR_UPLOAD_BYTES * 4) // 3) + 1024:
        raise InvalidAvatarError("Profile images must be 3 MB or smaller.")
    m = _DATA_URL_RE.match(input_str)
    if not m or m.group(1).lower() not in ALLOWED_AVATAR_TYPES:
        raise InvalidAvatarError("Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.")
    try:
        buf = base64.b64decode(m.group(2))
    except Exception:
        raise InvalidAvatarError("Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.")
    if not buf:
        raise InvalidAvatarError("The selected image is empty.")
    if len(buf) > MAX_AVATAR_UPLOAD_BYTES:
        raise InvalidAvatarError("Profile images must be 3 MB or smaller.")
    return buf


def _validate_file(file) -> None:
    content_type = (getattr(file, "content_type", "") or "").lower()
    if content_type not in ALLOWED_AVATAR_TYPES:
        raise InvalidAvatarError("Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.")
    if not file.size:
        raise InvalidAvatarError("The selected image is empty.")
    from apps.media.save_media import MAX_AVATAR_UPLOAD_BYTES

    if file.size > MAX_AVATAR_UPLOAD_BYTES:
        raise InvalidAvatarError("Profile images must be 3 MB or smaller.")


def _read_profile_request(request) -> dict:
    content_type = (request.content_type or "").lower()
    update: dict = {}

    if content_type.startswith("multipart/form-data"):
        form = request.data
        if "name" in form:
            update["name"] = _validate_name(form.get("name"))

        if form.get("removeAvatar") == "true":
            update["avatar"] = {"kind": "remove"}
        elif "avatar" in request.FILES:
            avatar_file = request.FILES["avatar"]
            _validate_file(avatar_file)
            update["avatar"] = {"kind": "upload", "buffer": avatar_file.read()}
        elif "avatar" in form and not isinstance(form.get("avatar"), str):
            raise InvalidAvatarError("Choose an image to upload.")

    elif content_type.startswith("application/json"):
        body = request.data if isinstance(request.data, dict) else None
        if body is None:
            raise InvalidAvatarError("Invalid profile update.")
        if "name" in body:
            update["name"] = _validate_name(body.get("name"))
        if body.get("avatar") is None and "avatar" in body or body.get("removeAvatar") is True:
            update["avatar"] = {"kind": "remove"}
        elif "avatar" in body:
            if not isinstance(body["avatar"], str):
                raise InvalidAvatarError("An image data URL is required.")
            update["avatar"] = {"kind": "upload", "buffer": _decode_data_url(body["avatar"])}
    else:
        raise InvalidAvatarError("Send profile data as JSON or multipart form data.")

    if update.get("name") is None and update.get("avatar") is None:
        raise InvalidAvatarError("Nothing to update.")
    return update


@api_view(["PATCH"])
@permission_classes([])
def password(request):
    session_user = request.user
    if not session_user:
        return _clear_session(error("UNAUTHENTICATED", "UNAUTHENTICATED", status=401))

    body = request.data or {}
    current_password = body.get("currentPassword")
    new_password = body.get("newPassword")
    if not isinstance(current_password, str) or not current_password or len(current_password) > 1024:
        return error("VALIDATION_ERROR", "Current password is required.", status=400)
    password_error = validate_password(new_password)
    if password_error:
        return error("VALIDATION_ERROR", password_error, status=400)

    account = User.objects.filter(id=session_user.id).first()
    if not account or not account.is_active or account.auth_version != session_user.auth_version:
        return _clear_session(error("UNAUTHENTICATED", "UNAUTHENTICATED", status=401))
    if not verify_password(current_password, account.password_hash, account.password_salt):
        return error("INVALID_CURRENT_PASSWORD", "Current password is incorrect.", status=401)

    hashed = hash_password(new_password)
    updated_count = User.objects.filter(
        id=account.id, is_active=True, auth_version=account.auth_version
    ).update(password_hash=hashed["hash"], password_salt=hashed["salt"], auth_version=account.auth_version + 1)

    if not updated_count:
        return _clear_session(error("SESSION_CONFLICT", "Your session changed. Sign in and try again.", status=409))

    new_auth_version = account.auth_version + 1
    response = success(None)
    response.set_cookie(settings.VEEVEE_SESSION_COOKIE, sign_session(str(account.id), new_auth_version), **session_cookie_kwargs())
    log_activity(str(account.id), "password_changed")
    return response
