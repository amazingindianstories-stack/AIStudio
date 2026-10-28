"""get_generation and cancel_generation: one generation by id as a ``GenerationResult``."""
import base64

import mcp_types as types
from apps.generation.models import Generation
from apps.generation.services import cancellation, reads
from .. import errors, hold, links, results
from ..registry import URL_EXPIRY, USER_DATA, ToolResult, obj, register
from ..runtime import db

WAIT_SECONDS = {'type': 'integer', 'minimum': 1, 'maximum': 45, 'default': 45,
                'description': 'Wait at most this many seconds, counted from the start of the call.'}


def not_found(identifier):
    return errors.ToolError(errors.NOT_FOUND, f'No generation {identifier} is visible to you. Use search_generations to find it.')


def detail(identifier):
    """``(item, Generation)`` for an id, with fresh links; None when no generation has that id."""
    item = reads.get_generation(identifier)
    return (item, results.generations([item])[0]) if item else None


def blocks(item, generation, *, include_preview):
    """Extra content: the inline preview (image thumbnail or video poster) when finished, and a link to the resource."""
    found = []
    if include_preview and generation['status'] == 'succeeded' and generation['outputs']:
        preview = links.preview_image(item)
        if preview:
            data, mime = preview
            found.append(types.ImageContent(type='image', data=base64.b64encode(data).decode(), mime_type=mime))
    found.append(types.ResourceLink(type='resource_link', uri=generation['resourceUri'], name=generation['name'] or generation['id'],
                                    mime_type='application/json', description='This generation; reading it returns fresh links.'))
    return found


async def generation_reply(call, found, *, quote=None, note=None, include_preview=True):
    """The ``ToolResult`` every tool that returns one generation sends; ``found`` is what ``detail`` returned."""
    item, generation = found
    call.record['generationId'] = generation['id']
    result = results.generation_result(generation, quote=quote, note=note)
    extra = await db(blocks, item, generation, include_preview=include_preview)
    return ToolResult(result, results.sentence(result), extra, outcome=result['outcome'])


@register(
    name='get_generation', title='Get a generation', scope='veevee.read', read_only=True,
    description=('Get one generation by id: status, cost, parameters and download links. Pass wait=true to wait up to '
                 '45 s for it to finish.\n'
                 'Returns the same result as the generate tools: outcome "running" comes with the exact call that keeps '
                 'waiting; "failed" and "cancelled" are results, not errors. cost.cents is the stored cost (the web\'s '
                 'estimate until reconciled); cost.bookedCents is what the job counts against your spending caps. '
                 + URL_EXPIRY + ' ' + USER_DATA),
    input_schema=obj({'id': {**results.UUID, 'description': 'The generation id.'},
                      'wait': {'type': 'boolean', 'default': False, 'description': 'Wait for the generation to finish.'},
                      'maxWaitSeconds': WAIT_SECONDS,
                      'includePreview': {'type': 'boolean', 'default': True,
                                         'description': 'Include a small preview image when it is finished.'}}, ('id',)),
    output_schema=results.RESULT_SCHEMA)
async def get_generation(call):
    arguments = call.arguments
    identifier = arguments['id'].lower()
    note = None
    if arguments.get('wait'):
        if not await db(hold.status_of, identifier):
            raise not_found(identifier)
        note = await hold.hold(call, identifier, max_wait_seconds=arguments.get('maxWaitSeconds'))
    found = await db(detail, identifier)
    if found is None:
        raise not_found(identifier)
    return await generation_reply(call, found, note=note, include_preview=arguments.get('includePreview', True))


CANCELLATIONS = ('cancelled', 'requested', 'too_late', 'not_cancellable')
CANCEL_SCHEMA = {**results.RESULT_SCHEMA,
                 'properties': {**results.RESULT_SCHEMA['properties'], 'cancellation': {'enum': list(CANCELLATIONS)},
                                'message': results.nullable({'type': 'string'})},
                 'required': [*results.RESULT_SCHEMA['required'], 'cancellation', 'message']}
