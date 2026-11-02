import base64
import hashlib
import io
import json
from unittest.mock import Mock
from django.test import SimpleTestCase
from apps.generation.prompting.golden_fixtures import GOLDENS
from apps.generation.prompting.shot_spec import build_cast_policy,build_shot_instruction,parse_ref_roles
from apps.generation.prompting.video_directive import build_video_directive
from apps.generation.prompting.assembler import assemble_prompt
from apps.generation.prompting.image_prep import prep_reference,analyze_identity_reference,detect_reference_role
from apps.generation.prompting.face_judge import judge_candidate,select_best_candidate
from apps.integrations.transport import HttpResult


def digest(value):
    raw=value if isinstance(value,str) else json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))
    return hashlib.sha256(raw.encode()).hexdigest()


class PromptingTests(SimpleTestCase):
    def test_unsupported_crispen_mime_preserves_input_without_native_work(self):
        import sys
        from unittest.mock import patch
        from apps.generation.prompting.image_prep import crispen
        native=Mock()
        original='original opaque input'
        with patch.dict(sys.modules,{'pyvips':native}),patch('apps.generation.prompting.image_prep.base64.b64decode') as decode:
            self.assertEqual(crispen('image/gif',original),{'mimeType':'image/gif','data':original})
        decode.assert_not_called()
        native.Image.new_from_buffer.assert_not_called()


    def test_supported_crispen_retains_native_derivative_and_original_on_failure(self):
        import sys
        from unittest.mock import patch
        from apps.generation.prompting.image_prep import crispen
        native=Mock()
        native.Image.new_from_buffer.return_value.sharpen.return_value.write_to_buffer.return_value=b'derivative'
        data=base64.b64encode(b'original').decode()
        with patch.dict(sys.modules,{'pyvips':native}):
            result=crispen('image/png',data)
            self.assertEqual(base64.b64decode(result['data']),b'derivative')
            native.Image.new_from_buffer.assert_called_once_with(b'original','')
            native.Image.new_from_buffer.side_effect=RuntimeError('offline native failure')
            self.assertEqual(crispen('image/png',data),{'mimeType':'image/png','data':data})

    def test_node_golden_video_texts(self):
        for fixture in GOLDENS['video']:
            with self.subTest(input=fixture['input']):
                self.assertEqual(digest(build_video_directive(fixture['input'])),fixture['sha256'])

    def test_node_golden_shot_and_cast_texts(self):
        for fixture in GOLDENS['shot']:
            with self.subTest(input=fixture['input']):
                self.assertEqual(digest(build_shot_instruction(fixture['input'])),fixture['sha256'])
        for fixture in GOLDENS['cast']:
            self.assertEqual(build_cast_policy(fixture['prompt']),fixture['output'])

    def test_node_golden_reference_assembler(self):
        for fixture in GOLDENS['assembler']:
            source=fixture['input']
            result=assemble_prompt(source['prompt'],[],source['uploads'],{'aspectRatio':'16:9'},
                read_image=lambda ref:{'mimeType':'image/png','data':ref},
                prep_reference=lambda mime,data:{'mimeType':mime,'data':data},
                analyze_identity=lambda *args:{'personReference':None,'crops':[]},detect_role=lambda *args:None,
                env={'PROMPT_SHOT_SPEC':'1' if source['shot'] else '0'})
            with self.subTest(input=source):
                self.assertEqual(digest(result),fixture['sha256'])
                self.assertEqual(result['instruction'],source['prompt'])

    def test_mixed_untagged_batch_retains_subject_and_style_roles(self):
        result=assemble_prompt('A woman turns.',[],['face','style'],{'medium':'video'},
            read_image=lambda ref:{'mimeType':'image/png','data':ref},prep_reference=lambda m,d:{'mimeType':m,'data':d},
            analyze_identity=lambda m,d,*a:{'personReference':d=='face','crops':[]},detect_role=lambda *a:'style',
            env={'PROMPT_SHOT_SPEC':'1'})
        self.assertEqual([(g['tag'],g['identity']) for g in result['groups']],[('SUBJECT',True),('REFERENCE-STYLE',False)])
        self.assertEqual([i['data'] for i in result['groups'][0]['images']],['face'])
        self.assertIn('style or grade drift',result['shotInstruction'])

    def board_assembly(self,uploads,analysis,opts=None):
        return assemble_prompt('a cat',[],uploads,opts or {'aspectRatio':'1:1','referenceUse':'board'},
            read_image=lambda ref:{'mimeType':'image/png','data':ref},prep_reference=lambda m,d:{'mimeType':m,'data':d},
            analyze_identity=lambda m,d,*a:analysis[d],detect_role=lambda *a:None,env={})

    def test_board_reference_without_a_person_is_context_not_an_identity_to_reproduce(self):
        from apps.generation.providers.gemini import build_parts
        analysis={'landscape':{'personReference':False,'crops':[]}}
        result=self.board_assembly(['landscape'],analysis)
        self.assertEqual([(g['tag'],g['identity']) for g in result['groups']],[('REFERENCE',False)])
        texts=[part['text'] for part in build_parts(result) if 'text' in part]
        self.assertEqual(len(texts),3)
        self.assertTrue(texts[0].startswith('REFERENCE IMAGE (1 image from the board)'))
        self.assertEqual(texts[1],'SCENE: a cat')
        self.assertNotIn('person',' '.join(texts[:2]).lower().replace('no person',''))
        self.assertFalse(any('FINAL CHECK' in text or 'exact same individual' in text for text in texts))

    def test_board_reference_showing_or_possibly_showing_a_person_keeps_the_identity_lock(self):
        for analysis in ({'personReference':True,'crops':[]},{'personReference':None,'crops':[]}):
            with self.subTest(analysis=analysis):
                result=self.board_assembly(['face'],{'face':analysis})
                self.assertEqual([(g['tag'],g['identity']) for g in result['groups']],[('SUBJECT',True)])
        mixed=self.board_assembly(['landscape','face'],{'landscape':{'personReference':False,'crops':[]},'face':{'personReference':True,'crops':[]}})
        self.assertEqual([(g['tag'],g['identity']) for g in mixed['groups']],[('SUBJECT',True)])

    def test_board_references_are_each_analysed_once_and_a_person_in_any_position_keeps_the_identity_lock(self):
        calls=[]
        analysis={'street':{'personReference':False,'crops':[]},'alley':{'personReference':False,'crops':[]},
                  'actor':{'personReference':True,'crops':[{'mimeType':'image/jpeg','data':'face-tile'}]},'rooftop':{'personReference':None,'crops':[]}}
        def analyze(mime,data,*args):
            calls.append(data)
            return analysis[data]
        result=assemble_prompt('the actor standing in this street',[],['street','alley','actor'],{'aspectRatio':'1:1','referenceUse':'board'},
            read_image=lambda ref:{'mimeType':'image/png','data':ref},prep_reference=lambda m,d:{'mimeType':m,'data':d},
            analyze_identity=analyze,detect_role=lambda *a:None,env={})
        self.assertEqual([(g['tag'],g['identity']) for g in result['groups']],[('SUBJECT',True)])
        self.assertEqual([t['data'] for t in result['groups'][0]['tiles']],['face-tile'])
        self.assertEqual(calls,['street','alley','actor'])
        for uploads in (['face'],['street','alley','street','rooftop']):
            with self.subTest(uploads=uploads):
                calls.clear()
                failed={'face':{'personReference':None,'crops':[]},**analysis}
                result=assemble_prompt('a cat',[],uploads,{'aspectRatio':'1:1','referenceUse':'board'},
                    read_image=lambda ref:{'mimeType':'image/png','data':ref},prep_reference=lambda m,d:{'mimeType':m,'data':d},
                    analyze_identity=lambda m,d,*a:calls.append(d) or failed[d],detect_role=lambda *a:None,env={})
                self.assertEqual([(g['tag'],g['identity']) for g in result['groups']],[('SUBJECT',True)])
                self.assertNotIn('tiles',result['groups'][0])
                self.assertEqual(calls,uploads)

    def test_the_library_keeps_the_identity_lock_for_the_same_reference(self):
        result=self.board_assembly(['landscape'],{'landscape':{'personReference':False,'crops':[]}},{'aspectRatio':'1:1'})
        self.assertEqual([(g['tag'],g['identity']) for g in result['groups']],[('SUBJECT',True)])

    def test_preprocessing_caps_reference_but_preserves_small_original(self):
        from PIL import Image
        for size in [(100,200),(4096,2048)]:
            raw=io.BytesIO();Image.new('RGB',size).save(raw,format='PNG')
            encoded=base64.b64encode(raw.getvalue()).decode()
            result=prep_reference('image/png',encoded)
            if size[0] == 100:
                self.assertEqual(result,{'mimeType':'image/png','data':encoded})
            else:
                with Image.open(io.BytesIO(base64.b64decode(result['data']))) as image:
                    self.assertEqual(image.size,(2048,1024))

    def test_identity_detection_retry_crop_and_payload(self):
        from PIL import Image
        raw=io.BytesIO();Image.new('RGB',(1000,1000)).save(raw,format='PNG')
        content={'person_reference':True,'face_box_2d':[200,200,400,400],'panel_boxes':None}
        result=HttpResult(200,json.dumps({'candidates':[{'content':{'parts':[{'text':json.dumps(content)}]}}]}).encode())
        transport=Mock();transport.request.side_effect=[HttpResult(429,b'{}'),result]
        wait=Mock()
        value=analyze_identity_reference('image/png',base64.b64encode(raw.getvalue()).decode(),
            env={'GOOGLE_API_KEY':'mock'},transport=transport,wait=wait)
        self.assertTrue(value['personReference'])
        self.assertEqual(len(value['crops']),1)
        wait.assert_called_once_with(1500)
        self.assertEqual(transport.request.call_args.kwargs['body']['generationConfig']['thinkingConfig'],{'thinkingBudget':0})
        with Image.open(io.BytesIO(base64.b64decode(value['crops'][0]['data']))) as image:
            self.assertEqual(image.size,(380,380))

    def test_judge_score_clamp_and_identity_floor(self):
        transport=Mock();transport.request.return_value=HttpResult(200,json.dumps({'candidates':[{'content':{'parts':[{'text':'{"identity":120,"prominence":40,"sharpness":-4}'}]}}]}).encode())
        ref={'mimeType':'image/png','data':'YQ=='}
        self.assertEqual(judge_candidate(ref,ref,env={'GOOGLE_API_KEY':'mock'},transport=transport),{'identity':100,'prominence':40,'sharpness':0})
        scores=[{'identity':90,'prominence':10,'sharpness':10},{'identity':81,'prominence':100,'sharpness':100},{'identity':85,'prominence':50,'sharpness':50}]
        self.assertEqual(select_best_candidate(scores),2)
        self.assertEqual(select_best_candidate([None,None]),0)
