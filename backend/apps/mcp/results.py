"""The shared result objects: ``Generation``, ``Output`` and ``GenerationResult`` (architecture v2 sections 4.3, 5.2).

A ``Generation`` is built only from the public library item (``serialization.generation_item``), so it means what the
web card means; internal fields (leases, depth claims, provider responses, submission input, poll state) never
appear. ``detail='summary'`` (lists) keeps only the thumbnail link and drops references and queue position.
"""
from django.conf import settings
from django.db import connection

from apps.authentication.models import User
from apps.generation.model_registry import model_definition
from apps.generation.models import Generation as GenerationRow
from apps.mcp_auth.controls import ACTIVE_STATUSES, counted_cents
from apps.projects.models import Project
from . import links
from .shapes import dollars, iso

STATUSES = ('queued', 'running', 'succeeded', 'failed', 'cancelled')
TERMINAL = ('succeeded', 'failed', 'cancelled')
OUTCOMES = {'succeeded': 'completed', 'failed': 'failed', 'cancelled': 'cancelled'}
COST_BASES = ('estimated', 'reconciled', 'cancelled_billing_unconfirmed', 'cancelled_before_submission')
REFERENCE_ROLES = (('referenceImages', 'image'), ('referenceVideos', 'video'), ('referenceAudios', 'audio'),
                   ('firstFrameUrl', 'firstFrame'), ('lastFrameUrl', 'lastFrame'))
PARAMS = (('aspectRatio', 'aspectRatio'), ('resolution', 'resolution'), ('duration', 'durationSeconds'), ('seed', 'seed'),
          ('generateAudio', 'generateAudio'), ('draftMode', 'draft'), ('bitrateMode', 'bitrateMode'), ('videoTaskMode', 'mode'),
          ('upscaleParams', 'upscale'))
QUEUE_REASONS = (('heldForProvider', 'lane_full'), ('heldForConcurrency', 'user_limit'), ('heldForBudget', 'budget'),
                 ('heldForAuthentication', 'needs_review'))
FULL_VARIANTS = ('original', 'preview', 'thumbnail', 'poster')
SUMMARY_VARIANTS = ('thumbnail',)

STRING, INTEGER, BOOLEAN = {'type': 'string'}, {'type': 'integer'}, {'type': 'boolean'}
BOOKED_TEXT = ('What this job counts against the agent spending caps now (get_account): a running Seedance 2.5 job '
               'counts its token estimate until the provider-reported cost replaces it, other jobs count cents. 0 for '
               'web jobs and jobs cancelled before submission.')


def nullable(schema):
    return {'anyOf': [schema, {'type': 'null'}]}


def obj(properties, required=None):
    """A closed object schema; every listed property is required unless ``required`` says otherwise."""
    return {'type': 'object', 'properties': properties, 'additionalProperties': False,
            'required': list(properties) if required is None else list(required)}


UUID_PATTERN = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
UUID = {'type': 'string', 'pattern': UUID_PATTERN}
NEXT_SCHEMA = obj({'tool': STRING, 'arguments': {'type': 'object'}, 'afterSeconds': INTEGER, 'why': STRING},
                  ('tool', 'arguments', 'why'))
URLS_SCHEMA = obj({variant: nullable(STRING) for variant in FULL_VARIANTS}, ())
OUTPUT_SCHEMA = obj({
    'role': {'enum': ['primary']}, 'filename': STRING, 'mimeType': STRING,
    'durationSeconds': nullable(INTEGER), 'width': nullable(INTEGER), 'height': nullable(INTEGER), 'bytes': nullable(INTEGER),
    'urls': URLS_SCHEMA, 'urlsExpireAt': nullable(STRING), 'resourceUri': STRING})
