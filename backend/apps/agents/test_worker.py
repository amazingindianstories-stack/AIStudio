"""The agent worker's claim, heartbeat, selection and the scheduler's resume pass (apps.agents.worker)."""
import uuid
from threading import Event

from django.test import TestCase, TransactionTestCase

from apps.admin_dashboard.models import AppSetting
from apps.common import leases
from apps.workers import scheduler
from . import worker
from .models import AgentConversation, AgentGrant, AgentRun


def make_run(status='queued', **fields):
    """A run in its own conversation (one active run per conversation), under a grant for a fresh user."""
    user_id = uuid.uuid4()
    grant = AgentGrant.objects.create(user_id=user_id, scopes=[], daily_cap_cents=0, auto_approve_cents=0,
                                      auth_version_at_issue=0, created_at=1)
    conversation = AgentConversation.objects.create(project_id=uuid.uuid4(), name='Chat', user_id=user_id, created_at=1,
                                                    updated_at=1)
    values = {'conversation_id': conversation.id, 'user_id': user_id, 'grant_id': grant.id, 'model': 'gemini-3.8-flash',
              'created_at': 1, 'updated_at': 1, 'status': status, **fields}
    return AgentRun.objects.create(**values)


class ClaimTests(TestCase):
    def test_a_run_is_advanced_under_its_own_lease_and_one_global_slot(self):
        run = make_run()
        lease = worker.claim(run.id, now=1000, owner='a')
        self.assertEqual((lease.run_id, lease.owner, lease.slot, lease.held), (run.id, 'a', 'lease:agent:slot:0', True))
        self.assertEqual(leases.read(worker.run_key(run.id)), {'owner': 'a', 'expiresAt': 1000 + worker.LEASE_MS})
        self.assertEqual(AgentRun.objects.get(pk=run.id).last_heartbeat_at, 1000)
        self.assertIsNone(worker.claim(run.id, now=2000, owner='b'), 'another worker never advances a held run')
        self.assertEqual(leases.read('lease:agent:slot:1'), None, 'a refused claim gives its slot back')
        lease.release()
        self.assertFalse(AppSetting.objects.exists())
        self.assertIsNotNone(worker.claim(run.id, now=3000, owner='b'))

    def test_a_run_over_the_global_concurrency_cap_stays_queued_and_is_never_failed(self):
        AppSetting.objects.create(key='agentMaxConcurrentRuns', value='2', updated_at=1)
        first, second, waiting = make_run(), make_run(), make_run()
        for index, run in enumerate((first, second)):
            self.assertIsNotNone(worker.claim(run.id, now=1000, owner=f'w{index}'))
        self.assertEqual(AgentRun.objects.filter(status='running').count(), 0, 'claimed runs are not running yet')
        self.assertIsNone(worker.claim(waiting.id, now=1000, owner='a'), 'the cap counts claims, not running rows')
        self.assertIsNone(leases.read(worker.run_key(waiting.id)))
        self.assertIsNone(leases.read(worker.slot_key(2)), 'nothing is held for a refused claim')
        self.assertEqual(AgentRun.objects.get(pk=waiting.id).status, 'queued')
        AppSetting.objects.filter(key='agentMaxConcurrentRuns').update(value='3')
        self.assertEqual(worker.claim(waiting.id, now=1000, owner='a').slot, worker.slot_key(2),
                         'an admin raising the cap applies at the next claim')

    def test_claims_before_any_run_starts_never_pass_the_concurrency_cap(self):
        AppSetting.objects.create(key='agentMaxConcurrentRuns', value='1', updated_at=1)
        runs = [make_run() for _ in range(4)]
        claimed = [lease for lease in (worker.claim(run.id, now=1000, owner=f'w{index}') for index, run in enumerate(runs)) if lease]
        self.assertEqual([lease.slot for lease in claimed], [worker.slot_key(0)])

    def test_a_running_run_is_reclaimed_even_at_the_cap(self):
        AppSetting.objects.create(key='agentMaxConcurrentRuns', value='1', updated_at=1)
        run = make_run(status='running')
        self.assertIsNotNone(worker.claim(run.id, now=1000, owner='a'))

    def test_every_replica_together_advances_at_most_the_global_slots(self):
        runs = [make_run() for _ in range(worker.GLOBAL_SLOTS + 1)]
        held = [worker.claim(run.id, now=1000, owner=f'w{index}') for index, run in enumerate(runs[:-1])]
        self.assertEqual(sorted(lease.slot for lease in held), sorted(worker.slot_key(index) for index in range(worker.GLOBAL_SLOTS)))
        self.assertIsNone(worker.claim(runs[-1].id, now=1000, owner='late'))
        self.assertIsNone(leases.read(worker.run_key(runs[-1].id)))
        held[3].release()
        self.assertEqual(worker.claim(runs[-1].id, now=1000, owner='late').slot, worker.slot_key(3))

    def test_heartbeat_renews_and_a_lost_lease_stops_the_run(self):
        run = make_run(status='running')
        lease = worker.claim(run.id, now=1000, owner='a')
        worker.heartbeat([lease], now=1000 + worker.HEARTBEAT_MS - 1)
        self.assertEqual(AgentRun.objects.get(pk=run.id).last_heartbeat_at, 1000, 'not due yet')
        due = 1000 + worker.HEARTBEAT_MS
        worker.heartbeat([lease, None], now=due)
        self.assertEqual(AgentRun.objects.get(pk=run.id).last_heartbeat_at, due)
        self.assertEqual(leases.read(worker.run_key(run.id))['expiresAt'], due + worker.LEASE_MS)
        self.assertEqual(leases.read(lease.slot)['expiresAt'], due + worker.LEASE_MS)
        # The worker stalled past its lease; another one took the run.
        late = due + worker.LEASE_MS
        self.assertIsNotNone(worker.claim(run.id, now=late, owner='b'))
        self.assertFalse(lease.renew(now=late + 1))
        self.assertFalse(lease.held)
        self.assertEqual(leases.read(worker.run_key(run.id))['owner'], 'b')
        worker.heartbeat([lease], now=late + worker.HEARTBEAT_MS * 2)
        self.assertEqual(leases.read(worker.run_key(run.id))['owner'], 'b')