CANCEL_WAIT_SECONDS = 5
REFUSED = 'The provider has already started this task and can no longer cancel it. It will continue normally.'
CONFIRMING = 'Cancellation requested. Waiting for the provider to confirm the outcome.'


def forbidden():
    return errors.ToolError(errors.FORBIDDEN, 'Only the person who started this generation, or an admin, can cancel it.')


def cancellation_of(status, state, message):
    """``(cancellation, message)`` for a row's status and cancellation state after a request."""
    if status == 'cancelled':
        return 'cancelled', message
    if status in ('succeeded', 'failed'):
        return 'too_late', message
    if state == 'refused':
        return 'too_late', message or REFUSED
    if state == cancellation.PENDING or state in cancellation.UNSETTLED:
        return 'requested', message
    return 'not_cancellable', message


def cancel(identifier, actor):
    """``(cancellation, message)`` from the shared cancellation service, owner or admin only.

    This service holds no provider credentials, so a job already with a provider is deferred: the row is marked
    ``pending`` and the generation worker sends the cancel exactly as the web would (``cancellation.settle_pending``).
    """
    row = Generation.objects.filter(pk=identifier).values('user_id').first()
    if row is None:
        raise not_found(identifier)
    if str(row['user_id']) != str(actor.id) and actor.role != 'admin':
        raise forbidden()
    try:
        item, message = cancellation.cancel_generation(identifier, actor, defer=True)
    except cancellation.CancelError as error:
        if error.status == 404:
            raise not_found(identifier) from None
        if error.status == 403:
            raise forbidden() from None
        return ('not_cancellable' if error.status == 400 or error.busy else 'too_late'), str(error)
    return cancellation_of(item.status, item.cancellation_state, message)


def deferred(identifier):
    """'waiting' while the worker has not sent a deferred cancel yet, else 'settled' (the hold's terminal state)."""
    row = Generation.objects.filter(pk=identifier).values('status', 'cancellation_state').first()
    return 'waiting' if row and row['status'] in cancellation.ACTIVE and row['cancellation_state'] == cancellation.PENDING else 'settled'


def settled(identifier):
    """What a deferred cancel came to, once the worker had a few seconds to send it."""
    row = Generation.objects.filter(pk=identifier).values('status', 'cancellation_state').first()
    state = row['cancellation_state']
    message = (None if row['status'] == 'cancelled' else cancellation.DEFERRED if state == cancellation.PENDING
               else REFUSED if state == 'refused' else CONFIRMING if state in cancellation.UNSETTLED
               else 'The generation finished before cancellation was confirmed. Its result has been kept.')
    return cancellation_of(row['status'], state, message)


@register(
    name='cancel_generation', title='Cancel a generation', scope='veevee.generate', read_only=False, destructive=True,
    idempotent=True, open_world=True,
    description=('Cancel a queued or running generation you started. Some providers can only cancel before rendering starts; '
                 'the result says what happened.\n'
                 'cancellation is "cancelled" (stopped), "requested" (Veevee is asking the provider; check get_generation), '
                 '"too_late" (it already started or finished) or "not_cancellable" (this model or state cannot be '
                 'cancelled). Admins can cancel anyone\'s generation. ' + USER_DATA),
    input_schema=obj({'id': {**results.UUID, 'description': 'The generation id.'}}, ('id',)),
    output_schema=CANCEL_SCHEMA)
async def cancel_generation(call):
    identifier = call.arguments['id'].lower()
    call.record['generationId'] = identifier
    state, message = await db(cancel, identifier, call.principal.user)
    if state == 'requested' and await db(deferred, identifier) == 'waiting':
        # Give the generation worker a few seconds to send it, so the answer is usually final.
        await hold.hold(call, identifier, max_wait_seconds=CANCEL_WAIT_SECONDS, read=deferred, terminal=('settled',))
        state, message = await db(settled, identifier)
    reply = await generation_reply(call, await db(detail, identifier), include_preview=False)
    reply.structured.update(cancellation=state, message=message)
    reply.sentence = f'Cancellation {state.replace("_", " ")}: {message}' if message else reply.sentence
    return reply
