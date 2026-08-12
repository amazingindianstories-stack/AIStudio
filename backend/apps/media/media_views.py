"""Port of src/app/api/media/[...path]/route.js and media-grant/route.js.

Auth here deliberately uses the lightweight `verify_session_token` (HMAC
only, no DB lookup) rather than the full session_auth DRF authentication
class — this route can be hit dozens of times by one media-heavy board, and
the TS version made the same trade for the same reason (avoid a Postgres
round trip per thumbnail). See that file's comment.
"""

from django.conf import settings
from django.http import HttpResponse, JsonResponse

from apps.common.session_auth import verify_session_token

from . import media_grant
from . import storage
from .media_derivatives import is_thumbnailable, thumb_key, thumb_ladder_width

MIN_THUMB_WIDTH = 32
MAX_THUMB_WIDTH = 1600


def _parse_thumb_width(raw: str | None) -> int | None:
    if not raw:
        return None
    try:
        n = float(raw)
    except ValueError:
        return None
    if n <= 0:
        return None
    return round(min(MAX_THUMB_WIDTH, max(MIN_THUMB_WIDTH, n)))


def serve_media(request, path):
    token = request.COOKIES.get(settings.LUMINA_SESSION_COOKIE)
    if not token or not verify_session_token(token):
        return JsonResponse({"error": "UNAUTHENTICATED"}, status=401)

    key = path
    if storage.is_protected_media_key(key):
        return HttpResponse("Not Found", status=404)

    width = _parse_thumb_width(request.GET.get("w"))

    try:
        target = key
        fresh: bytes | None = None
        step = thumb_ladder_width(width) if width and is_thumbnailable(key) else None
        if step:
            derivative = thumb_key(key, step)
            try:
                if storage.object_exists(derivative):
                    target = derivative
                else:
                    fresh = storage.render_thumbnail(key, step)
                    if fresh:
                        target = derivative
            except storage.MediaNotFoundError:
                raise
            except Exception as e:  # noqa: BLE001 — degrade to serving the original
                print(f"thumbnail lookup failed for {key} @{step}: {e}")

        inline = request.GET.get("inline") == "1"
        direct = None if inline else storage.browser_media_url(target)
        if direct:
            response = HttpResponse(status=307)
            response["Location"] = direct
            response["Cache-Control"] = f"private, max-age={storage.BROWSER_URL_REDIRECT_MAX_AGE_S}"
            return response

        if fresh:
            response = HttpResponse(fresh, content_type="image/webp", status=200)
            response["Content-Length"] = str(len(fresh))
            response["Cache-Control"] = "public, max-age=31536000, immutable"
            response["X-Content-Type-Options"] = "nosniff"
            return response

        media = storage.open_media_object(target, request.headers.get("range"))
        response = HttpResponse(media["body"], content_type=media["content_type"], status=media["status"])
        response["Content-Length"] = str(media["content_length"])
        response["Cache-Control"] = "public, max-age=31536000, immutable"
        response["Accept-Ranges"] = "bytes"
        response["X-Content-Type-Options"] = "nosniff"
        if media["content_range"]:
            response["Content-Range"] = media["content_range"]
        return response

    except storage.MediaNotFoundError:
        return HttpResponse("Not Found", status=404)
    except storage.InvalidMediaRangeError:
        return HttpResponse("Range Not Satisfiable", status=416)
    except Exception as e:  # noqa: BLE001 — mirrors the TS route's catch-all 500
        print(f"Error serving media: {e}")
        return HttpResponse("Internal Server Error", status=500)


def media_grant_view(request):
    """Unauthenticated by design — the HMAC token itself is the
    authorization (see media_grant.py)."""
    key = media_grant.verify_media_grant(request.GET.get("t"))
    if not key:
        return HttpResponse("Forbidden", status=403)
    try:
        media = storage.open_media_object(key)
    except storage.MediaNotFoundError:
        return HttpResponse("Not Found", status=404)
    response = HttpResponse(media["body"], content_type=media["content_type"], status=200)
    response["Content-Length"] = str(media["content_length"])
    response["Cache-Control"] = "private, no-store"
    response["X-Content-Type-Options"] = "nosniff"
    return response
