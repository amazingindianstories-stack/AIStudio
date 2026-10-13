from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from apps.media.uploads import cleanup_expired_uploads
from apps.media.storage import get_storage


class Command(BaseCommand):
    help = 'Collect only expired unpublished temporary upload sessions, bounded per invocation.'

    def add_arguments(self, parser):
        parser.add_argument('--limit', type=int, default=100)

    def handle(self, *args, **options):
        if settings.LOCAL_DATA_MODE == 'read_only_viewer':
            raise CommandError('Read-only viewer cannot clean storage')
        if not 1 <= options['limit'] <= 1000:
            raise CommandError('Limit must be between 1 and 1000')
        result = cleanup_expired_uploads(get_storage(), limit=options['limit'])
        self.stdout.write(str(result))
