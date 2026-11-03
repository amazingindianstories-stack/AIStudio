"""Spend, rate and concurrency checks the MCP tools run before they create a paid generation row.

A paid tool submits like this, so the checks and the row share one transaction and one per-user lock:

    from django.db import transaction
    from apps.mcp_auth import controls

    controls.check_rate(principal, 'calls')                      # every tool call
    decision = controls.price_decision(principal, cost_cents)    # 'submit' / 'quote' / 'confirm'
    with transaction.atomic():
        controls.admit_paid_submission(principal, cost_cents)    # raises BudgetExceeded / RateLimited / ConcurrencyLimit
        generation = submit(..., **principal.origin_fields())

Spend is the sum over agent-created rows in the trailing 24 hours of each row's cost (reconciled when known,
otherwise the estimate). Rows cancelled before submission cost nothing; rows whose billing is unconfirmed
count. Amounts are estimator cents. A Seedance 2.5 job is priced and booked at the higher of its web estimate and the
paid guard's current token estimate (``booked_cents``) until its provider-reported cost replaces it.
"""
import math
from contextlib import contextmanager
from dataclasses import dataclass

from django.db import connection
from django.db.models import Sum

from apps.common.leases import now_ms
from . import policy

ACTIVE_STATUSES = ('queued', 'running')
FREE_COST_BASIS = 'cancelled_before_submission'
SEEDANCE_25 = 'Seedance 2.5'


class ControlRefusal(Exception):
    code = None

    def __init__(self, message, *, retry_after_seconds=None):
        super().__init__(message)
        self.message, self.retry_after_seconds = message, retry_after_seconds


class BudgetExceeded(ControlRefusal):
    code = 'BUDGET_EXCEEDED'


class RateLimited(ControlRefusal):
    code = 'RATE_LIMITED'


class ConcurrencyLimit(ControlRefusal):
    code = 'CONCURRENCY_LIMIT'


@dataclass(frozen=True)
class RateResult:
    allowed: bool
    count: int
    limit: int
    retry_after_seconds: int


def dollars(cents):
    return f'${cents / 100:,.2f}'


def hit(bucket, limit, window_seconds, *, now=None, weight=1):
    """Count one event (``weight`` credits) in a fixed window and report whether it is within ``limit``."""
    now = now_ms() if now is None else now
    width = window_seconds * 1000
    start = now - now % width
    with connection.cursor() as cursor:
        cursor.execute('''INSERT INTO mcp_rate_windows (bucket, window_start, count, expires_at) VALUES (%s, %s, %s, %s)
            ON CONFLICT (bucket, window_start) DO UPDATE SET count = mcp_rate_windows.count + EXCLUDED.count
            RETURNING count''', [bucket, start, weight, start + width])
        count = cursor.fetchone()[0]
    return RateResult(count <= limit, count, limit, max(1, math.ceil((start + width - now) / 1000)))


def check_rate(principal, name, *, now=None):
    """Apply a per-grant limit from ``policy.RATE_LIMITS`` ('calls', 'paid_minute', 'paid_day', 'uploads')."""
    limit, window = policy.RATE_LIMITS[name]
    result = hit(f'{name}:{principal.token_id}', limit, window, now=now)
    if not result.allowed:
        raise RateLimited(f'Too many {"paid calls" if name.startswith("paid") else "calls"}. Retry in {result.retry_after_seconds} s.',
                          retry_after_seconds=result.retry_after_seconds)
    return result


def check_credits(principal, kind, *, now=None):
    """Spend the credits of one board API call (``policy.BOARD_COSTS[kind]``) from the grant's window.

    Returns the ``RateResult`` (the response headers report it); an exhausted window raises ``RateLimited``,
    and the refused call still counts, so a client that ignores Retry-After does not get a free retry."""
    limit, window = policy.BOARD_CREDITS
    result = hit(f'board:{principal.token_id}', limit, window, now=now, weight=policy.BOARD_COSTS[kind])
    if not result.allowed:
        raise RateLimited(f'Board API credits used up. Retry in {result.retry_after_seconds} s.',
                          retry_after_seconds=result.retry_after_seconds)
    return result


