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
count. Amounts are estimator cents. For Seedance 2.5 the caller passes the conservative token estimate when it
is higher than the stored estimate.
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


def hit(bucket, limit, window_seconds, *, now=None):
    """Count one event in a fixed window and report whether it is within ``limit``."""
    now = now_ms() if now is None else now
    width = window_seconds * 1000
    start = now - now % width
    with connection.cursor() as cursor:
        cursor.execute('''INSERT INTO mcp_rate_windows (bucket, window_start, count, expires_at) VALUES (%s, %s, 1, %s)
            ON CONFLICT (bucket, window_start) DO UPDATE SET count = mcp_rate_windows.count + 1
            RETURNING count''', [bucket, start, start + width])
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


def spent_cents(user_id, *, token_id=None, now=None):
    from apps.generation.models import Generation
    now = now_ms() if now is None else now
    rows = Generation.objects.filter(created_via='mcp', created_at__gt=now - policy.DAY_MS).exclude(cost_basis=FREE_COST_BASIS)
    rows = rows.filter(mcp_token_id=token_id) if token_id is not None else rows.filter(user_id=user_id)
    return rows.aggregate(total=Sum('cost_cents'))['total'] or 0


def active_jobs(user_id):
    from apps.generation.models import Generation
    return Generation.objects.filter(user_id=user_id, created_via='mcp', status__in=ACTIVE_STATUSES).count()


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
    caps = principal.caps
    running = active_jobs(user_id)
    if running >= caps.active_jobs:
        raise ConcurrencyLimit(f'You have {running} agent jobs running (limit {caps.active_jobs}). Wait for one to finish.')
    user_spent = spent_cents(user_id, now=now)
    if user_spent + cost_cents > caps.user_daily_cap_cents:
        raise BudgetExceeded(f'This {dollars(cost_cents)} job would pass your {dollars(caps.user_daily_cap_cents)} daily agent limit '
                             f'({dollars(user_spent)} used in the last 24 hours). Try again later or ask an admin.')
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
