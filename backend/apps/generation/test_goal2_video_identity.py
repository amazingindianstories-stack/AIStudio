"""Distinct native MOV fixtures exercise job/receipt/callback/master identity.

Synthetic provider outputs deliberately carry the submitted input watermark.
This proves local mapping, not the cause of the reported production incident.
"""
from concurrent.futures import ThreadPoolExecutor
import hashlib
from pathlib import Path
import subprocess
import tempfile
from unittest.mock import patch
from uuid import uuid4

from django.db import connections
from django.test import TransactionTestCase

from apps.generation.models import Generation
from apps.generation.services import coordinator, poller, video_execution
from apps.generation.services.deadline import Cancellation
from apps.media import persistence
from apps.media.storage import MemoryAdapter, StorageService


class Goal2VideoIdentityTests(TransactionTestCase):
    def test_three_watermarked_sources_sequential_concurrent_out_of_order_duplicate_callbacks(self):
        with tempfile.TemporaryDirectory() as directory:
            sources = {}
            for index, color in enumerate(('red', 'green', 'blue')):
                path = Path(directory) / f'source-{index}.mov'
                subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
                    f'color=c={color}:s=64x64:d=0.2:r=10', '-vf',
                    f'drawbox=x={index * 12}:y=8:w=8:h=16:color=white:t=fill',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mov', str(path)], check=True)
                sources[f'/api/media/references/source-{index}.mov'] = path.read_bytes()
            self.assertEqual(len({hashlib.sha256(value).hexdigest() for value in sources.values()}), 3)
            adapter = MemoryAdapter()
            storage = StorageService(adapter)
            for concurrent in (False, True):
                jobs = [Generation.objects.create(id=uuid4(), kind='video', status='running',
                    model='Seedance 2.5', prompt='Use @vid1', aspect_ratio='1:1', resolution='1080p',
                    duration=5, reference_videos=[source], reference_images=[], user_id=uuid4(),
                    video_task_mode='edit', bitrate_mode='high', created_at=100, updated_at=200)
                    for source in sources]

                def submit(identifier):
                    try:
                        item = Generation.objects.get(pk=identifier)
                        deps = video_execution.Dependencies()
                        deps.assets = lambda _: []
                        deps.inline = lambda values, signal: values
                        deps.sign = lambda ref: ref
                        def provider(value, **kwargs):
                            self.assertEqual(value['referenceVideoUrls'], item.reference_videos)
                            return 'fixture-task-' + str(item.id)
                        deps.seedance_submit = provider
                        def receipt(task, index, count):
                            Generation.objects.filter(pk=item.id, task_id__isnull=True).update(task_id=task)
                        return video_execution.submit_video(item, signal=Cancellation(), on_task=receipt, dependencies=deps, env={})
                    finally:
                        if concurrent:
                            connections.close_all()

                if concurrent:
                    with ThreadPoolExecutor(max_workers=3) as pool:
                        outcomes = list(pool.map(submit, [item.id for item in jobs]))
                else:
                    outcomes = [submit(item.id) for item in jobs]
                self.assertEqual(len({value['task_id'] for value in outcomes}), 3)
                for item in jobs:
                    item.refresh_from_db()
                    self.assertEqual(coordinator.task_item(item.task_id).id, item.id)
                tasks = {item.task_id: item for item in jobs}
                def save(url, ext, identifier, metadata):
                    return persistence.save_buffer_with_metadata(sources[url], ext, identifier, metadata)
                deps = poller.Dependencies(mock=lambda: False, now=lambda: 10000, publish=lambda item: None,
                    pricing=lambda: [], save_url=save,
                    get_video=lambda task, **kwargs: {'status': 'succeeded', 'videoUrl': tasks[task].reference_videos[0], 'outputFormat': 'mov'})
                with patch.object(persistence, 'get_storage', return_value=storage):
                    # Callback order 3,1,2 followed by duplicate 1,3,2.
                    for index in (2, 0, 1, 0, 2, 1):
                        observed = coordinator.task_item(jobs[index].task_id)
                        self.assertEqual(poller.advance(observed, dependencies=deps)['kind'], 'succeeded')
                refreshed = [Generation.objects.get(pk=item.id) for item in jobs]
                self.assertEqual(len({item.url for item in refreshed}), 3)
                for item in refreshed:
                    self.assertIn(str(item.id), item.url)
                    original = sources[item.reference_videos[0]]
                    stored = storage.read_reference_bytes(item.url)['bytes']
                    self.assertEqual(hashlib.sha256(stored).digest(), hashlib.sha256(original).digest())
                    self.assertEqual(item.task_id, 'fixture-task-' + str(item.id))
