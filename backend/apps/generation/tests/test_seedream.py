import io
from unittest import TestCase
from unittest.mock import patch, Mock
from PIL import Image
from apps.generation import seedream
from apps.generation.pricing import compute_seedream_cost, SEEDREAM_PRICING
from apps.generation.providers import seedream as provider

class SeedreamTests(TestCase):
    def test_sizes_and_payload(self):
        self.assertEqual(seedream.size(), '2048x2048')
        self.assertEqual(seedream.size('2K','16:9'), '2816x1584')
        with self.assertRaises(ValueError): seedream.size('4K')
        body=provider.payload('change red to blue', references=['a'])
        self.assertEqual(body['image'], ['a'])
        self.assertEqual(body['optimize_prompt_options'], {'mode':'standard'})
        self.assertFalse(body['watermark'])
        for field in ['seed','stream','sequential_image_generation','n']: self.assertNotIn(field,body)

    def test_resolution_order_limits_and_missing(self):
        result=seedream.resolve('use @hero and @img2, change coat to red', [{'slug':'hero','name':'Hero','kind':'character','images':['a','b']}], ['c','d'])
        self.assertEqual(result['references'], ['a','b','d'])
        self.assertIn('image 3, change coat to red',result['prompt'])
        self.assertEqual(len(seedream.resolve('compose',uploads=['a']*10)['references']),10)
        for prompt, refs in [('compose',['a']*11),('@img2',['a']),('@absent',[])]:
            with self.assertRaises(ValueError):seedream.resolve(prompt, uploads=refs)

    def test_cost_boundaries_and_rounding(self):
        def cost(pixels, refs=0):return compute_seedream_cost({'width':pixels,'height':1,'referenceCount':refs},SEEDREAM_PRICING)
        self.assertEqual(cost(2610000),5)
        self.assertEqual(cost(2610001),9)
        self.assertEqual(cost(2610000,10),7)
        self.assertEqual(cost(2610001,10),12)

    def test_original_preserved_and_corrupt_rejected(self):
        out=io.BytesIO();Image.new('RGB',(2500,2000),'red').save(out,format='PNG');data=out.getvalue()
        normalized,_,changed=seedream.normalize(data)
        self.assertIs(normalized,data)
        self.assertFalse(changed)
        with self.assertRaises(ValueError):seedream.normalize(b'corrupt')

    def test_oversized_preserves_ratio_and_alpha(self):
        out=io.BytesIO();Image.new('RGBA',(7200,6000),(1,2,3,100)).save(out,format='PNG')
        normalized,ext,changed=seedream.normalize(out.getvalue())
        im=Image.open(io.BytesIO(normalized))
        self.assertTrue(changed);self.assertEqual(ext,'png');self.assertIn('A',im.getbands())
        self.assertLessEqual(im.width*im.height,36000000)
        self.assertAlmostEqual(im.width/im.height,1.2,places=3)

    @patch.dict('os.environ',{'ARK_API_KEY':'test','ARK_BASE_URL':'https://provider'})
    def test_provider_errors_do_not_retry(self):
        for status in [400,401,403,429,500]:
            response=Mock(ok=False,status_code=status);response.json.return_value={'error':{'message':'secret'}}
            with patch.object(provider.requests,'post',return_value=response) as post:
                with self.assertRaisesRegex(RuntimeError,'Seedream rejected'):provider.generate('test')
                self.assertEqual(post.call_count,1)
        with patch.object(provider.requests,'post',side_effect=provider.requests.Timeout()) as post:
            with self.assertRaisesRegex(RuntimeError,'not resubmitted'):provider.generate('test')
            self.assertEqual(post.call_count,1)

    @patch.dict('os.environ',{'ARK_API_KEY':'test','ARK_BASE_URL':'https://provider'})
    def test_malformed_and_download_failure(self):
        response=Mock(ok=True);response.json.return_value={'data':[]}
        with patch.object(provider.requests,'post',return_value=response):
            with self.assertRaisesRegex(RuntimeError,'no valid'):provider.generate('test')
        response.json.return_value={'data':[{'url':'https://provider/image'}]}
        with patch.object(provider.requests,'post',return_value=response) as post, patch.object(provider.requests,'get',return_value=Mock(ok=False)):
            with self.assertRaisesRegex(RuntimeError,'download failed'):provider.generate('test')
            self.assertEqual(post.call_count,1)

