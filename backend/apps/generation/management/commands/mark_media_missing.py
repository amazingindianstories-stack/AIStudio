"""Mark succeeded generations whose stored master is verifiably absent as missing media.

Dry run by default: nothing is written without ``--apply``. A row is marked only when it is succeeded, its ``url`` is
a protected-namespace ``/api/media/`` key, and ``storage.exists`` (canonical and prefixed key) says the master is not
there. A row whose master exists is never marked; a storage error aborts that row (reported, exit code 1) rather than
being read as absence. Rerunning is safe: marked rows are reported as already marked and keep their first timestamp.
Status, cost, name and every other column are untouched; ``updated_at`` moves so clients refresh the row.

Examples:
    python backend/manage.py mark_media_missing --ids-file backend/apps/generation/data/missing_media_2026_09_21.txt
    python backend/manage.py mark_media_missing --ids-file <file> --apply
    python backend/manage.py mark_media_missing <uuid> [<uuid> ...] --apply
"""
from pathlib import Path
from uuid import UUID

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.media.keys import is_export_key, media_key_from_ref
from apps.media.storage import get_storage


def read_ids(path):
    """One UUID per line; blank lines and ``#`` comments are ignored; duplicates collapse in order."""
    ids = []
    for number, line in enumerate(Path(path).read_text().splitlines(), 1):
        text = line.split('#', 1)[0].strip()
        if not text:
            continue
        try:
            ids.append(str(UUID(text)))
        except ValueError:
            raise CommandError(f'{path}:{number}: not a UUID')
    return ids


def classify(row, storage):
    """Return (outcome, detail) for one generation row without writing."""
    if row is None:
        return 'not_found', ''
    if row.media_missing_at:
        return 'already_marked', ''
    if row.status != 'succeeded':
        return 'skipped', f'status is {row.status}'
    key = media_key_from_ref(row.url, getattr(settings, 'GCP_MEDIA_CDN_URL', '')) if row.url else None
    if not key or is_export_key(key):
        return 'skipped', 'no protected media key'
    try:
        present = storage.exists(key)
    except Exception as error:
        return 'error', type(error).__name__
    return ('present', key) if present else ('absent', key)


class Command(BaseCommand):
    help = 'Mark succeeded generations whose stored master is verified absent as missing media (dry run unless --apply).'

    def add_arguments(self, parser):
        parser.add_argument('ids', nargs='*', help='Generation ids.')
        parser.add_argument('--ids-file', help='File with one generation id per line.')
        parser.add_argument('--apply', action='store_true', help='Write the marks. Without it nothing is changed.')

    def handle(self, *args, ids, ids_file, apply, **options):
        wanted = list(dict.fromkeys([*(read_ids(ids_file) if ids_file else []), *[str(UUID(i)) for i in ids]]))
        if not wanted:
            raise CommandError('Give generation ids or --ids-file.')
        storage = get_storage()
        counts = {}
        for identifier in wanted:
            with transaction.atomic():
                row = Generation.objects.select_for_update().filter(pk=identifier).first()
                outcome, detail = classify(row, storage)
                if outcome == 'absent':
                    if apply:
                        stamp = now_ms()
                        Generation.objects.filter(pk=identifier, media_missing_at__isnull=True).update(
                            media_missing_at=stamp, updated_at=max(stamp, row.updated_at))
                        outcome = 'marked'
                    else:
                        outcome = 'would_mark'
            counts[outcome] = counts.get(outcome, 0) + 1
            suffix = f' ({detail})' if detail and outcome in ('skipped', 'error', 'present') else ''
            self.stdout.write(f'{identifier} {outcome}{suffix}')
        self.stdout.write('summary ' + ' '.join(f'{name}={counts[name]}' for name in sorted(counts))
                          + ('' if apply else ' (dry run; pass --apply to write)'))
        if counts.get('error'):
            raise CommandError('Storage could not be verified for some rows; nothing was assumed missing.')
