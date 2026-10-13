import hashlib
import io
import tempfile
import uuid
import zipfile
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest.mock import patch
from django.db import connections, OperationalError
from django.test import TransactionTestCase, override_settings
from apps.admin_dashboard.tests import SettingsTests
from apps.generation.models import Generation
from apps.library.services.folder_engine import create_folder, rename_folder
from apps.media.storage import MemoryAdapter, StorageService, MediaObject, MediaNotFoundError
from .models import MediaExport, MediaExportItem
from . import services
from .worker import run_once, output_key


class ExportServicesTests(TransactionTestCase):
    def setUp(self):
        self.user = uuid.uuid4()
        self.clock = 1800000000000
        self.storage = StorageService(MemoryAdapter())

    def generation(self, **values):
        return Generation.objects.create(kind=values.pop('kind', 'image'), status='completed', prompt='fixture', model='fixture',
            aspect_ratio='1:1', url=values.pop('url', '/api/media/generated/source.png'), created_at=1, updated_at=1, **values)

    def queued(self, generations=None):
        generations = generations or [self.generation()]
        job = services.create_export(self.user, self.clock)
        services.append_items(job['id'], self.user, [str(g.id) for g in generations], self.clock)
        return services.finalize_export(job['id'], self.user, self.clock)

    def race(self, calls):
        barrier = Barrier(len(calls))
        def run(call):
            try:
                barrier.wait(timeout=10)
                try:
                    return call()
                except services.ExportError as exc:
                    return str(exc)
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=len(calls)) as pool:
            return list(pool.map(run, calls))

    def test_append_dedup_order_rejections_and_ownership(self):
        first, second = self.generation(), self.generation(kind='video', url='/api/media/generated/master.mov')
        external = self.generation(url='https://untrusted.example/master.png')
        audio = self.generation(kind='audio')
        job = services.create_export(self.user, self.clock)
        self.assertIsNone(services.owned_export(job['id'], uuid.uuid4()))
        missing = str(uuid.uuid4())
        result = services.append_items(job['id'], self.user, [str(second.id), str(second.id), str(external.id), missing, str(audio.id), None], self.clock)
        self.assertEqual(result, {'accepted': 1, 'totalItems': 1, 'rejected': [
            {'id': str(external.id), 'reason': 'not_downloadable'}, {'id': missing, 'reason': 'not_found'},
            {'id': str(audio.id), 'reason': 'not_downloadable'}]})
        added = services.append_items(job['id'], self.user, [str(first.id), str(second.id)], self.clock)
        self.assertEqual((added['accepted'], added['totalItems']), (1, 2))
        self.assertEqual(list(MediaExportItem.objects.filter(export_id=job['id']).order_by('position').values_list('generation_id', flat=True)), [second.id, first.id])
        with self.assertRaisesMessage(services.ExportError, 'EXPORT_NOT_FOUND'):
            services.append_items(job['id'], uuid.uuid4(), [str(first.id)])
        with self.assertRaisesMessage(services.ExportError, 'INVALID_EXPORT_ITEMS'):
            services.append_items(job['id'], self.user, [str(uuid.uuid4()) for _ in range(501)])

    def test_frozen_manifest_retry_hierarchy_rename_and_deleted_generation(self):
        folder = create_folder(name='Original')
        generation = self.generation(folder_id=folder['id'])
        job = self.queued([generation])
        item = MediaExportItem.objects.get(export=job)
        self.assertEqual((job.manifest_version, item.filename), (3, 'Global/Original/original_0001.png'))
        rename_folder(folder_id=folder['id'], name='Renamed')
        generation.delete()
        MediaExport.objects.filter(pk=job.id).update(status='failed', attempt_count=3)
        queued = services.finalize_export(job.id, self.user, self.clock + 10)
        item.refresh_from_db()
        self.assertEqual((queued.attempt_count, item.filename), (0, 'Global/Original/original_0001.png'))
        with self.assertRaisesMessage(services.ExportError, 'EXPORT_NOT_DRAFT'):
            services.append_items(job.id, self.user, [str(uuid.uuid4())])

    def test_collision_disambiguates_missing_sequence_deterministically(self):
        first, second = self.generation(), self.generation()
        from apps.library.models import GenerationNaming
        GenerationNaming.objects.filter(generation_id__in=[first.id, second.id]).delete()
        job = self.queued([first, second])
        paths = list(MediaExportItem.objects.filter(export=job).values_list('filename', flat=True))
        self.assertEqual(len(set(path.casefold() for path in paths)), 2)
        self.assertTrue(all(path.startswith('Global/Unsorted/unsorted_0001_') for path in paths))

    def test_concurrent_append_is_ordered_once_and_finalize_single_winner(self):
        generations = [self.generation() for _ in range(8)]
        job = services.create_export(self.user, self.clock)
        ids = [str(row.id) for row in generations]
        results = self.race([lambda: services.append_items(job['id'], self.user, ids)] * 5)
        self.assertEqual(sum(result['accepted'] for result in results), 8)
        self.assertEqual(sorted(MediaExportItem.objects.values_list('position', flat=True)), list(range(1, 9)))
        finals = self.race([lambda: services.finalize_export(job['id'], self.user)] * 2)
        self.assertEqual(sum(isinstance(value, MediaExport) for value in finals), 1)
        self.assertIn('EXPORT_NOT_FINALIZABLE', finals)

    def test_skip_locked_claims_single_job_and_fences_reclaimed_attempt(self):
        job = self.queued()
        results = self.race([lambda n=n: services.claim_export('owner' + str(n), self.clock) for n in range(6)])
        claimed = [result for result in results if result is not None]
        self.assertEqual(len(claimed), 1)
        first = claimed[0]
        later = self.clock + services.LEASE_MS + 1
        second = services.claim_export('new-owner', later)
        self.assertEqual(second.attempt_count, 2)
        self.assertFalse(services.heartbeat_export(job.id, first.lease_owner, now=later, attempt=1))
        self.assertFalse(services.complete_export(job.id, first.lease_owner, output_key='old.zip', output_bytes=1, now=later, attempt=1))
        self.assertFalse(services.fail_export(job.id, first.lease_owner, 'old', now=later, attempt=1))
        self.assertNotEqual(output_key(first), output_key(second))
        self.assertTrue(services.complete_export(job.id, second.lease_owner, output_key='new.zip', output_bytes=2, now=later, attempt=2))
        self.assertFalse(MediaExportItem.objects.filter(export=job).exists())
        self.assertFalse(services.complete_export(job.id, second.lease_owner, output_key='duplicate.zip', output_bytes=3, now=later, attempt=2))

    def test_crash_final_attempt_reaped_and_retention(self):
        job = self.queued()
        for attempt in range(3):
            claim = services.claim_export('worker', self.clock + attempt * 10)
            if attempt < 2:
                self.assertTrue(services.fail_export(claim.id, 'worker', 'retry', now=self.clock + attempt * 10 + 1, attempt=claim.attempt_count))
        self.assertIsNone(services.claim_export('reaper', self.clock + services.LEASE_MS + 21))
        job.refresh_from_db()
        self.assertEqual((job.status, job.attempt_count), ('failed', 3))
        self.assertIn('stopped', job.error)
        old = services.create_export(self.user, self.clock - 25 * 60 * 60_000)
        source = self.generation()
        services.append_items(old['id'], self.user, [str(source.id)], self.clock - 25 * 60 * 60_000)
        frozen = list(MediaExportItem.objects.filter(export_id=old['id']).values())
        services.claim_export('cleanup', self.clock)
        self.assertTrue(MediaExport.objects.filter(pk=old['id'], status='draft', total_items=1).exists())
        self.assertEqual(list(MediaExportItem.objects.filter(export_id=old['id']).values()), frozen)

    def test_zip_exact_entries_hashes_native_mov(self):
        png = b'\x89PNG\r\nfixture image bytes\x00'
        mov = b'\x00\x00\x00\x14ftypqt  native MOV 10-bit bytes\xff\xfe'
        self.storage.primary.put('generated/source.png', png, 'image/png', '')
        self.storage.primary.put('generated/master.mov', mov, 'video/quicktime', '')
        rows = [self.generation(), self.generation(kind='video', url='/api/media/generated/master.mov')]
        job = self.queued(rows)
        names = list(MediaExportItem.objects.filter(export=job).order_by('position').values_list('filename', flat=True))
        result = run_once(storage=self.storage, clock=lambda: self.clock)
        self.assertEqual(result, {'claimed': 1, 'completed': 1, 'entries': 2, 'skipped': 0})
        job.refresh_from_db()
        raw, mime = self.storage.primary.objects[job.output_key]
        self.assertEqual(mime, 'application/zip')
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(archive.namelist(), names[:2])
            self.assertEqual(archive.testzip(), None)
            for name, original in zip(names, [png, mov]):
                self.assertEqual(hashlib.sha256(archive.read(name)).digest(), hashlib.sha256(original).digest())
            self.assertTrue(archive.namelist()[1].endswith('.mov'))
        self.assertEqual(job.output_bytes, len(raw))
        self.assertEqual((job.processed_items, job.skipped_items, job.expires_at), (2, 0, self.clock + services.TTL_MS))
        self.assertEqual(job.warnings, [])
        self.assertEqual(services.cleanup_expired_archives(self.storage, self.clock + services.TTL_MS), 1)
        self.assertNotIn(job.output_key, self.storage.primary.objects)
        self.assertTrue(MediaExport.objects.filter(pk=job.id).exists())

    def test_corrupted_length_retry_then_terminal_preserves_manifest(self):
        job = self.queued()
        class Broken:
            def __iter__(self):
                yield b'bad'
            def close(self):
                pass
        with patch.object(self.storage, 'open', return_value=MediaObject(Broken(), 'image/png', 5)):
            for _ in range(3):
                self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 0)
        job.refresh_from_db()
        self.assertEqual((job.status, job.attempt_count), ('failed', 3))
        self.assertEqual(MediaExportItem.objects.filter(export=job).count(), 1)
        self.assertEqual(self.storage.primary.objects, {})

    def test_completion_commit_ack_loss_preserves_authoritative_archive(self):
        job = self.queued()
        self.storage.primary.put('generated/source.png', b'original', 'image/png', '')
        complete = services.complete_export

        def committed_without_ack(*args, **kwargs):
            self.assertTrue(complete(*args, **kwargs))
            raise RuntimeError('Completion commit acknowledgment lost')

        with patch('apps.exports.services.complete_export', side_effect=committed_without_ack):
            run_once(storage=self.storage, clock=lambda: self.clock)
        job.refresh_from_db()
        self.assertEqual(job.status, 'ready')
        self.assertIn(job.output_key, self.storage.primary.objects)
        raw = self.storage.primary.objects[job.output_key][0]
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            self.assertEqual(archive.read(archive.namelist()[0]), b'original')

    def test_zip64_lazy_source_and_bounded_stream_upload_preserve_hash(self):
        job = self.queued()
        name = MediaExportItem.objects.get(export=job).filename
        chunk = bytes(range(256)) * 64
        repetitions = 24
        expected_hash = hashlib.sha256()
        for _ in range(repetitions):
            expected_hash.update(chunk)
        state = {'source_chunks': 0, 'closed': False, 'read_sizes': []}

        class LazySource:
            def __iter__(self):
                for _ in range(repetitions):
                    state['source_chunks'] += 1
                    yield chunk
            def close(self):
                state['closed'] = True

        with tempfile.TemporaryFile(mode='w+b') as uploaded:
            class BoundedUploadAdapter(MemoryAdapter):
                def put_stream(adapter, key, stream, content_type, cache_control):
                    self.assertEqual(content_type, 'application/zip')
                    self.assertNotIsInstance(stream.stream, io.BytesIO)
                    self.assertEqual(state['source_chunks'], repetitions)
                    total = 0
                    while True:
                        requested = 64 * 1024
                        state['read_sizes'].append(requested)
                        data = stream.read(requested)
                        self.assertLessEqual(len(data), requested)
                        if not data:
                            break
                        uploaded.write(data)
                        total += len(data)
                    return total

            storage = StorageService(BoundedUploadAdapter())
            with patch.object(storage, 'open', return_value=MediaObject(LazySource(), 'image/png', len(chunk) * repetitions)), \
                 patch.object(zipfile, 'ZIP64_LIMIT', 64 * 1024):
                result = run_once(storage=storage, clock=lambda: self.clock)
                self.assertEqual(result['completed'], 1)
                uploaded.seek(0)
                with zipfile.ZipFile(uploaded) as archive:
                    self.assertEqual(archive.namelist(), [name])
                    info = archive.getinfo(name)
                    self.assertGreaterEqual(info.extract_version, 45)
                    self.assertEqual(int.from_bytes(info.extra[:2], 'little'), 1)  # ZIP64 field.
                    self.assertEqual(int.from_bytes(info.extra[2:4], 'little'), 16)
                    self.assertEqual(int.from_bytes(info.extra[4:12], 'little'), len(chunk) * repetitions)
                    self.assertEqual(int.from_bytes(info.extra[12:20], 'little'), len(chunk) * repetitions)
                    self.assertEqual(info.file_size, len(chunk) * repetitions)
                    actual_hash = hashlib.sha256()
                    with archive.open(name) as entry:
                        while data := entry.read(64 * 1024):
                            actual_hash.update(data)
                    self.assertEqual(actual_hash.digest(), expected_hash.digest())
            self.assertTrue(state['closed'])
            self.assertGreater(len(state['read_sizes']), 1)
            self.assertTrue(all(size == 64 * 1024 for size in state['read_sizes']))
            job.refresh_from_db()
            uploaded.seek(0, 2)
            self.assertEqual(job.output_bytes, uploaded.tell())

    def test_cleanup_ownership_query_failure_retains_uploaded_archive(self):
        job = self.queued()
        self.storage.primary.put('generated/source.png', b'original', 'image/png', '')
        with patch('apps.exports.services.complete_export', side_effect=OperationalError('synthetic completion failure')), \
             patch('django.db.models.query.QuerySet.exists', side_effect=OperationalError('synthetic ownership query failure')):
            result = run_once(storage=self.storage, clock=lambda: self.clock)
        self.assertEqual(result['completed'], 0)
        job.refresh_from_db()
        self.assertNotEqual(job.status, 'ready')
        archives = [key for key in self.storage.primary.objects if key.startswith('exports/')]
        self.assertEqual(len(archives), 1)
        with zipfile.ZipFile(io.BytesIO(self.storage.primary.objects[archives[0]][0])) as archive:
            self.assertEqual(archive.read(archive.namelist()[0]), b'original')

    def test_obsolete_upload_cannot_replace_winner_archive(self):
        job = self.queued()
        self.storage.primary.put('generated/source.png', b'original', 'image/png', '')
        real_upload = self.storage.upload_stream
        state = {'now': self.clock}
        winner_key = 'exports/winner.zip'
        def racing_upload(stream, key, **kwargs):
            uploaded = real_upload(stream, key, **kwargs)
            state['now'] += services.LEASE_MS + 1
            winner = services.claim_export('winner', state['now'])
            self.storage.primary.put(winner_key, b'winner bytes', 'application/zip', '')
            services.complete_export(winner.id, 'winner', output_key=winner_key, output_bytes=12, now=state['now'], attempt=winner.attempt_count)
            return uploaded
        with patch.object(self.storage, 'upload_stream', side_effect=racing_upload):
            result = run_once(storage=self.storage, clock=lambda: state['now'])
        self.assertEqual(result['completed'], 0)
        job.refresh_from_db()
        self.assertEqual((job.status, job.output_key), ('ready', winner_key))
        self.assertEqual(self.storage.primary.objects[winner_key][0], b'winner bytes')
        self.assertEqual(set(self.storage.primary.objects), {'generated/source.png', winner_key})

    def test_legacy_manifest_extension_once_and_unsafe_filename_rejection(self):
        self.storage.primary.put('generated/source.png', b'bytes', 'image/png', '')
        for filename in ('legacy', 'legacy.png'):
            job = self.queued()
            MediaExport.objects.filter(pk=job.id).update(manifest_version=1)
            MediaExportItem.objects.filter(export=job).update(filename=filename)
            self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 1)
            job.refresh_from_db()
            raw = self.storage.primary.objects[job.output_key][0]
            with zipfile.ZipFile(io.BytesIO(raw)) as archive:
                self.assertEqual(archive.namelist(), ['legacy.png'])
        bad = self.queued()
        MediaExportItem.objects.filter(export=bad).update(filename='../escape.png')
        self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 0)

    def test_partial_and_all_missing_never_publish_ready(self):
        for present in (False, True):
            with self.subTest(present=present):
                rows = [self.generation(url='/api/media/generated/missing.png')]
                if present:
                    self.storage.primary.put('generated/source.png', b'original', 'image/png', '')
                    rows.insert(0, self.generation())
                job = self.queued(rows)
                for _ in range(3):
                    self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 0)
                job.refresh_from_db()
                self.assertEqual(job.status, 'failed')
                self.assertIsNone(job.output_key)
                self.assertEqual(MediaExportItem.objects.filter(export=job).count(), len(rows))
                self.assertFalse(any(key.startswith('exports/') for key in self.storage.primary.objects))

    def test_v1_and_v2_failed_retry_mapping_never_changes(self):
        for version in (1, 2):
            job = self.queued()
            MediaExport.objects.filter(pk=job.id).update(status='failed', manifest_version=version)
            MediaExportItem.objects.filter(export=job).update(filename='Historical.mov', source_key='legacy/master.mov')
            retried = services.finalize_export(job.id, self.user, self.clock)
            item = MediaExportItem.objects.get(export=job)
            self.assertEqual((retried.manifest_version, item.filename, item.source_key), (version, 'Historical.mov', 'legacy/master.mov'))

    def test_many_items_dedup_batches_and_hashes(self):
        for count in (1, 50, 501):
            with self.subTest(count=count):
                generations = [self.generation() for _ in range(count)]
                job = services.create_export(self.user, self.clock)
                ids = [str(row.id) for row in generations]
                for start in range(0, count, 500):
                    services.append_items(job['id'], self.user, ids[start:start + 500], self.clock)
                services.append_items(job['id'], self.user, ids[:min(count, 500)], self.clock)
                queued = services.finalize_export(job['id'], self.user, self.clock)
                self.storage.primary.put('generated/source.png', b'native bytes', 'image/png', '')
                self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['entries'], count)
                queued.refresh_from_db()
                with zipfile.ZipFile(io.BytesIO(self.storage.primary.objects[queued.output_key][0])) as archive:
                    self.assertEqual(len(archive.namelist()), count)
                    self.assertEqual(len({name.casefold() for name in archive.namelist()}), count)
                    self.assertIsNone(archive.testzip())
                    self.assertTrue(all(archive.read(name) == b'native bytes' for name in archive.namelist()))

    def test_forbidden_timeout_and_interrupted_large_source_never_publish(self):
        for error, code in ((PermissionError('private key must stay internal'), 'source_forbidden'), (TimeoutError('timeout'), 'source_timeout')):
            job = self.queued()
            with patch.object(self.storage, 'open', side_effect=error):
                self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 0)
            job.refresh_from_db()
            self.assertEqual(job.warnings[0]['reason'], code)
            self.assertIsNone(job.output_key)
            # Finish this job so the next claim is the next scenario.
            MediaExport.objects.filter(id=job.id).update(status='failed', attempt_count=3)
        job = self.queued()
        class Interrupted:
            def __iter__(self):
                yield b'first bytes'
                raise IOError('source interrupted')
            def close(self):
                pass
        with patch.object(self.storage, 'open', return_value=MediaObject(Interrupted(), 'video/quicktime', 3 * 1024**3 + 1)):
            self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 0)
        job.refresh_from_db()
        self.assertIsNone(job.output_key)
        self.assertEqual(MediaExportItem.objects.filter(export=job).count(), 1)

    def test_zero_or_skipped_completion_rejected(self):
        job = self.queued()
        services.claim_export('worker', self.clock)
        for kwargs in ({'skipped_items': 1}, {'warnings': [{'reason': 'missing'}]}, {'output_bytes': 0}):
            args = {'output_key': 'invalid.zip', 'output_bytes': 1, 'now': self.clock}
            args.update(kwargs)
            with self.assertRaisesMessage(services.ExportError, 'EXPORT_INCOMPLETE'):
                services.complete_export(job.id, 'worker', **args)
        job.refresh_from_db()
        self.assertEqual(job.status, 'running')

    def test_private_upload_cannot_be_selected_by_other_actor(self):
        from django.utils import timezone
        from apps.media.models import UploadSession
        key = 'uploads/private/master.mov'
        UploadSession.objects.create(actor_id=uuid.uuid4(), key=key, purpose='video-reference', content_type='video/quicktime',
            byte_size=5, state='ready', finalized_at=timezone.now(), expires_at=timezone.now())
        g = self.generation(kind='video', url='/api/media/' + key)
        job = services.create_export(self.user, self.clock)
        result = services.append_items(job['id'], self.user, [str(g.id)], self.clock)
        self.assertEqual(result, {'accepted': 0, 'totalItems': 0, 'rejected': [{'id': str(g.id), 'reason': 'not_downloadable'}]})

    def test_missing_primary_reads_legacy_fallback_native_mov(self):
        g = self.generation(kind='video', url='/api/media/legacy/master.mov')
        job = self.queued([g])
        fallback = MemoryAdapter()
        native = b'\x00\x00\x00\x14ftypqt  legacy master\xff'
        fallback.put('legacy/master.mov', native, 'video/quicktime', '')
        storage = StorageService(MemoryAdapter(), fallback)
        self.assertEqual(run_once(storage=storage, clock=lambda: self.clock)['completed'], 1)
        job.refresh_from_db()
        with zipfile.ZipFile(io.BytesIO(storage.primary.objects[job.output_key][0])) as archive:
            self.assertTrue(archive.namelist()[0].endswith('.mov'))
            self.assertEqual(archive.read(archive.namelist()[0]), native)

    def test_same_length_corrupt_bytes_with_expected_sha256_fail(self):
        job = self.queued()
        media = MediaObject(io.BytesIO(b'wrong'), 'image/png', 5)
        media.sha256 = hashlib.sha256(b'right').hexdigest()
        with patch.object(self.storage, 'open', return_value=media):
            self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], 0)
        job.refresh_from_db()
        self.assertIsNone(job.output_key)
        self.assertIn('SHA256', job.error)

    def test_expected_crc32c_matches_and_rejects_same_length_corruption(self):
        import base64
        import google_crc32c
        checksum = google_crc32c.Checksum(b'right')
        expected = base64.b64encode(checksum.digest()).decode()
        for body, completed in ((b'right', 1), (b'wrong', 0)):
            job = self.queued()
            media = MediaObject(io.BytesIO(body), 'image/png', len(body))
            media.crc32c = expected
            with patch.object(self.storage, 'open', return_value=media):
                self.assertEqual(run_once(storage=self.storage, clock=lambda: self.clock)['completed'], completed)
            job.refresh_from_db()
            if not completed:
                self.assertIn('CRC32C', job.error)
                self.assertIsNone(job.output_key)
