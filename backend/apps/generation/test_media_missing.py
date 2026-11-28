"""Missing-media marker: API field, MCP links, and the mark_media_missing command (dry run, verification, idempotency)."""
import io
import uuid
from pathlib import Path
from unittest.mock import patch

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TransactionTestCase

from apps.media.storage import MemoryAdapter, StorageService
from . import serialization
from .management.commands import mark_media_missing
from .models import Generation


class StorageWithError(MemoryAdapter):
    def exists(self, key):
        raise RuntimeError('storage unreachable')


class MediaMissingTests(TransactionTestCase):
    def setUp(self):
        self.adapter = MemoryAdapter()
        self.storage = StorageService(self.adapter)

    def row(self, key=None, **values):
        identifier = uuid.uuid4()
        key = key or f'generations/{identifier}.png'
        defaults = dict(id=identifier, kind='image', status='succeeded', prompt='p', model='Seedream 5.0 Pro',
                        aspect_ratio='1:1', url=f'/api/media/{key}', cost_cents=9, created_at=100, updated_at=100)
        defaults.update(values)
        return Generation.objects.create(**defaults)

    def key(self, row):
        return row.url[len('/api/media/'):]

    def run_command(self, *args, storage=None, expect_error=False):
        out = io.StringIO()
        with patch.object(mark_media_missing, 'get_storage', return_value=storage or self.storage):
            if expect_error:
                with self.assertRaises(CommandError):
                    call_command('mark_media_missing', *args, stdout=out)
            else:
                call_command('mark_media_missing', *args, stdout=out)
        return out.getvalue()

    def test_item_exposes_media_missing_at_only_when_set(self):
        plain, gone = self.row(), self.row(media_missing_at=1234)
        self.assertNotIn('mediaMissingAt', serialization.generation_item(plain, filename='a.png'))
        item = serialization.generation_item(gone, filename='a.png')
        self.assertEqual((item['mediaMissingAt'], item['status'], item['costCents']), (1234, 'succeeded', 9))

    def test_mcp_links_give_no_master_key_for_a_missing_row(self):
        from apps.mcp import links
        self.assertIsNone(links.media_key({'url': '/api/media/generations/x.png', 'mediaMissingAt': 5}))
        self.assertEqual(links.media_key({'url': '/api/media/generations/x.png'}), 'generations/x.png')

    def test_dry_run_default_verifies_but_writes_nothing(self):
        gone = self.row()
        output = self.run_command(str(gone.id))
        self.assertIn(f'{gone.id} would_mark', output)
        self.assertIn('dry run', output)
        gone.refresh_from_db()
        self.assertIsNone(gone.media_missing_at)
        self.assertEqual(gone.updated_at, 100)

    def test_apply_marks_only_absent_masters_and_keeps_status_cost_and_name(self):
        gone, present = self.row(permanent_name='unsorted_0001'), self.row()
        self.adapter.put(self.key(present), b'bytes', 'image/png', 'x')
        output = self.run_command(str(gone.id), str(present.id), '--apply')
        self.assertIn(f'{gone.id} marked', output)
        self.assertIn(f'{present.id} present', output)
        gone.refresh_from_db(); present.refresh_from_db()
        self.assertGreater(gone.media_missing_at, 0)
        self.assertEqual((gone.status, gone.cost_cents, gone.permanent_name, gone.url), ('succeeded', 9, 'unsorted_0001', f'/api/media/{self.key(gone)}'))
        self.assertGreaterEqual(gone.updated_at, 100)
        self.assertIsNone(present.media_missing_at)

    def test_a_master_under_the_prefixed_key_counts_as_present(self):
        from apps.media.storage import PrefixedGCSAdapter
        row = self.row()
        class Blob:
            def __init__(self, name): self.name = name
            def exists(self, timeout=None): return self.name == 'ns/' + self.key
        class Client:
            def bucket(self, name): return self
            def blob(self, key): return Blob(key)
        Blob.key = self.key(row)
        storage = StorageService(PrefixedGCSAdapter(Client(), 'bucket', prefix='ns/'))
        self.assertIn(f'{row.id} present', self.run_command(str(row.id), '--apply', storage=storage))
        row.refresh_from_db()
        self.assertIsNone(row.media_missing_at)

    def test_rerun_is_idempotent_and_keeps_the_first_timestamp(self):
        gone = self.row()
        self.run_command(str(gone.id), '--apply')
        first = Generation.objects.get(pk=gone.id)
        output = self.run_command(str(gone.id), '--apply')
        self.assertIn(f'{gone.id} already_marked', output)
        again = Generation.objects.get(pk=gone.id)
        self.assertEqual((again.media_missing_at, again.updated_at), (first.media_missing_at, first.updated_at))

    def test_unmarkable_rows_are_skipped_and_unknown_ids_reported(self):
        failed = self.row(status='failed')
        external = self.row(url='https://untrusted.example/a.png')
        exported = self.row(url='/api/media/exports/some/archive.zip')
        unknown = str(uuid.uuid4())
        output = self.run_command(str(failed.id), str(external.id), str(exported.id), unknown, '--apply')
        self.assertIn(f'{failed.id} skipped (status is failed)', output)
        self.assertIn(f'{external.id} skipped', output)
        self.assertIn(f'{exported.id} skipped', output)
        self.assertIn(f'{unknown} not_found', output)
        self.assertEqual(Generation.objects.filter(media_missing_at__isnull=False).count(), 0)

    def test_storage_error_is_never_read_as_absence(self):
        row = self.row()
        output = self.run_command(str(row.id), '--apply', storage=StorageService(StorageWithError()), expect_error=True)
        row.refresh_from_db()
        self.assertIsNone(row.media_missing_at)

    def test_ids_file_ignores_comments_and_rejects_garbage(self):
        row = self.row()
        import tempfile
        with tempfile.TemporaryDirectory() as root:
            good = Path(root) / 'ids.txt'
            good.write_text(f'# header\n\n{row.id}  # trailing\n{row.id}\n')
            self.assertIn('would_mark=1', self.run_command('--ids-file', str(good)))
            bad = Path(root) / 'bad.txt'
            bad.write_text('not-a-uuid\n')
            self.run_command('--ids-file', str(bad), expect_error=True)
        self.run_command(expect_error=True)

    def test_shipped_id_list_is_36_unique_uuids(self):
        ids = mark_media_missing.read_ids(Path(mark_media_missing.__file__).resolve().parents[2] / 'data' / 'missing_media_2026_09_21.txt')
        self.assertEqual((len(ids), len(set(ids))), (36, 36))
