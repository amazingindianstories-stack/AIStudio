"""The one path every paid tool takes: price, approve (auto-approve or quote), admit, submit, then optionally wait.

    priced = Priced(...)                 # from the tool's prepare(principal, arguments), on a database thread
    return await run(call, 'generate_image', priced)

Approval follows architecture v2 section 4.4 and ``controls.price_decision``: below the confirmation amount ($1) and at
or below the grant's auto-approve amount the call submits; otherwise it needs a matching unexpired, unused quote token,
plus ``confirmedByUser: true`` at or above the confirmation amount. A quote pays for one job. Submission goes through
the shared services with the row's agent origin, and the budget, rate and concurrency checks run in the transaction
that creates the row. Every paid call carries an idempotency key (derived from the token, tool, arguments and minute
when the agent sends none), so a transport retry returns the first generation instead of paying twice.
"""
import hashlib
from dataclasses import dataclass, field

from apps.common.leases import now_ms
from apps.generation.services import submission
from apps.generation.services.paid_guard import PaidBudgetHold
from apps.mcp_auth import controls
from . import errors, hold, quotes, results
from .registry import ToolResult
from .runtime import db
from .shapes import dollars

PAID_CONTROLS = {
    'wait': {'type': 'boolean', 'default': True,
             'description': 'Wait for the result (up to maxWaitSeconds). Pass false when starting several jobs.'},
    'maxWaitSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 45, 'default': 45,
                       'description': 'Wait at most this many seconds, counted from the start of the call.'},
    'includePreview': {'type': 'boolean', 'default': True, 'description': 'Include a small preview image when it is finished.'},
    'quoteToken': {'type': 'string', 'maxLength': 1024,
                   'description': 'The quote.token from a quote_required result or estimate_cost for these exact arguments.'},
    'confirmedByUser': {'type': 'boolean', 'description': 'Send true only after the user approved the quoted price.'},
    'idempotencyKey': {'type': 'string', 'pattern': '^[A-Za-z0-9_.:-]{8,128}$',
                       'description': 'Retrying with the same key returns the first job instead of paying again. '
                                      'Use a new key for each job you mean to start, even with identical arguments.'},
}
CONFLICTS = ('IDEMPOTENCY_PAYLOAD_MISMATCH', 'IDEMPOTENCY_OPERATION_MISMATCH', 'IDEMPOTENCY_ACTOR_MISMATCH')
LIST_MODELS = results.call('list_models', {}, 'Lists the models you can use now, with their inputs.')


@dataclass
class Priced:
    """A validated, priced request: ``canonical`` arguments (defaults filled) are what quotes and receipts bind to."""
    canonical: dict
    body: dict                      # the shared submission service's request values
    cost_cents: int
    summary: str                    # one line, e.g. "Seedance 2.5, 5 s, 1080p, 16:9, audio on"
    submit: object                  # submit(user, body, **options) -> public generation item
    extra: dict = field(default_factory=dict)


class PriceChanged(Exception):
    def __init__(self, cost_cents):
        super().__init__(f'The price is now {dollars(cost_cents)}.')
        self.cost_cents = cost_cents


class QuoteUsed(Exception):
    """The quote already paid for another job; the call needs a new one."""


def from_refused(refused):
    """A shared-service refusal as a tool error; the web's 400 texts pass through verbatim."""
    body = refused.body or {}
    message = body.get('error') or 'Veevee could not save this request.'
    if refused.code == 'MODEL_UNAVAILABLE':
        return errors.ToolError(errors.MODEL_UNAVAILABLE, f'{message} Call list_models for the models you can use.', next=LIST_MODELS)
    if refused.code in CONFLICTS:
        return errors.ToolError(errors.IDEMPOTENCY_CONFLICT, 'This idempotencyKey was already used with different arguments. Use a new key.')
    if refused.status == 404:
        return errors.ToolError(errors.NOT_FOUND, message)
    if refused.status == 429:
        retry = refused.headers.get('Retry-After')
        return errors.ToolError(errors.RATE_LIMITED, 'Veevee is busy reading media. Retry in a few seconds.',
                                retry_after_seconds=int(retry) if retry and retry.isdigit() else 1)
    if refused.status >= 500:
        return errors.ToolError(errors.INTERNAL_ERROR, f'{message} Try again in a minute.')
    return errors.ToolError(errors.INVALID_INPUT, message)


def price_of(prepare, principal, arguments):
    try:
        return prepare(principal, arguments)
    except submission.Refused as refused:
        raise from_refused(refused) from None


def derived_key(principal, tool, canonical, *, now=None):
    """The idempotency key for a call that sent none: one job per token, tool, arguments and minute."""
    minute = (now_ms() if now is None else now) // 60000
    seed = f'{principal.token_id}|{tool}|{quotes.digest(canonical)}|{minute}'
    return 'mcp.' + hashlib.sha256(seed.encode()).hexdigest()[:48]


