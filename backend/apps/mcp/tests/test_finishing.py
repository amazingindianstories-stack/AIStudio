"""Milestone 7: upscale_media and finalize_draft over both protocol eras.

Both are paid tools on the same path as generate_*: quotes, confirmation, budget admission in the row's transaction,
idempotent replays and agent origin fields, through the shared services the web's Upscale composer and Finalize
button use. No provider is ever called: the tools only queue rows.
"""
import base64
import uuid
from unittest.mock import patch

from django.test import override_settings

from apps.admin_dashboard.models import Pricing
from apps.authentication.session import sign_session
from apps.common.models import ActivityLog
from apps.generation.models import Generation
from apps.generation.services.enqueue import now_ms
from apps.generation.services.pricing import read_pricing
from apps.generation.services.upscale_validation import video_upscale_cost
from apps.mcp import results
from apps.mcp_auth import controls
from apps.mcp_auth.principal import authenticate_bearer
from .support import ERAS, SITE, McpCase
from .test_paid_tools import mid_minute
from .test_results import StorageMixin, mov_bytes, png_bytes

CREATIVE_DEFAULTS = {'scaleFactor': '2x', 'optimizedFor': 'standard', 'engine': 'automatic', 'creativity': 0, 'hdr': 0,
                     'resemblance': 0, 'fractality': 0}
VIDEO_DEFAULTS = {'resolution': '2k', 'creativity': 0, 'sharpen': 0, 'smartGrain': 0, 'fpsBoost': False, 'flavor': 'vivid',
                  'outputFormat': 'h264'}