GLOBAL_BUDGET_LOCK = 'mcp-budget:global'


def booked_cents(model, cost_cents, duration=None, resolution=None, reference_videos=None):
    """What an agent job costs before it reconciles: Seedance 2.5 books at least its current token estimate.

    The web estimate for Seedance 2.5 is a placeholder well below what the provider bills, so agents are quoted, confirmed
    and capped on the token estimate (not the paid guard's doubled reservation, which would refuse every 1080p clip).
    """
    from apps.generation.services.paid_guard import seedance_token_estimate
    cost = cost_cents or 0
    if model != SEEDANCE_25 or type(duration) is not int or resolution not in ('480p', '720p', '1080p'):
        return cost
    return max(cost, math.ceil(seedance_token_estimate(duration, resolution, bool(reference_videos))))


def counted_cents(model, status, cost_basis, cost_cents, duration=None, resolution=None, reference_videos=None):
    """What one agent-created row adds to ``spent_cents`` now: nothing if cancelled before submission, the booked amount
    while an estimated job is active, otherwise its stored cost."""
    if cost_basis == FREE_COST_BASIS:
        return 0
    if status in ACTIVE_STATUSES and cost_basis == 'estimated':
        return booked_cents(model, cost_cents, duration, resolution, reference_videos)
    return cost_cents or 0


def _generation_cents(rows):
    total = rows.aggregate(total=Sum('cost_cents'))['total'] or 0
    booked = rows.filter(model=SEEDANCE_25, status__in=ACTIVE_STATUSES, cost_basis='estimated').values_list(
        'cost_cents', 'duration', 'resolution', 'reference_videos')
    return total + sum(booked_cents(SEEDANCE_25, cost, duration, resolution, videos) - (cost or 0)
                       for cost, duration, resolution, videos in booked)


def llm_cents(*, user_id=None, grant_id=None, now=None):
    from apps.agents.limits import llm_spend_cents
    return llm_spend_cents(user_id=user_id, grant_id=grant_id, now=now)


def spent_cents(user_id, *, token_id=None, now=None):
    """Generation spend plus, for a user (or an Agents tab grant), the agent's model token cost in the trailing day."""
    from apps.agents.models import AgentGrant
    from apps.generation.models import Generation
    now = now_ms() if now is None else now
    rows = Generation.objects.filter(created_via__in=policy.AGENT_ORIGINS, created_at__gt=now - policy.DAY_MS).exclude(cost_basis=FREE_COST_BASIS)
    if token_id is None:
        return _generation_cents(rows.filter(user_id=user_id)) + llm_cents(user_id=user_id, now=now)
    spent = _generation_cents(rows.filter(mcp_token_id=token_id))
    return spent + (llm_cents(grant_id=token_id, now=now) if AgentGrant.objects.filter(pk=token_id).exists() else 0)


def global_spent_cents(*, now=None):
    """Every user's agent spend in the trailing day: agent-origin generations plus all model token cost."""
    from apps.generation.models import Generation
    now = now_ms() if now is None else now
    rows = Generation.objects.filter(created_via__in=policy.AGENT_ORIGINS, created_at__gt=now - policy.DAY_MS).exclude(cost_basis=FREE_COST_BASIS)
    return _generation_cents(rows) + llm_cents(now=now)


def active_jobs(user_id):
    from apps.generation.models import Generation
    return Generation.objects.filter(user_id=user_id, created_via__in=policy.AGENT_ORIGINS, status__in=ACTIVE_STATUSES).count()


def price_decision(principal, cost_cents):
    """'confirm' at or above $1 whatever the auto-approve amount; else 'submit' at or below it, otherwise 'quote'."""
    if cost_cents >= principal.caps.confirm_at_cents:
        return 'confirm'
    return 'submit' if cost_cents <= principal.caps.auto_approve_cents else 'quote'


