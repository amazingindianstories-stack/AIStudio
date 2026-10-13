import json
from unittest.mock import patch

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import TransactionTestCase, override_settings
from django.test.client import encode_multipart
from django.db import OperationalError, transaction

from apps.admin_dashboard.tests import SettingsTests
from apps.common.models import ActivityLog
from .models import User


class ProfileTests(TransactionTestCase):
    setUp = SettingsTests.setUp
    cookie = SettingsTests.cookie

    def update(self, body):
        return self.client.patch('/api/auth/me', body, content_type='application/json')

    def test_authentication_and_exact_name_validation(self):
        self.assertEqual(self.update({'name': 'New'}).status_code, 401)
        self.cookie()
        for body, message in [({}, 'Nothing to update.'), ([], 'Nothing to update.'),
                              (None, 'Invalid profile update.'),
                              ({'name': 1}, 'Name is required.'),
                              ({'name': '\ufeff '}, 'Name cannot be empty.'),
                              ({'name': '😀' * 41}, 'Name must be 80 characters or fewer.'),
                              ({'name': 'a\x00b'}, 'Name cannot contain control characters.'),
                              ({'name': 'Fixture'}, 'Nothing to update.')]:
            response = self.client.patch('/api/auth/me', json.dumps(body), content_type='application/json')
            self.assertEqual((response.status_code, response.json()), (400, {'error': message}))
        response = self.update({'name': '\ufeff  दृश्य 😀  '})
        self.assertEqual(response.json()['user']['name'], 'दृश्य 😀')
        self.assertEqual(ActivityLog.objects.get(action='profile_updated').detail, {'changedFields': ['name']})
        self.assertNotIn('password', json.dumps(response.json()))

    def test_avatar_upload_and_cleanup_and_public_shape(self):
        User.objects.update(avatar_url='/api/media/avatars/old.webp')
        self.cookie(age=172800000)
        with patch('apps.media.avatars.save_avatar_image', return_value='/api/media/avatars/new.webp') as save, \
             patch('apps.media.avatars.delete_avatar_image') as delete:
            response = self.update({'avatar': 'data:image/png;base64,YWJj'})
        self.assertEqual(response.status_code, 200)
        save.assert_called_once_with(b'abc')
        delete.assert_called_once_with('/api/media/avatars/old.webp')
        self.assertEqual(response.json()['user']['avatarUrl'], '/api/media/avatars/new.webp')
        self.assertEqual(response.cookies['veevee_session']['max-age'], 2592000)

    def test_session_revoked_during_upload_discards_new_object(self):
        User.objects.update(avatar_url='/api/media/avatars/old.webp')
        self.cookie()
        def upload(_data):
            User.objects.update(auth_version=1)
            return '/api/media/avatars/orphan.webp'
        with patch('apps.media.avatars.save_avatar_image', side_effect=upload), \
             patch('apps.media.avatars.delete_avatar_image') as delete:
            response = self.update({'name': 'No write', 'avatar': 'data:image/png;base64,YWJj'})
        self.assertEqual(response.status_code, 401)
        delete.assert_called_once_with('/api/media/avatars/orphan.webp')
        self.assertEqual(response.cookies['veevee_session']['max-age'], 0)
        self.assertEqual(User.objects.get().name, 'Fixture')
        self.assertEqual(User.objects.get().avatar_url, '/api/media/avatars/old.webp')
        self.assertFalse(ActivityLog.objects.filter(action='profile_updated').exists())

    def test_avatar_commit_ack_loss_preserves_authoritative_upload(self):
        self.cookie()
        original_exit = transaction.Atomic.__exit__
        raised = []
        def lost_ack(atomic, *args):
            result = original_exit(atomic, *args)
            if not raised:
                raised.append(True)
                raise OperationalError('synthetic lost commit acknowledgement')
            return result
        with patch('apps.media.avatars.save_avatar_image', return_value='/api/media/avatars/new.webp'), \
             patch('apps.media.avatars.delete_avatar_image') as delete, \
             patch.object(transaction.Atomic, '__exit__', lost_ack):
            response = self.update({'avatar': 'data:image/png;base64,YWJj'})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(User.objects.get().avatar_url, '/api/media/avatars/new.webp')
        delete.assert_not_called()

    def test_avatar_failed_write_cleans_only_proven_orphan(self):
        self.cookie()
        with patch('apps.media.avatars.save_avatar_image', return_value='/api/media/avatars/orphan.webp'), \
             patch('apps.media.avatars.delete_avatar_image') as delete, \
             patch('django.db.models.query.QuerySet.update', side_effect=OperationalError('synthetic write failure')):
            response = self.update({'avatar': 'data:image/png;base64,YWJj'})
        self.assertEqual(response.status_code, 500)
        self.assertIsNone(User.objects.get().avatar_url)
        delete.assert_called_once_with('/api/media/avatars/orphan.webp')

    def test_avatar_ownership_query_failure_retains_ambiguous_upload(self):
        self.cookie()
        with patch('apps.media.avatars.save_avatar_image', return_value='/api/media/avatars/ambiguous.webp'), \
             patch('apps.media.avatars.delete_avatar_image') as delete, \
             patch('django.db.models.query.QuerySet.update', side_effect=OperationalError('synthetic write failure')), \
             patch('django.db.models.query.QuerySet.exists', side_effect=OperationalError('synthetic ownership read failure')):
            response = self.update({'avatar': 'data:image/png;base64,YWJj'})
        self.assertEqual(response.status_code, 500)
        delete.assert_not_called()

    def test_multipart_first_name_and_removal_take_precedence(self):
        self.cookie()
        User.objects.update(avatar_url='/api/media/avatars/old.webp')
        data = encode_multipart('boundary', {'name': ['First', 'Second'], 'removeAvatar': 'true',
                 'avatar': SimpleUploadedFile('invalid.bin', b'not-an-image', content_type='text/plain')})
        with patch('apps.media.avatars.delete_avatar_image') as delete, \
             patch('apps.media.avatars.save_avatar_image') as save:
            response = self.client.patch('/api/auth/me', data, content_type='multipart/form-data; boundary=boundary')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['user']['name'], 'First')
        self.assertIsNone(response.json()['user']['avatarUrl'])
        save.assert_not_called()
        delete.assert_called_once_with('/api/media/avatars/old.webp')

    def test_invalid_upload_and_storage_failure_do_not_modify_identity(self):
        self.cookie()
        for avatar, message in [(42, 'An image data URL is required.'),
                                ('data:text/plain;base64,YWJj', 'Choose a JPEG, PNG, WebP, GIF, AVIF, or TIFF image.')]:
            response = self.update({'avatar': avatar})
            self.assertEqual(response.json(), {'error': message})
        with patch('apps.media.avatars.save_avatar_image', side_effect=RuntimeError('private diagnostic')), \
             patch('apps.media.avatars.delete_avatar_image'):
            response = self.update({'name': 'Not written', 'avatar': 'data:image/png;base64,YWJj'})
        self.assertEqual(response.status_code, 500)
        self.assertEqual(response.json(), {'error': 'Could not update the profile.'})
        self.assertEqual(User.objects.get().name, 'Fixture')

    def test_users_listing_exposes_only_attribution_fields_including_inactive(self):
        self.assertEqual(self.client.get('/api/users').status_code, 401)
        self.cookie()
        account = User.objects.get()
        User.objects.create(email='disabled@example.invalid', name='Disabled', password_hash='private',
                            password_salt='private', is_active=False, created_at=2)
        response = self.client.get('/api/users')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(response.json()['users']), 2)
        for row in response.json()['users']:
            self.assertEqual(set(row), {'id', 'email', 'name', 'color', 'avatarUrl'})
        self.assertEqual(User.objects.get(id=account.id).name, 'Fixture')


class AuthenticationTimingTests(TransactionTestCase):
    setUp = SettingsTests.setUp

    def test_missing_and_disabled_account_perform_password_work(self):
        User.objects.update(is_active=False)
        for email in ('missing@example.invalid', 'fixture@example.invalid'):
            with patch('apps.authentication.password.verify_password', return_value=False) as verify:
                response = self.client.post('/api/auth/login', {'email': email, 'password': 'wrong'},
                                            content_type='application/json')
            self.assertEqual(response.status_code, 401)
            verify.assert_called_once()

    def test_blocked_identifier_skips_password_work(self):
        from .throttle import record_failure
        for _ in range(5):
            record_failure('fixture@example.invalid')
        with patch('apps.authentication.password.verify_password') as verify:
            response = self.client.post('/api/auth/login', {'email': 'fixture@example.invalid', 'password': 'wrong'},
                                        content_type='application/json')
        self.assertEqual(response.status_code, 429)
        verify.assert_not_called()