from django.test import TestCase as DatabaseTestCase, override_settings
from rest_framework.test import APIClient
from apps.common.test_utils import SECRET, _cookie_for, _make_user
from apps.generation.models import Pricing
from apps.generation.pricing_db import read_pricing

@override_settings(AUTH_SECRET=SECRET)
class SeedreamRouteTests(DatabaseTestCase):
    def setUp(self):
        self.client=APIClient()
        self.user=_make_user(role='admin')
        self.client.cookies['veevee_session']=_cookie_for(str(self.user.id))

    def test_upload_requires_authentication_and_accepts_reference_purpose(self):
        response=APIClient().post('/api/uploads/presign',{'purpose':'image-reference','contentType':'image/png'},format='json')
        self.assertIn(response.status_code,[401,403])
        with patch('apps.media.upload_views.get_signed_upload_url',return_value='https://storage/upload'):
            response=self.client.post('/api/uploads/presign',{'purpose':'image-reference','contentType':'image/png'},format='json')
        self.assertEqual(response.status_code,200)
        self.assertTrue(response.json()['key'].startswith(f'uploads/image-reference/{self.user.id}-'))

    def test_pricing_seed_preserves_admin_rate_and_unit(self):
        Pricing.objects.create(model='Seedream 5.0 Pro',unit_cost_cents=5500,unit='per_1000_images')
        read_pricing();read_pricing()
        self.assertEqual(Pricing.objects.filter(model__startswith='Seedream 5.0 Pro').count(),3)
        self.assertEqual(Pricing.objects.get(model='Seedream 5.0 Pro').unit_cost_cents,5500)
        response=self.client.post('/api/admin/pricing',{'model':'Seedream 5.0 Pro','unitCostCents':5600,'unit':'per_1000_images'},format='json')
        self.assertEqual(response.status_code,200)
        self.assertEqual(Pricing.objects.get(model='Seedream 5.0 Pro').unit,'per_1000_images')

    def test_enqueue_limits_and_default(self):
        with patch('apps.generation.seedream.prepare',return_value=[]) as prepare:
            base={'prompt':'a teapot','model':'Seedream 5.0 Pro','referenceImages':[f'/api/media/references/{i}.png' for i in range(10)]}
            response=self.client.post('/api/generate/image',base,format='json')
            self.assertEqual(response.status_code,200,response.json())
            self.assertEqual(response.json()['resolution'],'2K')
            self.assertEqual(response.json()['costCents'],12)
            self.assertEqual(len(response.json()['referenceImages']),10)
            self.assertEqual(prepare.call_count,1)
            response=self.client.post('/api/generate/image',{**base,'resolution':'4K'},format='json')
            self.assertEqual(response.status_code,400)
            response=self.client.post('/api/generate/image',{**base,'referenceImages':base['referenceImages']+['/api/media/references/11.png']},format='json')
            self.assertEqual(response.status_code,400)
            self.assertEqual(prepare.call_count,1)

    def test_queue_uses_seedream_once_and_persists_original_estimated_cost(self):
        with patch('apps.generation.seedream.prepare',return_value=[]):
            response=self.client.post('/api/generate/image',{'prompt':'a teapot','model':'Seedream 5.0 Pro'},format='json')
        self.assertEqual(response.status_code,200)
        out=io.BytesIO();Image.new('RGB',(2048,2048),'blue').save(out,format='PNG');data=out.getvalue()
        with patch.dict('os.environ',{'MOCK_GENERATION':'0'}), patch('apps.generation.seedream.prepare',return_value=[]), patch('apps.generation.providers.seedream.generate',return_value=data) as generate, patch('apps.media.storage.upload_buffer',return_value='/api/media/generations/result.png') as persist, patch('apps.generation.generation_views.assemble_prompt') as gemini_assembly:
            done=self.client.post('/api/queue/execute',{'id':response.json()['id']},format='json')
        self.assertEqual(done.status_code,200)
        self.assertEqual(done.json()['status'],'succeeded',done.json())
        self.assertEqual(done.json()['costCents'],9)
        self.assertEqual(generate.call_count,1)
        self.assertEqual(persist.call_args.args[0],data)
        gemini_assembly.assert_not_called()
