"""Portrait Gallery routes pass the gateway; the migration count the launchers accept includes 0006."""
import importlib.util
from pathlib import Path

from django.test import SimpleTestCase

spec = importlib.util.spec_from_file_location('veevee_gateway_portraits', Path(__file__).with_name('gateway.py'))
gateway = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gateway)
ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'


class PortraitGalleryRouteTests(SimpleTestCase):
    def test_gallery_routes_pass_the_gateway_on_every_method_they_use(self):
        for method, path in (('GET', '/api/portraits'), ('HEAD', '/api/portraits'), ('POST', '/api/portraits'), ('PATCH', f'/api/portraits/{ID}'),
                             ('POST', '/api/portraits/delete'), ('GET', '/api/assets/portraits'), ('POST', '/api/assets/portraits/upload')):
            for flags in ((True, True), (False, False)):
                self.assertTrue(gateway.allowed(method, path, *flags), (method, path, flags))

    def test_admin_portrait_settings_stay_reachable_and_gated_admin_routes_do_not(self):
        self.assertTrue(gateway.allowed('POST', '/api/admin/portrait-settings'))
        self.assertFalse(gateway.allowed('POST', '/api/admin/audit/runtime'))

    def test_launchers_accept_the_migration_counts_before_and_after_each_portrait_migration(self):
        from deploy import legacy_config
        self.assertEqual(legacy_config.MIGRATION_ROWS, (60, 61, 62, 63))
