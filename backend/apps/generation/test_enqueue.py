from testsupport.frozen_oracle import run as oracle_run
import base64
import io
import json
import random
import subprocess
import uuid
from pathlib import Path
from unittest.mock import patch
from PIL import Image
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from apps.admin_dashboard import tests as session_fixtures
from apps.admin_dashboard.models import AppSetting, Pricing, UserLimit
from apps.assets.models import Asset
from apps.common.models import ActivityLog
from apps.library.models import GenerationNaming
from apps.media.storage import StorageService, MemoryAdapter
from .models import Generation
from .services import enqueue, upscale_validation as validation, seedream_references as references


def picture(width=64,height=64,format='PNG'):
    output = io.BytesIO()
    Image.new('RGB',(width,height),(70,90,120)).save(output,format=format)
    return output.getvalue()


def data_url(data=None,mime='image/png'):
    return f'data:{mime};base64,'+base64.b64encode(data or picture()).decode()


def node(script, values):
    result = oracle_run(['node','--import','tsx','--input-type=module','-e',script],input=json.dumps(values),
        text=True,capture_output=True,cwd=Path(__file__).resolve().parents[3])
    if result.returncode: raise AssertionError(result.stderr)
    return json.loads(result.stdout)


class EnqueueOracleTests(SimpleTestCase):
    def test_seedream_empty_references_need_no_native_runtime_or_io(self):
        import sys
        from unittest.mock import Mock
        reader,upload,sign=Mock(),Mock(),Mock()
        with patch.dict(sys.modules,{'pyvips':None}):
            self.assertEqual(references.prepare_seedream_references([],'id',read=reader,upload=upload,sign_ref=sign),
                             {'stable':[],'urls':[]})
        reader.assert_not_called()
        upload.assert_not_called()
        sign.assert_not_called()

    def test_seedream_missing_runtime_rejects_before_reference_read(self):
        import sys
        from unittest.mock import Mock
        reader,upload,sign=Mock(return_value={'bytes':b'original'}),Mock(),Mock()
        with patch.dict(sys.modules,{'pyvips':None}):
            with self.assertRaisesRegex(ValueError,'native image runtime'):
                references.prepare_seedream_references(['/api/media/assets/original.png'],'id',
                    read=reader,upload=upload,sign_ref=sign)
        reader.assert_not_called()
        upload.assert_not_called()
        sign.assert_not_called()


    def test_seedream_missing_native_runtime_rejects_before_pillow_decode(self):
        import sys
        with patch.dict(sys.modules,{'pyvips':None}),patch.object(Image,'open') as decode:
            with self.assertRaisesRegex(ValueError,'native image runtime'):
                references.normalize_seedream_reference(b'original source')
        decode.assert_not_called()


    def test_seedream_byte_reader_avoids_base64_and_supports_injected_legacy_reader(self):
        data = picture()
        store = StorageService(MemoryAdapter())
        ref = store.upload_buffer(data,'assets/original.png','png')
        with override_settings(VEEVEE_MEDIA_STORAGE=store), patch.object(store,'read_as_base64',side_effect=AssertionError('must use bytes')), patch.object(
                references,'normalize_seedream_reference',side_effect=lambda raw:{'bytes':raw,'ext':'png','changed':False}) as normalize, patch.object(store,'upload_buffer') as upload:
            self.assertEqual(references.prepare_seedream_references([ref],'fixture',sign=False),{'stable':[ref],'urls':[]})
            normalize.assert_called_once_with(data)
            upload.assert_not_called()
            normalize.reset_mock()
            result = references.prepare_seedream_references([ref],'fixture',sign=False,
                read=lambda source:{'mimeType':'image/png','data':base64.b64encode(data).decode()})
            self.assertEqual(result,{'stable':[ref],'urls':[]})
            normalize.assert_called_once_with(data)

    def test_video_validation_and_controls_match_current_node_route(self):
        cases = [dict(prompt='test',model=model,resolution=resolution,duration=duration) for model in
            ['Seedance 2.5','Seedance 2.0','Gemini Omni Flash','Higgsfield Seedance 2.0','unknown']
            for resolution in ['480p','720p','1080p','bad'] for duration in [4,5,30,'5']]
        cases += [dict(prompt='test',model='Seedance 2.5',**extra) for extra in [
            {'draftMode':True},{'draftMode':True,'resolution':'480p'}, {'bitrateMode':None}, {'bitrateMode':'standard'},
            {'videoTaskMode':'edit'},{'videoTaskMode':'extend','referenceVideos':['uploads/a.mov']},
            {'videoTaskMode':'edit','referenceVideos':['uploads/a.mov'],'firstFrame':'/api/media/a.png'},
            {'lastFrame':'/api/media/a.png'}, {'referenceImages':['a']*31},{'referenceVideos':['a']*11},
            {'firstFrame':'x','lastFrame':'y'}, {'seed':42,'generateAudio':True}, {'seed':True},
            {'referenceAudios':['a']*12}, {'videoTaskMode':'edit','referenceVideos':['a']}, {'duration':0},
        ]]
        script = r"""
import fs from 'node:fs';import * as config from './src/lib/config.js';
import {isOmniModel} from './src/lib/providers/omni.js';
import {resolveSeedanceRenderControls} from './src/lib/seedance-render-controls.js';
const source=fs.readFileSync('src/app/api/generate/video/route.js','utf8').replace(/^import[\s\S]*?;\n/gm,'').replace(/export /g,'');
let s='';for await(const c of process.stdin)s+=c;
const keys=['prompt','model','aspectRatio','resolution','duration','generateAudio','draftMode','bitrateMode','videoTaskMode','seed','referenceVideos','referenceAudios'];
const deps={...Object.fromEntries(Object.entries(config).filter(([k])=>k!=='default'&&k!=='module.exports')),isOmniModel,resolveSeedanceRenderControls,getSession:async()=>null,readEffectiveLimit:async()=>30000,
NextResponse:{json:(body,options)=>({status:options?.status??200,body})},readPricing:async()=>[],computeCostCents:()=>0,
saveReferenceImages:async v=>v,upsertItem:async()=>{},logActivity:async()=>{}};
const fn=new (Object.getPrototypeOf(async()=>{}).constructor)(...Object.keys(deps),'input',source+';return POST({json:async()=>input})');
const results=[];for(const value of JSON.parse(s)){try{const r=await fn(...Object.values(deps),value);results.push(r.status===200?{status:200,body:Object.fromEntries(keys.filter(k=>r.body[k]!==undefined).map(k=>[k,r.body[k]]))}:r)}catch{results.push({status:500})}}console.log(JSON.stringify(results));
"""
        expected = node(script,cases)
        keys = ['prompt','model','aspectRatio','resolution','duration','generateAudio','draftMode','bitrateMode','videoTaskMode','seed','referenceVideos','referenceAudios']
        with patch('apps.generation.services.enqueue.prompt_limit',return_value=30000):
            for value, oracle in zip(cases,expected):
                try:
                    item = enqueue.video_input(value)
                    actual = {'status':200,'body':{key:item[key] for key in keys if key in item}}
                except enqueue.InvalidRequest as error: actual={'status':400,'body':{'error':str(error)}}
                except Exception: actual={'status':500}
                with self.subTest(value=value):
                    if value.get('model') == 'Gemini Omni Flash':
                        # Retired 2026-10-18 (Google shuts the preview down 2026-10-22): refused before anything else.
                        self.assertEqual(actual,{'status':400,'body':{'error':'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.'}})
                    elif len(value.get('referenceAudios',[])) > 10:
                        # Preserve the inert historical oracle: it proves the old
                        # silent source loss. Goal3 intentionally rejects before cost.
                        self.assertEqual(oracle['status'],200)
                        self.assertEqual(len(oracle['body']['referenceAudios']),10)
                        self.assertEqual(actual,{'status':400,'body':{'error':'Seedance 2.5 accepts at most 10 reference audio clips (got 12).'}})
                    else:
                        self.assertEqual(actual,oracle)

    def test_magnific_parameter_validation_matches_node(self):
        base = dict(model='Magnific Creative',image='/api/media/a.png',params=dict(scaleFactor='2x',optimizedFor='standard',engine='automatic',creativity=0,hdr=0,resemblance=0,fractality=0))
        cases = [base,{},dict(base,model='unknown'),dict(base,image=''),dict(base,projectId='bad')]
        for key in ['scaleFactor','optimizedFor','engine','creativity','hdr','resemblance','fractality','filterNsfw','prompt','extra']:
            for value in [None,True,'2x',11,[],{}]: cases.append({**base,'params':{**base['params'],key:value}})
        for model in ['Magnific Precision V1','Magnific Precision V2']:
            params=dict(sharpen=5,smartGrain=7,ultraDetail=9)
            if model.endswith('V2'): params.update(scaleFactor='4x',flavor='photo')
            cases.extend([dict(model=model,image='data:a',params=params),dict(model=model,image='data:a',params={**params,'sharpen':'5'})])
        script="import {validateUpscaleRequest} from './src/lib/magnific-validation.js';let s='';for await(const c of process.stdin)s+=c;console.log(JSON.stringify(JSON.parse(s).map(x=>{try{return {value:validateUpscaleRequest(x)}}catch(e){return {error:e.message}}})));"
        for value,oracle in zip(cases,node(script,cases)):
            try: actual={'value':validation.validate_upscale_request(value)}
            except Exception as error: actual={'error':str(error)}
            with self.subTest(value=value): self.assertEqual(actual,oracle)

    def test_original_reference_bytes_dimension_corruption_animation_and_limits(self):
        data = picture()
        normalized = references.normalize_seedream_reference(data)
        self.assertEqual(normalized,{'bytes':data,'ext':'png','changed':False})
        for bad in [b'garbage',data[:40],picture(14,30),picture(16,300)]:
            with self.assertRaises(ValueError): references.normalize_seedream_reference(bad)
        output = io.BytesIO()
        Image.new('RGB',(30,30),'red').save(output,format='GIF',save_all=True,append_images=[Image.new('RGB',(30,30),'blue')])
        with self.assertRaisesRegex(ValueError,'animated'): references.normalize_seedream_reference(output.getvalue())
        with patch.object(references,'MAX_PIXELS',1024):
            changed = references.normalize_seedream_reference(data)
        self.assertTrue(changed['changed'])
        self.assertEqual(Image.open(io.BytesIO(changed['bytes'])).size,(32,32))
        # Same bounds/errors as the authoritative Sharp implementation.
        # Compare the exact historical bytes. Re-encoding the same pixels with
        # different platform libpng/GIF versions changes input hashes even when
        # behavior is identical; generated local-image checks remain above.
        from testsupport.frozen_oracle import DIRECTORY
        fixture=json.loads((DIRECTORY/'18e42cc0a25f2e1aada082e38f9298b0dbaee6f263e6ab4a5238481a29d4d24a.json').read_text())
        values=json.loads(fixture['request']['input'])
        script="import {normalizeSeedreamReference} from './src/lib/seedream-reference.js';let s='';for await(const c of process.stdin)s+=c;const r=[];for(const v of JSON.parse(s)){try{const n=await normalizeSeedreamReference(Buffer.from(v,'base64'));r.push({ext:n.ext,changed:n.changed})}catch(e){r.push({error:e.message})}}console.log(JSON.stringify(r));"
        for value,oracle in zip(values,node(script,values)):
            try:
                actual=references.normalize_seedream_reference(base64.b64decode(value));actual={key:actual[key] for key in ['ext','changed']}
            except ValueError as error: actual={'error':str(error)}
            self.assertEqual(actual,oracle)

    def test_upscale_source_and_image_type_boundaries(self):
        for good in ['/api/media/a.png','https://app.invalid/api/media/a.png','data:image/png;base64,AA==']:
            validation.validate_source(good,'https://app.invalid')
        for bad in ['https://evil.invalid/api/media/a.png','http://127.0.0.1/a.png','//evil.invalid/a.png','/private/a.png']:
            with self.assertRaises(validation.InvalidUpscaleRequest): validation.validate_source(bad,'https://app.invalid')
        encoded=base64.b64encode(picture()).decode()
        self.assertEqual(validation.inspect_image(encoded,'IMAGE/PNG')['meta'],{'width':64,'height':64})
        with self.assertRaisesRegex(validation.InvalidUpscaleRequest,'match'): validation.inspect_image(encoded,'image/jpeg')
        with self.assertRaisesRegex(validation.InvalidUpscaleRequest,'JPEG, PNG'): validation.inspect_image(encoded,'image/gif')
        with patch.object(validation,'MAX_BYTES',1):
            with self.assertRaisesRegex(validation.InvalidUpscaleRequest,'20 MB'): validation.inspect_image(encoded,'image/png')
        self.assertEqual(validation.aspect_ratio(1920,1080),'16:9')
        self.assertEqual(validation.aspect_ratio(320,100),'320:100')


