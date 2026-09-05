from django.test import SimpleTestCase
from django.urls import URLPattern, URLResolver, get_resolver


EXPECTED = {
    "admin/activity": {"GET"}, "admin/audit/runtime": {"POST"}, "admin/data": {"GET"},
    "admin/limits": {"POST"}, "admin/logs": {"GET"}, "admin/pricing": {"POST"},
    "admin/set-token": {"POST"}, "admin/status": {"GET"}, "admin/user-limits": {"POST"},
    "admin/users": {"POST", "PATCH", "DELETE"},
    "agent-conversations": {"GET", "POST"}, "agent-conversations/<str:conversation_id>": {"GET"},
    "agent-conversations/<str:conversation_id>/messages": {"POST"},
    "agent-conversations/<str:conversation_id>/messages/<str:message_id>": {"PATCH"},
    "assets": {"GET", "POST", "DELETE"}, "auth/login": {"POST"}, "auth/logout": {"POST"},
    "auth/me": {"GET", "PATCH"}, "auth/password": {"PATCH"},
    "canvas-boards": {"GET", "POST"}, "canvas-boards/<str:board_id>": {"GET", "PUT"},
    "canvas-boards/<str:board_id>/upload": {"POST"}, "cron/login-attempts": {"GET"},
    "cron/video-reconciliation": {"GET"}, "generate/depth": {"POST"},
    "generate/depth/status": {"GET"}, "generate/image": {"POST"}, "generate/video": {"POST"},
    "generate/video/status": {"GET"}, "history": {"GET", "PATCH", "DELETE"},
    "history/counts": {"GET"}, "history/download-zip": {"POST"}, "history/updates": {"GET"},
    "media-grant": {"GET"}, "media/<path:path>": {"GET"}, "projects": {"GET", "POST"},
    "queue/execute": {"POST"}, "queue/status": {"GET"}, "settings": {"GET"},
    "uploads/presign": {"POST"}, "users": {"GET"}, "worker/depth/claim": {"POST"},
    "worker/depth/complete": {"POST"}, "worker/depth/heartbeat": {"POST"},
    "worker/depth/progress": {"POST"}, "worker/depth/status": {"GET"},
    "worker/depth/upload-url": {"POST"},
}


def _routes(patterns, prefix=""):
    result = {}
    for entry in patterns:
        path = prefix + str(entry.pattern)
        if isinstance(entry, URLResolver):
            result.update(_routes(entry.url_patterns, path))
        elif isinstance(entry, URLPattern) and path.startswith("api/"):
            route = path.removeprefix("api/")
            cls = getattr(entry.callback, "cls", None)
            methods = set(getattr(cls, "http_method_names", []) or []) - {"options"}
            result[route] = {method.upper() for method in methods} if methods else {"GET"}
    return result


class ApiRouteContractTests(SimpleTestCase):
    def test_django_matches_retained_next_api_surface(self):
        actual = _routes(get_resolver().url_patterns)
        self.assertEqual({key: actual.get(key) for key in EXPECTED}, EXPECTED)
        self.assertEqual(set(actual) - set(EXPECTED), {"health", "whoami"})
