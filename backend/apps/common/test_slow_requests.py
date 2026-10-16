from django.test import SimpleTestCase
from .wsgi import slow_request_application


class SlowRequestCapacityTests(SimpleTestCase):
    def test_stream_holds_capacity_until_close_and_health_bypasses_limit(self):
        calls, closed = [], []
        class Response:
            def __iter__(self): yield b'original-master'
            def close(self): closed.append(1)
        def app(env,start):
            calls.append(env['PATH_INFO']);start('200 OK',[]);return Response()
        handle=slow_request_application(app,slots=1)
        slow={'REQUEST_METHOD':'GET','PATH_INFO':'/api/media/master.mov','QUERY_STRING':'inline=1'}
        first=handle(slow,lambda *_:None)
        statuses=[]
        rejected=handle(slow,lambda status,headers:statuses.append((status,dict(headers))))
        self.assertEqual(list(rejected),[b'{"error":"SLOW_REQUEST_CAPACITY_BUSY"}'])
        self.assertEqual(statuses[0][0],'429 Too Many Requests')
        self.assertEqual(statuses[0][1]['Retry-After'],'1')
        self.assertEqual(len(calls),1)
        health=handle({'REQUEST_METHOD':'GET','PATH_INFO':'/api/health'},lambda *_:None)
        health.close()
        first.close();first.close()
        again=handle(slow,lambda *_:None)
        self.assertEqual(list(again),[b'original-master'])
        again.close()
        self.assertEqual(len(closed),3)

    def test_exception_before_response_and_during_stream_release_capacity(self):
        phase=['before']
        def stream():
            yield b'prefix'
            raise IOError('disconnected')
        def app(env,start):
            if phase[0]=='before':raise IOError('storage failed')
            return stream()
        handle=slow_request_application(app,slots=1)
        env={'REQUEST_METHOD':'POST','PATH_INFO':'/api/audio/transcribe'}
        with self.assertRaises(IOError):handle(env,lambda *_:None)
        phase[0]='stream'
        for _ in range(2):
            with self.assertRaises(IOError):list(handle(env,lambda *_:None))

    def test_every_slow_route_is_gated_and_head_direct_redirects_are_not(self):
        routes=[('POST','/api/audio/transcribe',''),('POST','/api/generate/upscale',''),
                ('POST','/api/generate/image',''),('POST','/api/generate/video',''),
                ('GET','/api/generate/upscale/status','id=paid-job'),
                ('PUT','/api/uploads/local',''),('GET','/api/media-grant',''),
                ('GET','/api/generations/id/download',''),('GET','/api/media/key','inline=1')]
        calls=[]
        def app(env,start):calls.append(1);return [b'ok']
        handle=slow_request_application(app,slots=1)
        hold=handle({'REQUEST_METHOD':'POST','PATH_INFO':'/api/audio/transcribe'},lambda *_:None)
        for method,path,query in routes:
            status=[]
            handle({'REQUEST_METHOD':method,'PATH_INFO':path,'QUERY_STRING':query},lambda s,h:status.append(s))
            self.assertEqual(status,['429 Too Many Requests'])
        self.assertEqual(len(calls),1)
        for method,path,query in [('HEAD','/api/generations/id/download',''),('GET','/api/media/key','')]:
            self.assertEqual(handle({'REQUEST_METHOD':method,'PATH_INFO':path,'QUERY_STRING':query},lambda *_:None),[b'ok'])
        hold.close()