def admit_paid_submission(principal, cost_cents, *, now=None):
    """Lock the user's agent budget and refuse a submission that would pass a cap or limit.

    Call inside ``transaction.atomic()`` and create the generation row in the same transaction, so parallel
    calls for one user serialize and cannot overshoot. The paid-submission rate counters roll back with it.
    """
    if not connection.in_atomic_block:
        raise RuntimeError('admit_paid_submission must run inside the transaction that creates the row')
    now = now_ms() if now is None else now
    user_id = principal.user.id
    with connection.cursor() as cursor:
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", ['mcp-budget:' + str(user_id)])
        # Always user lock first, then this one, so two users admitting at once cannot deadlock or overshoot together.
        cursor.execute("SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))", [GLOBAL_BUDGET_LOCK])
    caps = principal.caps
    running = active_jobs(user_id)
    if running >= caps.active_jobs:
        raise ConcurrencyLimit(f'You have {running} agent jobs running (limit {caps.active_jobs}). Wait for one to finish.')
    user_spent = spent_cents(user_id, now=now)
    if user_spent + cost_cents > caps.user_daily_cap_cents:
        raise BudgetExceeded(f'This {dollars(cost_cents)} job would pass your {dollars(caps.user_daily_cap_cents)} daily agent limit '
                             f'({dollars(user_spent)} used in the last 24 hours). Try again later or ask an admin.')
    from apps.agents import limits as agent_limits
    global_cap = agent_limits.global_limits()['agentGlobalDailyCapCents']
    global_spent = global_spent_cents(now=now)
    if global_spent + cost_cents > global_cap:
        raise BudgetExceeded(f'This {dollars(cost_cents)} job would pass the {dollars(global_cap)} daily limit for all agents together '
                             f'({dollars(global_spent)} used in the last 24 hours). Try again later or ask an admin.')
    token_spent = spent_cents(user_id, token_id=principal.token_id, now=now)
    if token_spent + cost_cents > caps.token_daily_cap_cents:
        raise BudgetExceeded(f'This {dollars(cost_cents)} job would pass this connection\'s {dollars(caps.token_daily_cap_cents)} daily limit '
                             f'({dollars(token_spent)} used in the last 24 hours). Try again later or raise the limit in Veevee Settings.')
    check_rate(principal, 'paid_minute', now=now)
    check_rate(principal, 'paid_day', now=now)
    return {'userSpentCents': user_spent, 'tokenSpentCents': token_spent, 'activeJobs': running}


@contextmanager
def hold_slot(principal, *, now=None):
    """Bound concurrent waiting calls per grant (``policy.HOLDS_PER_TOKEN``); slots expire if a process dies."""
    now = now_ms() if now is None else now
    bucket = f'hold:{principal.token_id}'
    claimed = None
    with connection.cursor() as cursor:
        for slot in range(policy.HOLDS_PER_TOKEN):
            cursor.execute('''INSERT INTO mcp_rate_windows (bucket, window_start, count, expires_at) VALUES (%s, %s, 1, %s)
                ON CONFLICT (bucket, window_start) DO UPDATE SET count = 1, expires_at = excluded.expires_at
                WHERE mcp_rate_windows.expires_at <= %s RETURNING window_start''', [bucket, slot, now + policy.HOLD_TTL_MS, now])
            if cursor.fetchone() is not None:
                claimed = slot
                break
    if claimed is None:
        raise ConcurrencyLimit(f'This connection already has {policy.HOLDS_PER_TOKEN} calls waiting. Wait for one to return.')
    try:
        yield claimed
    finally:
        with connection.cursor() as cursor:
            cursor.execute('UPDATE mcp_rate_windows SET expires_at = 0 WHERE bucket = %s AND window_start = %s', [bucket, claimed])