@override_settings(ROOT_URLCONF='apps.generation.enqueue_urls')
class EnqueueContractTests(TransactionTestCase):
    setUp=session_fixtures.SettingsTests.setUp
    cookie=session_fixtures.SettingsTests.cookie

    def post(self,kind,payload):
        return self.client.post('/api/generate/'+kind,payload,content_type='application/json')

    def row(self,**fields):
        base=dict(id=uuid.uuid4(),kind='video',status='succeeded',prompt='draft prompt',model='Seedance 2.5',aspect_ratio='16:9',
            created_at=enqueue.now_ms(),updated_at=enqueue.now_ms(),draft_mode=True,task_id='synthetic-task',duration=5)
        base.update(fields)
        return Generation.objects.create(**base)

    def test_paid_admission_requires_login_before_preparation_or_insertion(self):
        with patch('apps.generation.enqueue_views.enqueue.prepare_video') as prepare, patch('apps.generation.enqueue_views.magnific.submit_upscale') as submit:
            for path in ['image','video','video/finalize','upscale']:
                response = self.post(path,{'prompt':'paid request','referenceImages':[data_url()]})
                self.assertEqual(response.status_code,401)
                self.assertEqual(response.json(),{'error':'UNAUTHENTICATED'})
            self.assertEqual(self.client.get('/api/generate/video/status').status_code,401)
            prepare.assert_not_called()
            submit.assert_not_called()
        self.assertEqual(Generation.objects.count(),0)
        self.assertEqual(GenerationNaming.objects.count(),0)
        self.cookie()
        response=self.post('video',{'prompt':' authenticated '})
        self.assertEqual(response.status_code,200)
        item=response.json()
        self.assertEqual(item['userId'],session_fixtures.UID)
        with patch('apps.generation.services.poller.advance',side_effect=AssertionError('must never poll')):
            status=self.client.get('/api/generate/video/status',{'id':item['id']})
        self.assertEqual(status.status_code,200)
        self.assertEqual(status['Cache-Control'],'no-store')
        self.assertEqual(self.client.get('/api/generate/video/status').json(),{'error':'Missing id.'})

    def test_admission_internal_errors_do_not_disclose_credentials(self):
        self.cookie()
        for kind in ('image','video'):
            for operation in ('prepare_'+kind,'finish_enqueue'):
                with self.subTest(kind=kind,operation=operation), patch.object(
                        enqueue,operation,side_effect=RuntimeError('private-fixture-token in storage URL')):
                    response = self.post(kind,{'prompt':'fixture'})
                self.assertEqual(response.status_code,500)
                self.assertNotIn('private-fixture-token',response.content.decode())
        with patch('apps.generation.services.enqueue.save_reference_images',
                side_effect=ValueError('private-fixture-token in upload URL')):
            response = self.post('image',{'prompt':'fixture','model':'Seedream 5.0 Pro',
                'referenceImages':[data_url()]})
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Failed to prepare the generation request.'})
        self.assertEqual(Generation.objects.count(),0)

    def test_finalize_internal_errors_do_not_disclose_credentials(self):
        self.cookie()
        source = self.row(user_id=session_fixtures.UID)
        with patch.object(enqueue,'build_final',side_effect=RuntimeError('private-fixture-token')):
            response = self.post('video/finalize',{'sourceGenerationId':str(source.id)})
        self.assertEqual(response.status_code,500)
        self.assertEqual(response.json(),{'error':'Failed to queue the final render.'})
        self.assertEqual(Generation.objects.count(),1)

    def test_repeated_finalize_reuses_an_in_flight_final(self):
        self.cookie()
        source=self.row(user_id=session_fixtures.UID)
        from apps.library.services.folder_engine import create_folder
        from apps.library.services.naming import assign_generation_naming
        folder = create_folder(name='Scene')
        Generation.objects.filter(pk=source.id).update(folder_id=folder['id'])
        source.refresh_from_db()
        assign_generation_naming(source.id, source.folder_id)
        source.refresh_from_db()
        source_name = source.permanent_name
        first=self.post('video/finalize',{'sourceGenerationId':str(source.id)})
        self.assertEqual(first.status_code,200,first.content)
        self.assertEqual(first.json()['filename'].rsplit('.', 1)[0], source_name)
        with patch('apps.generation.enqueue_views.enqueue.build_final') as build:
            second=self.post('video/finalize',{'sourceGenerationId':str(source.id)})
            build.assert_not_called()
        self.assertEqual(second.status_code,200)
        self.assertEqual(second.json()['id'],first.json()['id'])
        frozen = Generation.objects.get(pk=first.json()['id']).permanent_name
        self.assertTrue(frozen)
        self.assertEqual(frozen, source_name)
        self.assertEqual(Generation.objects.get(pk=second.json()['id']).permanent_name, frozen)
        self.assertEqual(Generation.objects.get(pk=source.id).permanent_name, source_name)
        self.assertEqual(Generation.objects.filter(source_generation_id=source.id).count(),1)
        # Once the final has finished (stored or failed), finalizing again is a deliberate new render.
        for finished in ('succeeded','failed'):
            Generation.objects.filter(source_generation_id=source.id).update(status=finished)
            again=self.post('video/finalize',{'sourceGenerationId':str(source.id)})
            self.assertEqual(again.status_code,200,again.content)
            self.assertNotEqual(again.json()['id'],first.json()['id'])
            self.assertEqual(Generation.objects.get(pk=again.json()['id']).permanent_name, source_name)
            self.assertEqual(again.json()['filename'].rsplit('.', 1)[0], source_name)
            self.assertEqual(Generation.objects.filter(source_generation_id=source.id,status='queued').count(),1)

    def test_concurrent_finalize_creates_one_final(self):
        from concurrent.futures import ThreadPoolExecutor
        from django.db import connections
        self.cookie()
        source=self.row(user_id=session_fixtures.UID)
        cookie=self.client.cookies['veevee_session'].value
        def go(_):
            from django.test import Client
            client=Client(HTTP_SEC_FETCH_SITE='same-origin')
            client.cookies['veevee_session']=cookie
            try:
                return client.post('/api/generate/video/finalize',data=json.dumps({'sourceGenerationId':str(source.id)}),content_type='application/json').json()['id']
            finally:
                connections.close_all()
        with ThreadPoolExecutor(4) as pool:
            ids=list(pool.map(go,range(4)))
        self.assertEqual(len(set(ids)),1)
        self.assertEqual(Generation.objects.filter(source_generation_id=source.id).count(),1)

    def test_shared_finalization_is_billed_to_requester_while_status_stays_owner_only(self):
        # Shared studio: any signed-in user may finalize an eligible draft; the
        # final is built for (and billed to) the requesting user.
        self.cookie()
        for owner in [uuid.uuid4(),None]:
            source=self.row(user_id=owner)
            response=self.post('video/finalize',{'sourceGenerationId':str(source.id)})
            self.assertEqual(response.status_code,200,response.content)
            self.assertEqual(str(Generation.objects.get(pk=response.json()['id']).user_id), str(session_fixtures.UID))
            self.assertEqual(self.client.get('/api/generate/video/status',{'id':str(source.id)}).status_code,403)
        from apps.authentication.models import User
        User.objects.filter(pk=session_fixtures.UID).update(role='admin')
        self.assertEqual(self.client.get('/api/generate/video/status',{'id':str(source.id)}).status_code,200)

    def test_idempotency_key_replays_one_generation(self):
        self.cookie()
        headers={'HTTP_IDEMPOTENCY_KEY':'submit-1234-0'}
        first=self.client.post('/api/generate/image',{'prompt':'a red kite'},content_type='application/json',**headers)
        self.assertEqual(first.status_code,200,first.content)
        with patch('apps.generation.services.enqueue.persist') as persist:
            second=self.client.post('/api/generate/image',{'prompt':'a red kite'},content_type='application/json',**headers)
            persist.assert_not_called()
        self.assertEqual(second.status_code,200)
        self.assertEqual(second.json()['id'],first.json()['id'])
        self.assertEqual(Generation.objects.filter(prompt='a red kite').count(),1)
        changed=self.client.post('/api/generate/image',{'prompt':'a blue kite'},content_type='application/json',**headers)
        self.assertEqual((changed.status_code,changed.json()['code']),(409,'IDEMPOTENCY_PAYLOAD_MISMATCH'))
        # Without a key (older clients) every POST is a new submission, as before.
        for _ in range(2):
            self.assertEqual(self.post('image',{'prompt':'no key'}).status_code,200)
        self.assertEqual(Generation.objects.filter(prompt='no key').count(),2)
        self.assertEqual(self.client.post('/api/generate/image',{'prompt':'x'},content_type='application/json',HTTP_IDEMPOTENCY_KEY='bad key!').status_code,400)

    def test_failed_submission_leaves_the_key_reusable(self):
        self.cookie()
        headers={'HTTP_IDEMPOTENCY_KEY':'submit-5678-0'}
        with patch('apps.generation.services.enqueue.assign_generation_naming',side_effect=RuntimeError('synthetic naming failure')):
            self.assertEqual(self.client.post('/api/generate/image',{'prompt':'retry me'},content_type='application/json',**headers).status_code,500)
        again=self.client.post('/api/generate/image',{'prompt':'retry me'},content_type='application/json',**headers)
        self.assertEqual(again.status_code,200,again.content)
        self.assertEqual(Generation.objects.filter(prompt='retry me').count(),1)

    def test_concurrent_duplicate_submissions_create_one_generation(self):
        from concurrent.futures import ThreadPoolExecutor
        from django.db import connections
        self.cookie()
        cookie=self.client.cookies['veevee_session'].value
        def go(_):
            from django.test import Client
            client=Client(HTTP_SEC_FETCH_SITE='same-origin')
            client.cookies['veevee_session']=cookie
            try:
                return client.post('/api/generate/image',data=json.dumps({'prompt':'double click'}),content_type='application/json',
                    HTTP_IDEMPOTENCY_KEY='submit-dbl-0').json()['id']
            finally:
                connections.close_all()
        with ThreadPoolExecutor(4) as pool:
            ids=list(pool.map(go,range(4)))
        self.assertEqual(len(set(ids)),1)
        self.assertEqual(Generation.objects.filter(prompt='double click').count(),1)

    def test_image_refs_seed_limits_and_atomic_failure(self):
        self.cookie()
        storage=StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            response=self.post('image',dict(prompt=' photo ',referenceImages=[data_url()],seed=42))
        self.assertEqual(response.status_code,200)
        item=response.json()
        self.assertEqual((item['seed'],item['prompt'],item['model']),(42,'photo','Nano Banana Pro'))
        self.assertNotIn('resolution',item)
        self.assertTrue(item['referenceImages'][0].startswith('/api/media/references/'))
        self.assertEqual(Generation.objects.get(pk=item['id']).seed,42)
        AppSetting.objects.create(key='maxPromptLength',value='2',updated_at=0)
        self.assertEqual(self.post('image',{'prompt':'😀a'}).json()['error'],'Prompt is too long (max 2 characters, this one is 3). An admin can raise this limit from the dashboard.')
        UserLimit.objects.create(user_id=session_fixtures.UID,key='maxPromptLength',value='10',updated_at=0)
        self.assertEqual(self.post('image',{'prompt':'abc'}).status_code,200)
        before=Generation.objects.count()
        with patch('apps.generation.services.enqueue.assign_generation_naming',side_effect=RuntimeError('synthetic naming failure')):
            self.assertEqual(self.post('image',{'prompt':'abc'}).status_code,500)
        self.assertEqual(Generation.objects.count(),before)

    def test_nano_banana_2_1_enqueue_stores_model_resolution_seed_and_estimate(self):
        # Default row: 4 estimator cents at 1K, x1.5 at 2K, x3 at 4K; a reference does not change it.
        self.cookie()
        storage=StorageService(MemoryAdapter())
        cases=[('Nano Banana 2.1','1K',None,4),('Nano Banana 2.1','2K',None,6),('Nano Banana 2.1','4K',None,12),
               ('nano-banana-2-1','4K',[data_url()],12),('Nano Banana 2.1',None,None,4)]
        for index,(model,resolution,references,cents) in enumerate(cases):
            with self.subTest(model=model,resolution=resolution,references=bool(references)):
                body=dict(prompt=f'lantern at dusk {index}',model=model,aspectRatio='4:5',seed=9)
                if resolution: body['resolution']=resolution
                if references: body['referenceImages']=references
                with override_settings(VEEVEE_MEDIA_STORAGE=storage):
                    response=self.post('image',body)
                self.assertEqual(response.status_code,200,response.content)
                row=Generation.objects.get(pk=response.json()['id'])
                self.assertEqual((row.kind,row.status,row.model,row.resolution,row.aspect_ratio,row.seed,row.cost_cents),
                                 ('image','queued',model,resolution,'4:5',9,cents))
                self.assertEqual(len(row.reference_images or []),len(references or []))
        self.assertEqual(Pricing.objects.get(pk='Nano Banana 2.1').unit_cost_cents,4)
        # An admin price edit is the estimate from then on, without a deploy.
        Pricing.objects.filter(pk='Nano Banana 2.1').update(unit_cost_cents=5)
        response=self.post('image',dict(prompt='lantern at dusk again',model='Nano Banana 2.1',resolution='2K'))
        self.assertEqual(Generation.objects.get(pk=response.json()['id']).cost_cents,8)

    def test_gemini_omni_flash_1_1_enqueue_stores_its_controls_and_estimate_and_refuses_the_retired_model(self):
        # Default row: 11 estimator cents per second at 720p, a third of that at 360p; no audio field.
        self.cookie()
        cases=[('Gemini Omni Flash 1.1','720p',4,'16:9',44),('Gemini Omni Flash 1.1','720p',10,'9:16',110),
               ('Gemini Omni Flash 1.1','360p',6,'16:9',22),('gemini-omni-1-1-flash','360p',10,'9:16',37)]
        for index,(model,resolution,duration,ratio,cents) in enumerate(cases):
            with self.subTest(model=model,resolution=resolution,duration=duration):
                response=self.post('video',dict(prompt=f'lantern river {index}',model=model,aspectRatio=ratio,resolution=resolution,
                                                duration=duration,generateAudio=True,seed=4))
                self.assertEqual(response.status_code,200,response.content)
                row=Generation.objects.get(pk=response.json()['id'])
                self.assertEqual((row.kind,row.status,row.model,row.resolution,row.duration,row.aspect_ratio,row.cost_cents,row.generate_audio,row.seed),
                                 ('video','queued',model,resolution,duration,ratio,cents,False,None))
        self.assertEqual(Pricing.objects.get(pk='Gemini Omni Flash 1.1').unit_cost_cents,11)
        before=Generation.objects.count()
        for change,error in [({'resolution':'1080p'},'Gemini Omni Flash 1.1 supports 360p/720p only (got 1080p).'),
                             ({'resolution':'4k'},'Gemini Omni Flash 1.1 supports 360p/720p only (got 4k).'),
                             ({'duration':3},'Gemini Omni Flash 1.1 supports 4/6/8/10s durations (got 3).'),
                             ({'duration':12},'Gemini Omni Flash 1.1 supports 4/6/8/10s durations (got 12).'),
                             ({'aspectRatio':'21:9'},'Gemini Omni Flash 1.1 supports 16:9/9:16 aspect ratios only (got 21:9).'),
                             ({'model':'Gemini Omni Flash'},'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.'),
                             ({'model':'gemini-omni-flash'},'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.')]:
            with self.subTest(change=change):
                body={**dict(prompt='lantern river',model='Gemini Omni Flash 1.1',aspectRatio='16:9',resolution='720p',duration=8),**change}
                response=self.post('video',body)
                self.assertEqual((response.status_code,response.json()),(400,{'error':error}))
        self.assertEqual(Generation.objects.count(),before)
        # Historical rows keep their model and their stored cost; the retired pricing row stays for them.
        old=self.row(model='Gemini Omni Flash',draft_mode=False,duration=8,resolution='720p',cost_cents=80,user_id=session_fixtures.UID)
        self.assertEqual(Pricing.objects.get(pk='Gemini Omni Flash').unit_cost_cents,10)
        old.refresh_from_db()
        self.assertEqual((old.model,old.cost_cents),('Gemini Omni Flash',80))
        # An admin price edit is the estimate from then on, without a deploy.
        Pricing.objects.filter(pk='Gemini Omni Flash 1.1').update(unit_cost_cents=12)
        response=self.post('video',dict(prompt='lantern river again',model='Gemini Omni Flash 1.1',aspectRatio='16:9',resolution='360p',duration=8))
        self.assertEqual(Generation.objects.get(pk=response.json()['id']).cost_cents,32)

    def test_seedream_no_reference_admission_preserved_without_native_runtime(self):
        import sys
        self.cookie()
        with patch.dict(sys.modules,{'pyvips':None}):
            response=self.post('image',dict(prompt='photo',model='Seedream 5.0 Pro'))
        self.assertEqual(response.status_code,200,response.content)
        row=Generation.objects.get(pk=response.json()['id'])
        self.assertEqual((row.status,row.user_id),('queued',uuid.UUID(session_fixtures.UID)))

    def test_seedream_missing_runtime_rejects_inline_reference_before_storage(self):
        import sys
        self.cookie()
        storage=StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch.dict(sys.modules,{'pyvips':None}),patch.object(storage,'upload_base64',wraps=storage.upload_base64) as upload:
            response=self.post('image',dict(prompt='photo',model='Seedream 5.0 Pro',referenceImages=[data_url()]))
        self.assertEqual(response.status_code,400)
        self.assertIn('native image runtime',response.json()['error'])
        upload.assert_not_called()
        self.assertEqual(Generation.objects.count(),0)
        self.assertEqual(GenerationNaming.objects.count(),0)

    def test_seedream_unavailable_native_runtime_cannot_enqueue_paid_work(self):
        import sys
        self.cookie()
        storage=StorageService(MemoryAdapter())
        original=picture()
        storage.primary.put('assets/native-required.png',original,'image/png','private')
        before=dict(storage.primary.objects)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch.dict(sys.modules,{'pyvips':None}),patch('apps.generation.providers.seedream.generate_image') as provider:
            response=self.post('image',dict(prompt='photo',model='Seedream 5.0 Pro',
                referenceImages=['/api/media/assets/native-required.png']))
        self.assertEqual(response.status_code,400)
        self.assertIn('native image runtime',response.json()['error'])
        self.assertEqual(Generation.objects.count(),0)
        self.assertEqual(GenerationNaming.objects.count(),0)
        self.assertEqual(storage.primary.objects,before)
        provider.assert_not_called()

    def test_seedream_refs_preflight_no_submit_and_original_master(self):
        self.cookie()
        storage=StorageService(MemoryAdapter())
        data=picture()
        storage.primary.put('assets/original.png',data,'image/png','private')
        Asset.objects.create(kind='character',name='Hero',slug='hero',images=['/api/media/assets/original.png'],created_at=1,updated_at=1)
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            response=self.post('image',dict(prompt='@hero photo',model='Seedream 5.0 Pro'))
            self.assertEqual(response.status_code,200,response.content)
            self.assertEqual(response.json()['resolution'],'2K')
            self.assertEqual(storage.read('assets/original.png'),data)
            self.assertEqual(self.post('image',dict(prompt='@missing',model='Seedream 5.0 Pro')).status_code,400)
            self.assertEqual(self.post('image',dict(prompt='photo',model='Seedream 5.0 Pro',referenceImages=['https://evil.invalid/image.png'])).status_code,400)
            self.assertEqual(self.post('image',dict(prompt='photo',model='Seedream 5.0 Pro',resolution='4K')).status_code,400)
            result=references.prepare_seedream_references(['/api/media/assets/original.png'],'id')
            self.assertEqual(result['stable'],['/api/media/assets/original.png'])
            self.assertTrue(result['urls'][0])
        self.assertEqual(Generation.objects.count(),1)

    def test_video_frames_render_controls_refs_and_validation(self):
        self.cookie()
        storage=StorageService(MemoryAdapter())
        with override_settings(VEEVEE_MEDIA_STORAGE=storage):
            response=self.post('video',dict(prompt='shot',model='Seedance 2.5',resolution='480p',draftMode=True,
                referenceImages=[data_url(picture(400,400))],firstFrame=data_url(picture(400,400)),lastFrame=data_url(picture(401,400)),generateAudio=True,seed=8))
        self.assertEqual(response.status_code,200,response.content)
        item=response.json()
        self.assertEqual((item['draftMode'],item['bitrateMode'],item['generateAudio']),(True,'high',True))
        paths=[item['referenceImages'][0],item['continuationFrameUrl'],item['lastFrameUrl']]
        self.assertEqual(len(set(paths)),3)
        self.assertNotIn('firstFrame',item)
        self.assertNotIn('lastFrame',item)
        final=self.post('video',dict(prompt='shot',model='Seedance 2.5')).json()
        self.assertEqual((final['draftMode'],final['bitrateMode']),(False,'high'))
        self.assertEqual(self.post('video',dict(prompt='shot',model='Seedance 2.5',draftMode=True)).status_code,400)
        self.assertEqual(self.post('video',dict(prompt='shot',model='Seedance 2.5',duration=31)).status_code,400)
        item=self.post('video',dict(prompt='edit',model='Seedance 2.5',videoTaskMode='edit',referenceVideos=['uploads/native.mov'])).json()
        self.assertNotIn('duration',item)
        self.assertEqual(item['referenceVideos'],['uploads/native.mov'])

    def test_removed_portrait_is_refused_at_submit_with_its_index(self):
        self.cookie()
        gone='/api/media/uploads/portrait/removed-portrait'
        lookup=lambda ref: {'byteplusAssetId':'a1','status':'PreviewDeleted','name':'R01_SC008_0008 (1)'} if ref==gone else None  # noqa: E731
        before=Generation.objects.count()
        with patch('apps.generation.enqueue_views.resolve_submission_references',side_effect=lambda data,user: data), \
             patch('apps.assets.portrait_db.get_portrait_asset_by_image_url',side_effect=lookup), \
             patch('apps.generation.services.enqueue.save_reference_images') as save:
            response=self.post('video',dict(prompt='shot',model='Seedance 2.5',referenceImages=['/api/media/uploads/image-reference/a',gone]))
            save.assert_not_called()
        self.assertEqual(response.status_code,400,response.content)
        self.assertEqual((response.json()['code'],response.json()['referenceIndex']),('PORTRAIT_UNAVAILABLE',2))
        self.assertIn('Reference 2 ("R01_SC008_0008 (1)") was removed from the Portrait Gallery',response.json()['error'])
        self.assertEqual(Generation.objects.count(),before)

    def test_overlong_reference_audio_is_refused_at_submit_with_its_index(self):
        self.cookie()
        lengths={'/api/media/uploads/audio-reference/short':12.0,'/api/media/uploads/audio-reference/dialogue':34.6}
        before=Generation.objects.count()
        with patch('apps.generation.enqueue_views.resolve_submission_references',side_effect=lambda data,user: data), \
             patch('apps.generation.services.enqueue.measure_reference_audio',side_effect=lengths.get), \
             patch('apps.generation.services.enqueue.save_reference_images') as save:
            response=self.post('video',dict(prompt='shot',model='Seedance 2.5',duration=24,referenceAudios=list(lengths)))
            save.assert_not_called()
        self.assertEqual(response.status_code,400,response.content)
        self.assertEqual((response.json()['code'],response.json()['audioIndex']),('REFERENCE_AUDIO_DURATION',2))
        self.assertIn('@audio2 is 34.6s long. Seedance 2.5 accepts reference audio clips of 2-30s each and 30s in total',response.json()['error'])
        self.assertEqual(Generation.objects.count(),before)

    def test_draft_finalization_expiry_cloning_and_no_provider_calls(self):
        self.cookie()
        source=self.row(user_id=session_fixtures.UID,bitrate_mode='standard',generate_audio=True,reference_videos=['uploads/native.mov'],seed=81,continuation_frame_url='original-first')
        response=self.post('video/finalize',{'sourceGenerationId':str(source.id)})
        self.assertEqual(response.status_code,200,response.content)
        item=response.json()
        self.assertEqual((item['sourceGenerationId'],item['draftTaskId'],item['draftMode'],item['resolution'],item['bitrateMode']),(str(source.id),'synthetic-task',False,'1080p','standard'))
        self.assertNotIn('seed',item)
        self.assertNotIn('continuationFrameUrl',item)
        self.assertTrue(GenerationNaming.objects.filter(generation_id=item['id']).exists())
        Generation.objects.filter(pk=source.id).update(created_at=enqueue.now_ms()-7*86400000-1)
        self.assertEqual(self.post('video/finalize',{'sourceGenerationId':str(source.id)}).status_code,400)
        self.assertEqual(self.post('video/finalize',{'sourceGenerationId':str(uuid.uuid4())}).status_code,404)
        self.assertEqual(self.post('video/finalize',{}).status_code,400)

    def test_upscale_durable_ref_before_single_submit_and_failure_order(self):
        self.cookie()
        storage=StorageService(MemoryAdapter())
        payload=dict(model='Magnific Precision V2',image=data_url(picture(160,90)),params=dict(scaleFactor='4x',flavor='photo',sharpen=7,smartGrain=7,ultraDetail=30))
        def submit(value):
            self.assertTrue(any(key.startswith('references/') for key in storage.primary.objects))
            self.assertEqual(value['model'],payload['model'])
            return {'taskId':'magnific-task'}
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch('apps.generation.enqueue_views.magnific.submit_upscale',side_effect=submit) as mocked:
            response=self.post('upscale',payload)
        self.assertEqual(response.status_code,200,response.content)
        mocked.assert_not_called()
        item=response.json()
        self.assertEqual((item['status'],item['aspectRatio'],item['resolution']),('queued','16:9','4x'))
        self.assertNotIn('taskId',item)
        self.assertEqual(Generation.objects.get(pk=item['id']).submission_input['params'],payload['params'])
        with override_settings(VEEVEE_MEDIA_STORAGE=storage),patch('apps.generation.enqueue_views.save_reference_images',side_effect=RuntimeError('synthetic storage unavailable')),patch('apps.generation.enqueue_views.magnific.submit_upscale') as submit:
            self.assertEqual(self.post('upscale',payload).status_code,500)
            submit.assert_not_called()
        self.assertEqual(self.post('upscale',{**payload,'image':'https://evil.invalid/a.png'}).status_code,400)

    def test_upscale_status_ownership_terminal_reads_race_and_transient_fallback(self):
        self.cookie()
        row=self.row(kind='image',status='running',model='Magnific Creative',user_id=uuid.uuid4())
        self.assertEqual(self.client.get('/api/generate/upscale/status',{'id':str(row.id)}).status_code,403)
        Generation.objects.filter(pk=row.id).update(status='succeeded')
        self.assertEqual(self.client.get('/api/generate/upscale/status',{'id':str(row.id)}).status_code,403)
        Generation.objects.filter(pk=row.id).update(status='running',user_id=session_fixtures.UID)
        with patch('apps.generation.enqueue_views.advance_magnific',side_effect=RuntimeError('synthetic transient')):
            response=self.client.get('/api/generate/upscale/status',{'id':str(row.id)})
        self.assertEqual(response.json()['status'],'running')
        self.assertEqual(response['Cache-Control'],'no-store')
        with patch('apps.generation.enqueue_views.advance_magnific',return_value={'kind':'raced'}):
            self.assertEqual(self.client.get('/api/generate/upscale/status',{'id':str(row.id)}).json()['id'],str(row.id))

    def test_status_error_metadata_owner_read(self):
        self.cookie()
        row=self.row(user_id=session_fixtures.UID,kind='image',last_poll_error_at=1,poll_error_count=2,next_poll_at=120)
        with patch('apps.generation.enqueue_views.now_ms',return_value=100):
            response=self.client.get('/api/generate/video/status',{'id':str(row.id)})
        self.assertEqual((response.json()['transientPollError'],response.json()['pollErrorCount'],response.json()['retryAfterMs']),(True,2,20))
        self.assertEqual(self.client.get('/api/generate/video/status',{'id':'bad'}).content,b'')
