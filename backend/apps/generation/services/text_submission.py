"""Submitting and pricing text jobs (kind 'text'): the board's "Create with AI" text formats.

A text job is a generation row like an image: it is priced here in the application's estimator cents, registered with
the paid guard in the transaction that creates it, admitted by the generation worker under the per-user limit and the
Gemini spend window, and executed once (``text_execution``). The row is not library media: library reads and live
updates leave it out and it takes no library name. Only the leased generation worker calls the provider.
"""
import math
import os
import uuid

from django.db import transaction

from apps.common.leases import now_ms
from apps.common.responses import log_activity
from . import enqueue
from .paid_guard import PaidBudgetHold
from .pricing import read_pricing
from .submission import AdmissionRefused, Refused, admitted, invalid, origin_values

PRICING_KEY = 'Board AI text'


def text_model(env=None):
    """The Gemini model code text jobs run on: the configured agent model (``AGENT_LLM_MODEL``)."""
    from apps.agents.llm import agent_model
    return agent_model(os.environ if env is None else env)


def model_name(code):
    return f'Gemini ({code})'


def text_cost(value, pricing):
    from apps.agents.board import estimated_tokens
    row = next((row for row in pricing if row['model'] == PRICING_KEY), None)
    if row is None or row['unit'] != 'per_million_tokens' or not enqueue.integer(row['unitCostCents']) or row['unitCostCents'] < 0:
        raise enqueue.InvalidRequest('Board AI pricing is not configured. Ask an administrator to set the "Board AI text" rate.')
    return max(1, math.ceil(row['unitCostCents'] * estimated_tokens(value) / 1000000))


def text_request(actor, name, turns):
    """The validated stored input and estimated cost of a text job: (submission input, cost cents)."""
    from apps.agents.board import submission_input
    try:
        enqueue.validate_prompt(turns[-1]['text'] if turns else '', actor.id)
        value = submission_input(name, text_model(), turns)
        return value, text_cost(value, read_pricing())
    except enqueue.InvalidRequest as error:
        raise invalid(error) from None
    except ValueError as error:
        raise Refused(400, {'error': str(error)}) from None


def quote_text(actor, name, turns):
    """Price a text job exactly as ``submit_text`` would queue it; nothing is stored or queued."""
    value, cost = text_request(actor, name, turns)
    return {'kind': 'text', 'model': model_name(value['model']), 'costCents': cost}


def submit_text(actor, name, turns, *, project_id=None, origin=None, admit=None):
    """Queue a text job for ``actor`` and return its generation row.

    ``admit(values)`` runs with the priced values and new ``id`` in the transaction that creates the row (the board
    creates its job row there); whatever it raises comes back as ``AdmissionRefused`` and nothing is stored.
    """
    value, cost = text_request(actor, name, turns)
    identifier, now = uuid.uuid4(), now_ms()
    item = dict(id=str(identifier), kind='text', status='queued', prompt=turns[-1]['text'], model=model_name(value['model']),
                aspectRatio='', userId=str(actor.id), costCents=cost, costBasis='estimated', submissionInput=value,
                createdAt=now, updatedAt=now)
    if project_id:
        item['projectId'] = str(project_id)
    try:
        with transaction.atomic():
            admitted(admit, item)
            row = enqueue.persist({**item, **origin_values(origin)})
    except (PaidBudgetHold, AdmissionRefused):
        raise
    except Exception:
        raise Refused(500, {'error': 'Failed to save the text request.'}) from None
    log_activity(actor.id, 'generate', {'id': str(identifier), 'kind': 'text', 'model': item['model'], 'costCents': cost})
    return row
