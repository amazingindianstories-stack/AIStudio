import json
import signal
from threading import Event
from django.core.management.base import BaseCommand
from apps.exports.worker import run_once, run_worker


class Command(BaseCommand):
    help = 'Build private media ZIP exports with the independent Python worker.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')
        parser.add_argument('--interval', type=float, default=2.0)

    def handle(self, *args, **options):
        stop = Event()
        previous = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}
        try:
            for signum in previous:
                signal.signal(signum, lambda *_: stop.set())
            if options['once']:
                self.stdout.write(json.dumps(run_once(stop=stop)))
            else:
                run_worker(interval=max(.1, options['interval']), stop=stop)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
