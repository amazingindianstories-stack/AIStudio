"""The Agents tab's admin limits: the checks the run API and the worker call, all reading the admin limit registry.

    enabled = agents_enabled(user)                        # the switch, with the global kill
    hit = check_run_admission(user)                       # API run creation, inside transaction.atomic()
    hit = check_step(run, cost_cents=estimate)            # worker, before every LLM or paid tool step
    if hit: status = apply_limit_hit(run, hit)            # pause once per kind, fail on the second refusal
    ok, hit = resume_run(run_id)                          # the Resume action, only when capacity is back

Limit values follow the other admin limits: a per-user ``UserLimit`` row overrides the global ``AppSetting`` row, and
both parse against ``admin_dashboard.views.LIMITS``. ``agentsEnabled`` resolves differently, see ``agents_enabled``.
Global-only keys (``agentGlobalDailyCapCents``, ``agentMaxConcurrentRuns``) ignore per-user rows.

A limit is never retried into: the first refusal of a kind pauses the run (``paused_limit``), the second refusal of the
same kind in the same run ends it ``failed`` with ``error = {'code': 'limit', 'kind': ...}``. Pauses are recorded in
``agent_runs.error`` as ``{'code': 'limit_paused', 'kind', 'hits': [kinds], 'costCents', ...}``, where ``costCents`` is the
refused step's estimate that Resume re-checks; no schema change is needed.
"""
from dataclasses import dataclass
from typing import Optional

from django.db import connection, transaction
from django.db.models import Sum

from apps.common.leases import now_ms
from .models import ACTIVE_RUN_STATUSES, AgentGrant, AgentLlmUsage, AgentRun

ENABLED = 'agentsEnabled'
RUN_KEYS = ('agentActiveRuns', 'agentMaxStepsPerRun', 'agentMaxRunCostCents')
GLOBAL_KEYS = ('agentGlobalDailyCapCents', 'agentMaxConcurrentRuns')
ATTACH_KEYS = {'maxMb': 'agentAttachMaxMb', 'maxVideoSeconds': 'agentAttachMaxVideoSeconds', 'maxAudioSeconds': 'agentAttachMaxAudioSeconds',
               'images': 'agentAttachImages', 'documents': 'agentAttachDocuments', 'video': 'agentAttachVideo', 'audio': 'agentAttachAudio'}
ATTACH_SWITCHES = ('images', 'documents', 'video', 'audio')
MICROCENTS_PER_CENT = 1_000_000
PAUSED = 'paused_limit'

# LimitHit.kind values
DISABLED, ACTIVE_RUNS, STEPS, RUN_COST = 'disabled', 'active_runs', 'steps', 'run_cost'
DAILY_CAP, GRANT_DAILY_CAP, GLOBAL_DAILY_CAP, GLOBAL_CONCURRENCY = 'daily_cap', 'grant_daily_cap', 'global_daily_cap', 'global_concurrency'


@dataclass(frozen=True)
class LimitHit:
    kind: str
    message: str
    resume_after_ms: Optional[int] = None      # earliest epoch ms the trailing window frees capacity; None for a cap only an admin lifts
    scope: str = 'user'                        # 'user' or 'global'
    cost_cents: int = 0                        # the refused step's estimated cost, which Resume checks again


def _views():
    from apps.admin_dashboard import views
    return views


def _global_raw(keys):
    from apps.admin_dashboard.models import AppSetting
    return dict(AppSetting.objects.filter(key__in=keys).values_list('key', 'value'))


def _values(user_id, keys, *, per_user=True):
    """Effective parsed values: a per-user row overrides the global row, which overrides the registry default."""
    from apps.admin_dashboard.models import UserLimit
    views = _views()
    raw = _global_raw(keys)
    if per_user and user_id is not None:
        raw.update(UserLimit.objects.filter(user_id=user_id, key__in=keys).values_list('key', 'value'))
    return {key: views.parse(raw.get(key), views.LIMITS[key]) for key in keys}


def run_limits(user_id):
    """``agentActiveRuns``, ``agentMaxStepsPerRun`` and ``agentMaxRunCostCents`` for one user."""
    return _values(user_id, RUN_KEYS)


def global_limits():
    """The account-wide limits: ``agentGlobalDailyCapCents`` and ``agentMaxConcurrentRuns``."""
    return _values(None, GLOBAL_KEYS, per_user=False)


def attachment_limits(user_id):
    """Attachment limits for one user: sizes and durations as ints, the per-kind switches as bools."""
    values = _values(user_id, tuple(ATTACH_KEYS.values()))
    return {name: (values[key] != 0 if name in ATTACH_SWITCHES else values[key]) for name, key in ATTACH_KEYS.items()}


def _switch(raw):
    """1/0 from a stored value, or None for a missing or unparsable one."""
    if raw is None:
        return None
    value = _views().parse(raw, (-1, 0, 1))
    return None if value < 0 else value


