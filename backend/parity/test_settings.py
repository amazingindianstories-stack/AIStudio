"""Settings flags exercise observable HTTP and command behavior."""
from django.test import override_settings
from django.core.management.base import CommandError
from .support import ParityCase


class ViewerSettingsParityTests(ParityCase):
    def test_viewer_flag_rejects_mutations_and_cleanup_by_command_name(self):
        with override_settings(LOCAL_DATA_MODE='read_only_viewer'):
            for method in ('post', 'put', 'patch', 'delete'):
                response = getattr(self.client, method)('/api/folders', {}, content_type='application/json')
                self.assertEqual((response.status_code, response.json()), (403, {'error': 'READ_ONLY_DATA_VIEWER'}))
            self.assertEqual(self.client.get('/api/settings').status_code, 200)
            with self.assertRaisesRegex(CommandError, 'Read-only viewer cannot clean storage'):
                self.command('cleanup_uploads')
