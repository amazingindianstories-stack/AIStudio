import json

from django.core.management.base import BaseCommand
from django.db import connections

from apps.common.login_throttle import cleanup_expired_login_attempts


class Command(BaseCommand):
    help = "Delete expired failed-login rows and terminate."

    def handle(self, *args, **options):
        try:
            deleted = cleanup_expired_login_attempts()
            self.stdout.write(json.dumps({"event": "maintenance_cleanup", "target": "login_attempts", "deleted": deleted}))
        finally:
            connections.close_all()
