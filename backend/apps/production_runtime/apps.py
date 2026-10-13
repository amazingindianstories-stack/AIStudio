"""Production runtime behaviour that previously lived in Railway launcher overlays.

Everything here is ordinary reviewed source configured by named settings.
Nothing is installed unless its setting is present, so tests and local runs
keep the plain application unless they opt in.
"""
from django.apps import AppConfig
from django.conf import settings


class ProductionRuntimeConfig(AppConfig):
    name = 'apps.production_runtime'
    label = 'production_runtime'

    def ready(self):
        paid = getattr(settings, 'VEEVEE_PAID_GUARD', None)
        if paid:
            from . import paid_guard
            from apps.generation.services import enqueue
            if not getattr(enqueue, '_goal4_paid_guard_installed', False):
                paid_guard.install_paid_guard(paid)
