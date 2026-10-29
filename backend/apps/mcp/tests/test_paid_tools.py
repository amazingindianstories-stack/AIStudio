"""Milestone 4: estimate_cost, generate_image, generate_video and cancel_generation over both protocol eras.

Quotes bind to the caller and the exact canonical arguments; budgets, rates and running-job limits are admitted in the
transaction that creates the row; retries replay through the shared receipts. No provider is ever called: the tools
only queue rows, and completion is simulated by updating the row.
"""
import asyncio
import os
import threading
import time
import uuid
from unittest.mock import Mock, patch

from django.db import connection
from django.test import override_settings

from apps.admin_dashboard.models import Pricing, UserLimit
from apps.authentication.session import sign_session
from apps.common.models import ActivityLog
from apps.generation.models import Generation
from apps.generation.services import cancellation, enqueue
from apps.generation.services.paid_guard import PaidBudgetHold
from apps.library.models import Folder
from apps.mcp import hold, quotes, results
from apps.mcp.runtime import db
from apps.mcp.tools import generations
from apps.mcp.tools.generations import CANCEL_SCHEMA
from apps.mcp.tools.generate import ESTIMATE_SCHEMA
from apps.mcp_auth import controls, policy
from apps.mcp_auth.principal import authenticate_bearer
from apps.projects.models import Project
from .support import ERAS, SITE, McpCase
from .test_results import FakeClock, StorageMixin, png_bytes

FOX = {'prompt': 'red fox in snow', 'wait': False}


def mid_minute():
    """Now, moved to the middle of its minute: rate windows cannot roll over mid-test."""
    now = int(time.time() * 1000)
    return now - now % 60000 + 30000


class PaidToolTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token()
        pinned = mid_minute()
        clock = patch('apps.mcp_auth.controls.now_ms', return_value=pinned)
        clock.start()
        self.addCleanup(clock.stop)

    def generate(self, arguments=None, tool='generate_image', raw=None, mode='legacy', headers=None):
        return self.call(raw or self.raw, tool, {**FOX, **(arguments or {})}, mode, headers)

    def submitted(self, result):
        self.assert_structured(result, results.RESULT_SCHEMA)
        return Generation.objects.get(pk=result.structured_content['generation']['id'])

    def parallel(self, raw, calls):
        async def use(client):
            return await asyncio.gather(*(client.call_tool(name, arguments) for name, arguments in calls))
        return self.with_client(raw, 'legacy', use)

    def audits(self):
        return list(ActivityLog.objects.filter(action='mcp_tool_call').order_by('created_at').values_list('detail', flat=True))

    def test_tools_are_listed_by_scope_with_their_annotations_and_live_model_enums(self):
        reader = self.token(scopes=('veevee.read',))
        self.assertIn('estimate_cost', self.tool_names(reader))
        self.assertFalse({'generate_image', 'generate_video', 'cancel_generation'} & set(self.tool_names(reader)))
        self.assert_tool_error(self.generate(raw=reader), 'INSUFFICIENT_SCOPE')

        async def tools(client):
            return {tool.name: tool for tool in (await client.list_tools()).tools}
        hints = lambda tool: (tool.annotations.read_only_hint, tool.annotations.destructive_hint,
                              tool.annotations.idempotent_hint, tool.annotations.open_world_hint)
        for era in ERAS:
            with override_settings(VEEVEE_KLING=False):
                found = self.with_client(self.raw, era, tools)
            self.assertEqual(hints(found['generate_image']), (False, False, True, True))
            self.assertEqual(hints(found['generate_video']), (False, False, True, True))
            self.assertEqual(hints(found['cancel_generation']), (False, True, True, True))
            self.assertEqual(hints(found['estimate_cost']), (True, False, True, False))
            image_models = found['generate_image'].input_schema['properties']['model']['enum']
            self.assertIn('nano-banana-2-1', image_models)
            self.assertNotIn('kling-image-3', image_models)
            self.assertIn('seedance-25', found['generate_video'].input_schema['properties']['model']['enum'])
        with override_settings(VEEVEE_KLING=True):
            self.assertIn('kling-image-3', self.with_client(self.raw, 'legacy', tools)['generate_image'].input_schema['properties']['model']['enum'])
            self.assertEqual(self.generate({'model': 'kling-image-3'}).structured_content['outcome'], 'running')
        with override_settings(VEEVEE_KLING=False):
            self.assert_tool_error(self.generate({'model': 'kling-image-3'}), 'INVALID_INPUT')

    def test_cheap_image_submits_at_once_with_agent_origin_and_an_audit(self):
        principal = authenticate_bearer(self.raw)
        for era in ERAS:
            result = self.generate({'prompt': f'red fox ({era})'}, mode=era)
            row = self.submitted(result)
            body = result.structured_content
            self.assertEqual((body['outcome'], body['quote'], body['generation']['status']), ('running', None, 'queued'))
            self.assertEqual(body['next']['tool'], 'get_generation')
            self.assertEqual(body['next']['arguments'], {'id': str(row.id), 'wait': True})
            self.assertEqual((row.model, row.resolution, row.aspect_ratio, row.cost_cents, row.user_id), ('Nano Banana 2.1', '1K', '1:1', 4, self.user.id))
            self.assertEqual((row.created_via, row.mcp_token_id, row.mcp_client_id), ('mcp', principal.token_id, None))
            self.assertEqual(body['generation']['createdVia'], 'mcp')
        audit = self.audits()[-1]
        self.assertEqual((audit['tool'], audit['generationId'], audit['costCents'], audit['outcome']),
                         ('generate_image', str(row.id), 4, 'running'))
        self.assertNotIn('red fox', str(self.audits()))

    def test_auto_approve_boundary(self):
        at_limit, below = self.token(auto_approve=4), self.token(auto_approve=3)
        self.assertEqual(self.generate(raw=at_limit).structured_content['outcome'], 'running')
        quoted = self.generate(raw=below)
        self.assert_structured(quoted, results.RESULT_SCHEMA)
        self.assertEqual(quoted.structured_content['outcome'], 'quote_required')
        self.assertEqual(Generation.objects.count(), 1)

    def test_quote_round_trip_and_binding(self):
        raw = self.token(auto_approve=0)
        first = self.generate({'resolution': '2K'}, raw=raw)
        self.assert_structured(first, results.RESULT_SCHEMA)
        body = first.structured_content
        quote, following = body['quote'], body['next']
        self.assertEqual((body['outcome'], body['generation'], quote['costCents'], quote['display']), ('quote_required', None, 6, '$0.06'))
        self.assertFalse(quote['requiresUserConfirmation'])
        self.assertEqual(following['tool'], 'generate_image')
        self.assertEqual(following['arguments'], {**FOX, 'resolution': '2K', 'quoteToken': quote['token']})
        self.assertEqual(Generation.objects.count(), 0)
        token = quote['token']
        # The token pays only for these arguments, this grant and this tool, and only until it expires.
        for changed in ({'resolution': '4K'}, {'prompt': 'grey wolf'}, {'aspectRatio': '16:9'}):
            again = self.generate({'resolution': '2K', **changed, 'quoteToken': token}, raw=raw)
            self.assertEqual(again.structured_content['outcome'], 'quote_required', changed)
        self.assertEqual(self.generate({'resolution': '2K', 'quoteToken': token}, raw=self.token(auto_approve=0)).structured_content['outcome'],
                         'quote_required')
        self.assertEqual(self.generate({'resolution': '2K', 'quoteToken': token[:-2] + 'xx'}, raw=raw).structured_content['outcome'],
                         'quote_required')
        with patch('apps.mcp.quotes.now_ms', return_value=int(time.time() * 1000) + quotes.TTL_MS + 1000):
            self.assertEqual(self.generate({'resolution': '2K', 'quoteToken': token}, raw=raw).structured_content['outcome'], 'quote_required')
        self.assertEqual(Generation.objects.count(), 0)
        paid_result = self.call(raw, following['tool'], following['arguments'])
        row = self.submitted(paid_result)
        self.assertEqual((paid_result.structured_content['quote']['costCents'], row.cost_cents), (6, 6))
        audit = self.audits()[-1]
        self.assertEqual((audit['outcome'], audit['costCents']), ('running', 6))
        self.assertRegex(audit['quoteId'], '^[0-9a-f]{16}$')
        self.assertEqual([detail['outcome'] for detail in self.audits()].count('quote_required'), 7)

    def test_jobs_at_or_above_a_dollar_need_the_users_confirmation(self):
        Pricing.objects.bulk_create([Pricing(model='Nano Banana 2.1', unit_cost_cents=100, unit='per_image', notes='')], ignore_conflicts=True)
        Pricing.objects.filter(model='Nano Banana 2.1').update(unit_cost_cents=100)
        first = self.generate().structured_content
        quote, following = first['quote'], first['next']
        self.assertTrue(quote['requiresUserConfirmation'])
        self.assertEqual((following['arguments']['confirmedByUser'], quote['display']), (True, '$1.00'))
        self.assertIn('Ask the user to approve $1.00', following['why'])
        unconfirmed = {key: value for key, value in following['arguments'].items() if key != 'confirmedByUser'}
        self.assertEqual(self.call(self.raw, 'generate_image', unconfirmed).structured_content['outcome'], 'quote_required')
        self.assertEqual(self.call(self.raw, 'generate_image', {**unconfirmed, 'confirmedByUser': False}).structured_content['outcome'],
                         'quote_required')
        self.assertEqual(Generation.objects.count(), 0)
        self.assertEqual(self.submitted(self.call(self.raw, 'generate_image', following['arguments'])).cost_cents, 100)

    def test_estimate_cost_is_read_only_and_its_token_pays_for_the_same_call(self):
        raw = self.token(auto_approve=0)
        for era in ERAS:
            estimate = self.call(raw, 'estimate_cost', {'tool': 'generate_image', 'arguments': {'prompt': 'red fox in snow'}}, era)
            self.assert_structured(estimate, ESTIMATE_SCHEMA)
            body = estimate.structured_content
            self.assertEqual((body['costCents'], body['autoApproves'], body['summary']), (4, False, 'Nano Banana 2.1, 1K, 1:1'))
        self.assertEqual(Generation.objects.count(), 0)
        self.assertNotIn('estimate_cost', [detail['tool'] for detail in self.audits()])
        # Explicit defaults and control arguments do not change what the quote binds to.
        result = self.generate({'model': 'nano-banana-2-1', 'aspectRatio': '1:1', 'resolution': '1K', 'quoteToken': body['token'],
                                'idempotencyKey': 'estimate-pays-1'}, raw=raw)
        self.assertEqual(self.submitted(result).cost_cents, 4)
        self.assert_tool_error(self.call(raw, 'estimate_cost', {'tool': 'generate_image', 'arguments': {}}), 'INVALID_INPUT')
        self.assert_tool_error(self.call(raw, 'estimate_cost', {'tool': 'generate_image', 'arguments': {'prompt': 'x', 'resolution': '9K'}}),
                               'INVALID_INPUT')
        self.assert_tool_error(self.call(raw, 'estimate_cost', {'tool': 'get_account', 'arguments': {}}), 'INVALID_INPUT')

    def test_web_refusals_pass_through_verbatim(self):
        UserLimit.objects.create(user_id=self.user.id, key='maxPromptLength', value='10', updated_at=1)
        error = self.assert_tool_error(self.generate(), 'INVALID_INPUT')
        self.assertIn('Prompt is too long (max 10 characters', error['message'])
        error = self.assert_tool_error(self.generate({'model': 'seedance-25', 'prompt': 'river', 'mode': 'edit'}, tool='generate_video'),
                                       'INVALID_INPUT')
        self.assertEqual(error['message'], 'Attach a reference clip to edit a video.')
        self.assertEqual(Generation.objects.count(), 0)

    def test_identical_calls_without_a_key_are_separate_jobs(self):
        # "4 images of X" as four identical wait=false calls in one minute: four jobs, four ids, four charges.
        made = [self.submitted(self.generate()) for _ in range(4)]
        self.assertEqual(len({row.id for row in made}), 4)
        self.assertEqual(sum(row.cost_cents for row in Generation.objects.all()), 4 * made[0].cost_cents)

    def test_idempotent_replay_and_conflict(self):
        keyed = self.submitted(self.generate({'idempotencyKey': 'agent-key-0001'}))
        self.assertEqual(self.submitted(self.generate({'idempotencyKey': 'agent-key-0001', 'wait': True, 'maxWaitSeconds': 1})).id, keyed.id)
        error = self.assert_tool_error(self.generate({'idempotencyKey': 'agent-key-0001', 'prompt': 'grey wolf'}), 'IDEMPOTENCY_CONFLICT')
        self.assertIn('Use a new key', error['message'])
        self.assertEqual(Generation.objects.count(), 1)

    def test_budget_refusal_names_get_account(self):
        raw = self.token(cap=10)
        for index in range(2):
            self.submitted(self.generate({'idempotencyKey': f'budget-key-{index}'}, raw=raw))
        error = self.assert_tool_error(self.generate({'idempotencyKey': 'budget-key-2'}, raw=raw), 'BUDGET_EXCEEDED')
        self.assertIn("$0.10 daily limit ($0.08 used", error['message'])
        self.assertTrue(error['message'].endswith('Veevee Settings. get_account shows what you have spent and your limits.'))
        self.assertEqual(error['next']['tool'], 'get_account')
        self.assertEqual(Generation.objects.count(), 2)

    def test_parallel_submissions_cannot_overshoot_the_budget(self):
        raw = self.token(cap=10)
        found = self.parallel(raw, [('generate_image', {**FOX, 'idempotencyKey': f'race-key-{index}'}) for index in range(4)])
        codes = sorted('ok' if not result.is_error else result.structured_content['code'] for result in found)
        self.assertEqual(codes, ['BUDGET_EXCEEDED', 'BUDGET_EXCEEDED', 'ok', 'ok'])
        self.assertEqual(Generation.objects.filter(created_via='mcp').count(), 2)

    def test_running_job_limit_under_parallel_submissions(self):
        UserLimit.objects.create(user_id=self.user.id, key=policy.ACTIVE_JOBS_LIMIT, value='2', updated_at=1)
        found = self.parallel(self.raw, [('generate_image', {**FOX, 'idempotencyKey': f'busy-key-{index}'}) for index in range(5)])
        codes = sorted('ok' if not result.is_error else result.structured_content['code'] for result in found)
        self.assertEqual(codes, ['CONCURRENCY_LIMIT'] * 3 + ['ok'] * 2)
        self.assertEqual(Generation.objects.count(), 2)
        Generation.objects.update(status='succeeded')
        self.submitted(self.generate({'idempotencyKey': 'busy-key-after'}))

    def test_paid_rate_limit(self):
        with patch.dict(policy.RATE_LIMITS, paid_minute=(2, 60)):
            for index in range(2):
                self.submitted(self.generate({'idempotencyKey': f'rate-key-{index}'}))
            error = self.assert_tool_error(self.generate({'idempotencyKey': 'rate-key-2'}), 'RATE_LIMITED')
        self.assertGreaterEqual(error['retryAfterSeconds'], 1)
        self.assertEqual(Generation.objects.count(), 2)

    def test_paid_guard_hold_is_an_error_and_creates_nothing(self):
        with patch.object(enqueue, 'persist', side_effect=PaidBudgetHold('Paid Preview budget unavailable or exhausted; no provider submission occurred.')):
            error = self.assert_tool_error(self.generate(), 'PAID_BUDGET_HOLD')
        self.assertIn('Try again in a few minutes.', error['message'])
        self.assertEqual(Generation.objects.count(), 0)

    def test_a_higher_price_at_submission_asks_for_a_new_quote(self):
        with patch.object(enqueue, 'prepare_image', return_value={'costCents': 30}):
            body = self.generate().structured_content
        self.assertEqual((body['outcome'], body['quote']['costCents']), ('quote_required', 30))
        self.assertEqual(Generation.objects.count(), 0)

    def test_wait_false_and_wait_true_return_the_same_result(self):
        submitted = self.generate({'idempotencyKey': 'wait-both-01'}).structured_content
        identifier = submitted['generation']['id']
        self.assertEqual(submitted, self.call(self.raw, 'get_generation', {'id': identifier}).structured_content)
        began = time.monotonic()
        waited = self.generate({'idempotencyKey': 'wait-both-01', 'wait': True, 'maxWaitSeconds': 1}).structured_content
        self.assertGreaterEqual(time.monotonic() - began, 0.9)
        self.assertEqual(waited, submitted)

    def test_wait_returns_the_finished_image(self):
        identifier = uuid.uuid4()
        url = self.store(f'generations/{identifier}.png', png_bytes(), 'image/png')

        def finish():
            Generation.objects.filter(created_via='mcp').update(status='succeeded', url=url, completed_at=int(time.time() * 1000))
            connection.close()
        timer = threading.Timer(1.5, finish)
        timer.start()
        self.addCleanup(timer.cancel)
        result = self.generate({'wait': True, 'maxWaitSeconds': 10})
        self.assert_structured(result, results.RESULT_SCHEMA)
        self.assertEqual((result.structured_content['outcome'], result.structured_content['next']), ('completed', None))
        self.assertEqual([block.type for block in result.content], ['text', 'image', 'resource_link'])

    def test_a_job_finishing_as_the_wait_ends_answers_without_making_derivatives(self):
        identifier = uuid.uuid4()
        url = self.store(f'generations/{identifier}.png', png_bytes(), 'image/png')

        def finish(generation_id):
            Generation.objects.filter(pk=generation_id).update(status='succeeded', url=url, completed_at=int(time.time() * 1000))

        async def finished_as_the_wait_ran_out(call, generation_id, **options):
            call.started = time.monotonic() - 45
            await db(finish, generation_id)
        with patch.object(hold, 'hold', finished_as_the_wait_ran_out):
            began = time.monotonic()
            result = self.generate({'wait': True})
        self.assertLess(time.monotonic() - began, 5)
        self.assert_structured(result, results.RESULT_SCHEMA)
        body = result.structured_content
        urls = body['generation']['outputs'][0]['urls']
        self.assertEqual((body['outcome'], urls['thumbnail'], urls['poster']), ('completed', None, None))
        self.assertIsNotNone(urls['original'])
        self.assertIsNotNone(urls['preview'])                                 # the master stands in for the preview
        self.assertEqual([block.type for block in result.content], ['text', 'resource_link'])
        self.assertFalse(self.storage.exists(f'thumbs/512/generations/{identifier}.png.webp'))
        # The next call has its own time and makes them.
        again = self.call(self.raw, 'get_generation', {'id': body['generation']['id']})
        self.assertIsNotNone(again.structured_content['generation']['outputs'][0]['urls']['thumbnail'])
        self.assertEqual([block.type for block in again.content], ['text', 'image', 'resource_link'])
        self.assertTrue(self.storage.exists(f'thumbs/512/generations/{identifier}.png.webp'))

    def test_the_hold_stops_45_seconds_after_the_call_began(self):
        clock, real = FakeClock(), hold.hold

        async def fake(call, identifier, **options):
            call.started, clock.now = 0.0, 30.0              # submitting took 30 s of the call
            return await real(call, identifier, clock=clock, sleep=clock.sleep, **options)
        with patch.object(hold, 'hold', fake):
            body = self.generate({'wait': True}).structured_content
        self.assertEqual((body['outcome'], clock.now), ('running', 45.0))
        self.assertEqual(clock.sleeps, [1.0] * 10 + [2.0] * 2 + [1.0])

    def test_references_and_location(self):
        project = Project.objects.create(name='Winter', created_at=1, updated_at=1)
        folder = Folder.objects.create(project=project, name='Hero shots', created_at=1)
        source = Generation.objects.create(id=uuid.uuid4(), kind='image', status='succeeded', prompt='source', model='Nano Banana 2.1',
                                           aspect_ratio='1:1', url='/api/media/generations/source.png', created_at=1, updated_at=1)
        clip = Generation.objects.create(id=uuid.uuid4(), kind='video', status='succeeded', prompt='clip', model='Seedance 2.5',
                                         aspect_ratio='16:9', url='/api/media/generations/clip.mov', created_at=1, updated_at=1)
        row = self.submitted(self.generate({'referenceIds': [str(source.id).upper()], 'folderId': str(folder.id)}))
        self.assertEqual((row.reference_images, row.folder_id, row.project_id), (['/api/media/generations/source.png'], folder.id, project.id))
        self.assertEqual(self.submitted(self.generate({'projectId': str(project.id), 'prompt': 'in project'})).project_id, project.id)
        self.assert_tool_error(self.generate({'referenceIds': [str(uuid.uuid4())]}), 'NOT_FOUND')
        self.assert_tool_error(self.generate({'referenceIds': [str(clip.id)]}), 'INVALID_INPUT')
        self.assert_tool_error(self.generate({'folderId': str(uuid.uuid4())}), 'NOT_FOUND')
        self.assert_tool_error(self.generate({'projectId': str(uuid.uuid4())}), 'NOT_FOUND')
        self.assert_tool_error(self.generate({'folderId': str(folder.id), 'projectId': str(uuid.uuid4())}), 'INVALID_INPUT')

    def test_video_defaults_draft_and_the_seedance_price(self):
        raw = self.token(cap=5000, auto_approve=100)
        first = self.generate({'model': 'seedance-25', 'prompt': 'river at dawn'}, tool='generate_video', raw=raw).structured_content
        quote = first['quote']
        # Seedance 2.5 is quoted at its current token estimate ($5.06 for 5 s at 1080p), not the web placeholder, so the
        # user confirms it whatever the auto-approve amount.
        self.assertEqual((first['outcome'], quote['costCents'], quote['requiresUserConfirmation']), ('quote_required', 506, True))
        self.assertEqual(quote['summary'], 'Seedance 2.5, 5 s, 1080p, 16:9, audio on (estimate; the final cost is reconciled from provider tokens)')
        row = self.submitted(self.call(raw, 'generate_video', first['next']['arguments']))
        self.assertEqual((row.model, row.resolution, row.duration, row.aspect_ratio, row.generate_audio, row.draft_mode, row.bitrate_mode),
                         ('Seedance 2.5', '1080p', 5, '16:9', True, False, 'high'))
        self.assertEqual((row.cost_cents, controls.booked_cents('Seedance 2.5', row.cost_cents, 5, '1080p', None)), (98, 506))
        self.assertEqual(self.call(raw, 'get_account').structured_content['spend']['tokenTodayCents'], 506)
        self.assertEqual(self.audits()[-1]['costCents'], 506)
        # The row keeps the web estimate; bookedCents is what get_account counts, and the note says why they differ.
        cost = lambda: self.call(raw, 'get_generation', {'id': str(row.id)}).structured_content['generation']['cost']
        self.assertEqual(cost(), {'cents': 98, 'display': '$0.98', 'basis': 'estimated', 'bookedCents': 506,
                                  'note': 'Billed from provider tokens when it finishes; counted at $5.06 until then.'})
        draft = self.submitted(self.generate({'model': 'seedance-25', 'prompt': 'river at dusk', 'draft': True}, tool='generate_video', raw=raw))
        self.assertEqual((draft.resolution, draft.draft_mode), ('480p', True))
        self.assertEqual(controls.booked_cents('Seedance 2.5', draft.cost_cents, 5, '480p', None), 53)
        self.assertEqual(controls.spent_cents(self.user.id), 506 + 53)
        Generation.objects.filter(pk=row.pk).update(status='succeeded', cost_basis='reconciled', cost_cents=462)
        self.assertEqual(controls.spent_cents(self.user.id), 462 + 53)
        self.assertEqual(cost(), {'cents': 462, 'display': '$4.62', 'basis': 'reconciled', 'bookedCents': 462})
        Generation.objects.filter(pk=draft.pk).update(status='cancelled', cost_basis='cancelled_billing_unconfirmed')
        self.assertEqual(controls.spent_cents(self.user.id), 462 + draft.cost_cents)
        Generation.objects.filter(pk=draft.pk).update(cost_basis='cancelled_before_submission')
        self.assertEqual(controls.spent_cents(self.user.id), 462)
        cancelled = self.call(raw, 'get_generation', {'id': str(draft.id)}).structured_content['generation']['cost']
        self.assertEqual((cancelled['bookedCents'], 'note' in cancelled), (0, False))

    def test_the_default_token_cap_holds_one_seedance_final(self):
        raw = self.token()                                   # $10 a day
        def final(prompt, key):
            quoted = self.generate({'model': 'seedance-25', 'prompt': prompt, 'idempotencyKey': key}, tool='generate_video', raw=raw)
            return self.call(raw, 'generate_video', quoted.structured_content['next']['arguments'])
        self.submitted(final('tide', 'tide-0001'))
        error = self.assert_tool_error(final('surf', 'surf-0001'), 'BUDGET_EXCEEDED')
        self.assertIn('This $5.06 job would pass', error['message'])
        self.assertEqual(Generation.objects.count(), 1)

    def test_confirmation_wins_over_auto_approve(self):
        Pricing.objects.bulk_create([Pricing(model='Nano Banana 2.1', unit_cost_cents=100, unit='per_image', notes='')], ignore_conflicts=True)
        Pricing.objects.filter(model='Nano Banana 2.1').update(unit_cost_cents=100)
        raw = self.token(auto_approve=100)
        body = self.generate(raw=raw).structured_content
        self.assertEqual((body['outcome'], body['quote']['costCents'], body['quote']['requiresUserConfirmation']), ('quote_required', 100, True))
        self.assertIs(body['next']['arguments']['confirmedByUser'], True)
        estimate = self.call(raw, 'estimate_cost', {'tool': 'generate_image', 'arguments': {'prompt': 'red fox in snow'}}).structured_content
        self.assertEqual((estimate['costCents'], estimate['autoApproves'], estimate['requiresUserConfirmation']), (100, False, True))
        self.assertEqual(Generation.objects.count(), 0)
        Pricing.objects.filter(model='Nano Banana 2.1').update(unit_cost_cents=99)
        self.assertEqual(self.submitted(self.generate(raw=raw)).cost_cents, 99)
        # A price that rises to $1 between pricing and submission asks again instead of submitting unconfirmed.
        with patch.object(enqueue, 'prepare_image', return_value={'costCents': 100}):
            body = self.generate({'idempotencyKey': 'rises-to-a-dollar'}, raw=raw).structured_content
        self.assertEqual((body['outcome'], body['quote']['requiresUserConfirmation']), ('quote_required', True))
        self.assertEqual(Generation.objects.count(), 1)

    def test_a_quote_pays_for_one_job(self):
        raw = self.token(auto_approve=0)
        arguments = self.generate(raw=raw).structured_content['next']['arguments']
        self.assertNotIn('idempotencyKey', arguments)
        # A refused submission leaves its quote unused.
        with patch.dict(policy.RATE_LIMITS, paid_minute=(0, 60)):
            self.assert_tool_error(self.call(raw, 'generate_image', arguments), 'RATE_LIMITED')
        row = self.submitted(self.call(raw, 'generate_image', arguments))
        # A confirmed job whose reply was lost, retried minutes later with the same quote (with or without a new key):
        # the job the quote paid for comes back, nothing is re-quoted and nothing more is charged.
        later = patch('apps.mcp_auth.controls.now_ms', return_value=mid_minute() + 180_000)
        later.start()
        self.addCleanup(later.stop)
        for retry in (arguments, {**arguments, 'idempotencyKey': 'quote-once-2'}):
            again = self.call(raw, 'generate_image', retry)
            self.assert_structured(again, results.RESULT_SCHEMA)
            body = again.structured_content
            self.assertEqual((body['outcome'], body['generation']['id'], body['quote']['token']),
                             ('running', str(row.id), arguments['quoteToken']))
            self.assertEqual(self.audits()[-1]['quoteId'], self.audits()[-2]['quoteId'])
        self.assertEqual(Generation.objects.count(), 1)
        # Another token cannot use the quote, and a new quote pays for a new job.
        self.assertEqual(self.call(self.token(auto_approve=0), 'generate_image', arguments).structured_content['outcome'],
                         'quote_required')
        fresh = self.generate(raw=raw).structured_content['next']['arguments']
        self.assertNotEqual(self.submitted(self.call(raw, 'generate_image', fresh)).id, row.id)
        self.assertEqual(Generation.objects.count(), 2)

    def test_a_quote_whose_job_was_deleted_is_not_found_and_pays_for_nothing_new(self):
        raw = self.token(auto_approve=0)
        arguments = self.generate(raw=raw).structured_content['next']['arguments']
        row = self.submitted(self.call(raw, 'generate_image', arguments))
        Generation.objects.filter(pk=row.id).delete()
        for wait in (False, True):
            began = time.monotonic()
            error = self.assert_tool_error(self.call(raw, 'generate_image', {**arguments, 'wait': wait}), 'NOT_FOUND')
            self.assertLess(time.monotonic() - began, 5)                   # a vanished job ends the wait at once
            self.assertIn('search_generations', error['message'])
        self.assertEqual(Generation.objects.count(), 0)

    def test_web_submissions_keep_no_agent_origin(self):
        self.client.cookies['veevee_session'] = sign_session(self.user)
        response = self.client.post('/api/generate/image', {'prompt': 'web fox', 'model': 'Nano Banana 2.1'}, content_type='application/json',
                                    HTTP_ORIGIN=SITE)
        self.assertEqual(response.status_code, 200, response.content)
        self.assertNotIn('createdVia', response.json())
        row = Generation.objects.get()
        self.assertEqual((row.created_via, row.mcp_token_id, row.mcp_client_id), (None, None, None))


