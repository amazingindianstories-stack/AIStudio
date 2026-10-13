"""Independent Lane G acceptance probes; no provider/network operations."""
import uuid
import hashlib
import errno
from types import SimpleNamespace
from unittest.mock import patch, Mock
from django.test import TransactionTestCase, SimpleTestCase
from apps.exports import services
from apps.exports.models import MediaExport, MediaExportItem
from apps.generation.models import Generation
from apps.projects.models import Project
from apps.library.models import Folder
from apps.media.storage import StorageService, MemoryAdapter
from apps.exports.worker import run_once
from apps.generation.references import resolve_submission_references
from apps.generation.services.video_execution import sign_reference
from apps.media.grants import sign_media_grant
from apps.exports.zip_paths import resolve_archive_paths, safe_zip_member_path, MAX_ITEMS


class ZIPAbuseBoundaryAuditTests(SimpleTestCase):
    def test_oversized_member_count_is_rejected_before_metadata_queries(self):
        with self.assertRaisesMessage(ValueError, 'Invalid export item count.'):
            resolve_archive_paths([object()] * (MAX_ITEMS + 1))

    def test_oversized_worker_manifest_never_reads_sources_or_uploads_archive(self):
        job = SimpleNamespace(id=uuid.uuid4(), user_id=uuid.uuid4(), lease_owner='audit',
            attempt_count=1, total_items=MAX_ITEMS + 1, items=[object()] * (MAX_ITEMS + 1))
        storage = Mock()
        with patch('apps.exports.services.claim_export', return_value=job), \
             patch('apps.exports.services.fail_export') as failed, \
             patch('apps.exports.worker.MediaExport.objects.filter') as output_reference:
            output_reference.return_value.exists.return_value = False
            result = run_once(storage=storage, clock=lambda: 1800000000000)
        self.assertEqual(result['completed'], 0)
        storage.open.assert_not_called()
        storage.upload_stream.assert_not_called()
        self.assertIn('manifest is incomplete', failed.call_args.args[2])

    def test_utf8_total_and_component_byte_limits_reject_one_byte_over_boundary(self):
        exact_total = '/'.join(['é' * 120] * 17)
        self.assertEqual(len(exact_total.encode('utf-8')), 4096)
        self.assertEqual(safe_zip_member_path(exact_total), exact_total)
        with self.assertRaises(ValueError):
            safe_zip_member_path(exact_total + 'a')
        exact_component = 'é' * 127 + 'a'
        self.assertEqual(len(exact_component.encode('utf-8')), 255)
        self.assertEqual(safe_zip_member_path(exact_component), exact_component)
        with self.assertRaises(ValueError):
            safe_zip_member_path(exact_component + 'a')


