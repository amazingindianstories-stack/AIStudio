"""Install the explicit provider fake before startup policies wrap the transport.

Used only in fresh-process parity scenarios. All model imports finish before
AppConfig.ready runs, so the fake can be installed without importing any app
implementation from the characterization tests.
"""
from django.apps import AppConfig
from testsupport.fake_providers import FakeProviders

NETWORK = None


class ParityProviderConfig(AppConfig):
    name = 'parity'
    label = 'parity_provider_fixture'

    def ready(self):
        global NETWORK
        NETWORK = FakeProviders()
        NETWORK.__enter__()