class CancelTests(StorageMixin, McpCase):
    def setUp(self):
        super().setUp()
        self.use_storage()
        self.raw = self.token()

    def row(self, **fields):
        values = dict(id=uuid.uuid4(), kind='video', status='queued', prompt='river', model='Seedance 2.5', aspect_ratio='16:9',
                      resolution='1080p', duration=5, user_id=self.user.id, cost_cents=98, cost_basis='estimated', created_at=1, updated_at=1)
        values.update(fields)
        return Generation.objects.create(**values)

    def cancel(self, row, raw=None, mode='legacy'):
        return self.call(raw or self.raw, 'cancel_generation', {'id': str(row.id)}, mode)

    def test_a_queued_job_is_cancelled_for_free_in_both_eras(self):
        for era in ERAS:
            row = self.row()
            result = self.cancel(row, mode=era)
            self.assert_structured(result, CANCEL_SCHEMA)
            body = result.structured_content
            self.assertEqual((body['outcome'], body['cancellation'], body['generation']['status']), ('cancelled', 'cancelled', 'cancelled'))
            row.refresh_from_db()
            self.assertEqual((row.status, row.cost_cents, row.cost_basis), ('cancelled', 0, 'cancelled_before_submission'))
        audit = ActivityLog.objects.filter(action='mcp_tool_call').latest('created_at').detail
        self.assertEqual((audit['tool'], audit['generationId'], audit['outcome']), ('cancel_generation', str(row.id), 'cancelled'))

    def test_owner_or_admin_only(self):
        row = self.row(user_id=self.admin.id)
        self.assert_tool_error(self.cancel(row), 'FORBIDDEN')
        self.assertEqual(Generation.objects.get(pk=row.pk).status, 'queued')
        mine = self.row()
        admin = self.token(self.admin)
        self.assertEqual(self.cancel(mine, raw=admin).structured_content['cancellation'], 'cancelled')
        self.assert_tool_error(self.call(self.raw, 'cancel_generation', {'id': str(uuid.uuid4())}), 'NOT_FOUND')

    def test_states_that_cannot_be_cancelled(self):
        image = self.row(kind='image', model='Nano Banana 2.1', resolution='1K', duration=None)
        self.assertEqual(self.cancel(image).structured_content['cancellation'], 'not_cancellable')
        finished = self.row(status='succeeded', completed_at=2)
        body = self.cancel(finished).structured_content
        self.assertEqual((body['cancellation'], body['outcome']), ('too_late', 'completed'))

    def settle_later(self, get_status, cancel):
        """The generation worker sending the deferred cancel while the tool holds, as it does in production."""
        def run():
            from apps.generation.services import poller
            deps = poller.Dependencies(mock=lambda: False, get_video=get_status, publish=lambda row: None)
            try:
                deadline = time.monotonic() + 10
                while not cancellation.pending_cancellations() and time.monotonic() < deadline:
                    time.sleep(0.05)
                for identifier in cancellation.pending_cancellations():
                    cancellation.settle_pending(identifier, env={}, adapters={'byteplus': (get_status, cancel)},
                                                advance=lambda item, **kw: poller.advance(item, dependencies=deps, **kw))
            finally:
                connection.close()
        worker = threading.Thread(target=run)
        worker.start()
        self.addCleanup(worker.join)
        return worker

    def test_a_job_with_a_provider_task_is_cancelled_by_the_generation_worker(self):
        row = self.row(task_id='cgt-remote-1', submitted_at=2)
        cancel = Mock()
        self.settle_later(Mock(side_effect=[{'status': 'queued'}, {'status': 'cancelled'}]), cancel)
        with patch.dict(os.environ, {'MOCK_GENERATION': '0'}), patch.dict(cancellation.ADAPTERS, {
                'byteplus': (Mock(side_effect=AssertionError('no provider call from mcp')),) * 2}):
            result = self.cancel(row)
        self.assert_structured(result, CANCEL_SCHEMA)
        body = result.structured_content
        cancel.assert_called_once()
        self.assertEqual((body['cancellation'], body['message'], body['outcome'], body['generation']['status']),
                         ('cancelled', None, 'cancelled', 'cancelled'))
        row.refresh_from_db()
        self.assertEqual((row.cancellation_state, row.cost_cents, row.cost_basis), ('confirmed', 98, 'cancelled_billing_unconfirmed'))

    def test_a_job_deleted_during_the_cancel_hold_is_not_found(self):
        row = self.row(task_id='cgt-deleted', submitted_at=2)

        def delete(identifier):
            Generation.objects.filter(pk=identifier).delete()

        async def deleted_while_holding(call, identifier, **options):
            await db(delete, identifier)
        with patch.object(hold, 'hold', deleted_while_holding):
            error = self.assert_tool_error(self.cancel(row), 'NOT_FOUND')
        self.assertIn('search_generations', error['message'])
        self.assertFalse(Generation.objects.filter(pk=row.pk).exists())

    def test_a_deferred_cancel_reports_requested_too_late_or_uncertain(self):
        waiting = self.row(task_id='cgt-nobody-home', submitted_at=2)
        began = time.monotonic()
        with patch.object(generations, 'CANCEL_WAIT_SECONDS', 1):
            body = self.cancel(waiting).structured_content       # no worker ran within the hold
        self.assertGreaterEqual(time.monotonic() - began, 0.9)
        self.assertEqual((body['cancellation'], body['message'], body['outcome']), ('requested', cancellation.DEFERRED, 'running'))
        self.assertEqual(Generation.objects.get(pk=waiting.pk).cancellation_state, 'pending')
        Generation.objects.filter(pk=waiting.pk).update(status='succeeded', cancellation_state=None, completed_at=3)
        started = self.row(task_id='cgt-started', submitted_at=2)
        worker = self.settle_later(Mock(return_value={'status': 'running'}), Mock())
        body = self.cancel(started).structured_content
        worker.join()
        self.assertEqual((body['cancellation'], body['message'], body['outcome']), ('too_late', generations.REFUSED, 'running'))
        unsure = self.row(task_id='cgt-unsure', submitted_at=2)
        self.settle_later(Mock(return_value={'status': 'queued'}), Mock(side_effect=TimeoutError('unknown')))
        body = self.cancel(unsure).structured_content
        self.assertEqual((body['cancellation'], body['message']), ('requested', generations.CONFIRMING))
        self.assertEqual(Generation.objects.get(pk=unsure.pk).cancellation_state, 'uncertain')
