import json
from unittest.mock import Mock, patch
from django.test import SimpleTestCase
from apps.generation.prompting.golden_fixtures import SEEDANCE_GOLDENS
from apps.generation.providers.seedance import video_task_payload,final_video_task_payload,create_video_task,create_final_video_task,get_video_task,normalize_video_task_payload,SeedanceError,friendly_error,tags_to_image_refs
from apps.integrations.transport import HttpResult


class SeedanceTests(SimpleTestCase):
    def test_multimodal_limit_rejects_before_paid_transport_without_dropping_sources(self):
        from apps.generation.services.enqueue import video_input, InvalidRequest
        for key in ('referenceVideoUrls','referenceAudioUrls'):
            transport=Mock()
            with self.subTest(key=key),self.assertRaises(SeedanceError):
                create_video_task({'modelDisplay':'Seedance 2.5','prompt':'Literal',key:['source']*11},transport=transport,env={'ARK_API_KEY':'mock'})
            transport.request.assert_not_called()
        for model in ('Seedance 2.5','seedance-25'):
            with self.subTest(model=model),self.assertRaises(InvalidRequest):
                video_input({'model':model,'prompt':'Literal','referenceAudios':['source']*11})
            with patch('apps.generation.services.enqueue.prompt_limit',return_value=30000):
                normalized=video_input({'model':model,'prompt':'Literal','referenceAudios':['source']*10})
            self.assertEqual(len(normalized['referenceAudios']),10)
        body=video_task_payload({'modelDisplay':'Seedance 2.5','prompt':'Literal','references':[{'dataUrl':str(i)} for i in range(30)],'referenceVideoUrls':[str(i) for i in range(10)],'referenceAudioUrls':[str(i) for i in range(10)]},{})
        self.assertEqual(len(body['content']),51)

    def test_submit_rejection_distinguishes_definitive_and_ambiguous_acceptance(self):
        for status,ambiguous in ((400,False),(429,False),(408,True),(500,True),(502,True)):
            with self.subTest(status=status):
                transport=Mock(request=Mock(return_value=HttpResult(status,b'{"error":{"message":"fixture"}}')))
                with self.assertRaises(SeedanceError) as caught:
                    create_video_task({'prompt':'Literal','modelDisplay':'Seedance 2.5'},transport=transport,env={'ARK_API_KEY':'mock'})
                self.assertIs(caught.exception.may_have_submitted,ambiguous)
                transport.request.assert_called_once()
        transport=Mock(request=Mock(return_value=HttpResult(200,b'{}')))
        with self.assertRaises(SeedanceError) as caught:
            create_video_task({'prompt':'Literal','modelDisplay':'Seedance 2.5'},transport=transport,env={'ARK_API_KEY':'mock'})
        self.assertTrue(caught.exception.may_have_submitted)

    def test_exact_node_request_goldens(self):
        for fixture in SEEDANCE_GOLDENS:
            with self.subTest(input=fixture['input']):
                builder=final_video_task_payload if fixture.get('final') else video_task_payload
                self.assertEqual(builder(fixture['input'],{}),fixture['output'])

    def test_all_25_modes_and_explicit_cost_controls(self):
        for mode in ('generate','edit','extend'):
            for draft in (False,True):
                body=video_task_payload({'modelDisplay':'Seedance 2.5','prompt':'Literal','taskMode':mode,
                    'referenceVideoUrls':['source'],'draftMode':draft,'bitrateMode':'standard','generateAudio':False,
                    'resolution':'480p','duration':5},{})
                self.assertEqual(body['output_format'],'mov')
                self.assertEqual(body['draft'],draft)
                self.assertEqual(body['bitrate_mode'],'standard')
                self.assertEqual(body['resolution'],'480p')
                self.assertFalse(body['generate_audio'])
        final=final_video_task_payload({'modelDisplay':'Seedance 2.5','draftTaskId':'draft','prompt':'ignored','seed':99},{})
        self.assertEqual(set(final),{'model','content','resolution','output_format'})
        self.assertEqual(video_task_payload({'modelDisplay':'seedance-25','prompt':'Literal'},{}).get('output_format'),'mov')

    def test_validation_precedes_billed_submission(self):
        cases=[({'modelDisplay':'Seedance 2.0','taskMode':'edit','referenceVideoUrls':['source']},'missing_source_video'),
               ({'modelDisplay':'Seedance 2.5','taskMode':'invalid'},'invalid_task_mode'),
               ({'modelDisplay':'Seedance 2.5','lastFrame':{'url':'last'}},'missing_first_frame'),
               ({'modelDisplay':'Seedance 2.5','taskMode':'edit','referenceVideoUrls':['source'],'firstFrame':{'url':'first'}},'invalid_frame_task'),
               ({'modelDisplay':'Seedance 2.0','references':[{'dataUrl':'x'}]*10},'too_many_reference_images')]
        transport=Mock()
        for fields,code in cases:
            with self.assertRaises(SeedanceError) as raised:
                create_video_task({'prompt':'Literal',**fields},transport=transport,env={'ARK_API_KEY':'mock'})
            self.assertEqual(raised.exception.code,code)
        transport.request.assert_not_called()

    def test_20_keeps_original_indices_25_submitted_order(self):
        refs=[{'tag':'@hero','index':7,'dataUrl':'ref'}]
        self.assertEqual(tags_to_image_refs('@hero stands. @heroine waits.',refs),'[image 7] stands. @heroine waits.')
        old=video_task_payload({'modelDisplay':'Seedance 2.0','prompt':'@hero stands.','references':refs},{})
        new=video_task_payload({'modelDisplay':'Seedance 2.5','prompt':'@hero stands.','references':refs},{})
        self.assertIn('[image 7] stands.',old['content'][0]['text'])
        self.assertIn('@Image 1 stands.',new['content'][0]['text'])

    def test_create_poll_and_failure_contract(self):
        transport=Mock();transport.request.return_value=HttpResult(200,b'{"data":{"id":"task"}}')
        self.assertEqual(create_video_task({'prompt':'Literal','modelDisplay':'Seedance 2.5'},transport=transport,env={'ARK_API_KEY':'mock'}),'task')
        self.assertEqual(transport.request.call_count,1)
        args=transport.request.call_args
        self.assertEqual(args.args[0],'POST')
        self.assertEqual(args.kwargs['headers']['Authorization'],'Bearer mock')
        transport.request.return_value=HttpResult(400,b'{"error":{"code":"SensitiveContent","message":"portrait"}}',{'x-tt-logid':'request'})
        with self.assertRaises(SeedanceError) as error:
            create_video_task({'prompt':'Literal','modelDisplay':'Seedance 2.5'},transport=transport,env={'ARK_API_KEY':'mock'})
        self.assertEqual(error.exception.code,'moderation')
        self.assertEqual(error.exception.provider_response['requestId'],'request')
        transport.request.return_value=HttpResult(200,b'{"status":"succeeded","content":{"video_url":"movie.mov"},"output_format":"mov","usage":{"total_tokens":123}}')
        result=get_video_task('task/slash',transport=transport,env={'ARK_API_KEY':'mock'})
        self.assertEqual(result['outputFormat'],'mov')
        self.assertEqual(result['totalTokens'],123)
        self.assertTrue(transport.request.call_args.args[1].endswith('task%2Fslash'))

    def test_unknown_delivery_never_resubmits(self):
        transport=Mock();transport.request.side_effect=TimeoutError('lost response')
        with self.assertRaises(TimeoutError):
            create_video_task({'prompt':'Literal','modelDisplay':'Seedance 2.5'},transport=transport,env={'ARK_API_KEY':'mock'})
        transport.request.assert_called_once()

    def test_callback_normalization_and_notfound_not_moderation(self):
        self.assertEqual(friendly_error(404,'{"error":{"code":"SensitiveContent","message":"portrait"}}').code,'seedance_error')
        result=normalize_video_task_payload({'data':{'state':'cancelled','error':{'message':'stopped'},'createdAt':123,'updated_at':456}})
        self.assertEqual(result['status'],'failed')
        self.assertEqual(result['error'],'stopped')
        self.assertEqual((result['providerCreatedAt'],result['providerUpdatedAt']),(123,456))
