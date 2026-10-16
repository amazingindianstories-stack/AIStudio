import json
import signal
from threading import Event
from django.core.management.base import BaseCommand
from apps.workers.scheduler import tick, run


class Command(BaseCommand):
    help = 'Run UTC depth/video/login/export maintenance with database slot leases.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')

    def handle(self, *args, **options):
        if options['once']:
            self.stdout.write(json.dumps(tick()))
            return
        stop = Event()
        for signum in (signal.SIGINT, signal.SIGTERM):
            signal.signal(signum, lambda *_: stop.set())
        run(stop=stop)
