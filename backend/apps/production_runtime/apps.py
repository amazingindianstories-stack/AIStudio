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
        component = getattr(settings, 'VEEVEE_RUNTIME_COMPONENT', None)
        # The automatic pool replaces the old portrait routes (which answer 410), so their lifecycle patches stay off.
        if (getattr(settings, 'VEEVEE_PORTRAIT_LIFECYCLE', False) and component == 'api'
                and not getattr(settings, 'VEEVEE_MANAGED_PORTRAITS', False)):
            install_portrait_lifecycle()


def install_portrait_lifecycle():
    """List-only sync and tombstones live in apps.assets; registration wraps them, then remote delete."""
    from apps.assets import portraits as route
    from .portraits import registration, remote_delete
    if getattr(route, '_veevee_portrait_lifecycle_installed', False):
        return
    registration.install(route, registration.native_client)
    remote_delete.install(route)
    route._veevee_portrait_lifecycle_installed = True
