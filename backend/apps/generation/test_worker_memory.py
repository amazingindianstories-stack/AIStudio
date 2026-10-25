from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from django.test import SimpleTestCase
from apps.generation import worker


class WorkerMemoryTests(SimpleTestCase):
    def test_heap_is_trimmed_after_every_processed_job(self):
        with patch.object(worker, 'reap_stale_running_images'), \
                patch.object(worker, 'select_due_generations', return_value=[SimpleNamespace(id=i, model='Seedance 2.0') for i in range(3)]), \
                patch.object(worker, 'connections'), patch.object(worker, 'release_freed_memory') as trim:
            worker.run_once(concurrency=2, process=lambda identifier, **kwargs: {'kind': 'succeeded'})
        self.assertEqual(trim.call_count, 3)

    def test_trim_survives_a_missing_libc(self):
        with patch.object(worker.ctypes, 'CDLL', side_effect=OSError):
            worker.release_freed_memory()

    def test_image_caps_glibc_arenas(self):
        dockerfile = Path(__file__).resolve().parents[2] / 'Dockerfile'
        if not dockerfile.exists():
            self.skipTest('Dockerfile is not shipped inside the image')
        self.assertIn('ENV MALLOC_ARENA_MAX=2', dockerfile.read_text())
