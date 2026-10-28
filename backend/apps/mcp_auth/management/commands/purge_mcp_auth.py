import json
from django.core.management.base import BaseCommand
from apps.mcp_auth.maintenance import purge_expired


class Command(BaseCommand):
    help = 'Delete expired agent authorization codes, rate windows, old tokens and unused registered clients.'

    def handle(self, *args, **options):
        self.stdout.write(json.dumps(purge_expired()))
