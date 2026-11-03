"""A run's event feed (``agent_run_events``): what the Agents tab polls while a run is active.

    emit(run.id, 'job_queued', {'generationId': ...})
    rows = page(run.id, after=12)

``seq`` is strictly increasing per run with no gaps: every writer (the worker and the API) allocates it while holding
the run's row lock, so concurrent writers serialise on that row instead of colliding on the unique ``(run_id, seq)``.
"""
from django.db import transaction
from django.db.models import Max

from apps.common.leases import now_ms
from .models import AgentRun, AgentRunEvent

PAGE_SIZE = 100


def emit(run_id, kind, payload=None, *, now=None):
    """Append one event; joins the caller's transaction when there is one."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        list(AgentRun.objects.select_for_update().filter(pk=run_id).values_list('id', flat=True))
        last = AgentRunEvent.objects.filter(run_id=run_id).aggregate(seq=Max('seq'))['seq'] or 0
        return AgentRunEvent.objects.create(run_id=run_id, seq=last + 1, kind=kind, payload=payload or {}, created_at=now)


def page(run_id, *, after=0, limit=PAGE_SIZE):
    """Up to ``limit`` events after ``after``, in ``seq`` order."""
    return list(AgentRunEvent.objects.filter(run_id=run_id, seq__gt=after).order_by('seq')[:max(1, min(limit, PAGE_SIZE))])
