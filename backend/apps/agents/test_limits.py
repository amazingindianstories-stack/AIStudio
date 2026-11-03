"""The Agents tab's admin limits: the switch, per-user and global values, step checks, pausing and the shared budget."""
import json
import uuid

from django.db import transaction
from django.test import override_settings

from apps.admin_dashboard.models import AppSetting, UserLimit
from apps.generation.models import Generation
from apps.mcp.tests.support import McpCase
from apps.mcp_auth import controls, policy
from . import limits
from .grants import agent_principal, ensure_grant
from .models import AgentConversation, AgentGrant, AgentLlmUsage, AgentRun

NOW = 1_800_000_000_000
HOUR = 3_600_000


class LimitsCase(McpCase):
    def setting(self, key, value):
        AppSetting.objects.update_or_create(key=key, defaults={'value': str(value), 'updated_at': 1})

    def override(self, user, key, value):
        UserLimit.objects.update_or_create(user_id=user.id, key=key, defaults={'value': str(value), 'updated_at': 1})

    def run_for(self, user, **values):
        conversation = AgentConversation.objects.create(project_id=uuid.uuid4(), name='c', user_id=user.id, created_at=1, updated_at=1)
        grant = ensure_grant(user.id)
        fields = {'conversation_id': conversation.id, 'user_id': user.id, 'grant_id': grant.id, 'model': 'm', 'created_at': NOW, 'updated_at': NOW,
                  'status': 'running'}
        return AgentRun.objects.create(**{**fields, **values})

    def usage(self, user, micro, *, created_at=NOW, run=None, grant=None):
        return AgentLlmUsage.objects.create(user_id=user.id, grant_id=grant or (run.grant_id if run else None), run_id=run.id if run else None,
                                            model='m', purpose='loop', prompt_tokens=1, cached_tokens=0, output_tokens=1, thoughts_tokens=0,
                                            tool_prompt_tokens=0, total_tokens=2, cost_microcents=micro, created_at=created_at)

    def generation(self, user, cost, *, created_at=NOW, token_id=None):
        return Generation.objects.create(id=uuid.uuid4(), kind='image', status='succeeded', prompt='p', model='Nano Banana 2.1', aspect_ratio='1:1',
                                         user_id=user.id, cost_cents=cost, cost_basis='estimated', created_at=created_at, updated_at=1,
                                         created_via='agent', mcp_token_id=token_id)


class LimitValueTests(LimitsCase):
    def test_per_user_row_beats_global_setting_beats_default(self):
        self.assertEqual(limits.run_limits(self.user.id), {'agentActiveRuns': 2, 'agentMaxStepsPerRun': 40, 'agentMaxRunCostCents': 1000})
        self.setting('agentMaxStepsPerRun', 60)
        self.setting('agentActiveRuns', 3)
        self.override(self.user, 'agentMaxStepsPerRun', 10)
        self.assertEqual(limits.run_limits(self.user.id), {'agentActiveRuns': 3, 'agentMaxStepsPerRun': 10, 'agentMaxRunCostCents': 1000})
        self.assertEqual(limits.run_limits(self.admin.id)['agentMaxStepsPerRun'], 60)

    def test_global_only_limits_ignore_user_rows(self):
        self.override(self.user, 'agentMaxConcurrentRuns', 1)
        self.setting('agentGlobalDailyCapCents', 5000)
        self.assertEqual(limits.global_limits(), {'agentGlobalDailyCapCents': 5000, 'agentMaxConcurrentRuns': 8})

    def test_attachment_limits_resolve_per_user_with_bool_switches(self):
        self.assertEqual(limits.attachment_limits(self.user.id), {'maxMb': 20, 'maxVideoSeconds': 300, 'maxAudioSeconds': 600, 'images': True,
                                                                  'documents': True, 'video': True, 'audio': True})
        self.setting('agentAttachVideo', 0)
        self.override(self.user, 'agentAttachMaxMb', 5)
        self.override(self.admin, 'agentAttachVideo', 1)
        self.assertEqual((limits.attachment_limits(self.user.id)['video'], limits.attachment_limits(self.user.id)['maxMb']), (False, 5))
        self.assertTrue(limits.attachment_limits(self.admin.id)['video'])

    def test_agents_enabled_resolution_table(self):
        member, admin = self.user, self.admin
        self.assertEqual((limits.agents_enabled(admin), limits.agents_enabled(member)), (True, False), 'unset: admins only')
        self.assertEqual((limits.agents_enabled(admin.id), limits.agents_enabled(member.id)), (True, False), 'user ids resolve the role')
        self.override(member, 'agentsEnabled', 1)
        self.override(admin, 'agentsEnabled', 0)
        self.assertEqual((limits.agents_enabled(admin), limits.agents_enabled(member)), (False, True), 'per-user rows win over the default')
        UserLimit.objects.all().delete()
        self.setting('agentsEnabled', 1)
        self.assertEqual((limits.agents_enabled(admin), limits.agents_enabled(member)), (True, True), 'global 1: on for all')
        self.override(member, 'agentsEnabled', 0)
        self.assertEqual(limits.agents_enabled(member), False, 'global 1 yields to a per-user 0')
        self.override(member, 'agentsEnabled', 1)
        self.setting('agentsEnabled', 0)
        self.assertEqual((limits.agents_enabled(admin), limits.agents_enabled(member)), (False, False), 'global 0 is a kill switch')
        self.setting('agentsEnabled', 'garbage')
        self.assertEqual((limits.agents_enabled(admin), limits.agents_enabled(member)), (True, True), 'an unparsable global row is unset')