def agents_enabled(user):
    """Whether the Agents tab is on for a user (a ``User`` or a user id).

    A global ``agentsEnabled`` row of 0 is the kill switch: off for everyone, admins and per-user overrides included.
    Otherwise a per-user row decides, then a global 1 (on for all), then the default: on for admins, off for members.
    """
    from apps.admin_dashboard.models import UserLimit
    from apps.authentication.models import User
    kill_or_on = _switch(_global_raw((ENABLED,)).get(ENABLED))
    if kill_or_on == 0:
        return False
    user_id = getattr(user, 'id', user)
    own = _switch(UserLimit.objects.filter(user_id=user_id, key=ENABLED).values_list('value', flat=True).first())
    if own is not None:
        return own == 1
    if kill_or_on == 1:
        return True
    role = getattr(user, 'role', None) or User.objects.filter(pk=user_id).values_list('role', flat=True).first()
    return role == 'admin'


def llm_spend_cents(*, user_id=None, grant_id=None, now=None):
    """Agent model token cost in the trailing 24 hours as whole cents, rounded up once on the sum of microcents."""
    from apps.mcp_auth import policy
    now = now_ms() if now is None else now
    rows = AgentLlmUsage.objects.filter(created_at__gt=now - policy.DAY_MS)
    if user_id is not None:
        rows = rows.filter(user_id=user_id)
    if grant_id is not None:
        rows = rows.filter(grant_id=grant_id)
    return -(-(rows.aggregate(total=Sum('cost_microcents'))['total'] or 0) // MICROCENTS_PER_CENT)


def _run_llm_cents(run_id):
    """A run's model token cost, whatever its age (a run's own cap does not roll)."""
    total = AgentLlmUsage.objects.filter(run_id=run_id).aggregate(total=Sum('cost_microcents'))['total'] or 0
    return -(-total // MICROCENTS_PER_CENT)


def _dollars(cents):
    return f'${cents / 100:,.2f}'


def _window_resume(excess_cents, *, user_id=None, grant_id=None, now):
    """Earliest epoch ms at which the trailing window has shed ``excess_cents``, from the oldest counted rows; None when
    it never will (the excess is more than everything in the window)."""
    from apps.generation.models import Generation
    from apps.mcp_auth import controls, policy
    rows = Generation.objects.filter(created_via__in=policy.AGENT_ORIGINS, created_at__gt=now - policy.DAY_MS)
    usage = AgentLlmUsage.objects.filter(created_at__gt=now - policy.DAY_MS)
    if user_id is not None:
        rows, usage = rows.filter(user_id=user_id), usage.filter(user_id=user_id)
    if grant_id is not None:
        rows, usage = rows.filter(mcp_token_id=grant_id), usage.filter(grant_id=grant_id)
    events = [(created, controls.counted_cents(model, status, basis, cost, duration, resolution, videos))
              for created, model, status, basis, cost, duration, resolution, videos in rows.values_list(
                  'created_at', 'model', 'status', 'cost_basis', 'cost_cents', 'duration', 'resolution', 'reference_videos')]
    events += [(created, micro / MICROCENTS_PER_CENT) for created, micro in usage.values_list('created_at', 'cost_microcents')]
    freed = 0
    for created, cents in sorted(events):
        freed += cents
        if freed >= excess_cents:
            return created + policy.DAY_MS
    return None


_CAP_NAMES = {DAILY_CAP: 'your daily agent limit', GRANT_DAILY_CAP: 'the Agents tab\'s own daily limit',
              GLOBAL_DAILY_CAP: 'the daily limit for all agents together'}


def _cap_hit(kind, scope, spent, upcoming, cap, *, user_id=None, grant_id=None, now):
    if spent + upcoming <= cap:
        return None
    resume = _window_resume(spent + upcoming - cap, user_id=user_id, grant_id=grant_id, now=now) if upcoming <= cap else None
    return LimitHit(kind, f'The next step would pass {_CAP_NAMES[kind]} of {_dollars(cap)} ({_dollars(spent)} used in the last 24 hours).',
                    resume, scope, upcoming)


def check_global_concurrency():
    """A hit when ``agentMaxConcurrentRuns`` runs are already running across everyone, else None."""
    cap = global_limits()['agentMaxConcurrentRuns']
    running = AgentRun.objects.filter(status='running').count()
    if running >= cap:
        return LimitHit(GLOBAL_CONCURRENCY, f'{running} agent runs are running (limit {cap}). Try again shortly.', None, 'global')
    return None


def check_run_admission(user):
    """Before creating a run: the switch, the user's active-run cap and the global concurrency cap, or None.

    Call inside ``transaction.atomic()``; a per-user advisory lock serializes concurrent creates so the count cannot
    be overshot. ``user`` is a ``User``.
    """
    if not connection.in_atomic_block:
        raise RuntimeError('check_run_admission must run inside the transaction that creates the run')
    if not agents_enabled(user):
        return LimitHit(DISABLED, 'Agents are turned off for your account.', None, 'user')
    with connection.cursor() as cursor:
        cursor.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))', ['agent-runs:' + str(user.id)])
    cap = run_limits(user.id)['agentActiveRuns']
    active = AgentRun.objects.filter(user_id=user.id, status__in=ACTIVE_RUN_STATUSES).count()
    if active >= cap:
        return LimitHit(ACTIVE_RUNS, f'You have {active} agent runs in progress (limit {cap}). Finish or cancel one first.', None, 'user')
    return check_global_concurrency()


