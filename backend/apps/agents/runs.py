"""What the Agents tab's run endpoints do: start a run or deliver a message to the active one, request a cancel,
answer a quote and read a run's event feed. The worker (``apps.agents.runner``) does everything else.

    outcome = post_message(conversation, user, 'Make a red fox')   # {'delivery': 'run' | 'inbox', ...}
    request_cancel(run.id, cancel_jobs=True)

A conversation has at most one active run (``agent_runs_one_active_uniq``). A message posted while one is active goes
to its inbox and is delivered at the next step boundary. If the run is waiting for a quote, the message declines the
quote so the model can follow it; a run paused by a limit is retried at once.
"""
import uuid

from django.db import transaction

from apps.common.leases import now_ms
from . import events, grants, runner
from .loop_llm import LOOP_MODEL, LOOP_MODELS
from .models import ACTIVE_RUN_STATUSES, AgentConversation, AgentConversationMessage, AgentInboxMessage, AgentRun
from .services import message_json

RECENT_RUNS = 20


class AgentsDisabled(Exception):
    """The global ``agentsEnabled`` switch is off: no new run starts."""


def identifier(value):
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


def owned_conversation(conversation_id, user):
    """The conversation when ``user`` owns it, else None."""
    key = identifier(conversation_id)
    row = AgentConversation.objects.filter(pk=key).first() if key is not None else None
    owner = row.user_id or row.created_by if row is not None else None
    return row if owner is not None and str(owner) == str(user.id) else None


def conversation_run(conversation, run_id):
    key = identifier(run_id)
    return AgentRun.objects.filter(pk=key, conversation_id=conversation.id).first() if key is not None else None


def run_model(conversation, requested):
    if requested in LOOP_MODELS:
        return requested
    configured = (conversation.settings or {}).get('model')
    return configured if configured in LOOP_MODELS else LOOP_MODEL


def run_json(run):
    return {'id': str(run.id), 'conversationId': str(run.conversation_id), 'status': run.status, 'model': run.model,
            'stepCount': run.step_count, 'costCents': run.cost_cents, 'pauseReason': run.pause_reason,
            'resumeAfter': run.resume_after, 'error': run.error, 'cancelRequestedAt': run.cancel_requested_at,
            'cancelJobs': run.cancel_jobs, 'startedAt': run.started_at, 'finishedAt': run.finished_at,
            'createdAt': run.created_at, 'updatedAt': run.updated_at}


def inbox_json(row):
    return {'id': str(row.id), 'runId': str(row.run_id) if row.run_id else None, 'content': row.content,
            'createdAt': row.created_at, 'deliveredAt': row.delivered_at, 'deliveredStep': row.delivered_step}


def event_json(row):
    return {'seq': row.seq, 'kind': row.kind, 'payload': row.payload, 'createdAt': row.created_at}


def post_message(conversation, user, content, *, model=None, now=None):
    """Start a run with ``content`` as its first message, or put it in the active run's inbox. Raises
    ``AgentsDisabled`` or ``grants.AgentGrantInvalid`` when no run may start."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        # The conversation row lock serialises posts, so two messages cannot both start a run.
        locked = AgentConversation.objects.select_for_update().get(pk=conversation.id)
        active = AgentRun.objects.select_for_update().filter(conversation_id=locked.id, status__in=ACTIVE_RUN_STATUSES).first()
        if active is not None:
            return deliver(active, user, content, now=now)
        if not runner.switch_on():
            raise AgentsDisabled()
        grant = grants.ensure_grant(user.id, now=now)
        message = AgentConversationMessage.objects.create(conversation_id=locked.id, role='user', content=content, created_at=now)
        run = AgentRun.objects.create(conversation_id=locked.id, user_id=user.id, grant_id=grant.id,
                                      model=run_model(locked, model), created_at=now, updated_at=now)
        AgentConversation.objects.filter(pk=locked.id).update(status=run.status, last_run_at=now, updated_at=now)
        events.emit(run.id, 'run_queued', {'messageId': str(message.id)}, now=now)
        return {'delivery': 'run', 'run': run_json(run), 'message': message_json(message)}


def deliver(run, user, content, *, now):
    """Queue ``content`` for the locked active ``run``, waking it when it waits on a quote or a limit."""
    row = AgentInboxMessage.objects.create(conversation_id=run.conversation_id, run_id=run.id, user_id=user.id,
                                           content=content, created_at=now)
    events.emit(run.id, 'message_queued', {'inboxId': str(row.id)}, now=now)
    if run.status == 'waiting_approval' and run.cancel_requested_at is None:
        runner.decline_quote(run.id, 'message', now=now)
    elif run.status == 'paused_limit' and (run.resume_after is None or run.resume_after > now):
        AgentRun.objects.filter(pk=run.id).update(resume_after=now, updated_at=now)
    AgentConversation.objects.filter(pk=run.conversation_id).update(updated_at=now)
    run = AgentRun.objects.get(pk=run.id)
    return {'delivery': 'inbox', 'run': run_json(run), 'inbox': inbox_json(row)}


def request_cancel(run_id, *, cancel_jobs, now=None):
    """Ask the worker to stop the run at its next step boundary (and, with ``cancel_jobs``, cancel its active jobs).
    Returns the run, or None once it has finished."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        run = AgentRun.objects.select_for_update().get(pk=run_id)
        if run.status not in ACTIVE_RUN_STATUSES:
            return None
        requested_at = run.cancel_requested_at or now
        jobs = run.cancel_jobs or bool(cancel_jobs)
        if (requested_at, jobs) != (run.cancel_requested_at, run.cancel_jobs):
            AgentRun.objects.filter(pk=run.id).update(cancel_requested_at=requested_at, cancel_jobs=jobs, updated_at=now)
            events.emit(run.id, 'cancel_requested', {'cancelJobs': jobs}, now=now)
        return AgentRun.objects.get(pk=run.id)


def recent_runs(conversation):
    return [run_json(run) for run in AgentRun.objects.filter(conversation_id=conversation.id).order_by('-created_at', '-id')[:RECENT_RUNS]]


def feed(run, *, after, limit):
    """A page of the run's events after ``after``, with the run and its undelivered messages. The run is read first:
    a terminal status is written with its final event, so a client that stops polling on it has seen every event
    once ``more`` is false."""
    current = AgentRun.objects.get(pk=run.id)
    rows = events.page(run.id, after=after, limit=limit)
    pending = AgentInboxMessage.objects.filter(run_id=run.id, delivered_at__isnull=True).order_by('created_at', 'id')
    return {'run': run_json(current), 'events': [event_json(row) for row in rows],
            'nextAfter': rows[-1].seq if rows else after, 'more': len(rows) == max(1, min(limit, events.PAGE_SIZE)),
            'pendingMessages': [inbox_json(row) for row in pending]}