class SpendTests(LimitsCase):
    def test_user_spend_includes_llm_cost_rounded_up_once_on_the_sum(self):
        self.generation(self.user, 100, created_at=NOW)
        for _ in range(3):
            self.usage(self.user, 400_000, created_at=NOW)                  # 3 x 0.4 cent: 2 cents, not 3
        self.usage(self.user, 10 ** 9, created_at=NOW - controls.policy.DAY_MS - 1)
        self.usage(self.admin, 5_000_000, created_at=NOW)
        self.assertEqual(controls.spent_cents(self.user.id, now=NOW), 102)
        self.assertEqual(limits.llm_spend_cents(user_id=self.user.id, now=NOW), 2)

    def test_token_spend_adds_llm_rows_only_for_an_agent_grant(self):
        grant = ensure_grant(self.user.id)
        self.generation(self.user, 100, token_id=grant.id)
        self.usage(self.user, 3_000_000, grant=grant.id)
        self.usage(self.user, 9_000_000, grant=uuid.uuid4())
        self.assertEqual(controls.spent_cents(self.user.id, token_id=grant.id, now=NOW), 103)
        mcp_token = uuid.uuid4()
        self.generation(self.user, 40, token_id=mcp_token)
        self.usage(self.user, 7_000_000, grant=mcp_token)
        self.assertEqual(controls.spent_cents(self.user.id, token_id=mcp_token, now=NOW), 40, 'MCP tokens stay generation-only')

    def principal(self, user):
        return agent_principal(ensure_grant(user.id).id)

    def test_admission_counts_llm_cost_against_the_user_cap(self):
        self.override(self.user, 'mcpDailyCapCents', 500)
        principal = self.principal(self.user)
        self.usage(self.user, 450 * 1_000_000)
        with self.assertRaises(controls.BudgetExceeded) as refused, transaction.atomic():
            controls.admit_paid_submission(principal, 100, now=NOW)
        self.assertIn('$5.00 daily agent limit ($4.50 used', refused.exception.message)
        with transaction.atomic():
            controls.admit_paid_submission(principal, 50, now=NOW)

    def test_the_global_cap_is_left_to_check_step_not_admission(self):
        self.setting('agentGlobalDailyCapCents', 1000)
        self.override(self.user, 'mcpDailyCapCents', 100000)
        self.override(self.user, 'agentsEnabled', 1)
        self.usage(self.admin, 600 * 1_000_000)                             # another user's model spend
        self.generation(self.admin, 300)                                    # and generation
        self.assertEqual(controls.global_spent_cents(now=NOW), 900)
        with transaction.atomic():
            controls.admit_paid_submission(self.principal(self.user), 200, now=NOW)
        hit = limits.check_step(self.run_for(self.user), cost_cents=200, now=NOW)
        self.assertEqual((hit.kind, hit.scope), ('global_daily_cap', 'global'))
        self.assertIn('all agents together', hit.message)