@override_settings(VEEVEE_MAGNIFIC_UPSCALE=True)
class UpscaleToolTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        Pricing.objects.bulk_create([Pricing(model='Magnific Creative', unit_cost_cents=20, unit='per_image', notes=''),
                                     Pricing(model='Magnific Precision V1', unit_cost_cents=10, unit='per_image', notes=''),
                                     Pricing(model='Magnific Video Creative', unit_cost_cents=900, unit='per_1000_frames', notes=''),
                                     Pricing(model='Magnific Video Topaz', unit_cost_cents=900, unit='per_1000_frames', notes='')],
                                    ignore_conflicts=True)
        self.raw = self.token()
        pinned = mid_minute()
        clock = patch('apps.mcp_auth.controls.now_ms', return_value=pinned)
        clock.start()
        self.addCleanup(clock.stop)
        self.image = self.finished('image', 'generations/still.png', png_bytes(600, 400), 'image/png')
        self.clip = self.finished('video', 'generations/clip.mov', mov_bytes(), 'video/quicktime')

    def finished(self, kind, key, data, mime):
        return Generation.objects.create(id=uuid.uuid4(), kind=kind, status='succeeded', prompt=f'source {kind}', model='Nano Banana 2.1',
                                         aspect_ratio='3:2', url=self.store(key, data, mime), user_id=self.user.id,
                                         created_at=now_ms(), updated_at=now_ms())

    def upscale(self, arguments, raw=None, mode='legacy'):
        return self.call(raw or self.raw, 'upscale_media', {'wait': False, **arguments}, mode)

    def submitted(self, result):
        self.assert_structured(result, results.RESULT_SCHEMA)
        return Generation.objects.get(pk=result.structured_content['generation']['id'])

    def test_listing_annotations_model_enum_and_estimate(self):
        self.assertNotIn('upscale_media', self.tool_names(self.token(scopes=('veevee.read',))))
        for era in ERAS:
            async def tools(client):
                return {tool.name: tool for tool in (await client.list_tools()).tools}
            found = self.with_client(self.raw, era, tools)
            hints = found['upscale_media'].annotations
            self.assertEqual((hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint, hints.open_world_hint),
                             (False, False, True, True))
            self.assertEqual(found['upscale_media'].input_schema['properties']['model']['enum'],
                             ['magnific-creative', 'magnific-precision-v2', 'magnific-precision-v1', 'magnific-video-creative',
                              'magnific-video-creative-turbo', 'magnific-video-precision', 'magnific-video-topaz'])
            self.assertEqual(found['estimate_cost'].input_schema['properties']['tool']['enum'],
                             ['generate_image', 'generate_video', 'upscale_media', 'finalize_draft'])
        models = {model['id']: model for model in self.call(self.raw, 'list_models').structured_content['models']}
        self.assertEqual(models['magnific-creative']['inputs']['defaults'], CREATIVE_DEFAULTS)
        self.assertEqual(models['magnific-video-creative']['inputs']['defaults'], VIDEO_DEFAULTS)
        estimate = self.call(self.raw, 'estimate_cost', {'tool': 'upscale_media', 'arguments': {'sourceId': str(self.image.id)}})
        self.assertEqual((estimate.structured_content['costCents'], estimate.structured_content['autoApproves'],
                          estimate.structured_content['summary']), (20, True, 'Magnific Creative, 2x image upscale'))
        self.assertFalse(Generation.objects.filter(model__startswith='Magnific').exists())
        with override_settings(VEEVEE_MAGNIFIC_UPSCALE=False):
            self.assertEqual(self.with_client(self.raw, 'legacy', tools)['upscale_media'].input_schema['properties']['model']['enum'], [])
            error = self.assert_tool_error(self.upscale({'sourceId': str(self.image.id)}), 'MODEL_UNAVAILABLE')
            self.assertEqual(error['next']['tool'], 'list_models')

    def test_image_upscale_matches_the_web_row_with_agent_origin(self):
        principal = authenticate_bearer(self.raw)
        for era in ERAS:
            result = self.upscale({'sourceId': str(self.image.id), 'idempotencyKey': f'upscale-{era}'}, mode=era)
            row = self.submitted(result)
            body = result.structured_content
            self.assertEqual((body['outcome'], body['generation']['status'], body['generation']['kind']), ('running', 'queued', 'image'))
            self.assertEqual((row.model, row.resolution, row.aspect_ratio, row.cost_cents, row.user_id, row.folder_id),
                             ('Magnific Creative', '2x', '3:2', 20, self.user.id, None))
            self.assertEqual(row.submission_input['params'], CREATIVE_DEFAULTS)
            self.assertTrue(row.submission_input['source'].startswith('/api/media/references/'))
            self.assertEqual((row.created_via, row.mcp_token_id), ('mcp', principal.token_id))
            # The image source is copied into an immutable reference; the intent records which generation it was.
            self.assertEqual(row.submission_input['sourceGenerationId'], str(self.image.id))
            self.assertEqual((body['generation']['related']['upscaleSourceId'], body['generation']['references']),
                             (str(self.image.id), [{'role': 'image', 'generationId': str(self.image.id)}]))
        # The web composer's request for the same source and parameters stores the same intent, with no agent origin.
        self.client.cookies['veevee_session'] = sign_session(self.user)
        response = self.client.post('/api/generate/upscale', {'image': self.image.url, 'model': 'Magnific Creative',
                                                              'params': {'model': 'Magnific Creative', 'filterNsfw': False, **CREATIVE_DEFAULTS}},
                                    content_type='application/json', HTTP_ORIGIN=SITE)
        self.assertEqual(response.status_code, 200, response.content)
        web = Generation.objects.get(pk=response.json()['id'])
        self.assertEqual((web.model, web.resolution, web.aspect_ratio, web.cost_cents, web.mcp_token_id),
                         (row.model, row.resolution, row.aspect_ratio, row.cost_cents, None))
        self.assertIsNone(web.created_via)
        # The web path looks nothing up and records no source generation.
        self.assertNotIn('sourceGenerationId', web.submission_input)
        audit = ActivityLog.objects.filter(action='mcp_tool_call').order_by('-created_at').first().detail
        self.assertEqual((audit['tool'], audit['generationId'], audit['costCents']), ('upscale_media', str(row.id), 20))

    def test_params_models_and_sources_are_checked_before_anything_is_stored(self):
        row = self.submitted(self.upscale({'sourceId': str(self.image.id), 'model': 'magnific-precision-v1',
                                           'params': {'sharpen': 50}}))
        self.assertEqual((row.model, row.cost_cents, row.submission_input['params']),
                         ('Magnific Precision V1', 10, {'sharpen': 50, 'smartGrain': 7, 'ultraDetail': 30}))
        cases = (({'params': {'scaleFactor': '3x'}}, 'INVALID_INPUT', 'params.scaleFactor'),
                 ({'params': {'colour': 'red'}}, 'INVALID_INPUT', "('colour' was unexpected)"),
                 ({'model': 'magnific-video-creative'}, 'INVALID_INPUT', 'Magnific Video Creative upscales videos and the source is an image'),
                 # Creative output above 25.3 MP is the web's own refusal at submission, verbatim.
                 ({'params': {'scaleFactor': '16x'}}, 'INVALID_INPUT', 'Magnific Creative output cannot exceed 25.3 megapixels'))
        for arguments, code, text in cases:
            with self.subTest(arguments=arguments):
                self.assertIn(text, self.assert_tool_error(self.upscale({'sourceId': str(self.image.id), **arguments}), code)['message'])
        failed = Generation.objects.create(id=uuid.uuid4(), kind='image', status='failed', prompt='x', model='Nano Banana 2.1',
                                           created_at=now_ms(), updated_at=now_ms())
        self.assertIn('is not a finished image or video',
                      self.assert_tool_error(self.upscale({'sourceId': str(failed.id)}), 'INVALID_INPUT')['message'])
        self.assert_tool_error(self.upscale({'sourceId': str(uuid.uuid4())}), 'NOT_FOUND')
        self.assertEqual(Generation.objects.filter(model__startswith='Magnific').count(), 1)

    def test_video_upscale_prices_the_probed_clip(self):
        pricing = read_pricing()
        meta = {'durationSeconds': 1.0, 'fps': 10.0}
        expected = video_upscale_cost('Magnific Video Creative', VIDEO_DEFAULTS, meta, pricing)
        for era in ERAS:
            result = self.upscale({'sourceId': str(self.clip.id), 'idempotencyKey': f'clip-{era}'}, mode=era)
            row = self.submitted(result)
            self.assertEqual((row.kind, row.model, row.resolution, row.duration, row.cost_cents),
                             ('video', 'Magnific Video Creative', '2k', 1, expected))
            self.assertEqual(row.reference_videos, [self.clip.url])
            self.assertEqual(result.structured_content['generation']['related']['upscaleSourceId'], str(self.clip.id))
            self.assertEqual(row.submission_input['sourceGenerationId'], str(self.clip.id))
            self.assertEqual(row.submission_input['params'], VIDEO_DEFAULTS)
            self.assertEqual(row.created_via, 'mcp')
        error = self.assert_tool_error(self.upscale({'sourceId': str(self.clip.id), 'model': 'magnific-video-topaz',
                                                     'params': {'frameInterpolation': 'chronos'}}), 'INVALID_INPUT')
        self.assertEqual(error['message'], 'frameInterpolation requires targetFps.')
        topaz = self.submitted(self.upscale({'sourceId': str(self.clip.id), 'model': 'magnific-video-topaz', 'params': {'targetFps': 30}},
                                            raw=self.token(auto_approve=50)))
        self.assertEqual(topaz.submission_input['params'],
                         {'resolution': '2k', 'enhancementModel': 'starlight_precise_2_5', 'noise': 0, 'targetFps': 30})
        self.assertEqual(topaz.cost_cents, video_upscale_cost('Magnific Video Topaz', {'resolution': '2k', 'targetFps': 30}, meta, pricing))

    def test_the_agent_records_its_chosen_source_and_a_web_video_upscale_links_by_url(self):
        # A newer row shares the clip's URL: the agent's chosen id is recorded; a web upscale records none and links to
        # the oldest row at its reference URL when read.
        copy = Generation.objects.create(id=uuid.uuid4(), kind='video', status='succeeded', prompt='copy', model='Seedance 2.5',
                                         url=self.clip.url, user_id=self.user.id, created_at=now_ms() + 5, updated_at=now_ms() + 5)
        result = self.upscale({'sourceId': str(copy.id).upper()})
        self.assertEqual(self.submitted(result).submission_input['sourceGenerationId'], str(copy.id))
        self.assertEqual(result.structured_content['generation']['related']['upscaleSourceId'], str(copy.id))
        self.client.cookies['veevee_session'] = sign_session(self.user)
        response = self.client.post('/api/generate/upscale', {'video': self.clip.url, 'model': 'Magnific Video Creative',
                                                              'params': {'model': 'Magnific Video Creative', **VIDEO_DEFAULTS}},
                                    content_type='application/json', HTTP_ORIGIN=SITE)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertIsNone(response.json()['sourceGenerationId'], 'the web item keeps its draft link column, untouched')
        web = Generation.objects.get(pk=response.json()['id'])
        self.assertNotIn('sourceGenerationId', web.submission_input)
        self.assertEqual(web.reference_videos, [self.clip.url])
        found = self.call(self.raw, 'get_generation', {'id': str(web.id)}).structured_content['generation']
        self.assertEqual((found['related']['upscaleSourceId'], found['references']),
                         (str(self.clip.id), [{'role': 'video', 'generationId': str(self.clip.id)}]))

    def test_owned_uploads_are_sources_and_others_are_not(self):
        data = {'dataBase64': base64.b64encode(png_bytes(300, 300)).decode(), 'contentType': 'image/png'}
        mine = self.call(self.raw, 'upload_reference', data).structured_content['reference']
        result = self.upscale({'sourceId': mine['id']})
        row = self.submitted(result)
        self.assertEqual((row.model, row.aspect_ratio), ('Magnific Creative', '1:1'))
        # An upload is no library generation: nothing is recorded and nothing is linked.
        self.assertNotIn('sourceGenerationId', row.submission_input)
        self.assertIsNone(result.structured_content['generation']['related']['upscaleSourceId'])
        other = self.make_user('other@example.invalid', 'Other', 'user')
        theirs = self.call(self.token(other), 'upload_reference', data).structured_content['reference']
        self.assert_tool_error(self.upscale({'sourceId': theirs['id']}), 'NOT_FOUND')

    def test_quotes_confirmation_idempotency_and_budget(self):
        raw = self.token(auto_approve=10)
        quoted = self.upscale({'sourceId': str(self.image.id)}, raw=raw).structured_content
        self.assertEqual((quoted['outcome'], quoted['quote']['costCents'], quoted['quote']['requiresUserConfirmation']),
                         ('quote_required', 20, False))
        row = self.submitted(self.call(raw, 'upscale_media', quoted['next']['arguments']))
        # A quote pays for one job: the same quote again, even with a new key, returns that job and charges nothing.
        again = self.call(raw, 'upscale_media', {**quoted['next']['arguments'], 'idempotencyKey': 'second-job-01'}).structured_content
        self.assertEqual((again['outcome'], again['generation']['id'], again['quote']['token']),
                         ('running', str(row.id), quoted['quote']['token']))
        first = self.upscale({'sourceId': str(self.image.id), 'idempotencyKey': 'replay-key-01'})
        replay = self.upscale({'sourceId': str(self.image.id), 'idempotencyKey': 'replay-key-01'})
        self.assertEqual(first.structured_content['generation']['id'], replay.structured_content['generation']['id'])
        self.assert_tool_error(self.upscale({'sourceId': str(self.image.id), 'idempotencyKey': 'replay-key-01',
                                             'params': {'scaleFactor': '4x'}}), 'IDEMPOTENCY_CONFLICT')
        self.assertEqual(Generation.objects.filter(model__startswith='Magnific').exclude(pk=row.pk).count(), 1)
        poor = self.token(cap=15)
        self.assert_tool_error(self.upscale({'sourceId': str(self.image.id)}, raw=poor), 'BUDGET_EXCEEDED')
        self.assertEqual(Generation.objects.filter(model__startswith='Magnific').count(), 2)


class FinalizeToolTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token()
        pinned = mid_minute()
        clock = patch('apps.mcp_auth.controls.now_ms', return_value=pinned)
        clock.start()
        self.addCleanup(clock.stop)

    def draft(self, **fields):
        values = dict(id=uuid.uuid4(), kind='video', status='succeeded', prompt='river at dawn', model='Seedance 2.5',
                      aspect_ratio='16:9', resolution='480p', duration=5, draft_mode=True, task_id='draft-task', generate_audio=True,
                      user_id=self.user.id, created_at=now_ms(), updated_at=now_ms())
        values.update(fields)
        return Generation.objects.create(**values)

    def finalize(self, arguments, raw=None, mode='legacy'):
        return self.call(raw or self.raw, 'finalize_draft', {'wait': False, **arguments}, mode)

    def test_listing_and_annotations(self):
        self.assertNotIn('finalize_draft', self.tool_names(self.token(scopes=('veevee.read',))))
        async def find(client):
            return next(tool for tool in (await client.list_tools()).tools if tool.name == 'finalize_draft')
        for era in ERAS:
            hints = self.with_client(self.raw, era, find).annotations
            self.assertEqual((hints.read_only_hint, hints.destructive_hint, hints.idempotent_hint, hints.open_world_hint),
                             (False, False, True, True))

    def test_final_is_quoted_at_the_token_estimate_and_needs_the_user(self):
        raw = self.token(cap=5000)
        principal = authenticate_bearer(raw)
        for era in ERAS:
            source = self.draft()
            quoted = self.finalize({'id': str(source.id)}, raw=raw, mode=era).structured_content
            quote = quoted['quote']
            self.assertEqual((quoted['outcome'], quote['costCents'], quote['requiresUserConfirmation']), ('quote_required', 506, True))
            self.assertEqual(quote['summary'], 'Seedance 2.5 final, 5 s, 1080p (estimate; the final cost is reconciled from provider tokens)')
            self.assertEqual(quoted['next']['arguments'], {'id': str(source.id), 'wait': False, 'quoteToken': quote['token'],
                                                           'confirmedByUser': True})
            unconfirmed = {key: value for key, value in quoted['next']['arguments'].items() if key != 'confirmedByUser'}
            self.assertEqual(self.call(raw, 'finalize_draft', unconfirmed, era).structured_content['outcome'], 'quote_required')
            self.assertFalse(Generation.objects.filter(source_generation_id=source.id).exists())
            result = self.call(raw, 'finalize_draft', quoted['next']['arguments'], era)
            self.assert_structured(result, results.RESULT_SCHEMA)
            final = Generation.objects.get(pk=result.structured_content['generation']['id'])
            self.assertEqual((final.source_generation_id, final.draft_task_id, final.resolution, final.draft_mode, final.duration, final.user_id),
                             (source.id, 'draft-task', '1080p', False, 5, self.user.id))
            self.assertEqual((final.created_via, final.mcp_token_id), ('mcp', principal.token_id))
            self.assertEqual(controls.booked_cents('Seedance 2.5', final.cost_cents, 5, '1080p', None), 506)
            self.assertEqual(result.structured_content['generation']['related']['draftId'], str(source.id))
        audit = ActivityLog.objects.filter(action='mcp_tool_call').order_by('-created_at').first().detail
        self.assertEqual((audit['tool'], audit['costCents'], audit['generationId']), ('finalize_draft', 506, str(final.id)))
        self.assertTrue(audit['quoteId'])

    def test_an_in_flight_final_is_reused_and_charges_nothing(self):
        source = self.draft()
        raw = self.token(auto_approve=25, cap=10000)
        quoted = self.finalize({'id': str(source.id)}, raw=raw).structured_content
        first = self.call(raw, 'finalize_draft', quoted['next']['arguments']).structured_content
        again = self.finalize({'id': str(source.id)}, raw=raw).structured_content
        repeat = self.call(raw, 'finalize_draft', {**again['next']['arguments'], 'idempotencyKey': 'final-again-01'}).structured_content
        self.assertEqual(repeat['generation']['id'], first['generation']['id'])
        self.assertEqual(Generation.objects.filter(source_generation_id=source.id).count(), 1)
        # Only the one final is booked against the token: the reuse admitted and charged nothing.
        self.assertEqual(controls.spent_cents(self.user.id, token_id=authenticate_bearer(raw).token_id), 506)

    def test_web_texts_budget_and_replay(self):
        for fields, code, text in (({'draft_mode': False}, 'INVALID_INPUT', 'This generation is not a draft.'),
                                   ({'model': 'Seedance 2.0'}, 'INVALID_INPUT', 'Only Seedance 2.5 drafts can be finalized.'),
                                   ({'status': 'running'}, 'INVALID_INPUT', 'The draft must finish successfully before it can be finalized.')):
            with self.subTest(fields=fields):
                self.assertEqual(self.assert_tool_error(self.finalize({'id': str(self.draft(**fields).id)}), code)['message'], text)
        self.assertEqual(self.assert_tool_error(self.finalize({'id': str(uuid.uuid4())}), 'NOT_FOUND')['message'], 'Source generation not found.')
        source = self.draft()
        poor = self.token(cap=500)
        quoted = self.finalize({'id': str(source.id)}, raw=poor).structured_content
        self.assert_tool_error(self.call(poor, 'finalize_draft', quoted['next']['arguments']), 'BUDGET_EXCEEDED')
        self.assertFalse(Generation.objects.filter(source_generation_id=source.id).exists())
        quoted = self.finalize({'id': str(source.id), 'idempotencyKey': 'final-key-0001'}).structured_content
        first = self.call(self.raw, 'finalize_draft', quoted['next']['arguments']).structured_content
        Generation.objects.filter(pk=first['generation']['id']).update(status='succeeded')
        replay = self.call(self.raw, 'finalize_draft', quoted['next']['arguments']).structured_content
        self.assertEqual(replay['generation']['id'], first['generation']['id'])
        self.assertEqual(Generation.objects.filter(source_generation_id=source.id).count(), 1)

    def test_web_finalize_is_unchanged(self):
        source = self.draft()
        self.client.cookies['veevee_session'] = sign_session(self.user)
        response = self.client.post('/api/generate/video/finalize', {'sourceGenerationId': str(source.id)},
                                    content_type='application/json', HTTP_ORIGIN=SITE)
        self.assertEqual(response.status_code, 200, response.content)
        final = Generation.objects.get(pk=response.json()['id'])
        self.assertEqual((final.mcp_token_id, final.resolution, final.cost_cents), (None, '1080p', response.json()['costCents']))
        self.assertIsNone(final.created_via)