GENERATION_SCHEMA = obj({
    'id': STRING, 'name': nullable(STRING), 'kind': STRING, 'model': STRING, 'modelName': STRING,
    'status': {'enum': list(STATUSES)},
    'progress': nullable(obj({'percent': nullable(INTEGER), 'message': nullable(STRING)})),
    'queue': nullable(obj({'position': INTEGER, 'reason': {'enum': ['waiting', *[reason for _, reason in QUEUE_REASONS]]},
                           'retryAfterSeconds': nullable(INTEGER)})),
    'prompt': STRING,
    'params': {'type': 'object'},
    'references': {'type': 'array', 'items': obj({'role': {'enum': [role for _, role in REFERENCE_ROLES]},
                                                   'generationId': nullable(STRING)})},
    'location': obj({'projectId': nullable(STRING), 'projectName': nullable(STRING),
                     'folderId': nullable(STRING), 'folderPath': nullable(STRING)}),
    'favorite': BOOLEAN,
    'createdBy': nullable(obj({'id': STRING, 'name': STRING})),
    'createdAt': STRING, 'completedAt': nullable(STRING),
    'cost': obj({'cents': INTEGER, 'display': STRING, 'basis': {'enum': list(COST_BASES)},
                 'bookedCents': {**INTEGER, 'description': BOOKED_TEXT}, 'note': STRING},
                ('cents', 'display', 'basis', 'bookedCents')),
    'canCancel': BOOLEAN,
    'error': nullable(obj({'code': STRING, 'message': STRING})),
    'outputs': {'type': 'array', 'items': OUTPUT_SCHEMA},
    'related': obj({'draftId': nullable(STRING), 'finalIds': {'type': 'array', 'items': STRING},
                    'upscaleSourceId': nullable(STRING)}),
    'resourceUri': STRING, 'createdVia': {'enum': ['web', 'mcp']},
}, ('id', 'name', 'kind', 'model', 'modelName', 'status', 'progress', 'queue', 'prompt', 'params', 'location', 'favorite',
    'createdBy', 'createdAt', 'completedAt', 'cost', 'canCancel', 'error', 'outputs', 'related', 'resourceUri', 'createdVia'))
QUOTE_SCHEMA = obj({'token': STRING, 'costCents': INTEGER, 'display': STRING, 'expiresAt': STRING, 'summary': STRING,
                    'requiresUserConfirmation': BOOLEAN})
RESULT_SCHEMA = obj({
    'outcome': {'enum': ['completed', 'running', 'failed', 'cancelled', 'quote_required']},
    'generation': nullable(GENERATION_SCHEMA), 'quote': nullable(QUOTE_SCHEMA), 'next': nullable(NEXT_SCHEMA),
    'note': STRING,
}, ('outcome', 'generation', 'quote', 'next'))


def resource_uri(identifier, part=None):
    return f'veevee://generation/{identifier}' + (f'/{part}' if part else '')


def call(tool, arguments, why, after_seconds=0):
    return {'tool': tool, 'arguments': arguments, 'afterSeconds': after_seconds, 'why': why}


def folder_paths(folder_ids):
    """``{folder_id: 'Parent/Child'}`` for each folder, walking ancestors in one recursive query (cycle-safe)."""
    if not folder_ids:
        return {}
    with connection.cursor() as cursor:
        cursor.execute('''WITH RECURSIVE walk(start_id, id, parent_id, name, depth) AS (
                SELECT id, id, parent_id, name, 0 FROM folders WHERE id = ANY(%s::uuid[])
                UNION ALL
                SELECT walk.start_id, f.id, f.parent_id, f.name, walk.depth + 1
                FROM walk JOIN folders f ON f.id = walk.parent_id WHERE walk.depth < 64)
            SELECT start_id, string_agg(name, '/' ORDER BY depth DESC) FROM walk GROUP BY start_id''', [list(folder_ids)])
        return {str(start): path for start, path in cursor.fetchall()}


