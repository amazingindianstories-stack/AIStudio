from urllib.parse import urlsplit

from django.conf import settings
from django.http import JsonResponse


SAFE_METHODS = {"GET", "HEAD", "OPTIONS", "TRACE"}
INDEPENDENT_AUTH_PREFIXES = ("/api/worker/depth/", "/api/cron/")
INDEPENDENT_AUTH_PATHS = {"/api/media-grant", "/api/admin/set-token"}


def _normalized_origin(value):
    try:
        parsed = urlsplit(value)
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.netloc or parsed.path not in {"", "/"}:
        return None
    return f"{parsed.scheme}://{parsed.netloc}".lower()


class TrustedOriginMiddleware:
    """Reject unsafe browser requests from origins outside the explicit allowlist."""

    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path
        independently_authenticated = path in INDEPENDENT_AUTH_PATHS or path.startswith(INDEPENDENT_AUTH_PREFIXES)
        origin = request.headers.get("Origin")
        if request.method not in SAFE_METHODS and origin and not independently_authenticated:
            allowed = {_normalized_origin(item) for item in settings.CORS_ALLOWED_ORIGINS}
            if _normalized_origin(origin) not in allowed:
                return JsonResponse(
                    {"ok": False, "error": {"code": "UNTRUSTED_ORIGIN", "message": "Request origin is not allowed."}},
                    status=403,
                )
        return self.get_response(request)
