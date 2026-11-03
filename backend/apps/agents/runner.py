"""The Agents tab's run engine: advances one ``agent_runs`` row step by step while the worker holds its lease.

    outcome = advance(run_id, lease=lease, stop=stop)   # called by apps.agents.worker on a pool thread

A run moves queued -> running -> waiting_approval | waiting_jobs | paused_limit -> completed | failed | cancelled.
Every step is journaled in ``agent_run_steps`` before it runs: an ``llm`` step is one Gemini call through
``AgentLoopTransport``; a ``tool`` step is one model function call, dispatched in-process with ``server.dispatch`` as the
run's agent grant and the idempotency key ``<run id>:<step index>``. The next action is always derived from the
journal, so a worker that dies anywhere resumes where it stopped: an ``llm`` step without an outcome is re-issued, and
a ``tool`` step without an outcome is replayed with the same key, which returns the first receipt instead of paying
again.

At every step boundary the runner stops if its lease was lost or the worker is stopping (the run goes back to
``queued``), honours a cancel request, re-checks the grant, drains the inbox, and checks the bounds: the global
``agentsEnabled`` switch, the per-run step, cost and wall-clock bounds, and ``step_limits.check_limits``. Paid tools never
wait: after a model turn's calls the run sits in ``waiting_jobs`` until every generation it linked is terminal, or
until the artist sends a message. A
``quote_required`` result parks the run in ``waiting_approval``; once the artist approves (``approve_quote``), the same
step is replayed with the quote token, plus ``confirmedByUser`` at the confirmation amount. The model can never send
either field (``declarations.harness_arguments``).
"""
import asyncio
import hashlib
import json
import logging
import os
from dataclasses import dataclass

from django.db import transaction

from apps.admin_dashboard.models import AppSetting
from apps.authentication.models import User
from apps.common.leases import now_ms
from apps.generation.models import Generation
from apps.generation.services import cancellation
from apps.integrations.transport import ProviderError
from apps.mcp import server
from apps.mcp.registry import REGISTRY, visible
from . import events, grants
from .declarations import HARNESS_FIELDS, harness_arguments
from .step_limits import check_limits
from .llm import PART_METADATA
from .loop_llm import AgentLoopTransport, UsageContext, loop_body
from .models import (TERMINAL_RUN_STATUSES, AgentChatAsset, AgentConversation, AgentConversationMessage, AgentInboxMessage,
                     AgentRun, AgentRunStep)

logger = logging.getLogger('veevee.agents')

MAX_STEPS = 60                       # steps per run, LLM and tool together
MAX_RUN_COST_CENTS = 5000            # paid tool estimates per run
MAX_WALL_MS = 2 * 60 * 60 * 1000     # from the run's first step, waits included
SWITCH = 'agentsEnabled'             # AppSetting: 'false' pauses every run at its next step boundary
SWITCH_RETRY_MS = 60_000
LLM_ATTEMPTS = 3
LLM_RETRY_SECONDS = (2, 10)
RETRYABLE_STATUS = frozenset((408, 429, 500, 502, 503, 504))
HISTORY_MESSAGES = 40                # earlier chat messages a run's first turn sees
RESPONSE_BUDGET = 24_000             # characters of JSON per function response the model sees
SUBMIT_TOOLS = frozenset(('generate_image', 'generate_video', 'upscale_media', 'finalize_draft'))
ACTIVE_JOBS = cancellation.ACTIVE
PROTOCOL = 'agent-run'
STARTABLE = ('queued', 'waiting_jobs', 'paused_limit')


@dataclass(frozen=True)
class Action:
    """What the journal says comes next: ``llm`` or ``tool`` (a new step, or ``step`` to replay), ``wait_approval``,
    ``wait_jobs`` or ``complete``."""
    kind: str
    step: object = None
    call: dict = None


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), default=str).encode()).hexdigest()


# Run state -------------------------------------------------------------------------------------------------------

def _locked(run_id):
    return AgentRun.objects.select_for_update().get(pk=run_id)