def context(items, *, detail):
    """The batched lookups a list of items needs: names, folder paths, provenance, finals and reference ids."""
    ids = [item['id'] for item in items]
    project_ids = {item['projectId'] for item in items if item.get('projectId')}
    user_ids = {item['userId'] for item in items if item.get('userId')}
    found = {
        'projects': {str(pk): name for pk, name in Project.objects.filter(pk__in=project_ids).values_list('id', 'name')},
        'folders': folder_paths({item['folderId'] for item in items if item.get('folderId')}),
        'users': {str(pk): name or email for pk, name, email in User.objects.filter(pk__in=user_ids).values_list('id', 'name', 'email')},
        'via': {str(pk): via for pk, via in GenerationRow.objects.filter(pk__in=ids).values_list('id', 'created_via')},
        'finals': {}, 'urls': {}, 'queue': {},
        # The source generation an upscale recorded at submission (older upscales recorded none).
        'sources': {str(pk): source for pk, source in GenerationRow.objects.filter(
            pk__in=[item['id'] for item in items if item['model'].startswith('Magnific ')]).values_list(
            'id', 'submission_input__sourceGenerationId') if isinstance(source, str)},
    }
    for source, final in GenerationRow.objects.filter(source_generation_id__in=ids).order_by('created_at', 'id').values_list(
            'source_generation_id', 'id'):
        found['finals'].setdefault(str(source), []).append(str(final))
    if detail == 'full':
        refs = {ref for item in items for ref in references_of(item, raw=True)}
        if refs:
            # Every row behind each URL, oldest first: one URL can hold several rows (a copy, or an upscale whose result
            # is its source), and a generation is never its own reference.
            for url, pk in GenerationRow.objects.filter(url__in=refs).order_by('created_at', 'id').values_list('url', 'id'):
                found['urls'].setdefault(url, []).append(str(pk))
        from apps.generation.services.admission import queue_position
        for item in items:
            if item['status'] == 'queued':
                found['queue'][item['id']] = queue_position(item['id'])
    return found


def references_of(item, *, raw=False, urls=None):
    found = []
    for field, role in REFERENCE_ROLES:
        value = item.get(field)
        for ref in (value if isinstance(value, list) else [value] if value else []):
            if isinstance(ref, str):
                found.append(ref if raw else {'role': role, 'generationId': next(
                    (pk for pk in (urls or {}).get(ref, ()) if pk != item['id']), None)})
    return found