class RetainedDraftAuditTests(TransactionTestCase):
    def test_foreign_private_export_key_cannot_be_admitted_as_video_reference(self):
        owner, attacker, job_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        key = f'exports/{owner}/{job_id}/1-private-attempt.zip'
        MediaExport.objects.create(id=job_id, user_id=owner, status='ready', total_items=1,
            output_key=key, output_bytes=100, created_at=1, updated_at=1, expires_at=1800000000000)
        with self.assertRaises(ValueError):
            resolve_submission_references({'referenceVideos': ['/api/media/' + key]}, attacker)

    def test_foreign_private_export_key_never_reaches_cloud_signer(self):
        owner, attacker, job_id = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
        key = f'exports/{owner}/{job_id}/1-private-attempt.zip'
        adapter = Mock()
        adapter.signed_read_url.return_value = 'https://offline.invalid/mock-private-export-capability'
        storage = StorageService(adapter)
        with patch('apps.generation.services.video_execution.get_storage', return_value=storage):
            with self.assertRaises(ValueError):
                sign_reference('/api/media/' + key, actor_id=attacker)
        adapter.signed_read_url.assert_not_called()

    def test_private_archive_and_derivative_cannot_become_hmac_reference_grants(self):
        key = f'exports/{uuid.uuid4()}/{uuid.uuid4()}/1-private-attempt.zip'
        for value in (key, 'thumbs/512/' + key + '.webp'):
            with self.subTest(key=value), self.assertRaises(ValueError):
                sign_media_grant(value, actor_id=uuid.uuid4())

    def test_private_archive_cannot_be_read_through_reference_helper(self):
        key = f'exports/{uuid.uuid4()}/{uuid.uuid4()}/1-private-attempt.zip'
        adapter = MemoryAdapter()
        adapter.put(key, b'PK private archive contents', 'application/zip', '')
        storage = StorageService(adapter)
        with self.assertRaises(ValueError):
            storage.read_reference_bytes('/api/media/' + key)

    def test_unrelated_worker_poll_preserves_aged_selection_and_counters(self):
        actor = uuid.uuid4()
        clock = 1800000000000
        old = clock - 90 * 24 * 60 * 60_000
        generation = Generation.objects.create(kind='video', status='completed', prompt='audit',
            model='fixture', aspect_ratio='1:1', url='/api/media/audit/native.mov',
            created_at=old, updated_at=old)
        job = services.create_export(actor, old)
        services.append_items(job['id'], actor, [str(generation.id)], old)
        before = list(MediaExportItem.objects.filter(export_id=job['id']).values())
        self.assertIsNone(services.claim_export('unrelated-idle-worker', clock))
        retained = MediaExport.objects.get(pk=job['id'])
        self.assertEqual((retained.status, retained.total_items, retained.updated_at), ('draft', 1, old))
        self.assertEqual(list(MediaExportItem.objects.filter(export_id=job['id']).values()), before)

    def test_literal_display_name_cannot_alias_generated_entity_suffix(self):
        actor = uuid.uuid4()
        first = Project.objects.create(name='Alias', created_at=1, updated_at=1)
        second = Project.objects.create(name='alias', created_at=1, updated_at=1)
        derived = 'Alias_' + hashlib.sha256(str(first.id).encode()).hexdigest()[:12]
        third = Project.objects.create(name=derived, created_at=1, updated_at=1)
        generations = [Generation.objects.create(kind='video', status='completed', prompt='audit',
            model='fixture', aspect_ratio='1:1', url='/api/media/audit/native.mov',
            project=project, created_at=1, updated_at=1) for project in (first, second, third)]
        job = services.create_export(actor)
        services.append_items(job['id'], actor, [str(g.id) for g in generations])
        services.finalize_export(job['id'], actor)
        paths = list(MediaExportItem.objects.filter(export_id=job['id']).values_list('filename', flat=True))
        self.assertEqual(len(paths), 3)
        self.assertEqual(len({path.casefold() for path in paths}), 3)
        self.assertTrue(all(path.endswith('/Unsorted/unsorted_0001.mov') for path in paths))

    def test_temp_volume_exhaustion_never_publishes_or_discards_manifest(self):
        actor = uuid.uuid4()
        clock = 1800000000000
        generation = Generation.objects.create(kind='video', status='completed', prompt='audit',
            model='fixture', aspect_ratio='1:1', url='/api/media/audit/native.mov', created_at=1, updated_at=1)
        job = services.create_export(actor, clock)
        services.append_items(job['id'], actor, [str(generation.id)], clock)
        services.finalize_export(job['id'], actor, clock)
        before = list(MediaExportItem.objects.filter(export_id=job['id']).values())
        storage = StorageService(MemoryAdapter())
        with patch('apps.exports.worker.tempfile.TemporaryFile', side_effect=OSError(errno.ENOSPC, 'audit volume full')):
            result = run_once(storage=storage, clock=lambda: clock)
        self.assertEqual(result['completed'], 0)
        row = MediaExport.objects.get(pk=job['id'])
        self.assertEqual(row.status, 'queued')
        self.assertIsNone(row.output_key)
        self.assertEqual(list(MediaExportItem.objects.filter(export_id=job['id']).values()), before)
