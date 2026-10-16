import threading
import time
from unittest.mock import Mock, patch
from django.test import SimpleTestCase
from .dns import BoundedMediaResolver, MediaDNSCapacityError
from .remote import SafeMediaFetcher, UnsafeMediaURL


class MediaDNSTests(SimpleTestCase):
    def test_timeout_retains_capacity_until_actual_completion_and_never_connects(self):
        dns = BoundedMediaResolver(slots=1)
        entered,release = threading.Event(),threading.Event()
        threads = []
        def lookup(*args,**kwargs):
            threads.append(threading.current_thread())
            entered.set()
            release.wait(2)
            return [(2,1,6,'',('93.184.216.34',443))]
        connect = Mock()
        fetch = SafeMediaFetcher(['media.example'],resolver=lookup,connection=connect,dns=dns,total_timeout=.03)
        began = time.monotonic()
        try:
            with self.assertRaisesRegex(TimeoutError,'DNS deadline'):
                fetch('https://media.example/a.mov')
            self.assertTrue(entered.is_set())
            self.assertLess(time.monotonic()-began,.5)
            with self.assertRaises(MediaDNSCapacityError):
                fetch('https://media.example/a.mov')
            self.assertEqual(len(threads),1)
            connect.assert_not_called()
        finally:
            release.set()
            for thread in threads:
                thread.join(1)
                self.assertFalse(thread.is_alive())
        self.assertTrue(dns.capacity.acquire(blocking=False))
        dns.capacity.release()
        connect.assert_not_called()

    def test_late_dns_budget_and_private_addresses_are_rejected_before_connect(self):
        for address,expired,error in [('93.184.216.34',True,TimeoutError),('127.0.0.1',False,UnsafeMediaURL)]:
            with self.subTest(address=address):
                clock = [0.0]
                def lookup(*args,**kwargs):
                    if expired:clock[0]=2.0
                    return [(2,1,6,'',(address,443))]
                connect = Mock()
                fetch = SafeMediaFetcher(['media.example'],resolver=lookup,connection=connect,
                    total_timeout=1,clock=lambda:clock[0],dns=BoundedMediaResolver())
                with self.assertRaises(error):fetch('https://media.example/a.mov')
                connect.assert_not_called()

    def test_thread_start_failure_restores_capacity(self):
        dns = BoundedMediaResolver(slots=1)
        for target in ('apps.media.dns.threading.Thread','apps.media.dns.threading.Thread.start'):
            with self.subTest(target=target), patch(target,side_effect=RuntimeError('fixture start failure')):
                with self.assertRaises(RuntimeError):dns.resolve(Mock(),timeout=.1)
            self.assertTrue(dns.capacity.acquire(blocking=False))
            dns.capacity.release()
