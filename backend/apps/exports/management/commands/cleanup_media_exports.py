from django.core.management.base import BaseCommand
from apps.exports.services import cleanup_expired_archives
from apps.media.storage import get_storage


class Command(BaseCommand):
    help = 'Delete expired private export objects, retaining status rows for HTTP 410.'

    def handle(self, *args, **options):
        self.stdout.write(str(cleanup_expired_archives(get_storage())))