def quote_required(call, tool, priced, cost_cents, *, used=False):
    """``outcome: quote_required``: nothing was submitted; ``next`` is this exact call carrying the new quote."""
    principal = call.principal
    quote = quotes.mint(principal, tool, priced.canonical, cost_cents, priced.summary)
    arguments = {key: value for key, value in call.arguments.items() if key not in ('quoteToken', 'confirmedByUser')}
    arguments['quoteToken'] = quote['token']
    if quote['requiresUserConfirmation']:
        arguments['confirmedByUser'] = True
        why = f"Ask the user to approve {quote['display']} ({quote['summary']}) before calling. The quote expires at {quote['expiresAt']}."
        sentence = f"This costs {quote['display']}; ask the user to approve it, then repeat the call with the quoteToken and confirmedByUser."
    else:
        why = (f"{quote['display']} is above your {dollars(principal.caps.auto_approve_cents)} auto-approve amount. "
               f"Repeat the call with this quoteToken before {quote['expiresAt']}.")
        sentence = f"This costs {quote['display']}, above your auto-approve amount; repeat the call with the quoteToken to start it."
    if used:
        why, sentence = f'The quoteToken you sent already paid for a job. {why}', f'That quote was already used. {sentence}'
    call.record['costCents'] = cost_cents
    result = {'outcome': 'quote_required', 'generation': None, 'quote': quote, 'next': results.call(tool, arguments, why)}
    return ToolResult(result, sentence, outcome='quote_required')


def auto_limit(caps):
    """The most a call may cost and still submit without a quote: confirmation at $1 or more wins over auto-approve."""
    return min(caps.auto_approve_cents, caps.confirm_at_cents - 1)


def approval(call, tool, priced):
    """``(limit, echoed quote, quote id)`` when the call may submit at up to ``limit`` cents, or None when it needs a quote."""
    principal = call.principal
    if controls.price_decision(principal, priced.cost_cents) == 'submit':
        return auto_limit(principal.caps), None, None
    token = call.arguments.get('quoteToken')
    payload = quotes.verify(principal, tool, priced.canonical, token) if token else None
    if payload is None or payload['c'] < priced.cost_cents:
        return None
    if payload['c'] >= principal.caps.confirm_at_cents and call.arguments.get('confirmedByUser') is not True:
        return None
    call.record['quoteId'] = payload['q']
    return payload['c'], quotes.echo(principal, token, payload, priced.summary), payload


def submit(principal, priced, key, limit, quote=None):
    """Create the row with its agent origin; the budget admission and the quote's single use share the row's
    transaction, so a refused or failed submission leaves the quote unused. Returns the id."""
    def admit(values):
        cost = controls.booked_cents(values['model'], values['costCents'], values.get('duration'), values.get('resolution'),
                                     values.get('referenceVideos'))
        if cost > limit:
            raise PriceChanged(cost)
        if quote is not None and not quotes.consume(quote):
            raise QuoteUsed()
        controls.admit_paid_submission(principal, cost)
    try:
        return priced.submit(principal.user, priced.body, idempotency_key=key, origin=principal.origin_fields(), admit=admit)['id']
    except submission.AdmissionRefused as refused:
        raise refused.error from None
    except submission.Refused as refused:
        raise from_refused(refused) from None
    except PaidBudgetHold as held:
        raise errors.ToolError(errors.PAID_BUDGET_HOLD, f'{held} Try again in a few minutes.') from None


async def run(call, tool, priced):
    """Approve, submit and (unless ``wait`` is false) hold; returns the tool's ``GenerationResult``."""
    from .tools.generations import detail, generation_reply
    call.record['costCents'] = priced.cost_cents
    approved = approval(call, tool, priced)
    if approved is None:
        return quote_required(call, tool, priced, priced.cost_cents)
    limit, quote, payload = approved
    key = call.arguments.get('idempotencyKey') or derived_key(call.principal, tool, priced.canonical)
    try:
        identifier = await db(submit, call.principal, priced, key, limit, payload)
    except PriceChanged as changed:
        return quote_required(call, tool, priced, changed.cost_cents)
    except QuoteUsed:
        call.record.pop('quoteId', None)
        return quote_required(call, tool, priced, priced.cost_cents, used=True)
    call.record['generationId'] = identifier
    note = None
    if call.arguments.get('wait', True):
        note = await hold.hold(call, identifier, max_wait_seconds=call.arguments.get('maxWaitSeconds'))
    found = await db(detail, identifier)
    return await generation_reply(call, found, quote=quote, note=note, include_preview=call.arguments.get('includePreview', True))
