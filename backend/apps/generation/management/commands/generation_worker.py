import json
import signal
from threading import Event
from django.core.management.base import BaseCommand
from apps.generation.worker import run_once, run_worker


class Command(BaseCommand):
    help = 'Run the independent Python generation coordinator and executor.'

    def add_arguments(self, parser):
        parser.add_argument('--once', action='store_true')
        parser.add_argument('--interval', type=float, default=2)
        parser.add_argument('--concurrency', type=int, default=2)

    def handle(self, *args, **options):
        from apps.generation.services import portrait_prepare
        portrait_prepare.check_ready()
        stop = Event()
        previous = {signum: signal.getsignal(signum) for signum in (signal.SIGINT, signal.SIGTERM)}
        try:
            for signum in previous:
                signal.signal(signum, lambda *_: stop.set())
            if options['once']:
                self.stdout.write(json.dumps(run_once(concurrency=options['concurrency'], stop=stop)))
            else:
                run_worker(interval=options['interval'], concurrency=options['concurrency'], stop=stop)
        finally:
            for signum, handler in previous.items():
                signal.signal(signum, handler)
