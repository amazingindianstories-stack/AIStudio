from django.apps import AppConfig


class CommonConfig(AppConfig):
    default_auto_field = 'django.db.models.BigAutoField'
    name = 'apps.common'
    label = 'common'

    def ready(self):
        # Registers the DATABASE_URL-must-be-Postgres system check (see
        # checks.py's module docstring for why this is a warning, not a
        # hard failure). Import here, not at module top-level, per Django's
        # own guidance for AppConfig.ready() side effects.
        from . import checks  # noqa: F401