def check_step(run, *, cost_cents=0, now=None):
    """Evaluated before each LLM or paid tool step: None, or the first ``LimitHit`` that refuses it.

    ``cost_cents`` is the step's estimated cost (0 for a free tool). Order: switch, steps, run cost, user daily cap,
    the grant's own daily cap, global daily cap. Reads are unlocked; ``controls.admit_paid_submission`` is the atomic
    check for paid jobs. The global daily cap is enforced here only, never in MCP admission.
    """
    from apps.mcp_auth import controls, policy
    now = now_ms() if now is None else now
    if not agents_enabled(run.user_id):
        return LimitHit(DISABLED, 'Agents were turned off by an admin.', None, 'user', cost_cents)
    limits = run_limits(run.user_id)
    if run.step_count >= limits['agentMaxStepsPerRun']:
        return LimitHit(STEPS, f'This run reached its limit of {limits["agentMaxStepsPerRun"]} steps.', None, 'user', cost_cents)
    run_spent = run.cost_cents + _run_llm_cents(run.id)
    if run_spent + cost_cents > limits['agentMaxRunCostCents']:
        return LimitHit(RUN_COST, f'The next step would pass this run\'s {_dollars(limits["agentMaxRunCostCents"])} cost limit '
                                  f'({_dollars(run_spent)} used).', None, 'user', cost_cents)
    grant_cap = AgentGrant.objects.values_list('daily_cap_cents', flat=True).get(pk=run.grant_id)
    hit = (_cap_hit(DAILY_CAP, 'user', controls.spent_cents(run.user_id, now=now), cost_cents,
                    policy.user_limits(run.user_id)['dailyCapCents'], user_id=run.user_id, now=now)
           or _cap_hit(GRANT_DAILY_CAP, 'user', controls.spent_cents(run.user_id, token_id=run.grant_id, now=now), cost_cents,
                       grant_cap, grant_id=run.grant_id, now=now))
    return hit or _cap_hit(GLOBAL_DAILY_CAP, 'global', controls.global_spent_cents(now=now), cost_cents,
                           global_limits()['agentGlobalDailyCapCents'], now=now)


def apply_limit_hit(run, hit, *, now=None):
    """Record a refusal on the run and return its new status.

    The first refusal of a kind pauses the run (``paused_limit``, ``pause_reason`` = the kind, ``resume_after`` from the
    hit); a second refusal of the same kind ends it ``failed`` with ``error = {'code': 'limit', 'kind': ...}``. A run
    that is already finished is left alone. The caller must stop stepping either way and never retry the refused step.
    """
    now = now_ms() if now is None else now
    with transaction.atomic():
        locked = AgentRun.objects.select_for_update().filter(pk=run.pk).first()
        if locked is None or locked.status in ('completed', 'failed', 'cancelled'):
            return locked.status if locked else None
        hits = list((locked.error or {}).get('hits', []))
        if hit.kind in hits:
            locked.status, locked.pause_reason, locked.resume_after, locked.finished_at = 'failed', None, None, now
            locked.error = {'code': 'limit', 'kind': hit.kind, 'message': hit.message, 'scope': hit.scope, 'hits': hits}
        else:
            locked.status, locked.pause_reason, locked.resume_after = PAUSED, hit.kind, hit.resume_after_ms
            locked.error = {'code': 'limit_paused', 'kind': hit.kind, 'message': hit.message, 'scope': hit.scope, 'hits': hits + [hit.kind],
                            'costCents': hit.cost_cents}
        locked.updated_at = now
        locked.save(update_fields=['status', 'pause_reason', 'resume_after', 'finished_at', 'error', 'updated_at'])
    for field in ('status', 'pause_reason', 'resume_after', 'finished_at', 'error', 'updated_at'):
        setattr(run, field, getattr(locked, field))
    return locked.status


def resume_run(run_id, *, now=None):
    """The Resume action: requeue a ``paused_limit`` run only when the limit that paused it has capacity again for the
    refused step's recorded cost.

    Returns ``(True, None)`` once requeued, else ``(False, hit)`` with the limit still in the way (or ``(False, None)``
    when the run is not paused on a limit). The refused kind stays in ``error['hits']``, so refusing again fails the run.
    """
    now = now_ms() if now is None else now
    with transaction.atomic():
        run = AgentRun.objects.select_for_update().filter(pk=run_id).first()
        if run is None or run.status != PAUSED:
            return False, None
        if run.resume_after is not None and run.resume_after > now:
            return False, LimitHit(run.pause_reason, (run.error or {}).get('message', 'Still at the limit.'), run.resume_after,
                                   (run.error or {}).get('scope', 'user'))
        hit = check_step(run, cost_cents=(run.error or {}).get('costCents', 0), now=now)
        if hit is not None:
            return False, hit
        AgentRun.objects.filter(pk=run.pk).update(status='queued', pause_reason=None, resume_after=None, updated_at=now)
        return True, None
