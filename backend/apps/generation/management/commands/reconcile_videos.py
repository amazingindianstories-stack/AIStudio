import json

from django.core.management.base import BaseCommand
from django.db import connections

from apps.generation.video_reconciliation import run_video_reconciliation


class Command(BaseCommand):
    help = "Reconcile a bounded batch of stale provider-backed videos and terminate."

    def handle(self, *args, **options):
        try:
            counts = run_video_reconciliation()
            self.stdout.write(json.dumps({"event": "video_reconciliation", "version": 1, **counts}))
        finally:
            connections.close_all()
