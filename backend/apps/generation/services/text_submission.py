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

# Each processing level has its own model and its own estimator rate.
PRICING_KEYS = {'basic': 'Board AI text', 'advanced': 'Board AI text (advanced)'}
# The Google Search grounding fee of one grounded request (``per_1000_requests``), for the web formats only.
WEB_SEARCH_KEY = 'Board AI web search'


def text_model(processing='basic', env=None):
    """The Gemini model code text jobs run on: the agent model (``AGENT_LLM_MODEL``), or with advanced processing the
    stronger ``AGENT_LLM_MODEL_ADVANCED``."""
    from apps.agents.llm import advanced_agent_model, agent_model
    env = os.environ if env is None else env
    return advanced_agent_model(env) if processing == 'advanced' else agent_model(env)


def model_name(code):
    return f'Gemini ({code})'


def web_search_fee(pricing):
    """The exact (unrounded) cents one grounded request adds. A worker reads only stored prices, so a row that was never
    stored falls back to the default one."""
    from apps.admin_dashboard.default_pricing import DEFAULT_PRICING
    row = next((row for row in pricing if row['model'] == WEB_SEARCH_KEY), None) or next(row for row in DEFAULT_PRICING if row['model'] == WEB_SEARCH_KEY)
    if row['unit'] != 'per_1000_requests' or not enqueue.integer(row['unitCostCents']) or row['unitCostCents'] < 0:
        raise enqueue.InvalidRequest(f'Board AI pricing is not configured. Ask an administrator to set the "{WEB_SEARCH_KEY}" rate.')
    return row['unitCostCents'] / 1000


def text_cost(value, pricing, processing='basic', *, grounded=None):
    """Estimator cents of a text job: tokens at the processing rate, plus one grounding fee for a web format.
    ``grounded=False`` prices a web format as if no search ran (the refund when the answer reports none)."""
    from apps.agents.board import estimated_tokens, is_web_format
    key = PRICING_KEYS[processing]
    row = next((row for row in pricing if row['model'] == key), None)
    if row is None or row['unit'] != 'per_million_tokens' or not enqueue.integer(row['unitCostCents']) or row['unitCostCents'] < 0:
        raise enqueue.InvalidRequest(f'Board AI pricing is not configured. Ask an administrator to set the "{key}" rate.')
    fee = web_search_fee(pricing) if is_web_format(value['format']) and grounded is not False else 0
    return max(1, math.ceil(row['unitCostCents'] * estimated_tokens(value) / 1000000 + fee))


def text_request(actor, name, turns, processing, prompt=None):
    """The validated stored input and estimated cost of a text job: (submission input, cost cents)."""
    from apps.agents.board import submission_input
    try:
        enqueue.validate_prompt(prompt if prompt is not None else (turns[-1]['text'] if turns else ''), actor.id)
        value = submission_input(name, text_model(processing), turns)
        return value, text_cost(value, read_pricing(), processing)
    except enqueue.InvalidRequest as error:
        raise invalid(error) from None
    except ValueError as error:
        raise Refused(400, {'error': str(error)}) from None


def quote_text(actor, name, turns, processing='basic', prompt=None):
    """Price a text job exactly as ``submit_text`` would queue it; nothing is stored or queued."""
    from apps.agents.board import is_web_format
    value, cost = text_request(actor, name, turns, processing, prompt)
    result = {'kind': 'text', 'model': model_name(value['model']), 'costCents': cost}
    if is_web_format(name):
        # What the grounding fee adds to costCents, so the panel can show it before the person runs the request.
        result['groundingCents'] = cost - text_cost(value, read_pricing(), processing, grounded=False)
    return result


def submit_text(actor, name, turns, *, processing='basic', project_id=None, origin=None, admit=None, prompt=None):
    """Queue a text job for ``actor`` and return its generation row.

    ``admit(values)`` runs with the priced values and new ``id`` in the transaction that creates the row (the board
    creates its job row there); whatever it raises comes back as ``AdmissionRefused`` and nothing is stored.
    """
    value, cost = text_request(actor, name, turns, processing, prompt)
    identifier, now = uuid.uuid4(), now_ms()
    item = dict(id=str(identifier), kind='text', status='queued', prompt=prompt if prompt is not None else turns[-1]['text'], model=model_name(value['model']),
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
