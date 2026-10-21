"""Paid admission through the production WSGI entrypoint, never policy internals."""
import json
from .support import ParityCase

UNLIMITED = {'approved_scope': 'GOAL4_EXISTING_GREEN_PREVIEW_UNLIMITED_NEW_IMAGE_AND_SEEDANCE_20_25_PAID_ONLY',
             'unlimited_new_jobs': True}
LIMITED = {'approved_scope': 'GOAL4_EXISTING_GREEN_PREVIEW_NEW_IMAGE_AND_SEEDANCE_PAID_ONLY',
           'maximum_total_cents': 2000, 'reviewed_maximum_quotes': {}}


def case(model, kind='image', **body):
    return {'path': '/api/generate/' + kind, 'body': {'model': model, 'prompt': 'A quiet garden',
            'aspectRatio': '16:9' if kind == 'video' else '1:1',
            'resolution': '720p' if kind == 'video' else '1K', 'duration': 5, **body}}


class PaidAdmissionParityTests(ParityCase):
    def run_cases(self, cases, guard=UNLIMITED, **flags):
        return self.scenario('paid', {'VEEVEE_PAID_GUARD': json.dumps(guard) if guard else '',
            'VEEVEE_RUNTIME_COMPONENT': 'api', **flags}, cases=cases)

    def test_exact_unlimited_flag_refusals(self):
        cases = [case('Kling Image 3.0'), case('Kling Image 2.1'),
                 case('Gemini Omni Flash 1.1', 'video', duration=8), case('Veo 3.1', 'video')]
        result = self.run_cases(cases, VEEVEE_KLING='0', VEEVEE_GEMINI_OMNI='0')
        messages = ['Kling Image 3.0 is not enabled. Choose another image model.',
                    'Kling Image 2.1 is not enabled. Choose another image model.',
                    'Gemini Omni Flash 1.1 is not enabled', 'Only Seedance 2.0 or 2.5 video authorized']
        self.assertEqual(result['responses'], [{'status': 409, 'body': {'error': message,
            'code': 'PREVIEW_PAID_BUDGET_HOLD'}} for message in messages])
        self.assertEqual(result['reservations'], 0)

    def test_limited_scope_refuses_unquoted_models(self):
        result = self.run_cases([case('Seedream 5.0 Pro'), case('Kling Image 3.0'),
            case('Seedance 2.0', 'video'), case('Gemini Omni Flash 1.1', 'video', duration=8)], guard=LIMITED,
            VEEVEE_KLING='1', VEEVEE_GEMINI_OMNI='1')
        self.assertEqual(result['responses'], [{'status': 409, 'body': {
            'error': 'No verified maximum charge quote for this model',
            'code': 'PREVIEW_PAID_BUDGET_HOLD'}}] * 4)
        self.assertEqual(result['reservations'], 0)

    def test_enabled_models_enqueue_and_register_once(self):
        cases = [case(m) for m in ('Nano Banana Pro', 'Nano Banana 2.1', 'Seedream 5.0 Pro',
                                  'Kling Image 3.0', 'Kling Image 2.1')]
        cases += [case('Seedance 2.5', 'video'), case('Seedance 2.0', 'video'),
                  case('Gemini Omni Flash 1.1', 'video', duration=8)]
        result = self.run_cases(cases, VEEVEE_KLING='1', VEEVEE_GEMINI_OMNI='1')
        self.assertEqual([r['status'] for r in result['responses']], [200] * len(cases), result)
        self.assertTrue(all(r['body'].get('id') for r in result['responses']))
        self.assertEqual(result['reservations'], len(cases))
        seedance = result['responses'][5]['body']
        self.assertEqual((seedance['draftMode'], seedance['bitrateMode']), (False, 'high'))

    def test_guard_off_accepts_models_without_reservations(self):
        cases = [case('Nano Banana Pro'), case('Kling Image 3.0'), case('Seedance 2.5', 'video'),
                 case('Gemini Omni Flash 1.1', 'video', duration=8)]
        result = self.run_cases(cases, guard=None, VEEVEE_KLING='0', VEEVEE_GEMINI_OMNI='0')
        self.assertEqual([r['status'] for r in result['responses']], [200] * len(cases), result)
        self.assertEqual(result['reservations'], 0)

    def test_legacy_nano_model_still_enqueues_and_retired_omni_refuses(self):
        result = self.run_cases([case('Nano Banana 2'), case('Gemini Omni Flash', 'video'),
            case('Magnific Precision V2'), case('Magnific Video Creative', 'video')], guard=None)
        self.assertEqual(result['responses'][0]['status'], 200)
        self.assertEqual(result['responses'][0]['body']['model'], 'Nano Banana 2')
        self.assertEqual(result['responses'][1:], [
            {'status': 400, 'body': {'error': message}} for message in (
                'Gemini Omni Flash has been retired. Choose Gemini Omni Flash 1.1 instead.',
                'Upscale models run from the Upscale composer.', 'Upscale models run from the Upscale composer.')])

    def test_managed_portrait_stale_reference_messages(self):
        result = self.run_cases([case('Seedance 2.5', 'video', referenceImages=['asset://old']),
            case('Seedance 2.5', 'video', firstFrame='asset://old')], guard=None, VEEVEE_MANAGED_PORTRAITS='1')
        self.assertEqual(result['responses'], [{'status': 400, 'body': {'error': message,
            'code': 'PORTRAIT_UNAVAILABLE', 'referenceIndex': index}} for index, message in ((1,
                '@img1 is an old portrait link that no longer exists. Add the image again; nothing was queued.'),
                (None, 'The first frame is an old portrait link that no longer exists. Add the image again; nothing was queued.'))])

    def test_reservation_failure_rolls_back_generation(self):
        result = self.scenario('paid', {'VEEVEE_PAID_GUARD': json.dumps(UNLIMITED),
            'VEEVEE_RUNTIME_COMPONENT': 'api'}, cases=[case('Nano Banana Pro')], reserve_failure=True)
        self.assertEqual(result['responses'], [{'status': 409, 'body': {
            'error': 'Paid Preview budget unavailable or exhausted; no provider submission occurred.',
            'code': 'PREVIEW_PAID_BUDGET_HOLD'}}])
        self.assertEqual(result['reservations'], 0)

    def test_limited_quote_over_cap_preserves_requested_quality(self):
        quote = {'maximum_cents': 2001, 'pricing_status': 'VERIFIED_PROVIDER_MAXIMUM_NOT_ESTIMATE',
                 'maximum_charge_verified': True}
        result = self.run_cases([case('Nano Banana Pro', resolution='4K')],
            guard={**LIMITED, 'reviewed_maximum_quotes': {'Nano Banana Pro': quote}})
        self.assertEqual(result['responses'], [{'status': 409, 'body': {
            'error': 'Conservative paid reservation exceeds the twenty dollar budget; requested quality was preserved',
            'code': 'PREVIEW_PAID_BUDGET_HOLD'}}])
        self.assertEqual(result['reservations'], 0)

    def test_draft_to_final_admitted_unlimited_and_held_limited(self):
        import time
        from django.apps import apps
        row = apps.get_model('generation', 'Generation').objects.create(kind='video', model='Seedance 2.5',
            prompt='A quiet garden', aspect_ratio='16:9', status='succeeded', draft_mode=True,
            task_id='draft-fixture', resolution='480p', duration=5, bitrate_mode='high', user_id=self.actor.id,
            created_at=int(time.time()*1000), updated_at=int(time.time()*1000))
        request = {'path': '/api/generate/video/finalize', 'body': {'sourceGenerationId': str(row.id)}}
        quote = {'maximum_cents': 300, 'pricing_status': 'VERIFIED_PROVIDER_MAXIMUM_NOT_ESTIMATE',
            'maximum_charge_verified': True, 'pricing_evidence_sha256': 'a' * 64,
            'allowed_input_values': {}, 'provider_payload_allowed_values': {'output_format': ['mov']}}
        result = self.run_cases([request], guard={**LIMITED, 'reviewed_maximum_quotes': {'Seedance 2.5': quote}})
        self.assertEqual(result['responses'], [{'status': 409, 'body': {
            'error': 'New authenticated generation only; finalization separately held',
            'code': 'PREVIEW_PAID_BUDGET_HOLD'}}])
        result = self.run_cases([request])
        self.assertEqual(result['responses'][0]['status'], 200, result)
        self.assertEqual(result['responses'][0]['body']['draftTaskId'], 'draft-fixture')
        self.assertEqual(result['responses'][0]['body']['bitrateMode'], 'high')
        self.assertEqual(result['reservations'], 1)

    def test_magnific_flag_off_refuses_and_on_enqueues_image_upscale(self):
        import base64
        from testsupport.fake_providers import png_bytes
        request = {'path': '/api/generate/upscale', 'body': {
            'image': 'data:image/png;base64,' + base64.b64encode(png_bytes((640, 640))).decode(),
            'model': 'Magnific Precision V2', 'params': {'scaleFactor': '2x', 'flavor': 'photo', 'sharpen': 0, 'smartGrain': 0, 'ultraDetail': 0}}}
        result = self.run_cases([request], VEEVEE_MAGNIFIC_UPSCALE='0')
        self.assertEqual(result['responses'], [{'status': 409, 'body': {
            'error': 'Magnific upscaling is not enabled', 'code': 'PREVIEW_PAID_BUDGET_HOLD'}}])
        result = self.run_cases([request], VEEVEE_MAGNIFIC_UPSCALE='1')
        self.assertEqual(result['responses'][0]['status'], 200, result)
        self.assertEqual(result['reservations'], 1)

    def test_audio_configured_model_refusal_and_fake_worker_transcription(self):
        import base64
        from testsupport.fake_providers import TRANSCRIPT
        request = {'path': '/api/audio/transcribe', 'body': {
            'audioRef': 'data:audio/wav;base64,' + base64.b64encode(b'RIFF fixture audio bytes').decode(), 'name': 'fixture.wav'}}
        result = self.run_cases([request], AUDIO_TRANSCRIPTION_MODEL='invalid-model')
        self.assertEqual(result['responses'], [{'status': 409, 'body': {
            'error': 'Audio transcription outside the configured model', 'code': 'PREVIEW_PAID_BUDGET_HOLD'}}])
        result = self.scenario('paid', {'VEEVEE_PAID_GUARD': json.dumps(UNLIMITED),
            'VEEVEE_RUNTIME_COMPONENT': 'api', 'AUDIO_TRANSCRIPTION_MODEL': 'gemini-2.5-flash',
            'MOCK_GENERATION': '0', 'GOOGLE_API_KEY': 'fake-google'}, cases=[request], run_audio_worker=True)
        self.assertEqual(result['responses'][0]['status'], 200, result)
        self.assertEqual(result['responses'][0]['body']['transcript'], TRANSCRIPT)
        self.assertEqual(result['reservations'], 1)

    def test_legacy_portrait_processing_deleted_and_missing_remote_refusals(self):
        from django.apps import apps
        group = apps.get_model('assets', 'PortraitGroup').objects.create(name='Fixture', created_at=1, updated_at=1)
        asset = apps.get_model('assets', 'PortraitAsset').objects.create(group=group, name='Face',
            image_url='/api/media/uploads/portrait/fixture', byteplus_asset_id='asset-fixture',
            status='Processing', created_at=1, updated_at=1)
        request = case('Seedance 2.5', 'video', referenceImages=[asset.image_url])
        for status, message in (('Processing', 'Reference 1 ("Face") is not ready for video yet. Remove it from the references and try again; nothing was queued.'),
                ('PreviewDeleted', 'Reference 1 ("Face") was removed from the Portrait Gallery. Remove it from the references and try again; nothing was queued.')):
            apps.get_model('assets', 'PortraitAsset').objects.filter(pk=asset.id).update(status=status)
            result = self.run_cases([request], guard=None, VEEVEE_MANAGED_PORTRAITS='0')
            self.assertEqual(result['responses'], [{'status': 400, 'body': {'error': message,
                'code': 'PORTRAIT_UNAVAILABLE', 'referenceIndex': 1}}])
        result = self.run_cases([case('Seedance 2.5', 'video', referenceImages=['asset://missing'])],
            guard=None, VEEVEE_MANAGED_PORTRAITS='0', MOCK_ASSET_PROVIDER='0',
            BYTEPLUS_ACCESS_KEY_ID='fake', BYTEPLUS_SECRET_ACCESS_KEY='fake')
        self.assertEqual(result['responses'], [{'status': 400, 'body': {
            'error': 'Portrait unavailable or remote registration could not be verified. No generation was queued.'}}])
