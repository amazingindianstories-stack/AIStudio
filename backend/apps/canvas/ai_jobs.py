"""Board "Create with AI" jobs: quote, submit, read and mark placed.

Each format names an engine. A ``text`` format (sticky notes now; Doc, mind map, table and the other text formats
later) queues a text job whose prompt shape lives in ``apps.agents.board``; the ``image`` format queues an ordinary
image generation in the board's project. Both run on the generation worker under its admission, per-user limit,
Gemini spend window and paid guard; this module never calls a provider.

Processing is ``basic`` (the default) or ``advanced``. Advanced text runs on the stronger Gemini model
(``AGENT_LLM_MODEL_ADVANCED``) at its own estimator rate; an advanced image renders at 2K where the model offers it,
priced by the model's own resolution pricing.

A submission needs an Idempotency-Key. The key's receipt, the generation row and the job row commit in one
transaction, so a double click, a retried request or a second tab with the same key returns the first job and never
queues a second billed generation. The board places a result itself (it owns the graph and its autosave) and then
marks the job placed, which only one caller can do.
"""
import re
import uuid

from apps.common.leases import now_ms
from apps.generation.model_registry import capability
from apps.generation.models import Generation
from apps.generation.serialization import generation_item
from apps.generation.services import submission, text_submission
from apps.library.services import idempotency
from .models import BoardAiJob

ENGINES = {'stickies': 'text', 'image': 'image'}
PROCESSING = ('basic', 'advanced')
ADVANCED_RESOLUTION = '2K'
OPERATION = 'BOARD_AI_JOB'
ORIGIN = {'created_via': 'board'}
UUID = re.compile(r'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}')
ACTIVE = ('queued', 'running')
RECENT_MS = 24 * 60 * 60 * 1000
LIST_LIMIT = 20
MAX_PLACED_NODES = 100


class JobError(Exception):
    def __init__(self, status, error, code=None):
        super().__init__(error)
        self.status, self.body = status, {'error': error, **({'code': code} if code else {})}


def request_values(body):
    """The validated job request: format, prompt, processing, optional parent job, and the image's model and aspect ratio."""
    if not isinstance(body, dict):
        raise JobError(400, 'Invalid request.')
    name = body.get('format')
    if name not in ENGINES:
        raise JobError(400, 'Unknown format.', 'UNKNOWN_FORMAT')
    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise JobError(400, 'Prompt is required.')
    processing = body.get('processing', 'basic')
    if processing not in PROCESSING:
        raise JobError(400, 'Unknown processing.', 'UNKNOWN_PROCESSING')
    values = {'format': name, 'prompt': prompt.strip(), 'processing': processing}
    parent = body.get('parentJobId')
    if parent is not None:
        if not isinstance(parent, str) or not UUID.fullmatch(parent):
            raise JobError(400, 'Invalid parentJobId.')
        values['parentJobId'] = parent.lower()
    if name == 'image':
        for field in ('model', 'aspectRatio'):
            value = body.get(field)
            if value is not None:
                if not isinstance(value, str) or not value:
                    raise JobError(400, f'Invalid {field}.')
                values[field] = value
    return values


def parent_job(board, actor, values):
    """The succeeded job a refinement builds on, with its generation; refining crosses no board or format."""
    identifier = values.get('parentJobId')
    if identifier is None:
        return None, None
    job = BoardAiJob.objects.filter(pk=identifier, board=board).first()
    if job is None or job.format != values['format']:
        raise JobError(404, 'The result to refine was not found on this board.')
    generation = Generation.objects.filter(pk=job.generation_id).first()
    if generation is None or generation.status != 'succeeded' or (job.format == 'image' and not generation.url):
        raise JobError(409, 'Only a finished result can be refined.', 'PARENT_NOT_READY')
    return job, generation


def text_turns(values, parent, generation):
    from apps.agents.board import conversation
    if parent is None:
        return conversation(values['prompt'])
    turns = (generation.submission_input or {}).get('turns') or []
    first = turns[0]['text'] if turns and isinstance(turns[0], dict) and isinstance(turns[0].get('text'), str) else parent.prompt
    return conversation(values['prompt'], (first, generation.output))


def image_body(board, values, generation):
    """The image generation request. A refinement edits the previous image: it is the reference the new prompt describes
    changes to, and the new image keeps its model and aspect ratio unless the request names others."""
    model = values.get('model') or (generation.model if generation is not None else None)
    ratio = values.get('aspectRatio') or (generation.aspect_ratio if generation is not None else None) or '1:1'
    body = {'prompt': values['prompt'], 'model': model, 'aspectRatio': ratio, 'projectId': str(board.project_id)}
    if generation is not None:
        body['referenceImages'] = [generation.url]
    if values['processing'] == 'advanced':
        resolutions = (capability(model, 'referenceResolutions', None) if generation is not None else None) or capability(model, 'resolutions', [])
        if ADVANCED_RESOLUTION in resolutions:
            body['resolution'] = ADVANCED_RESOLUTION
    return {key: value for key, value in body.items() if value is not None}


def quote(actor, board, body):
    values = request_values(body)
    parent, generation = parent_job(board, actor, values)
    if ENGINES[values['format']] == 'text':
        result = text_submission.quote_text(actor, values['format'], text_turns(values, parent, generation), values['processing'])
    else:
        result = submission.quote_generation(actor, 'image', image_body(board, values, generation))
    return {'format': values['format'], 'processing': values['processing'], 'model': result['model'], 'costCents': result['costCents']}