def queue_of(position):
    if not position or position.get('status') != 'queued':
        return None
    reason = next((reason for key, reason in QUEUE_REASONS if position.get(key)), 'waiting')
    retry = position.get('retryAfterMs')
    return {'position': int(position.get('position') or 0), 'reason': reason,
            'retryAfterSeconds': -(-int(retry) // 1000) if retry else None}


def error_of(item):
    if item['status'] != 'failed':
        return None
    message = item.get('error') or 'This generation failed. Try again, or change the prompt or settings.'
    return {'code': 'MODERATION_BLOCKED' if item.get('moderationBlocked') else 'GENERATION_FAILED', 'message': message}


def output_of(item, resolved, *, variants):
    filename = item.get('filename') or f"{item['id']}.bin"
    urls = resolved['urls'] if resolved else {}
    return {'role': 'primary', 'filename': filename, 'mimeType': links.mime_type(item, filename),
            'durationSeconds': item.get('duration') if item['kind'] in ('video', 'audio') else None,
            'width': resolved and resolved['width'], 'height': resolved and resolved['height'],
            'bytes': resolved and resolved['bytes'],
            'urls': {variant: urls.get(variant) for variant in variants},
            'urlsExpireAt': iso(resolved['urlsExpireAt']) if resolved else None,
            'resourceUri': resource_uri(item['id'], 'original')}


def cost_of(item, definition, via):
    """The stored cost, plus ``bookedCents``: what the job counts against the agent caps now (``get_account``'s rule)."""
    cents = item.get('costCents') or 0
    booked = counted_cents(item['model'], item['status'], item['costBasis'], cents, item.get('duration'),
                           item.get('resolution'), item.get('referenceVideos')) if via == 'mcp' else 0
    cost = {'cents': cents, 'display': dollars(cents), 'basis': item['costBasis'], 'bookedCents': booked}
    if definition.get('usageCost') and item['costBasis'] == 'estimated' and item['status'] in ACTIVE_STATUSES:
        cost['note'] = (f'Billed from provider tokens when it finishes; counted at {dollars(booked)} until then.'
                        if via == 'mcp' else 'Billed from provider tokens when it finishes.')
    return cost


def generation_of(item, found, resolved, *, detail):
    definition = model_definition(item['model']) or {}
    filename = item.get('filename')
    status = item['status'] if item['status'] in STATUSES else 'queued' if item['status'] == 'pending' else 'running'
    active = status in ('queued', 'running')
    percent, message = item.get('progressPercent'), item.get('progressMessage')
    source = item.get('sourceGenerationId')
    references = references_of(item, urls=found['urls'])
    upscaled = found['sources'].get(item['id'])
    if upscaled and references:
        # An upscale's one reference is its source (for images, an immutable copy of it).
        references[0] = {**references[0], 'generationId': upscaled}
    result = {
        'id': item['id'], 'name': filename.rsplit('.', 1)[0] if filename else None, 'kind': item['kind'],
        'model': definition.get('id', item['model']), 'modelName': definition.get('name', item['model']),
        'status': status,
        'progress': {'percent': percent, 'message': message} if active and (percent is not None or message) else None,
        'queue': queue_of(found['queue'].get(item['id'])) if status == 'queued' else None,
        'prompt': item['prompt'],
        'params': {name: item[field] for field, name in PARAMS if item.get(field) is not None},
        'location': {'projectId': item.get('projectId'), 'projectName': found['projects'].get(item.get('projectId')),
                     'folderId': item.get('folderId'), 'folderPath': found['folders'].get(item.get('folderId'))},
        'favorite': bool(item['isFavorite']),
        'createdBy': ({'id': item['userId'], 'name': found['users'][item['userId']]}
                      if item.get('userId') in found['users'] else None),
        'createdAt': iso(item['createdAt']), 'completedAt': iso(item.get('completedAt')),
        'cost': cost_of(item, definition, found['via'].get(item['id'])),
        'canCancel': bool(item['canCancel']),
        'error': error_of(item),
        'outputs': ([output_of(item, resolved, variants=FULL_VARIANTS if detail == 'full' else SUMMARY_VARIANTS)]
                    if status == 'succeeded' and item.get('url') else []),
        'related': {'draftId': source, 'finalIds': found['finals'].get(item['id'], []),
                    'upscaleSourceId': upscaled or next((ref['generationId'] for ref in references if ref['generationId']), None)
                    if item['model'].startswith('Magnific ') else None},
        'resourceUri': resource_uri(item['id']),
        'createdVia': 'mcp' if found['via'].get(item['id']) == 'mcp' else 'web',
    }
    if detail == 'full':
        result['references'] = references
    return result


def generations(items, *, detail='full', until=None):
    """``Generation`` objects for public library items, in order; ``until`` is the call's reply deadline (``links``).
    Runs on a database thread."""
    if not items:
        return []
    found = context(items, detail=detail)
    ready = [item for item in items if item['status'] == 'succeeded' and item.get('url')]
    resolved = dict(zip([item['id'] for item in ready],
                        links.resolve_many(ready, FULL_VARIANTS if detail == 'full' else SUMMARY_VARIANTS, measure=detail == 'full',
                                           until=until)))
    return [generation_of(item, found, resolved.get(item['id']), detail=detail) for item in items]


def waiting_next(generation, wait_seconds):
    status = generation['status']
    queue = generation['queue']
    if status == 'queued' and queue and queue['position']:
        why = f"Queued at position {queue['position']}. Call this to wait up to {wait_seconds} s more."
    elif generation['progress'] and generation['progress']['percent'] is not None:
        why = f"Still rendering ({generation['progress']['percent']}%). Call this to wait up to {wait_seconds} s more."
    else:
        why = f"Still {'queued' if status == 'queued' else 'rendering'}. Call this to wait up to {wait_seconds} s more."
    return call('get_generation', {'id': generation['id'], 'wait': True}, why)


def generation_result(generation, *, quote=None, note=None):
    """The ``GenerationResult`` for a generation: running work names the call that keeps waiting."""
    outcome = OUTCOMES.get(generation['status'], 'running')
    result = {'outcome': outcome, 'generation': generation, 'quote': quote,
              'next': waiting_next(generation, settings.MCP_MAX_HOLD_SECONDS) if outcome == 'running' else None}
    if note:
        result['note'] = note
    return result


def sentence(result):
    """One plain sentence describing a ``GenerationResult`` for clients that show text only."""
    generation = result['generation']
    label = generation['name'] or generation['id']
    return {'completed': f"{label} is ready ({generation['modelName']}, {generation['cost']['display']}).",
            'failed': f"{label} failed: {(generation['error'] or {}).get('message', 'no reason was recorded.')}",
            'cancelled': f'{label} was cancelled.',
            'running': f"{label} is still {generation['status']}; call get_generation with wait=true to keep waiting."}[result['outcome']]
