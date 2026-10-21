"""Model availability: the composer's pickers and the paid guard's enqueue refusals give one answer."""
import json
import os
from unittest.mock import patch
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.generation.services import paid_guard
from .test_paid_guard import UNLIMITED, contract
from deploy import legacy_config
from .availability import SWITCHES, availability, available
from .model_registry import MODEL_REGISTRY

ALWAYS = ['seedream-5-pro', 'nano-banana-pro', 'nano-banana-2-1', 'seedance', 'seedance-25', 'depth-anything-local']
SWITCHED = {'kling': ['kling-image-3', 'kling-image-21'], 'omni': ['gemini-omni-1-1-flash'],
            'magnific': ['magnific-creative', 'magnific-precision-v2', 'magnific-precision-v1', 'magnific-video-creative',
                         'magnific-video-creative-turbo', 'magnific-video-precision', 'magnific-video-topaz']}
ALL_OFF = {'VEEVEE_KLING': False, 'VEEVEE_GEMINI_OMNI': False, 'VEEVEE_MAGNIFIC_UPSCALE': False}
ALL_ON = {name: True for name in ALL_OFF}


def registry_order(ids):
    return [model['id'] for model in MODEL_REGISTRY if model['id'] in ids]


def valid_contract(model):
    """A new job on ``model`` that the paid guard admits while its switch is on."""
    if model['provider'] == 'kling':
        return contract(kind='image', model=model['name'], resolution='1K', aspect_ratio='1:1')
    if model['provider'] == 'omni':
        return contract(kind='video', model=model['name'], resolution='720p', duration=8, aspect_ratio='16:9')
    if model['provider'] == 'magnific':
        kind = 'video' if model['capabilities'].get('upscaleMedia') == 'video' else 'image'
        return contract(kind=kind, model=model['name'], submission_input={'version': 1})
    if model['kind'] == 'video':
        return contract(kind='video', model=model['name'], resolution='720p', duration=5, aspect_ratio='16:9')
    return contract(kind='image', model=model['name'], resolution='2K', aspect_ratio='1:1')


class AvailabilityTests(SimpleTestCase):
    def test_each_switch_shows_and_hides_exactly_its_own_models(self):
        with override_settings(**ALL_OFF):
            self.assertEqual(availability(), {'models': ALWAYS})
        with override_settings(**ALL_ON):
            self.assertEqual(availability(), {'models': registry_order(ALWAYS + sum(SWITCHED.values(), []))})
        for provider, switch in SWITCHES.items():
            with self.subTest(switch=switch), override_settings(**{**ALL_OFF, switch: True}):
                self.assertEqual(availability(), {'models': registry_order(ALWAYS + SWITCHED[provider])})

    def test_a_switch_is_on_only_when_its_setting_is_true(self):
        for value in (False, None, 1, '1', 'true'):
            with self.subTest(value=value), override_settings(VEEVEE_KLING=value):
                self.assertNotIn('kling-image-3', availability()['models'])

    def test_retired_and_unoffered_models_are_never_available(self):
        with override_settings(**ALL_ON):
            models = availability()['models']
        self.assertNotIn('gemini-omni-flash', models)
        hidden = [model['id'] for model in MODEL_REGISTRY if not model['offered'] or model.get('retiredFor')]
        self.assertIn('gemini-omni-flash', hidden)
        self.assertEqual(set(hidden) & set(models), set())

    def test_the_picker_and_the_paid_guard_refusal_never_disagree(self):
        for model in MODEL_REGISTRY:
            if model['kind'] == 'depth' or not model['offered']:
                continue
            for settings in (ALL_OFF, ALL_ON):
                with self.subTest(model=model['id'], on=settings is ALL_ON), override_settings(**settings), \
                        patch.dict(os.environ, {}, clear=False) as environ:
                    environ.pop('KLING_API_HOST', None)
                    try:
                        paid_guard.quote_for(valid_contract(model), UNLIMITED)
                        refused = None
                    except ValueError as error:
                        refused = str(error)
                    self.assertEqual(available(model), refused is None, refused)
        retired = next(model for model in MODEL_REGISTRY if model['id'] == 'gemini-omni-flash')
        with override_settings(**ALL_ON), self.assertRaisesRegex(ValueError, 'has been retired'):
            paid_guard.quote_for(valid_contract(retired), UNLIMITED)
        self.assertFalse(available(retired))

    def test_every_switch_reaches_django_from_its_railway_variable(self):
        for switch in SWITCHES.values():
            self.assertIn(switch, legacy_config.PASS_THROUGH)


class CurrentUserAvailabilityTests(TransactionTestCase):
    cookie = SettingsTests.cookie
    setUp = SettingsTests.setUp

    def test_signed_in_users_get_availability_and_signed_out_requests_do_not(self):
        self.cookie()
        with override_settings(**ALL_OFF):
            body = self.client.get('/api/auth/me').json()
        self.assertEqual(set(body), {'user', 'availability'})
        self.assertEqual(body['availability'], {'models': ALWAYS})
        with override_settings(**{**ALL_OFF, 'VEEVEE_KLING': True}):
            self.assertEqual(self.client.get('/api/auth/me').json()['availability'],
                             {'models': registry_order(ALWAYS + SWITCHED['kling'])})
        self.client.cookies['veevee_session'] = 'invalid'
        self.assertEqual(self.client.get('/api/auth/me').json(), {'user': None})

    def test_availability_never_carries_configuration(self):
        self.cookie()
        secrets = {'KLING_API': 'sentinel-kling-key', 'KLING_API_HOST': 'https://sentinel.klingai.com',
                   'MAGNIFIC_API_KEY': 'sentinel-magnific-key', 'GOOGLE_API_KEY': 'sentinel-google-key'}
        with override_settings(**ALL_ON), patch.dict(os.environ, secrets):
            response = self.client.get('/api/auth/me')
        text = response.content.decode()
        for value in (*secrets.values(), 'sentinel', 'http', 'VEEVEE_', 'price', 'cents', 'providerModelId', 'kling-v3'):
            self.assertNotIn(value, text)
        registry_ids = {model['id'] for model in MODEL_REGISTRY}
        self.assertEqual(list(json.loads(text)['availability']), ['models'])
        self.assertLessEqual(set(json.loads(text)['availability']['models']), registry_ids)
