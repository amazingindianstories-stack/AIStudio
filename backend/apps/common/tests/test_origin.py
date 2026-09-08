import json

from django.http import JsonResponse
from django.test import RequestFactory, SimpleTestCase, override_settings

from ..origin import TrustedOriginMiddleware


@override_settings(CORS_ALLOWED_ORIGINS=["https://studio.example"])
class TrustedOriginMiddlewareTests(SimpleTestCase):
    def setUp(self):
        self.factory = RequestFactory()
        self.middleware = TrustedOriginMiddleware(lambda _request: JsonResponse({"ok": True}))

    def test_rejects_untrusted_unsafe_browser_origin(self):
        response = self.middleware(
            self.factory.post("/api/projects", HTTP_ORIGIN="https://evil.example")
        )
        self.assertEqual(response.status_code, 403)
        self.assertEqual(json.loads(response.content)["error"]["code"], "UNTRUSTED_ORIGIN")

    def test_accepts_exact_trusted_origin(self):
        response = self.middleware(
            self.factory.patch("/api/auth/me", HTTP_ORIGIN="https://studio.example")
        )
        self.assertEqual(response.status_code, 200)

    def test_safe_and_non_browser_requests_are_not_blocked(self):
        self.assertEqual(
            self.middleware(self.factory.get("/api/projects", HTTP_ORIGIN="https://evil.example")).status_code,
            200,
        )
        self.assertEqual(self.middleware(self.factory.post("/api/projects")).status_code, 200)

    def test_independently_authenticated_routes_are_exempt(self):
        for path in (
            "/api/worker/depth/claim", "/api/cron/video-reconciliation",
            "/api/media-grant", "/api/admin/set-token",
        ):
            with self.subTest(path=path):
                response = self.middleware(self.factory.post(path, HTTP_ORIGIN="https://evil.example"))
                self.assertEqual(response.status_code, 200)