class StepTests(LimitsCase):
    def test_check_step_kinds_in_order(self):
        run = self.run_for(self.user)
        self.assertEqual(limits.check_step(run, now=NOW).kind, 'disabled')  # members are off by default
        self.override(self.user, 'agentsEnabled', 1)
        self.assertIsNone(limits.check_step(run, now=NOW))
        self.setting('agentMaxStepsPerRun', 5)
        run.step_count = 5
        self.assertEqual(limits.check_step(run, now=NOW).kind, 'steps')
        self.assertIsNone(limits.check_step(run, count_step=False, now=NOW), 'a replayed step is not counted again')
        run.step_count = 4
        self.setting('agentMaxRunCostCents', 100)
        run.cost_cents = 60
        self.usage(self.user, 30 * 1_000_000, run=run)
        self.assertIsNone(limits.check_step(run, cost_cents=10, now=NOW))
        hit = limits.check_step(run, cost_cents=11, now=NOW)
        self.assertEqual((hit.kind, hit.resume_after_ms, hit.scope), ('run_cost', None, 'user'))
        self.setting('agentMaxRunCostCents', 100000)
        self.setting('agentsEnabled', 0)
        hit = limits.check_step(run, now=NOW)
        self.assertEqual((hit.kind, hit.resume_after_ms), ('disabled', NOW + limits.SWITCH_RETRY_MS), 'retried until switched back on')

    def test_daily_caps_report_when_the_window_frees_capacity(self):
        self.override(self.user, 'agentsEnabled', 1)
        self.override(self.user, 'mcpDailyCapCents', 1000)
        run = self.run_for(self.user)
        self.generation(self.user, 600, created_at=NOW - 20 * HOUR)
        self.generation(self.user, 300, created_at=NOW - 5 * HOUR)
        self.usage(self.user, 50 * 1_000_000, created_at=NOW - 2 * HOUR)
        hit = limits.check_step(run, cost_cents=100, now=NOW)               # 950 + 100 passes 1000 by 50: the oldest row frees it
        self.assertEqual((hit.kind, hit.scope, hit.resume_after_ms), ('daily_cap', 'user', NOW - 20 * HOUR + 24 * HOUR))
        hit = limits.check_step(run, cost_cents=750, now=NOW)               # needs 700 freed: both older rows
        self.assertEqual(hit.resume_after_ms, NOW - 5 * HOUR + 24 * HOUR)
        self.assertIsNone(limits.check_step(run, cost_cents=1001, now=NOW).resume_after_ms, 'a step bigger than the cap never fits')
        self.override(self.user, 'mcpDailyCapCents', 100000)
        self.setting('agentGlobalDailyCapCents', 1000)
        hit = limits.check_step(run, cost_cents=100, now=NOW)
        self.assertEqual((hit.kind, hit.scope, hit.resume_after_ms), ('global_daily_cap', 'global', NOW - 20 * HOUR + 24 * HOUR))

    def test_the_agents_tab_grant_cap_pauses_before_the_user_cap(self):
        self.override(self.user, 'agentsEnabled', 1)
        self.override(self.user, 'mcpDailyCapCents', 5000)
        self.setting('agentMaxRunCostCents', 100000)
        run = self.run_for(self.user)
        AgentGrant.objects.filter(pk=run.grant_id).update(daily_cap_cents=1000)
        self.generation(self.user, 400, created_at=NOW - 20 * HOUR, token_id=run.grant_id)
        self.generation(self.user, 2000, created_at=NOW - 22 * HOUR, token_id=uuid.uuid4())    # another connection: user cap only
        self.usage(self.user, 550 * 1_000_000, created_at=NOW - 3 * HOUR, run=run)
        self.assertIsNone(limits.check_step(run, cost_cents=50, now=NOW))
        hit = limits.check_step(run, cost_cents=100, now=NOW)               # 950 + 100 passes the grant's 1000 by 50
        self.assertEqual((hit.kind, hit.scope, hit.cost_cents), ('grant_daily_cap', 'user', 100))
        self.assertEqual(hit.resume_after_ms, NOW - 20 * HOUR + 24 * HOUR, 'only the grant\'s own rows free its window')
        self.assertIn('$10.00', hit.message)
        self.assertIsNone(limits.check_step(run, cost_cents=1001, now=NOW).resume_after_ms)

    def test_first_refusal_pauses_and_the_second_of_the_same_kind_fails(self):
        self.override(self.user, 'agentsEnabled', 1)
        run = self.run_for(self.user)
        steps = limits.LimitHit('steps', 'This run reached its limit of 1 steps.')
        self.assertEqual(limits.apply_limit_hit(run, steps, now=NOW), 'paused_limit')
        saved = AgentRun.objects.get(pk=run.pk)
        self.assertEqual((saved.status, saved.pause_reason, saved.resume_after, saved.error['hits'], saved.finished_at),
                         ('paused_limit', 'steps', None, ['steps'], None))
        self.assertEqual(json.loads(json.dumps(saved.error))['code'], 'limit_paused')
        capped = limits.LimitHit('daily_cap', 'Over the daily limit.', NOW + HOUR)
        AgentRun.objects.filter(pk=run.pk).update(status='running')
        self.assertEqual(limits.apply_limit_hit(saved, capped, now=NOW), 'paused_limit')
        self.assertEqual(AgentRun.objects.get(pk=run.pk).resume_after, NOW + HOUR)
        AgentRun.objects.filter(pk=run.pk).update(status='running')
        self.assertEqual(limits.apply_limit_hit(run, steps, now=NOW + 1), 'failed')
        failed = AgentRun.objects.get(pk=run.pk)
        self.assertEqual((failed.status, failed.error['code'], failed.error['kind'], failed.finished_at, failed.pause_reason),
                         ('failed', 'limit', 'steps', NOW + 1, None))
        self.assertEqual(limits.apply_limit_hit(run, capped, now=NOW + 2), 'failed', 'a finished run is left alone')
        self.assertEqual(AgentRun.objects.get(pk=run.pk).error['code'], 'limit')

    def test_a_still_paused_run_that_hits_a_waiting_limit_again_is_paused_again(self):
        run = self.run_for(self.user)
        limits.apply_limit_hit(run, limits.LimitHit('daily_cap', 'Over.', NOW + HOUR), now=NOW)
        self.assertEqual(limits.apply_limit_hit(run, limits.LimitHit('daily_cap', 'Still over.', NOW + 2 * HOUR), now=NOW + 1), 'paused_limit')
        saved = AgentRun.objects.get(pk=run.pk)
        self.assertEqual((saved.pause_reason, saved.resume_after, saved.error['message'], saved.error['hits']),
                         ('daily_cap', NOW + 2 * HOUR, 'Still over.', ['daily_cap']))
        steps = limits.LimitHit('steps', 'At the step limit.')
        self.assertEqual(limits.apply_limit_hit(run, steps, now=NOW + 2), 'paused_limit')
        self.assertEqual(limits.apply_limit_hit(run, steps, now=NOW + 3), 'failed', 'a per-run bound is not waited out')

    def test_resume_only_when_capacity_is_back(self):
        self.override(self.user, 'agentsEnabled', 1)
        self.setting('agentMaxStepsPerRun', 5)
        run = self.run_for(self.user, step_count=5)
        self.assertEqual(limits.resume_run(run.id, now=NOW), (False, None), 'not paused')
        limits.apply_limit_hit(run, limits.check_step(run, now=NOW), now=NOW)
        refused, hit = limits.resume_run(run.id, now=NOW)
        self.assertEqual((refused, hit.kind), (False, 'steps'))
        self.assertEqual(AgentRun.objects.get(pk=run.pk).status, 'paused_limit')
        self.setting('agentMaxStepsPerRun', 6)                              # an admin raises the cap
        self.assertEqual(limits.resume_run(run.id, now=NOW), (True, None))
        resumed = AgentRun.objects.get(pk=run.pk)
        self.assertEqual((resumed.status, resumed.pause_reason, resumed.resume_after, resumed.error['hits']), ('queued', None, None, ['steps']))

    def test_resume_waits_for_resume_after(self):
        self.override(self.user, 'agentsEnabled', 1)
        run = self.run_for(self.user)
        limits.apply_limit_hit(run, limits.LimitHit('daily_cap', 'Over.', NOW + HOUR), now=NOW)
        refused, hit = limits.resume_run(run.id, now=NOW + 1)
        self.assertEqual((refused, hit.kind, hit.resume_after_ms), (False, 'daily_cap', NOW + HOUR))
        self.assertEqual(limits.resume_run(run.id, now=NOW + HOUR), (True, None))

    def test_resume_checks_the_refused_step_cost_again(self):
        self.override(self.user, 'agentsEnabled', 1)
        self.setting('agentMaxRunCostCents', 1000)
        run = self.run_for(self.user, cost_cents=990)
        hit = limits.check_step(run, cost_cents=20, now=NOW)
        self.assertEqual((hit.kind, hit.cost_cents), ('run_cost', 20))
        limits.apply_limit_hit(run, hit, now=NOW)
        self.assertEqual(AgentRun.objects.get(pk=run.pk).error['costCents'], 20)
        refused, again = limits.resume_run(run.id, now=NOW + 1)
        self.assertEqual((refused, again.kind), (False, 'run_cost'), 'no capacity was freed for the 20-cent step')
        self.assertEqual(AgentRun.objects.get(pk=run.pk).status, 'paused_limit')
        self.setting('agentMaxRunCostCents', 1010)
        self.assertEqual(limits.resume_run(run.id, now=NOW + 2), (True, None))


