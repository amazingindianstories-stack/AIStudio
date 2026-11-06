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
from apps.mcp.tools.generate import GLOBAL
from . import events, grants, limits, runner
from .loop_llm import DEFAULT_THINKING_LEVEL, LOOP_MODEL, LOOP_MODELS, THINKING_LEVELS
from .models import ACTIVE_RUN_STATUSES, AgentConversation, AgentConversationMessage, AgentInboxMessage, AgentRun
from .services import conversation_json, message_json

RECENT_RUNS = 20


class AgentsDisabled(Exception):
    """Agents are off for the user (the global switch or their own override): no new run starts."""


class RunLimitReached(Exception):
    """An admin limit refuses a new run (``agentActiveRuns``); ``hit`` is the ``limits.LimitHit``."""

    def __init__(self, hit):
        super().__init__(hit.message)
        self.hit = hit


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


def thinking_allowed(model, level):
    """True when ``level`` is a thinking level ``model`` takes; None (no choice) always is."""
    return level is None or level in THINKING_LEVELS.get(model, ())


def run_thinking_level(model, requested):
    return requested if requested in THINKING_LEVELS.get(model, ()) else DEFAULT_THINKING_LEVEL


def run_json(run):
    return {'id': str(run.id), 'conversationId': str(run.conversation_id), 'status': run.status, 'model': run.model,
            'thinkingLevel': run.thinking_level,
            'stepCount': run.step_count, 'costCents': run.cost_cents, 'pauseReason': run.pause_reason,
            'resumeAfter': run.resume_after, 'error': run.error, 'cancelRequestedAt': run.cancel_requested_at,
            'cancelJobs': run.cancel_jobs, 'startedAt': run.started_at, 'finishedAt': run.finished_at,
            'createdAt': run.created_at, 'updatedAt': run.updated_at}


def inbox_json(row):
    return {'id': str(row.id), 'runId': str(row.run_id) if row.run_id else None, 'content': row.content,
            'attachments': row.attachments or [], 'composer': row.composer, 'createdAt': row.created_at, 'deliveredAt': row.delivered_at, 'deliveredStep': row.delivered_step}


def event_json(row):
    return {'seq': row.seq, 'kind': row.kind, 'payload': row.payload, 'createdAt': row.created_at}


def follow_location(conversation, context, now):
    """New jobs land where the composer that sent the message saves: its folder, or its project's unsorted items."""
    if context is not None:
        AgentConversation.objects.filter(pk=conversation.id).update(
            default_folder_id=context.get('folderId') if context.get('folderId') != GLOBAL else None,
            default_project_id=context.get('projectId'), updated_at=now)


# The name the Agents tab gives a chat it creates; a chat still called this takes its first message as its name.
DEFAULT_NAME = 'New chat'
TITLE_CHARS = 60


def title_from(content):
    """A chat name from its first message: one line, cut at a word near ``TITLE_CHARS``."""
    text = ' '.join(content.split())
    if len(text) <= TITLE_CHARS:
        return text
    cut = text[:TITLE_CHARS].rsplit(' ', 1)[0] or text[:TITLE_CHARS]
    return cut.rstrip(' ,.;:-') + '…'


def name_from_first_message(conversation, content, now):
    if conversation.name != DEFAULT_NAME or not content.strip():
        return
    if AgentConversationMessage.objects.filter(conversation_id=conversation.id, role='user').exists():
        return
    conversation.name = title_from(content)
    AgentConversation.objects.filter(pk=conversation.id).update(name=conversation.name, updated_at=now)


def message_trace(attachments, context):
    trace = {**({'attachments': list(attachments)} if attachments else {}), **({'composer': context} if context else {})}
    return trace or None


def post_message(conversation, user, content, *, model=None, thinking_level=None, attachments=(), composer=None, now=None):
    """Start a run with ``content`` as its first message on ``model`` at ``thinking_level`` (each defaulted when None),
    or put it in the active run's inbox, where the running model and level stay; ``attachments``
    (``media.attachment_json`` items, already validated) and the ``composer`` context (``views.composer_context``) are
    stored with it. Raises ``AgentsDisabled``, ``RunLimitReached`` or ``grants.AgentGrantInvalid`` when no run may
    start."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        # The conversation row lock serialises posts, so two messages cannot both start a run.
        locked = AgentConversation.objects.select_for_update().get(pk=conversation.id)
        active = AgentRun.objects.select_for_update().filter(conversation_id=locked.id, status__in=ACTIVE_RUN_STATUSES).first()
        if active is not None:
            follow_location(locked, composer, now)
            return deliver(active, user, content, attachments=attachments, composer=composer, now=now)
        hit = limits.check_run_admission(user)
        if hit is not None:
            raise AgentsDisabled() if hit.kind == limits.DISABLED else RunLimitReached(hit)
        follow_location(locked, composer, now)
        name_from_first_message(locked, content, now)
        grant = grants.ensure_grant(user.id, now=now)
        message = AgentConversationMessage.objects.create(conversation_id=locked.id, role='user', content=content, created_at=now,
                                                          tool_trace=message_trace(attachments, composer))
        chosen = run_model(locked, model)
        run = AgentRun.objects.create(conversation_id=locked.id, user_id=user.id, grant_id=grant.id, model=chosen,
                                      thinking_level=run_thinking_level(chosen, thinking_level), created_at=now, updated_at=now)
        AgentConversation.objects.filter(pk=locked.id).update(status=run.status, last_run_at=now, updated_at=now)
        events.emit(run.id, 'run_queued', {'messageId': str(message.id)}, now=now)
        return {'delivery': 'run', 'run': run_json(run), 'message': message_json(message),
                'conversation': conversation_json(AgentConversation.objects.get(pk=locked.id))}


def deliver(run, user, content, *, attachments=(), composer=None, now):
    """Queue ``content`` for the locked active ``run``, waking it when it waits on a quote or a limit."""
    row = AgentInboxMessage.objects.create(conversation_id=run.conversation_id, run_id=run.id, user_id=user.id,
                                           content=content, attachments=list(attachments), composer=composer, created_at=now)
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
