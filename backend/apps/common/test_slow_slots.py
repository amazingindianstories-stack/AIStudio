from django.test import SimpleTestCase
from .wsgi import slow_request_application, slow_request_slots


def held(handle, count, path='/api/generate/video'):
    return [handle({'REQUEST_METHOD': 'POST', 'PATH_INFO': path}, lambda *_: None) for _ in range(count)]


class SlowRequestSlotTests(SimpleTestCase):
    def test_slots_scale_with_threads_and_keep_ordinary_headroom(self):
        self.assertEqual(slow_request_slots(8), 4)
        self.assertEqual(slow_request_slots('8'), 4)
        self.assertEqual(slow_request_slots(4), 2)
        self.assertEqual(slow_request_slots(1), 2)
        self.assertEqual(slow_request_slots(8, '3'), 3)
        self.assertEqual(slow_request_slots(8, ''), 4)

    def test_default_application_admits_the_scaled_slot_count_of_eight_threads(self):
        calls = []
        def app(env, start):
            calls.append(1)
            start('200 OK', [])
            return iter([b'ok'])
        handle = slow_request_application(app, slots=slow_request_slots(8))
        responses = held(handle, 4)
        self.assertEqual(len(calls), 4)
        status = []
        handle({'REQUEST_METHOD': 'POST', 'PATH_INFO': '/api/generate/image'}, lambda s, h: status.append(s))
        self.assertEqual(status, ['429 Too Many Requests'])
        for response in responses:
            response.close()

    def test_signed_download_redirects_are_not_slow_but_ranged_or_plain_downloads_are(self):
        calls = []
        def app(env, start):
            calls.append(1)
            return [b'ok']
        handle = slow_request_application(app, slots=1)
        hold = held(handle, 1)[0]
        path = '/api/generations/abc/download'
        for query in ('signed=1', 'redirect=1'):
            self.assertEqual(handle({'REQUEST_METHOD': 'GET', 'PATH_INFO': path, 'QUERY_STRING': query}, lambda *_: None), [b'ok'])
        status = []
        for extra in ({'QUERY_STRING': ''}, {'QUERY_STRING': 'signed=1', 'HTTP_RANGE': 'bytes=0-9'}):
            handle({'REQUEST_METHOD': 'GET', 'PATH_INFO': path, **extra}, lambda s, h: status.append(s))
        self.assertEqual(status, ['429 Too Many Requests'] * 2)
        hold.close()