def _set(run, now, **fields):
    """Update the locked run row and the conversation's status."""
    fields['updated_at'] = now
    AgentRun.objects.filter(pk=run.id).update(**fields)
    for key, value in fields.items():
        setattr(run, key, value)
    if 'status' in fields:
        AgentConversation.objects.filter(pk=run.conversation_id).update(status=fields['status'])


def _finish(run_id, status, kind, payload, *, now, **fields):
    with transaction.atomic():
        run = _locked(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            return run
        _set(run, now, status=status, finished_at=now, pause_reason=None, resume_after=None, **fields)
        events.emit(run.id, kind, payload, now=now)
        return run


def fail(run_id, code, message, *, now=None):
    now = now_ms() if now is None else now
    _finish(run_id, 'failed', 'failed', {'code': code, 'message': message}, now=now, error={'code': code, 'message': message})
    return 'failed'


def pause(run_id, reason, resume_after, *, now=None):
    now = now_ms() if now is None else now
    with transaction.atomic():
        run = _locked(run_id)
        if run.status in TERMINAL_RUN_STATUSES:
            return 'finished'
        changed = (run.status, run.pause_reason) != ('paused_limit', reason)
        _set(run, now, status='paused_limit', pause_reason=reason, resume_after=resume_after)
        if changed:
            # A later retry only moves resume_after; the feed shows each pause once.
            events.emit(run.id, 'paused', {'reason': reason, 'resumeAfter': resume_after}, now=now)
    return 'paused'


def requeue(run_id, *, now=None):
    """A graceful stop or a lost lease: the next worker resumes the run from its journal."""
    now = now_ms() if now is None else now
    AgentRun.objects.filter(pk=run_id, status='running').update(status='queued', updated_at=now)
    return 'stopped'


def cancel(run, *, now=None, cancel_job=None):
    """Stop the run; with ``cancel_jobs`` also cancel every linked job still queued or running. Jobs that are kept
    finish normally and still land in the library."""
    now = now_ms() if now is None else now
    cancel_job = cancel_job or cancellation.cancel_generation
    jobs = []
    if run.cancel_jobs:
        actor = User.objects.filter(pk=run.user_id).first()
        for identifier in Generation.objects.filter(agent_run_id=run.id, status__in=ACTIVE_JOBS).order_by('created_at', 'id') \
                .values_list('id', flat=True):
            try:
                # Deferred: the generation worker, which holds the provider keys, sends any provider cancel.
                item, message = cancel_job(identifier, actor, defer=True) if actor is not None else (None, 'No owner.')
                jobs.append({'generationId': str(identifier), 'status': getattr(item, 'status', None), 'message': message})
            except cancellation.CancelError as error:
                jobs.append({'generationId': str(identifier), 'status': None, 'message': str(error)})
    _finish(run.id, 'cancelled', 'cancelled', {'cancelJobs': run.cancel_jobs, 'jobs': jobs}, now=now)
    return 'cancelled'


def approve_quote(run_id, user_id, *, step_index=None, now=None):
    """The artist approved the waiting quote: store the approval on the step and queue the run, which replays that
    step with the quote. Returns the run, or None when nothing is waiting for approval (or ``step_index`` differs)."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        run = _locked(run_id)
        step = AgentRunStep.objects.filter(run_id=run.id, kind='tool', outcome='quote_required').order_by('-step_index').first()
        if (run.status != 'waiting_approval' or run.cancel_requested_at is not None or step is None
                or (step_index is not None and step.step_index != step_index)):
            return None
        result = {**step.result, 'approval': {'by': str(user_id), 'at': now}}
        AgentRunStep.objects.filter(pk=step.pk).update(result=result)
        _set(run, now, status='queued')
        events.emit(run.id, 'quote_approved', {'stepIndex': step.step_index, 'costCents': step.result['quote']['costCents']}, now=now)
        return run


# The journal -----------------------------------------------------------------------------------------------------

def journal(run_id):
    return list(AgentRunStep.objects.filter(run_id=run_id).order_by('step_index'))


def pending_inbox(run):
    return AgentInboxMessage.objects.filter(run_id=run.id, delivered_at__isnull=True)


def active_jobs(run):
    return list(Generation.objects.filter(agent_run_id=run.id, status__in=ACTIVE_JOBS).order_by('created_at', 'id')
                .values_list('id', flat=True))


def next_action(run, steps):
    if steps and steps[-1].outcome is None:
        return Action(steps[-1].kind, step=steps[-1])
    last = steps[-1] if steps else None
    if last is not None and last.kind == 'tool' and last.outcome == 'quote_required':
        return Action('tool', step=last) if last.result.get('approval') else Action('wait_approval', step=last)
    model_turn = next((step for step in reversed(steps) if step.kind == 'llm'), None)
    if model_turn is None:
        return Action('llm')
    calls = model_turn.result.get('calls') or []
    done = sum(1 for step in steps if step.kind == 'tool' and step.step_index > model_turn.step_index)
    if done < len(calls):
        return Action('tool', call=calls[done])
    if calls:
        # A message from the artist wakes the model while jobs are still running.
        return Action('wait_jobs') if active_jobs(run) and not pending_inbox(run).exists() else Action('llm')
    if model_turn.outcome == 'final' and not pending_inbox(run).exists():
        return Action('complete')
    return Action('llm')


def drain_inbox(run, step_index, *, now=None):
    """Deliver every undelivered inbox message for the run, oldest first, before the step at ``step_index``."""
    now = now_ms() if now is None else now
    with transaction.atomic():
        _locked(run.id)
        rows = list(pending_inbox(run).order_by('created_at', 'id'))
        for row in rows:
            AgentInboxMessage.objects.filter(pk=row.pk).update(delivered_at=now, delivered_step=step_index)
            AgentConversationMessage.objects.create(conversation_id=run.conversation_id, role='user', content=row.content,
                                                    tool_trace={'runId': str(run.id), 'deliveredStep': step_index}, created_at=now)
            events.emit(run.id, 'message_delivered', {'inboxId': str(row.id), 'stepIndex': step_index}, now=now)
    return len(rows)


def _new_step(run, kind, *, now, tool_name=None, result=None):
    """Journal the next step and advance ``step_count`` in one transaction."""
    with transaction.atomic():
        locked = _locked(run.id)
        index = locked.step_count
        step = AgentRunStep.objects.create(
            run_id=run.id, step_index=index, kind=kind, tool_name=tool_name, input_hash='',
            idempotency_key=f'{run.id}:{index}' if kind == 'tool' else None, result=result or {}, started_at=now)
        _set(locked, now, step_count=index + 1)
        events.emit(run.id, 'step_started', {'stepIndex': index, 'kind': kind, **({'tool': tool_name} if tool_name else {})}, now=now)
        return step


# Building a step's contents --------------------------------------------------------------------------------------

def history_turns(run):
    """The chat before this run (its first user message included), oldest first."""
    rows = list(AgentConversationMessage.objects.filter(conversation_id=run.conversation_id, created_at__lte=run.created_at,
                                                        role__in=('user', 'assistant'))
                .order_by('-created_at', '-id')[:HISTORY_MESSAGES])
    return [{'role': 'model' if row.role == 'assistant' else 'user', 'parts': [{'text': row.content}]}
            for row in reversed(rows) if row.content]


def note_parts(notes):
    """The harness's own notes before a model turn: jobs that finished since the model last spoke."""
    jobs = (notes or {}).get('jobs') or []
    if not jobs:
        return []
    listed = '; '.join(f"{job['kind']} {job['id']} {job['status']}" for job in jobs)
    return [{'text': f'Veevee: these jobs finished since your last turn: {listed}. get_generation shows each result.'}]


def rejected_parts(names):
    return [{'text': f'Veevee: {name} is not a tool you can call. Use only the declared tools.'} for name in names]


def merge(turns):
    """Adjacent turns of the same role become one, so roles alternate."""
    merged = []
    for turn in turns:
        if merged and merged[-1]['role'] == turn['role']:
            merged[-1] = {'role': turn['role'], 'parts': merged[-1]['parts'] + turn['parts']}
        else:
            merged.append({'role': turn['role'], 'parts': list(turn['parts'])})
    return merged


def build_contents(run, steps, step):
    """The Gemini contents for the llm ``step``: the chat so far, then each earlier model turn followed by its function
    responses, the harness notes and the inbox messages delivered by then, in the order the model met them."""
    turns = history_turns(run)
    inbox = list(AgentInboxMessage.objects.filter(run_id=run.id, delivered_step__isnull=False)
                 .order_by('delivered_step', 'created_at', 'id'))
    pending, placed = [], 0

    def user_turn(before, notes):
        nonlocal pending, placed
        parts = pending + note_parts(notes)
        while placed < len(inbox) and inbox[placed].delivered_step <= before:
            parts.append({'text': inbox[placed].content})
            placed += 1
        pending = []
        if parts:
            turns.append({'role': 'user', 'parts': parts})

    for earlier in steps:
        if earlier.step_index >= step.step_index:
            break
        if earlier.kind == 'tool':
            if earlier.outcome is not None and earlier.outcome != 'quote_required':
                call = earlier.result['call']
                response = {'name': call['name'], 'response': earlier.result.get('response') or {}}
                if call.get('id'):
                    response['id'] = call['id']
                pending.append({'functionResponse': response})
            continue
        user_turn(earlier.step_index, earlier.result.get('notes'))
        turns.append({'role': 'model', 'parts': earlier.result.get('parts') or []})
        pending.extend(rejected_parts(earlier.result.get('rejected') or []))
    user_turn(step.step_index, step.result.get('notes'))
    return merge([turn for turn in turns if turn['parts']])


def model_response(value):
    """A tool result as the model sees it: never a quote token, and at most ``RESPONSE_BUDGET`` characters of JSON."""
    def clean(item):
        if isinstance(item, dict):
            return {key: clean(child) for key, child in item.items() if key not in ('quoteToken', 'token')}
        if isinstance(item, list):
            return [clean(child) for child in item]
        return item
    cleaned = clean(value if isinstance(value, dict) else {'result': value})
    text = json.dumps(cleaned, ensure_ascii=False, separators=(',', ':'), default=str)
    if len(text) <= RESPONSE_BUDGET:
        return cleaned
    return {'truncated': True, 'json': text[:RESPONSE_BUDGET]}


# LLM steps -------------------------------------------------------------------------------------------------------

def finished_jobs(run, steps):
    """Linked jobs that reached a terminal state and no earlier model turn was told about."""
    told = {job['id'] for step in steps if step.kind == 'llm' for job in (step.result.get('notes') or {}).get('jobs', [])}
    rows = Generation.objects.filter(agent_run_id=run.id).exclude(status__in=ACTIVE_JOBS).order_by('created_at', 'id') \
        .values('id', 'kind', 'status')
    return [{'id': str(row['id']), 'kind': row['kind'], 'status': row['status']} for row in rows if str(row['id']) not in told]


def read_reply(principal, payload):
    """``(parts, calls, rejected, text)`` from a generateContent answer: the model turn to keep, its function calls
    for tools this grant can call, the names of any other calls (dropped), and its visible text."""
    candidates = payload.get('candidates') if isinstance(payload, dict) else None
    content = (candidates[0].get('content') if candidates and isinstance(candidates[0], dict) else None) or {}
    allowed = {spec.name for spec in visible(principal)}
    parts, calls, rejected, texts = [], [], [], []
    for part in content.get('parts') or []:
        if not isinstance(part, dict):
            continue
        part = {key: value for key, value in part.items() if key in ('text', 'functionCall') or key in PART_METADATA}
        if 'functionCall' in part and 'text' not in part:
            function = part['functionCall'] if isinstance(part['functionCall'], dict) else {}
            name, arguments = function.get('name'), function.get('args', {})
            if name not in allowed or not isinstance(arguments, dict):
                rejected.append(str(name)[:80])
                continue
            call = {'name': name, 'args': arguments, **({'id': function['id']} if isinstance(function.get('id'), str) else {})}
            part['functionCall'] = call
            calls.append(call)
            parts.append(part)
        elif isinstance(part.get('text'), str) and 'functionCall' not in part:
            parts.append(part)
            if not part.get('thought'):
                texts.append(part['text'])
    return parts, calls, rejected, ''.join(texts).strip()


def llm_step(run, principal, action, stop, *, now=now_ms):
    steps = journal(run.id)
    if action.step is None:
        step = _new_step(run, 'llm', now=now(), result={'notes': {'jobs': finished_jobs(run, steps)}})
        for job in step.result['notes']['jobs']:
            events.emit(run.id, 'job_finished', {'generationId': job['id'], 'kind': job['kind'], 'status': job['status'],
                                                 'stepIndex': step.step_index}, now=now())
        steps.append(step)
    else:
        step = action.step
    body = loop_body(principal, build_contents(run, steps, step))
    AgentRunStep.objects.filter(pk=step.pk).update(input_hash=digest(body))
    key = os.environ.get('GOOGLE_API_KEY')
    if not key:
        return fail(run.id, 'llm_unconfigured', 'The Agents tab is not configured on this server.')
    transport = AgentLoopTransport(run.model, UsageContext(user_id=run.user_id, grant_id=run.grant_id,
                                                           conversation_id=run.conversation_id, run_id=run.id,
                                                           step_index=step.step_index))
    retryable, payload = False, None
    try:
        response = transport.request('POST', transport.endpoint, headers={'Content-Type': 'application/json', 'x-goog-api-key': key},
                                     body=body)
        if response.ok:
            payload = response.json()
        else:
            retryable = response.status in RETRYABLE_STATUS
    except ProviderError as error:
        retryable = getattr(error, 'code', None) != 'agent_scope'
    except ValueError:
        retryable = True
    if payload is None:
        attempts = (step.result.get('attempts') or 0) + 1
        AgentRunStep.objects.filter(pk=step.pk).update(result={**step.result, 'attempts': attempts})
        if not retryable or attempts >= LLM_ATTEMPTS:
            return fail(run.id, 'llm_failed', 'The model could not answer. Try again in a few minutes.')
        stop.wait(LLM_RETRY_SECONDS[min(attempts, len(LLM_RETRY_SECONDS)) - 1])
        return None
    parts, calls, rejected, text = read_reply(principal, payload)
    if not calls and not rejected and not text:
        return fail(run.id, 'empty_reply', 'The model returned nothing usable.')
    return finish_llm_step(run, step, parts, calls, rejected, text, now=now())


def finish_llm_step(run, step, parts, calls, rejected, text, *, now):
    outcome = 'final' if not calls and not rejected else 'calls'
    with transaction.atomic():
        locked = _locked(run.id)
        result = {**step.result, 'parts': parts, 'calls': calls, 'rejected': rejected, 'text': text}
        AgentRunStep.objects.filter(pk=step.pk).update(status='finished', outcome=outcome, result=result, finished_at=now)
        if text:
            events.emit(run.id, 'assistant_text', {'stepIndex': step.step_index, 'text': text, 'final': outcome == 'final'}, now=now)
        if outcome != 'final':
            return None
        AgentConversationMessage.objects.create(conversation_id=run.conversation_id, role='assistant', content=text,
                                                tool_trace={'runId': str(run.id), 'stepIndex': step.step_index}, created_at=now)
        if pending_inbox(locked).exists():
            return None
        return complete(locked, now=now)


def complete(run, *, now):
    """Finish the locked run unless a message is still waiting in its inbox."""
    with transaction.atomic():
        run = _locked(run.id)
        if run.status in TERMINAL_RUN_STATUSES:
            return 'finished'
        if pending_inbox(run).exists():
            return None
        _set(run, now, status='completed', finished_at=now)
        events.emit(run.id, 'completed', {'steps': run.step_count, 'costCents': run.cost_cents}, now=now)
        return 'completed'


# Tool steps ------------------------------------------------------------------------------------------------------

def with_location(conversation, name, arguments):
    """The model's arguments, plus the chat's default folder (or project) when a tool that takes a location got none."""
    spec = REGISTRY.get(name)
    properties = spec.schema().get('properties', {}) if spec is not None else {}
    if not {'folderId', 'projectId'} <= set(properties) or arguments.get('folderId') or arguments.get('projectId'):
        return arguments
    if conversation.default_folder_id:
        return {**arguments, 'folderId': str(conversation.default_folder_id)}
    if conversation.default_project_id:
        return {**arguments, 'projectId': str(conversation.default_project_id)}
    return arguments


def tool_step(run, principal, action, *, now=now_ms):
    if action.step is None:
        conversation = AgentConversation.objects.get(pk=run.conversation_id)
        model_arguments = {key: value for key, value in action.call['args'].items() if key not in HARNESS_FIELDS}
        call = {**action.call, 'args': with_location(conversation, action.call['name'], model_arguments)}
        step = _new_step(run, 'tool', now=now(), tool_name=call['name'], result={'call': call})
    else:
        step = action.step
    call, quote = step.result['call'], step.result.get('quote')
    approved = quote is not None and step.result.get('approval') is not None
    arguments = harness_arguments(call['name'], call['args'], idempotency_key=step.idempotency_key,
                                  quote_token=quote['token'] if approved else None,
                                  confirmed=approved and quote['costCents'] >= principal.caps.confirm_at_cents)
    AgentRunStep.objects.filter(pk=step.pk).update(input_hash=digest({'name': call['name'], 'arguments': call['args']}),
                                                   outcome=None, status='started')
    try:
        done = asyncio.run(server.dispatch(principal, call['name'], arguments, request_id=f'agent:{run.id}:{step.step_index}',
                                           protocol_version=PROTOCOL, tags={'runId': str(run.id), 'stepIndex': step.step_index}))
    except server.UnknownTool:
        done = None
    return finish_tool_step(run, step, done, now=now())


def finish_tool_step(run, step, done, *, now):
    call = step.result['call']
    if done is None:
        outcome, structured, sentence, record = 'UNKNOWN_TOOL', {'code': 'UNKNOWN_TOOL', 'message': 'This tool cannot be used here.'}, '', {}
    else:
        outcome, record = done.outcome, done.call.record
        structured = done.result.structured if done.error is None else done.error.payload()
        sentence = done.result.sentence if done.error is None else done.error.message
    with transaction.atomic():
        locked = _locked(run.id)
        if outcome == 'quote_required':
            quote = structured['quote']
            result = {key: value for key, value in step.result.items() if key != 'approval'}
            result['quote'] = {key: quote[key] for key in ('token', 'costCents', 'display', 'expiresAt', 'summary', 'requiresUserConfirmation')}
            AgentRunStep.objects.filter(pk=step.pk).update(status='finished', outcome=outcome, result=result, finished_at=now)
            _set(locked, now, status='waiting_approval')
            events.emit(run.id, 'quote_required', {
                'stepIndex': step.step_index, 'tool': call['name'], 'arguments': call['args'], 'prompt': call['args'].get('prompt'),
                'quote': {key: quote[key] for key in ('costCents', 'display', 'expiresAt', 'summary', 'requiresUserConfirmation')}},
                now=now)
            return 'waiting'
        cost, generation_id = 0, record.get('generationId')
        if call['name'] in SUBMIT_TOOLS and generation_id and done.error is None:
            linked = link_job(locked, generation_id, now=now)
            if linked is not None:
                cost = int(record.get('costCents') or 0)
                events.emit(run.id, 'job_queued', {'generationId': str(generation_id), 'kind': linked, 'tool': call['name'],
                                                   'stepIndex': step.step_index}, now=now)
        AgentRunStep.objects.filter(pk=step.pk).update(status='finished', outcome=outcome, cost_cents=cost, finished_at=now,
                                                       result={**step.result, 'response': model_response(structured)})
        _set(locked, now, cost_cents=locked.cost_cents + cost)
        events.emit(run.id, 'tool_called', {'stepIndex': step.step_index, 'tool': call['name'], 'outcome': outcome,
                                            'summary': sentence[:300]}, now=now)
    return None


def link_job(run, generation_id, *, now):
    """Link a job this run's grant submitted to the run and the chat; returns its kind the first time, else None."""
    row = Generation.objects.filter(pk=generation_id, mcp_token_id=run.grant_id).values('kind', 'agent_run_id').first()
    if row is None or row['agent_run_id'] not in (None, run.id):
        return None
    Generation.objects.filter(pk=generation_id, agent_run_id__isnull=True).update(agent_run_id=run.id)
    _, created = AgentChatAsset.objects.get_or_create(conversation_id=run.conversation_id, asset_id=generation_id,
                                                      defaults={'source': 'output', 'kind': row['kind'], 'run_id': run.id,
                                                                'created_at': now})
    return row['kind'] if created else None


# The loop --------------------------------------------------------------------------------------------------------

def switch_on():
    return AppSetting.objects.filter(key=SWITCH).values_list('value', flat=True).first() != 'false'


def bound_exceeded(run, action, now):
    if action.step is None and run.step_count >= MAX_STEPS:
        return 'step_limit', f'This run reached its {MAX_STEPS} step limit.'
    if run.cost_cents >= MAX_RUN_COST_CENTS:
        return 'cost_limit', 'This run reached its spending limit.'
    if run.started_at is not None and now - run.started_at > MAX_WALL_MS:
        return 'time_limit', 'This run reached its time limit.'
    return None


def start(run, now):
    """Move a startable run to ``running``; the first time also stamps ``started_at``."""
    with transaction.atomic():
        locked = _locked(run.id)
        if locked.status == 'running':
            return locked
        if locked.status not in STARTABLE:
            return None
        resumed = locked.started_at is not None
        _set(locked, now, status='running', pause_reason=None, resume_after=None,
             **({} if resumed else {'started_at': now}))
        events.emit(run.id, 'resumed' if resumed else 'run_started', {}, now=now)
        return locked


def wait_for_jobs(run, now):
    with transaction.atomic():
        locked = _locked(run.id)
        if locked.status == 'waiting_jobs':
            _set(locked, now)
        else:
            _set(locked, now, status='waiting_jobs')
            events.emit(run.id, 'waiting_jobs', {'generationIds': [str(identifier) for identifier in active_jobs(run)]}, now=now)
    return 'waiting'


def wait_for_approval(run, now):
    with transaction.atomic():
        locked = _locked(run.id)
        if locked.status != 'waiting_approval':
            _set(locked, now, status='waiting_approval')
    return 'waiting'


def advance(run_id, *, lease, stop, now=now_ms):
    """Advance the run until it waits, pauses, ends, or must stop; returns why it yielded."""
    principal = None
    while True:
        run = AgentRun.objects.filter(pk=run_id).first()
        if run is None or run.status in TERMINAL_RUN_STATUSES:
            return 'finished'
        if not lease.held or stop.is_set():
            return requeue(run.id, now=now())
        if run.cancel_requested_at is not None:
            return cancel(run, now=now())
        try:
            principal = grants.recheck(principal) if principal is not None else grants.agent_principal(run.grant_id)
        except grants.AgentGrantInvalid as error:
            return fail(run.id, 'grant_invalid', str(error), now=now())
        action = next_action(run, journal(run.id))
        if action.kind == 'wait_approval':
            return wait_for_approval(run, now())
        if action.kind == 'wait_jobs':
            return wait_for_jobs(run, now())
        if action.kind == 'complete':
            outcome = complete(run, now=now())
            if outcome is not None:
                return outcome
            continue
        if not switch_on():
            return pause(run.id, 'agents_disabled', now() + SWITCH_RETRY_MS, now=now())
        exceeded = bound_exceeded(run, action, now())
        if exceeded is not None:
            return fail(run.id, *exceeded, now=now())
        verdict = check_limits(run, action.kind)
        if not verdict.ok:
            return pause(run.id, verdict.reason or 'limit', verdict.resume_after, now=now())
        run = start(run, now())
        if run is None:
            return 'finished'
        drain_inbox(run, run.step_count, now=now())
        if action.kind == 'llm':
            outcome = llm_step(run, principal, action, stop, now=now)
        else:
            outcome = tool_step(run, principal, action, now=now)
        if outcome is not None:
            return outcome
