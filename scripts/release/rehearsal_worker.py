#!/usr/bin/env python3
"""Local release rehearsal: run a worker from the built image against a fake provider network.

    python /scripts/release/rehearsal_worker.py {generation|export|scheduler}

Identical to ``python -m deploy.entrypoint <component>`` except that the provider
transport and media fetcher are replaced by testsupport.fake_providers *before*
Django starts, so the production paid guard wraps the fake and its ledger
transitions run for real. Never use this in a deployed service.
"""
import os
import sys
from unittest.mock import patch

sys.path[:0] = ['/app']
from deploy import entrypoint, legacy_config  # noqa: E402

component = sys.argv[1]
if os.environ.get('VEEVEE_REHEARSAL') != '1':
    raise SystemExit('rehearsal worker requires VEEVEE_REHEARSAL=1')
env, contract = dict(os.environ), None
if legacy_config.present(env):
    raise SystemExit('rehearsal must not use production launcher configuration')
env = entrypoint.prepare_environment(env)
env['VEEVEE_RUNTIME_COMPONENT'] = component
os.environ.clear()
os.environ.update(env)

from testsupport.fake_providers import FakeProviders  # noqa: E402
from apps.generation.providers import transport  # noqa: E402

fake = FakeProviders()
transport.HttpTransport.request = lambda self, method, url, **kwargs: fake.request(self, method, url, **kwargs)

import django  # noqa: E402
django.setup()  # installs the paid guard around the fake transport
for target in ('apps.media.remote.get_media_fetcher', 'apps.media.persistence.get_media_fetcher',
               'apps.generation.services.poller.get_media_fetcher'):
    patch(target, lambda: fake.fetch).start()
print('{"event": "rehearsal_worker_ready", "component": "%s"}' % component, flush=True)
from django.core.management import execute_from_command_line  # noqa: E402
execute_from_command_line(['manage.py', *entrypoint.WORKER_COMMANDS[component]])
