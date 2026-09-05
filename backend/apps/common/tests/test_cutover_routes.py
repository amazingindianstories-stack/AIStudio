from unittest.mock import patch

from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from ..models import AppSetting, UserLimit
from ..test_utils import SECRET, _cookie_for, _make_user


@override_settings(AUTH_SECRET=SECRET)
class SettingsAndUploadContractTests(TestCase):
    def setUp(self):
        self.client = APIClient()
        self.user = _make_user()

    def authenticate(self):
        self.client.cookies["veevee_session"] = _cookie_for(str(self.user.id))

    def test_settings_requires_auth_and_applies_user_override(self):
        self.assertEqual(self.client.get("/api/settings").status_code, 401)
        AppSetting.objects.create(key="maxConcurrentJobs", value="3", updated_at=1)
        UserLimit.objects.create(user_id=self.user.id, key="maxConcurrentJobs", value="2", updated_at=2)
        self.authenticate()
        self.assertEqual(self.client.get("/api/settings").json()["maxConcurrentJobs"], 2)

    def test_upload_presign_validates_purpose_and_video_type(self):
        self.authenticate()
        invalid_purpose = self.client.post(
            "/api/uploads/presign", {"purpose": "avatar", "contentType": "video/mp4"}, format="json"
        )
        self.assertEqual(invalid_purpose.status_code, 400)
        invalid_type = self.client.post(
            "/api/uploads/presign", {"purpose": "depth-input", "contentType": "image/png"}, format="json"
        )
        self.assertEqual(invalid_type.status_code, 400)

    @patch("apps.media.upload_views.get_signed_upload_url", return_value="https://upload.example/signed")
    def test_upload_presign_returns_scoped_key(self, signer):
        self.authenticate()
        response = self.client.post(
            "/api/uploads/presign", {"purpose": "depth-input", "contentType": "video/mp4"}, format="json"
        )
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["key"].startswith(f"uploads/depth-input/{self.user.id}-"))
        self.assertEqual(response.json()["uploadUrl"], "https://upload.example/signed")
        signer.assert_called_once()


class CronContractTests(TestCase):
    @patch.dict("os.environ", {"CRON_SECRET": "cron-test"})
    def test_cron_rejects_missing_and_wrong_secret(self):
        self.assertEqual(APIClient().get("/api/cron/login-attempts").status_code, 401)
        self.assertEqual(
            APIClient().get("/api/cron/login-attempts", HTTP_AUTHORIZATION="Bearer wrong").status_code,
            401,
        )

    @patch.dict("os.environ", {"CRON_SECRET": "cron-test"})
    @patch("apps.common.cron_views.cleanup_expired_login_attempts", return_value=4)
    def test_cleanup_cron_contract(self, cleanup):
        response = APIClient().get(
            "/api/cron/login-attempts", HTTP_AUTHORIZATION="Bearer cron-test"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "deleted": 4})
        cleanup.assert_called_once_with()

    @patch.dict("os.environ", {"CRON_SECRET": "cron-test"})
    @patch("apps.common.cron_views.run_video_reconciliation", return_value={"checked": 0, "pending": 0})
    def test_reconciliation_cron_is_no_store(self, reconcile):
        response = APIClient().get(
            "/api/cron/video-reconciliation", HTTP_AUTHORIZATION="Bearer cron-test"
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response["Cache-Control"], "no-store")
        self.assertEqual(response.json()["checked"], 0)
        reconcile.assert_called_once_with()