def receipt_key(raw, actor):
    if not raw:
        raise JobError(400, 'An Idempotency-Key header is required.', 'IDEMPOTENCY_KEY_REQUIRED')
    raw = raw.strip()
    if not submission.IDEMPOTENCY_KEY.match(raw):
        raise JobError(400, 'Invalid Idempotency-Key header.')
    return f'board-ai-job:{actor.id}:{raw}'


def submit(actor, board, body, idempotency_key):
    """Queue the job's generation and its job row once per key; returns the job."""
    values = request_values(body)
    key = receipt_key(idempotency_key, actor)

    def mutation():
        parent, generation = parent_job(board, actor, values)
        created = {}

        def admit(item):
            now = now_ms()
            created['job'] = BoardAiJob.objects.create(id=uuid.uuid4(), board=board, user_id=actor.id, format=values['format'],
                prompt=values['prompt'], generation_id=item['id'], parent_job=parent, created_at=now, updated_at=now)

        if ENGINES[values['format']] == 'text':
            text_submission.submit_text(actor, values['format'], text_turns(values, parent, generation), processing=values['processing'],
                                        origin=ORIGIN, admit=admit)
        else:
            submission.submit_generation(actor, 'image', image_body(board, values, generation), origin=ORIGIN, admit=admit)
        return {'jobId': str(created['job'].id)}

    try:
        receipt = idempotency.execute(OPERATION, {'boardId': str(board.id), **values}, mutation,
                                      actor_id=actor.id, idempotency_key=key)
    except idempotency.OrganizationError as error:
        raise JobError(error.status, str(error), error.code) from None
    return job_json(BoardAiJob.objects.get(pk=receipt['jobId']))


def jobs(actor, board, ids=None, recent=False):
    """The actor's jobs on this board (newest first): the named ones; with ``recent`` the finished results of the last
    day, placed or not, which the panel offers to place again; else the recent ones not yet placed."""
    rows = BoardAiJob.objects.filter(board=board, user_id=actor.id)
    if ids:
        rows = rows.filter(pk__in=[value for value in ids if UUID.fullmatch(value)][:LIST_LIMIT])
    elif recent:
        rows = rows.filter(created_at__gt=now_ms() - RECENT_MS,
                           generation_id__in=Generation.objects.filter(status='succeeded').values('id'))
    else:
        rows = rows.filter(placed_at__isnull=True, created_at__gt=now_ms() - RECENT_MS)
    rows = list(rows.order_by('-created_at', '-id')[:LIST_LIMIT])
    generations = {row.id: row for row in Generation.objects.filter(pk__in=[row.generation_id for row in rows])}
    return [job_json(row, generations.get(row.generation_id)) for row in rows]


def mark_placed(actor, board, identifier, body):
    """Record the board nodes that hold a job's result (an empty list dismisses it); the first caller wins."""
    nodes = body.get('placedNodeIds') if isinstance(body, dict) else None
    if (not isinstance(nodes, list) or len(nodes) > MAX_PLACED_NODES
            or any(not isinstance(node, str) or not 0 < len(node) <= 64 for node in nodes)):
        raise JobError(400, 'placedNodeIds must be a list of node ids.')
    if not UUID.fullmatch(identifier):
        raise JobError(404, 'Job not found.')
    job = BoardAiJob.objects.filter(pk=identifier, board=board, user_id=actor.id).first()
    if job is None:
        raise JobError(404, 'Job not found.')
    generation = Generation.objects.filter(pk=job.generation_id).first()
    if nodes and (generation is None or generation.status != 'succeeded'):
        raise JobError(409, 'Only a finished result can be placed.', 'NOT_READY')
    now = now_ms()
    if not BoardAiJob.objects.filter(pk=job.pk, placed_at__isnull=True).update(placed_node_ids=nodes, placed_at=now, updated_at=now):
        raise JobError(409, 'This result was already placed.', 'ALREADY_PLACED')
    job.refresh_from_db()
    return job_json(job, generation)


def job_json(job, generation=None):
    generation = generation or Generation.objects.filter(pk=job.generation_id).first()
    result = {'id': str(job.id), 'boardId': str(job.board_id), 'format': job.format, 'prompt': job.prompt,
              'parentJobId': str(job.parent_job_id) if job.parent_job_id else None, 'generationId': str(job.generation_id),
              'placedNodeIds': job.placed_node_ids, 'placedAt': job.placed_at, 'createdAt': job.created_at}
    if generation is None:
        return {**result, 'status': 'failed', 'error': 'This result was deleted from the library.', 'costCents': 0}
    item = generation_item(generation)
    result.update(status=generation.status, costCents=generation.cost_cents, model=generation.model)
    for field in ('error', 'progressMessage'):
        if item.get(field):
            result[field] = item[field]
    if generation.status == 'queued':
        from apps.generation.services.admission import queue_position
        position = queue_position(generation.id) or {}
        if position.get('heldReason'):
            result['heldReason'] = position['heldReason']
    if generation.status == 'succeeded':
        if ENGINES.get(job.format) == 'text':
            result['result'] = generation.output
        else:
            result['result'] = {'url': generation.url, 'aspectRatio': generation.aspect_ratio}
    return result
