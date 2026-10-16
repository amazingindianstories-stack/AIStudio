"""Undo assets.0005_managed_portraits and 0006_portrait_gallery so a pre-portrait launcher (which asserts 60 migration rows) can start again.

    python manage.py managed_portraits_rollback                    report only (default)
    python manage.py managed_portraits_rollback --delete-remote --confirm

Run with the database owner's DATABASE_URL (the migration drops tables) after VEEVEE_MANAGED_PORTRAITS has been
turned off on every service. Refuses while a generation still holds a portrait. Only the five managed-portrait
tables and their migration rows are removed (migrating assets to 0004 reverses 0006 and 0005); generations, media and every other table are untouched.
"""
from django.conf import settings
from django.core.management import call_command
from django.core.management.base import BaseCommand, CommandError
from django.db import connection
from django.db.migrations.recorder import MigrationRecorder

from apps.assets import managed_pool
from apps.assets.models import ManagedPortraitAsset, ManagedPortraitPin, ManagedPortraitPool

MIGRATION = ('assets', '0005_managed_portraits')
TABLES = ('managed_portrait_pool', 'managed_portrait_assets', 'managed_portrait_pins', 'managed_portrait_waits', 'reference_face_scans')


class Command(BaseCommand):
    help = 'Remove the managed portrait pool (remote assets, tables, migration row) for a launcher rollback.'

    def add_arguments(self, parser):
        parser.add_argument('--delete-remote', action='store_true', help="delete every asset in Veevee's BytePlus pool group, then the group, first")
        parser.add_argument('--confirm', action='store_true', help='perform the rollback (default: report only)')

    def handle(self, *args, delete_remote=False, confirm=False, **options):
        applied = MigrationRecorder(connection).migration_qs.filter(app=MIGRATION[0], name=MIGRATION[1]).exists()
        if not applied:
            self.stdout.write('assets.0005_managed_portraits is not applied; nothing to do.')
            return
        pins = ManagedPortraitPin.objects.count()
        live = ManagedPortraitAsset.objects.filter(status__in=managed_pool.LIVE).count()
        group = ManagedPortraitPool.objects.filter(pk=1).values_list('byteplus_group_id', flat=True).first()
        self.stdout.write(f'pins={pins} live_assets={live} group={"set" if group else "none"} '
                          f'flag_in_this_process={settings.VEEVEE_MANAGED_PORTRAITS}')
        if not confirm:
            self.stdout.write('Report only. Re-run with --confirm (and --delete-remote when live_assets > 0).')
            return
        if settings.VEEVEE_MANAGED_PORTRAITS:
            raise CommandError('VEEVEE_MANAGED_PORTRAITS is on; turn it off on every service (and here) first.')
        if pins:
            raise CommandError(f'{pins} portrait pin(s) are held by queued/running generations; wait for them to finish.')
        if group and delete_remote:
            self.stdout.write(f'deleted {self._empty_group(group)} remote asset(s) and the pool group.')
        elif live:
            raise CommandError(f'{live} portrait(s) may still exist at BytePlus; add --delete-remote (or remove them first).')
        call_command('migrate', MIGRATION[0], '0004', interactive=False, verbosity=1)
        with connection.cursor() as cursor:
            cursor.execute('SELECT count(*) FROM django_migrations')
            rows = cursor.fetchone()[0]
            cursor.execute('SELECT count(*) FROM pg_tables WHERE schemaname = current_schema() AND tablename = ANY(%s)', [list(TABLES)])
            remaining = cursor.fetchone()[0]
        if remaining or MigrationRecorder(connection).migration_qs.filter(app=MIGRATION[0], name__in=(MIGRATION[1], '0006_portrait_gallery')).exists():
            raise CommandError('rollback incomplete: managed portrait tables or migration row remain')
        self.stdout.write(f'rolled back: django_migrations rows={rows}')

    def _empty_group(self, group):
        """Delete every asset in Veevee's own pool group, re-listing until BytePlus reports it empty, then the group itself."""
        client = managed_pool.default_client()
        deleted = 0
        for _ in range(20):
            items = client.list_assets(group_ids=[group], max_results=100).get('Items') or []
            items = [item for item in items if item.get('Status') != 'Deleted']
            if not items:
                try:
                    client.delete_asset_group(group)
                except Exception as error:      # already gone is fine; anything else must not be left behind silently
                    if getattr(error, 'code', None) not in ('NotFound.group_id', 'NotFound'):
                        raise CommandError(f'could not delete the pool group: {getattr(error, "code", type(error).__name__)}') from error
                ManagedPortraitAsset.objects.filter(status__in=managed_pool.LIVE).update(
                    status='DELETED', deleted_at=managed_pool.now_ms(), error_code='rollback')
                return deleted
            for item in items:
                try:
                    client.delete_asset(item['Id'])
                    deleted += 1
                except Exception as error:      # NotFound is fine; anything else is retried on the next listing
                    if getattr(error, 'code', None) not in ('NotFound.asset_id', 'NotFound'):
                        self.stderr.write(f'delete {item["Id"]}: {getattr(error, "code", type(error).__name__)}')
        raise CommandError('BytePlus still lists assets in the pool group after 20 rounds; nothing was migrated.')
