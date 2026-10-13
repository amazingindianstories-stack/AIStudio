import threading
import time
from django.test import SimpleTestCase
from .services.deadline import with_queue_execution_deadline, QueueExecutionDeadlineError, QueueExecutionCapacityError


class DeadlineCapacityTests(SimpleTestCase):
    def test_timed_out_work_holds_capacity_until_actual_completion(self):
        capacity=threading.BoundedSemaphore(1)
        release=threading.Event()
        calls=[]
        def work(signal):
            calls.append(1)
            release.wait(2)
            return 'late output'
        try:
            with self.assertRaises(QueueExecutionDeadlineError):
                with_queue_execution_deadline(work,timeout_ms=20,_capacity=capacity)
            for _ in range(8):
                with self.assertRaises(QueueExecutionCapacityError):
                    with_queue_execution_deadline(work,timeout_ms=20,_capacity=capacity)
            self.assertEqual(calls,[1])
        finally:
            release.set()
        until=time.monotonic()+1
        while time.monotonic()<until:
            if capacity.acquire(blocking=False):
                capacity.release()
                break
            time.sleep(.005)
        else:self.fail('Capacity did not return after actual completion')
        self.assertEqual(with_queue_execution_deadline(lambda signal:'ok',timeout_ms=100,_capacity=capacity),'ok')

    def test_thread_construction_failure_restores_capacity(self):
        from unittest.mock import patch
        capacity=threading.BoundedSemaphore(1)
        with patch('apps.generation.services.deadline.threading.Thread',side_effect=RuntimeError('thread unavailable')):
            with self.assertRaises(RuntimeError):
                with_queue_execution_deadline(lambda signal:'unused',_capacity=capacity)
        self.assertTrue(capacity.acquire(blocking=False))
        capacity.release()
