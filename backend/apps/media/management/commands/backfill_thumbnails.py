"""Pre-generate tiered WebP display derivatives for existing canvas board images.

Safe and idempotent: writes create-only derivatives under ``thumbs/<width>/<key>.webp``
and never modifies or deletes original masters. Existing derivatives are skipped.

Examples:
    python backend/manage.py backfill_thumbnails --board <board-uuid>
    python backend/manage.py backfill_thumbnails --board <board-uuid> --workers 4 --dry-run
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import threading
from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import close_old_connections
from apps.canvas.models import CanvasBoard
from apps.media.derivatives import THUMB_WIDTHS, bounded_derivative, derivative_key, ready_upload_is_image
from apps.media.images import is_thumbnailable
from apps.media.keys import media_key_from_ref, is_export_key
from apps.media.storage import get_storage


def extract_board_image_keys(data, cdn_url=''):
    """Return deduplicated thumbnailable storage keys referenced by a board's image/linkcard nodes."""
    keys = []
    seen = set()
    nodes = data.get('nodes', []) if isinstance(data, dict) else []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        node_type = node.get('type')
        refs = []
        if node_type == 'image':
            refs.append(node.get('src'))
        elif node_type == 'linkcard':
            refs.append(node.get('image'))
        for ref in refs:
            key = media_key_from_ref(ref, cdn_url)
            if not key or key in seen or is_export_key(key):
                continue
            if is_thumbnailable(key) or ready_upload_is_image(key):
                seen.add(key)
                keys.append(key)
    return keys


def backfill_key(storage, key, *, gate, widths=THUMB_WIDTHS, dry_run=False):
    """Ensure all derivative tiers exist for ``key``. Returns 'skipped', 'generated', 'missing_tier', or 'failed'."""
    try:
        missing = [w for w in widths if not storage.exists(derivative_key(key, w))]
        if not missing:
            return 'skipped'
        if dry_run:
            return 'missing_tier'
        target, _ = bounded_derivative(storage, key, missing[0], gate=gate)
        if target == key:
            return 'failed'
        return 'generated'
    except Exception:
        return 'failed'
    finally:
        close_old_connections()


class Command(BaseCommand):
    help = 'Pre-generate tiered WebP display thumbnails for existing canvas board images.'

    def add_arguments(self, parser):
        parser.add_argument('--board', action='append', dest='boards', default=[], help='CanvasBoard UUID to backfill (repeatable).')
        parser.add_argument('--workers', type=int, default=4, help='Concurrent worker threads (1-8, default 4).')
        parser.add_argument('--dry-run', action='store_true', help='Inspect and report missing thumbnails without writing.')

    def handle(self, *args, **options):
        boards = options['boards']
        if isinstance(boards, str):
            boards = [boards]
        if not boards:
            raise CommandError('Specify --board <uuid>.')
        workers = max(1, min(8, int(options['workers'])))
        dry_run = bool(options['dry_run'])

        qs = CanvasBoard.objects.filter(id__in=boards)

        cdn_url = getattr(settings, 'GCP_MEDIA_CDN_URL', '')
        keys = []
        seen = set()
        board_count = 0
        for data in qs.values_list('data', flat=True).iterator(chunk_size=50):
            board_count += 1
            for key in extract_board_image_keys(data, cdn_url):
                if key not in seen:
                    seen.add(key)
                    keys.append(key)

        storage = get_storage()
        gate = threading.BoundedSemaphore(workers)
        counts = {'boards': board_count, 'keys': len(keys), 'skipped': 0, 'generated': 0, 'missing_tier': 0, 'failed': 0}

        if workers == 1 or len(keys) <= 1:
            for key in keys:
                status = backfill_key(storage, key, gate=gate, dry_run=dry_run)
                counts[status] += 1
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futures = [pool.submit(backfill_key, storage, key, gate=gate, dry_run=dry_run) for key in keys]
                for future in as_completed(futures):
                    status = future.result()
                    counts[status] += 1

        self.stdout.write(json.dumps({'ok': True, 'dryRun': dry_run, **counts}))