class BudgetTests(LimitsCase):
    def test_check_budget_refuses_once_a_daily_cap_has_no_cent_left_counting_model_tokens(self):
        grant = ensure_grant(self.user.id)
        self.assertIsNone(limits.check_budget(self.user.id, grant.id, now=NOW))
        self.usage(self.user, 2_000_000, created_at=NOW, grant=grant.id)
        self.setting('agentGlobalDailyCapCents', 3)
        self.assertIsNone(limits.check_budget(self.user.id, grant.id, now=NOW), 'two of three cents are spent')
        self.setting('agentGlobalDailyCapCents', 2)
        hit = limits.check_budget(self.user.id, grant.id, now=NOW)
        self.assertEqual((hit.kind, hit.scope, hit.resume_after_ms), (limits.GLOBAL_DAILY_CAP, 'global', NOW + 24 * HOUR))
        self.assertIsNone(limits.check_budget(self.user.id, grant.id, now=NOW + 24 * HOUR + 1), 'the window rolled')

    def test_check_budget_reads_the_user_then_the_grant_cap_at_call_time(self):
        grant = ensure_grant(self.user.id)
        self.usage(self.user, 2_000_000, created_at=NOW, grant=grant.id)
        AgentGrant.objects.filter(pk=grant.id).update(daily_cap_cents=2)
        self.assertEqual(limits.check_budget(self.user.id, grant.id, now=NOW).kind, limits.GRANT_DAILY_CAP)
        self.assertIsNone(limits.check_budget(self.user.id, None, now=NOW), 'no grant, no grant cap')
        self.override(self.user, 'mcpDailyCapCents', 2)
        self.assertEqual(limits.check_budget(self.user.id, grant.id, now=NOW).kind, limits.DAILY_CAP)
        self.override(self.user, 'mcpDailyCapCents', 50)
        AgentGrant.objects.filter(pk=grant.id).update(daily_cap_cents=50)
        self.assertIsNone(limits.check_budget(self.user.id, grant.id, now=NOW))


class AdmissionTests(LimitsCase):
    def test_admission_checks_switch_and_active_runs_and_leaves_global_concurrency_to_the_claim(self):
        with transaction.atomic():
            self.assertEqual(limits.check_run_admission(self.user).kind, 'disabled')
            self.assertIsNone(limits.check_run_admission(self.admin))
        with self.assertRaises(RuntimeError):
            limits.check_run_admission(self.admin)
        self.override(self.user, 'agentsEnabled', 1)
        self.override(self.user, 'agentActiveRuns', 1)
        self.run_for(self.user, status='waiting_jobs')
        with transaction.atomic():
            hit = limits.check_run_admission(self.user)
        self.assertEqual((hit.kind, hit.scope), ('active_runs', 'user'))
        self.setting('agentMaxConcurrentRuns', 1)
        self.run_for(self.admin)
        with transaction.atomic():
            self.assertIsNone(limits.check_run_admission(self.admin), 'a busy account still creates the run, queued')