class SelectionTests(TestCase):
    def test_runnable_runs_least_recently_touched_first(self):
        now = 100_000
        queued = make_run('queued', updated_at=5)
        jobs = make_run('waiting_jobs', updated_at=3)
        approval = make_run('waiting_approval', updated_at=1)
        cancel_approval = make_run('waiting_approval', updated_at=2, cancel_requested_at=10)
        paused_due = make_run('paused_limit', updated_at=4, resume_after=now)
        make_run('paused_limit', updated_at=4, resume_after=now + 1)
        make_run('paused_limit', updated_at=4)
        cancel_paused = make_run('paused_limit', updated_at=6, cancel_requested_at=10)
        make_run('running', updated_at=0)
        for status in ('completed', 'failed', 'cancelled'):
            make_run(status, updated_at=0, cancel_requested_at=10)
        self.assertNotIn(approval.id, worker.runnable(now=now))
        self.assertEqual(worker.runnable(now=now), [cancel_approval.id, jobs.id, paused_due.id, queued.id, cancel_paused.id])
        self.assertEqual(worker.runnable(now=now, limit=2, exclude={cancel_approval.id}), [jobs.id, paused_due.id])
        self.assertEqual(worker.runnable(now=now, limit=0), [])


class RunLoopTests(TransactionTestCase):
    """Runs are advanced on pool threads with their own connections, so these rows must be committed."""

    def test_run_once_claims_advances_and_releases(self):
        first, second = make_run(updated_at=1), make_run(updated_at=2)
        seen = []

        def process(run_id, lease, stop):
            seen.append((run_id, lease.run_id, lease.held, leases.read(worker.run_key(run_id))['owner'] == lease.owner))
            return 'waiting' if run_id == second.id else 'completed'
        result = worker.run_once(concurrency=1, process=process)
        self.assertEqual(result, {'processed': 1, 'outcomes': {'completed': 1}})
        self.assertEqual(seen, [(first.id, first.id, True, True)])
        self.assertFalse(AppSetting.objects.exists(), 'both leases are released after the run yields')

    def test_a_failing_run_is_contained_and_its_leases_released(self):
        run = make_run()

        def process(run_id, lease, stop):
            raise RuntimeError('provider body with a secret')
        with self.assertLogs('veevee.agents', 'ERROR') as logs:
            self.assertEqual(worker.handle_run(run.id, process, Event()), 'worker_error')
        self.assertNotIn('secret', '\n'.join(logs.output))
        self.assertFalse(AppSetting.objects.exists())
        stop = Event()
        stop.set()
        self.assertEqual(worker.handle_run(run.id, process, stop), 'stopped')

    def test_run_worker_refills_slots_and_stops(self):
        runs = [make_run(updated_at=index) for index in range(3)]
        stop, seen = Event(), []

        def process(run_id, lease, stop_event):
            seen.append(run_id)
            AgentRun.objects.filter(pk=run_id).update(status='completed')
            if len(seen) == len(runs):
                stop.set()
            return 'completed'
        worker.run_worker(interval=.1, concurrency=2, stop=stop, process=process)
        self.assertEqual(sorted(seen), sorted(run.id for run in runs))
        self.assertFalse(AppSetting.objects.exists())


class ResumeTests(TestCase):
    def test_the_scheduler_requeues_running_runs_whose_heartbeat_stopped(self):
        now = 10_000_000
        stale = make_run('running', last_heartbeat_at=now - worker.STALE_MS - 1)
        never = make_run('running')
        fresh = make_run('running', last_heartbeat_at=now - worker.STALE_MS)
        waiting = make_run('waiting_jobs', last_heartbeat_at=0)
        self.assertEqual(worker.reconcile_stale_runs(now=now), {'ok': True, 'requeued': 2})
        statuses = dict(AgentRun.objects.values_list('id', 'status'))
        self.assertEqual((statuses[stale.id], statuses[never.id], statuses[fresh.id], statuses[waiting.id]),
                         ('queued', 'queued', 'running', 'waiting_jobs'))
        self.assertEqual(AgentRun.objects.get(pk=stale.id).updated_at, now)
        self.assertIn(stale.id, worker.runnable(now=now))

    def test_the_scheduler_runs_the_resume_pass_on_its_own_slot(self):
        make_run('running', last_heartbeat_at=0)
        handlers = scheduler.default_handlers()
        self.assertIs(handlers['agent_runs'], scheduler.resume_agent_runs)
        self.assertEqual(scheduler.tick(now=leases.now_ms(), handlers={'agent_runs': handlers['agent_runs']}),
                         {'agent_runs': {'ok': True, 'requeued': 1}})
        self.assertEqual(AgentRun.objects.get().status, 'queued')
