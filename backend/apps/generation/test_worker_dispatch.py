"""Exercise the service loop against committed rows and independent DB connections."""
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
from uuid import uuid4
from unittest.mock import patch

from django.db import connections
from django.test import TransactionTestCase

from apps.common.leases import now_ms
from apps.generation import worker
from apps.generation.models import Generation
from apps.generation.services import admission, coordinator, executor


class RollingDispatcherTests(TransactionTestCase):
    def job(self, **extra):
        return Generation.objects.create(kind='image', status='queued', model='seedream-5-pro',
            prompt='fixture', aspect_ratio='1:1', user_id=uuid4(), created_at=now_ms(),
            updated_at=now_ms(), **extra)

    def video(self, **extra):
        values = {'kind': 'video', 'status': 'queued', 'model': 'Seedance 2.5', 'prompt': 'fixture',
                  'aspect_ratio': '16:9', 'user_id': uuid4(), 'created_at': now_ms(), 'updated_at': now_ms()}
        values.update(extra)
        return Generation.objects.create(**values)

    def test_late_seedance_draft_takes_the_first_freed_slot_ahead_of_an_image_backlog(self):
        images = [self.job() for _ in range(6)]
        release = {row.id: Event() for row in images}
        stop, busy, video_started = Event(), Event(), Event()
        started, late = [], {}
        lock = Lock()
        def process(identifier, *, owner, **kwargs):
            self.assertIsNotNone(coordinator.claim_generation(identifier, owner))
            with lock:
                started.append(identifier)
                if len(started) == 2:
                    busy.set()
            if identifier == late.get('id'):
                video_started.set()
            else:
                self.assertTrue(release[identifier].wait(5))
            Generation.objects.filter(pk=identifier).update(status='succeeded')
            coordinator.release_generation(identifier, owner)
            return {'kind': 'succeeded'}
        with patch.object(worker, 'process_generation', side_effect=process), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker.run_worker, concurrency=2, interval=.02, stop=stop)
            try:
                self.assertTrue(busy.wait(2))
                late['id'] = self.video(draft_mode=True).id
                release[started[0]].set()
                self.assertTrue(video_started.wait(2), 'the late video waited behind the image backlog')
                self.assertEqual(started[2], late['id'])
            finally:
                stop.set()
                for event in release.values():
                    event.set()
                future.result(timeout=5)

    def test_newly_due_job_uses_freed_slot_before_other_job_finishes(self):
        slow, quick = self.job(), self.job()
        slow_started, quick_started, release_quick, release_slow, late_started = (Event() for _ in range(5))
        stop = Event()
        seen = Counter()
        lock = Lock()
        def process(identifier, *, owner, **kwargs):
            with lock:
                seen[identifier] += 1
            row = coordinator.claim_generation(identifier, owner)
            self.assertIsNotNone(row)
            if identifier == slow.id:
                slow_started.set()
                self.assertTrue(release_slow.wait(5))
            elif identifier == quick.id:
                quick_started.set()
                self.assertTrue(release_quick.wait(5))
            else:
                late_started.set()
            Generation.objects.filter(pk=identifier).update(status='succeeded')
            coordinator.release_generation(identifier, owner)
            return {'kind': 'succeeded'}
        with patch.object(worker, 'process_generation', side_effect=process), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker.run_worker, concurrency=2, interval=.02, stop=stop)
            try:
                self.assertTrue(slow_started.wait(2))
                self.assertTrue(quick_started.wait(2))
                late = self.job(next_poll_at=now_ms() + 50)
                release_quick.set()
                self.assertTrue(late_started.wait(1), 'free slot waited for the old batch')
                self.assertFalse(release_slow.is_set())
            finally:
                stop.set()
                release_quick.set()
                release_slow.set()
                future.result(timeout=5)
        self.assertEqual(seen, Counter({slow.id: 1, quick.id: 1, late.id: 1}))

    def test_all_slots_run_in_parallel_and_shutdown_drains_without_new_claims(self):
        rows = [self.job() for _ in range(7)]
        stop, release, all_started = Event(), Event(), Event()
        seen, db_connections = [], set()
        lock = Lock()
        def process(identifier, *, owner, **kwargs):
            self.assertIsNotNone(coordinator.claim_generation(identifier, owner))
            with lock:
                seen.append(identifier)
                db_connections.add(id(connections['default'].connection))
                if len(seen) == 4:
                    all_started.set()
            self.assertTrue(release.wait(5))
            Generation.objects.filter(pk=identifier).update(status='succeeded')
            coordinator.release_generation(identifier, owner)
            return {'kind': 'succeeded'}
        with patch.object(worker, 'process_generation', side_effect=process), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker.run_worker, concurrency=4, interval=.02, stop=stop)
            try:
                self.assertTrue(all_started.wait(2))
                stop.set()
                self.assertFalse(future.done(), 'shutdown did not drain active jobs')
            finally:
                stop.set()
                release.set()
                future.result(timeout=5)
        self.assertEqual(len(seen), 4)
        self.assertEqual(len(set(seen)), 4)
        self.assertEqual(len(db_connections), 4)
        self.assertEqual(Generation.objects.filter(status='queued').count(), len(rows) - 4)

    def test_local_in_flight_exclusion_covers_the_submit_to_claim_gap(self):
        slow, quick = self.job(), self.job()
        started, release, quick_done, later_started, duplicate = (Event() for _ in range(5))
        stop = Event()
        seen = Counter()
        lock = Lock()
        def process(identifier, **kwargs):
            with lock:
                seen[identifier] += 1
                if seen[identifier] > 1:
                    duplicate.set()
            if identifier == slow.id:
                started.set()
                release.wait(5)  # Deliberately no DB lease yet.
            else:
                Generation.objects.filter(pk=identifier).update(status='succeeded')
                (quick_done if identifier == quick.id else later_started).set()
            return {'kind': 'pending'}
        with patch.object(worker, 'process_generation', side_effect=process), ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(worker.run_worker, concurrency=2, interval=.1, stop=stop)
            try:
                self.assertTrue(started.wait(2))
                self.assertTrue(quick_done.wait(2))
                later = self.job()
                self.assertTrue(later_started.wait(2))
                self.assertFalse(duplicate.is_set())
                self.assertEqual(seen[later.id], 1)
            finally:
                stop.set()
                release.set()
                future.result(timeout=5)

    def test_concurrent_claims_execute_provider_only_once(self):
        row = self.job()
        start = Barrier(4)
        provider_called, release = Event(), Event()
        calls = []
        lock = Lock()
        def image(item, **kwargs):
            with lock:
                calls.append(item.id)
            provider_called.set()
            release.wait(5)
            return {'status': 'succeeded', 'url': '/api/media/generations/fixture.png'}
        def execute():
            try:
                start.wait(timeout=3)
                return executor.process_generation(row.id, image_execute=image, heartbeat=False, env={})
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(execute) for _ in range(4)]
            try:
                self.assertTrue(provider_called.wait(2))
            finally:
                release.set()
                outcomes = [future.result(timeout=5)['kind'] for future in futures]
        self.assertEqual(calls, [row.id])
        self.assertEqual(outcomes.count('succeeded'), 1)

    def test_worker_reason_round_trips_to_card_and_clears_on_admission(self):
        from apps.generation.serialization import generation_item
        row = self.job()
        admission.show_worker_slot_wait(row.id)
        row.refresh_from_db()
        card = generation_item(row)
        self.assertEqual(card['providerStatus'], admission.WORKER_SLOT_WAITING)
        self.assertEqual(card['progressMessage'], 'Waiting for a free worker slot')
        admitted = admission.admit_job(row.id)
        self.assertEqual(admitted.status, 'running')
        self.assertIsNone(admitted.provider_status)
        self.assertIsNone(admitted.progress_message)

    def test_worker_reason_replaces_only_a_stale_slot_wait_and_does_not_label_blocked_rows(self):
        from apps.admin_dashboard.models import AppSetting
        stale = self.video(provider_status=admission.SLOT_WAITING, progress_message='Waiting for a free Seedance 2.5 slot')
        admission.show_worker_slot_wait(stale.id)
        stale.refresh_from_db()
        self.assertEqual((stale.provider_status, stale.progress_message),
                         (admission.WORKER_SLOT_WAITING, 'Waiting for a free worker slot'))
        portrait = self.job(provider_status='PORTRAIT_WAITING', progress_message='Existing reason')
        admission.show_worker_slot_wait(portrait.id)
        portrait.refresh_from_db()
        self.assertEqual((portrait.provider_status, portrait.progress_message), ('PORTRAIT_WAITING', 'Existing reason'))
        Generation.objects.filter(pk=stale.id).delete()
        for _ in range(admission.lane_capacity()):
            self.video(status='running')
        held = self.video(provider_status=admission.SLOT_WAITING, progress_message='Waiting for a free Seedance 2.5 slot')
        admission.show_worker_slot_wait(held.id)
        held.refresh_from_db()
        self.assertEqual((held.provider_status, held.progress_message),
                         (admission.SLOT_WAITING, 'Waiting for a free Seedance 2.5 slot'))
        AppSetting.objects.create(key='maxConcurrentJobs', value='1', updated_at=now_ms())
        row = self.job()
        Generation.objects.create(kind='image', status='running', model='seedream-5-pro', prompt='fixture',
            aspect_ratio='1:1', user_id=row.user_id, created_at=now_ms(), updated_at=now_ms())
        admission.show_worker_slot_wait(row.id)
        row.refresh_from_db()
        self.assertIsNone(row.provider_status)
