"""The monthly Create with AI allowance: the most one user may spend on board AI jobs in a calendar month (UTC).

The cap is the admin limit ``boardAiMonthlyCapCents`` (a global default and a per-user override, in estimator cents).
Spend is the sum of the cost of the user's board-created generations since the month began, so a job that fails and
is refunded to zero stops counting. A job is admitted only if its quoted cost fits in what remains; the check runs
in the submit transaction path, after the idempotency lookup, so a replayed request never trips it.
"""
import datetime

from django.db.models import Sum

from apps.common.leases import now_ms
from apps.generation.models import Generation

LIMIT = 'boardAiMonthlyCapCents'
ORIGIN = 'board'


def month_start_ms(now=None):
    moment = datetime.datetime.fromtimestamp((now_ms() if now is None else now) / 1000, datetime.timezone.utc)
    return int(moment.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)


def next_month_start_ms(now=None):
    start = datetime.datetime.fromtimestamp(month_start_ms(now) / 1000, datetime.timezone.utc)
    following = (start.replace(day=28) + datetime.timedelta(days=4)).replace(day=1)
    return int(following.timestamp() * 1000)


def cap_cents(user_id):
    from apps.admin_dashboard.models import AppSetting, UserLimit
    from apps.admin_dashboard.views import LIMITS, parse
    row = UserLimit.objects.filter(user_id=user_id, key=LIMIT).values_list('value', flat=True).first()
    if row is None:
        row = AppSetting.objects.filter(key=LIMIT).values_list('value', flat=True).first()
    return parse(row, LIMITS[LIMIT])


def spent_cents(user_id, now=None):
    rows = Generation.objects.filter(user_id=user_id, created_via=ORIGIN, created_at__gte=month_start_ms(now))
    return rows.aggregate(total=Sum('cost_cents'))['total'] or 0


def status(user_id, now=None):
    cap, spent = cap_cents(user_id), spent_cents(user_id, now)
    return {'capCents': cap, 'spentCents': spent, 'remainingCents': max(cap - spent, 0), 'resetsAt': next_month_start_ms(now)}


def exceeded(user_id, cost_cents, now=None):
    """The allowance status when a job costing ``cost_cents`` does not fit in what remains, else None."""
    state = status(user_id, now)
    return state if state['spentCents'] + (cost_cents or 0) > state['capCents'] else None
