"""Make the first-frame poster of existing succeeded video generations that have none.

Safe on production and idempotent: a poster is written create-only under ``thumbs/poster/<key>.webp`` and recorded on
the row only while its ``poster`` is still NULL. Masters are never read in full, rewritten or deleted. Rows walk in
``(created_at, id)`` order; a failure or a missing master is logged and skipped. Resume with the printed ``next``
cursor (``--after``); a plain re-run also converges because finished rows no longer match.

Examples:
    python backend/manage.py backfill_video_posters --dry-run
    python backend/manage.py backfill_video_posters --limit 200 --workers 2
    python backend/manage.py backfill_video_posters --limit 200 --after 1760000000000:<uuid>
"""
from concurrent.futures import ThreadPoolExecutor
import json
import logging
import threading
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db.models import Q

from apps.generation.models import Generation
from apps.generation.services.video_posters import poster_ref
from apps.media.keys import media_key_from_ref
from apps.media.storage import get_storage

logger = logging.getLogger('veevee.generation')
MAX_WORKERS = 4
MAX_BATCH = 100


def candidates(after=None):
    rows = Generation.objects.filter(kind='video', status='succeeded', poster__isnull=True).exclude(Q(url__isnull=True) | Q(url=''))
    if after:
        rows = rows.filter(Q(created_at__gt=after[0]) | Q(created_at=after[0], id__gt=after[1]))
    return rows.order_by('created_at', 'id')


def parse_cursor(value):
    try:
        created_at, identifier = value.split(':', 1)
        return int(created_at), UUID(identifier)
    except (ValueError, AttributeError):
        raise CommandError('--after must look like <created_at>:<generation-uuid>.')


def make_one(storage, row, gate):
    """('poster', ref), ('missing', None) or ('failed', None) for one row; touches storage only."""
    try:
        key = media_key_from_ref(row.url, getattr(settings, 'GCP_MEDIA_CDN_URL', ''))
        if not key or not storage.exists(key):
            return 'missing', None
        ref = poster_ref(row.url, storage, gate=gate)
        return ('poster', ref) if ref else ('failed', None)
    except Exception as error:
        logger.warning('video_poster_backfill_error id=%s error=%s', row.id, type(error).__name__)
        return 'failed', None


class Command(BaseCommand):
    help = 'Make first-frame posters for succeeded video generations that have none.'

    def add_arguments(self, parser):
        parser.add_argument('--limit', type=int, default=200, help='Most rows to examine this run (default 200; 0 means no limit).')
        parser.add_argument('--batch-size', type=int, default=25, help=f'Rows loaded and processed together (1-{MAX_BATCH}, default 25).')
        parser.add_argument('--workers', type=int, default=1, help=f'Concurrent ffmpeg reads (1-{MAX_WORKERS}, default 1).')
        parser.add_argument('--after', help='Resume after this <created_at>:<uuid> cursor, as printed in "next".')
        parser.add_argument('--dry-run', action='store_true', help='Count the rows that would be examined; write nothing.')

    def handle(self, *args, **options):
        limit = max(0, int(options['limit']))
        batch_size = max(1, min(MAX_BATCH, int(options['batch_size'])))
        workers = max(1, min(MAX_WORKERS, int(options['workers'])))
        after = parse_cursor(options['after']) if options.get('after') else None
        counts = {'examined': 0, 'poster': 0, 'missing': 0, 'failed': 0}
        if options['dry_run']:
            total = candidates(after).count()
            self.stdout.write(json.dumps({'ok': True, 'dryRun': True, 'pending': min(total, limit) if limit else total}))
            return
        storage, gate = get_storage(), threading.BoundedSemaphore(workers)
        last = None
        with ThreadPoolExecutor(max_workers=workers) as pool:
            while not limit or counts['examined'] < limit:
                take = min(batch_size, limit - counts['examined']) if limit else batch_size
                rows = list(candidates(after)[:take])
                if not rows:
                    last = None
                    break
                for row, (outcome, ref) in zip(rows, pool.map(lambda row: make_one(storage, row, gate), rows)):
                    counts['examined'] += 1
                    if outcome == 'poster' and Generation.objects.filter(pk=row.pk, poster__isnull=True).update(poster=ref):
                        counts['poster'] += 1
                    elif outcome != 'poster':
                        counts[outcome] += 1
                        logger.warning('video_poster_backfill_%s id=%s', outcome, row.id)
                last = rows[-1]
                after = (last.created_at, last.id)
        self.stdout.write(json.dumps({'ok': True, 'dryRun': False, **counts,
                                      'next': f'{last.created_at}:{last.id}' if last else None}))
