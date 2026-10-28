"""Paid generation: generate_image, generate_video and the read-only estimate_cost.

Arguments name models by catalogue id and references by library generation id or the caller's own upload id
(``upload_reference``); OmniHuman takes one image and one audio that way. Omitted inputs take the catalogue's
defaults (``catalog.defaults``) before pricing, so a quote binds to what will actually run and an explicit default
quotes the same as an omitted one. The request then goes through the same shared submission service as the web.
Seedance 2.5 is quoted at the higher of the web estimate and its current token estimate (``controls.booked_cents``).
"""
from apps.generation.model_registry import model_definition
from apps.generation.models import Generation
from apps.generation.services import submission
from apps.library.models import Folder
from apps.media.models import UploadSession
from apps.mcp_auth import controls
from apps.projects.models import Project
from .. import catalog, errors, paid, quotes, results
from ..registry import REGISTRY, URL_EXPIRY, USER_DATA, ToolResult, obj, register
from ..runtime import db

STRING, BOOLEAN = {'type': 'string'}, {'type': 'boolean'}
UUID = results.UUID
GLOBAL = 'global'
DEFAULT_MODELS = {'image': 'nano-banana-2-1', 'video': 'seedance-25'}
SEED = {'type': 'integer', 'minimum': 0, 'maximum': 4294967295, 'description': 'Only for models whose inputs list seed.'}
# MCP argument -> shared request field, for plain values.
FIELDS = {'image': {'prompt': 'prompt', 'aspectRatio': 'aspectRatio', 'resolution': 'resolution', 'seed': 'seed'},
          'video': {'prompt': 'prompt', 'aspectRatio': 'aspectRatio', 'resolution': 'resolution', 'seed': 'seed',
                    'durationSeconds': 'duration', 'generateAudio': 'generateAudio', 'draft': 'draftMode',
                    'bitrateMode': 'bitrateMode', 'mode': 'videoTaskMode'}}
# MCP reference argument -> (shared request field, generation kind it takes, single value).
REFERENCES = {'image': {'referenceIds': ('referenceImages', 'image', False)},
              'video': {'referenceImageIds': ('referenceImages', 'image', False), 'referenceVideoIds': ('referenceVideos', 'video', False),
                        'referenceAudioIds': ('referenceAudios', 'audio', False), 'firstFrameId': ('firstFrame', 'image', True),
                        'lastFrameId': ('lastFrame', 'image', True)}}
LOCATION = {
    'folderId': {'anyOf': [UUID, {'const': GLOBAL}],
                 'description': 'Put the result in this folder (from list_folders); "global" or omitted means the global library, unsorted.'},
    'projectId': {**UUID, 'description': "Put the result in this project's unsorted items (from list_folders)."},
}


def models_of(kind):
    return [model for model in catalog.offered() if model['kind'] == kind]


def union(models, key):
    found = []
    for model in models:
        found += [value for value in model.get('capabilities', {}).get(key) or [] if value not in found]
    return found


def model_enum(kind, models):
    ids = [model['id'] for model in models]
    schema = {'enum': ids, 'description': f'A {kind} model id from list_models; options and limits differ per model.'}
    preferred = DEFAULT_MODELS[kind] if DEFAULT_MODELS[kind] in ids else ids[0] if ids else None
    return {**schema, 'default': preferred} if preferred else schema


def references(maximum, what):
    return {'type': 'array', 'items': UUID, 'maxItems': max(maximum, 1),
            'description': f'Finished {what} generation ids from the library or {what} reference ids from upload_reference, '
                           'in the order the prompt refers to them.'}


def image_schema():
    models = models_of('image')
    return obj({
        'model': model_enum('image', models),
        'prompt': {'type': 'string', 'minLength': 1, 'description': 'What to make.'},
        'aspectRatio': {'enum': union(models, 'aspectRatios'), 'description': 'Per-model values in list_models.'},
        'resolution': {'enum': union(models, 'resolutions'), 'description': 'Per-model values in list_models.'},
        'seed': SEED,
        'referenceIds': references(max((m.get('capabilities', {}).get('maxReferenceImages', 0) for m in models), default=0), 'image'),
        **LOCATION, **paid.PAID_CONTROLS}, ('prompt',))


def video_schema():
    models = models_of('video')
    def most(key):
        return max((m.get('capabilities', {}).get(key, 0) for m in models), default=0)
    return obj({
        'model': model_enum('video', models),
        'prompt': {'type': 'string', 'minLength': 1, 'description': 'What to make. Required except for OmniHuman, which follows its audio.'},
        'mode': {'enum': ['generate', 'edit', 'extend'], 'description': 'Seedance 2.5 only: edit or extend the clip in referenceVideoIds.'},
        'durationSeconds': {'type': 'integer', 'minimum': 1, 'maximum': 300, 'description': 'Per-model lengths in list_models.'},
        'resolution': {'enum': union(models, 'resolutions'),
                       'description': 'Per-model values in list_models; omitted means the final quality (1080p where offered).'},
        'aspectRatio': {'enum': union(models, 'aspectRatios'), 'description': 'Per-model values in list_models.'},
        'generateAudio': {'type': 'boolean', 'description': 'Generate a soundtrack (models with audio; default on).'},
        'draft': {'type': 'boolean', 'description': 'Seedance 2.5 Draft: a cheap 480p preview you can later finalize.'},
        'bitrateMode': {'enum': ['standard', 'high']},
        'referenceImageIds': references(most('maxReferenceImages'), 'image'),
        'referenceVideoIds': references(most('maxReferenceVideos'), 'video'),
        'referenceAudioIds': references(max(most('maxReferenceAudios'), 10), 'audio'),
        'firstFrameId': {**UUID, 'description': 'A finished image generation id or image upload id to start from.'},
        'lastFrameId': {**UUID, 'description': 'A finished image generation id or image upload id to end on (needs firstFrameId).'},
        'seed': SEED, **LOCATION, **paid.PAID_CONTROLS})


def chosen_model(kind, arguments):
    identifier = arguments.get('model') or DEFAULT_MODELS[kind]
    model = next((model for model in models_of(kind) if model['id'] == identifier), None)
    if model is None:
        definition = model_definition(identifier)
        name = definition['name'] if definition else identifier
        raise errors.ToolError(errors.MODEL_UNAVAILABLE, f'{name} is switched off right now. Call list_models for the models you can use.',
                               next=paid.LIST_MODELS)
    return model


def canonical(kind, arguments):
    """The call's arguments with every omitted input set to the catalogue default; quotes and receipts bind to this."""
    model = chosen_model(kind, arguments)
    values = {key: value for key, value in arguments.items() if key not in quotes.CONTROL_FIELDS}
    values['model'] = model['id']
    chosen = catalog.defaults(model)
    if values.get('draft') and model.get('capabilities', {}).get('draft'):
        chosen['resolution'] = '480p'          # Seedance 2.5 drafts render at 480p only
    if values.get('mode') == 'edit':
        chosen.pop('durationSeconds', None)    # an edit keeps the clip's length
    for key, value in chosen.items():
        if value is not None:
            values.setdefault(key, value)
    for name in REFERENCES[kind]:
        if name in values:
            values[name] = [value.lower() for value in values[name]] if isinstance(values[name], list) else values[name].lower()
    for name in LOCATION:
        if isinstance(values.get(name), str):
            values[name] = values[name].lower()
    return model, values


def reference_urls(user, ids, kind, name):
    """Library URLs, in order, for finished generations of ``kind`` or the caller's own ready ``kind`` uploads."""
    rows = {str(pk): (row_kind, status, url) for pk, row_kind, status, url in
            Generation.objects.filter(pk__in=ids).values_list('id', 'kind', 'status', 'url')}
    files = {str(row.id): row for row in UploadSession.objects.filter(pk__in=set(ids) - set(rows), actor_id=user.id)}
    found = []
    for identifier in ids:
        if identifier in files:
            found.append(uploaded(files[identifier], kind, name))
            continue
        if identifier not in rows:
            raise errors.ToolError(errors.NOT_FOUND, f'{name}: no generation or upload {identifier} is visible to you. '
                                                     'Use search_generations or upload_reference.')
        row_kind, status, url = rows[identifier]
        if row_kind != kind or status != 'succeeded' or not url:
            raise errors.ToolError(errors.INVALID_INPUT, f'{name}: generation {identifier} is not a finished {kind}. '
                                                         f'{name} takes finished {kind} generations or {kind} uploads.')
        found.append(url)
    return found


def uploaded(row, kind, name):
    """An owned upload's canonical URL; the shared submission service re-checks readiness, owner and purpose."""
    if row.state == 'cancelled':
        raise errors.ToolError(errors.NOT_FOUND, f'{name}: upload {row.id} was cancelled. Upload the file again with upload_reference.')
    if not row.finalized_at or row.state != 'ready':
        raise errors.ToolError(errors.INVALID_INPUT, f'{name}: upload {row.id} is not finished. Call upload_reference with its uploadId first.',
                               next=results.call('upload_reference', {'uploadId': str(row.id)}, 'Finalizes the upload.'))
    if row.purpose != f'{kind}-reference':
        raise errors.ToolError(errors.INVALID_INPUT, f'{name}: upload {row.id} is a {row.purpose.split("-")[0]} file; {name} takes {kind} files.')
    return '/api/media/' + row.key


def location(values):
    """``{projectId, folderId}`` for the shared request; a folder decides its project."""
    folder, project = values.get('folderId'), values.get('projectId')
    found = {}
    if folder and folder != GLOBAL:
        row = Folder.objects.filter(pk=folder).values('id', 'project_id').first()
        if row is None:
            raise errors.ToolError(errors.NOT_FOUND, f'No folder {folder} is visible to you. Use list_folders to find one.')
        owner = str(row['project_id']) if row['project_id'] else None
        if project and project != owner:
            raise errors.ToolError(errors.INVALID_INPUT, f'Folder {folder} is not in project {project}. Send only folderId.')
        found = {'folderId': folder, **({'projectId': owner} if owner else {})}
    elif project:
        if folder == GLOBAL:
            raise errors.ToolError(errors.INVALID_INPUT, 'folderId "global" means no project. Send projectId or folderId "global", not both.')
        if not Project.objects.filter(pk=project).exists():
            raise errors.ToolError(errors.NOT_FOUND, f'No project {project} is visible to you. Use list_folders to find one.')
        found = {'projectId': project}
    return found


def summary(kind, model, values):
    parts = [model['name']]
    if kind == 'video' and values.get('durationSeconds'):
        parts.append(f"{values['durationSeconds']} s")
    parts += [values[key] for key in ('resolution', 'aspectRatio') if values.get(key) and values[key] != 'Auto']
    if kind == 'video':
        if 'generateAudio' in values:
            parts.append('audio on' if values['generateAudio'] else 'audio off')
        if values.get('draft'):
            parts.append('draft')
        if values.get('mode') in ('edit', 'extend'):
            parts.append(values['mode'])
    count = sum(len(values[name]) if isinstance(values[name], list) else 1 for name in REFERENCES[kind] if values.get(name))
    if count:
        parts.append(f"{count} reference{'s' if count != 1 else ''}")
    text = ', '.join(parts)
    return f'{text} (estimate; the final cost is reconciled from provider tokens)' if model['name'] == controls.SEEDANCE_25 else text


def prepare(kind):
    """``prepare(principal, arguments) -> paid.Priced``: canonical values, the shared request and its web price."""
    def run(principal, arguments):
        model, values = canonical(kind, arguments)
        body = {'model': model['name'], **location(values)}
        for name, field in FIELDS[kind].items():
            if name in values:
                body[field] = values[name]
        for name, (field, wanted, single) in REFERENCES[kind].items():
            if values.get(name):
                urls = reference_urls(principal.user, [values[name]] if single else values[name], wanted, name)
                body[field] = urls[0] if single else urls
        cost = submission.quote_generation(principal.user, kind, body)['costCents']
        cost = controls.booked_cents(body['model'], cost, body.get('duration'), body.get('resolution'), body.get('referenceVideos'))
        return paid.Priced(canonical=values, body=body, cost_cents=cost, summary=summary(kind, model, values),
                           submit=lambda user, request, **options: submission.submit_generation(user, kind, request, **options))
    return run


# tools/finishing.py adds upscale_media and finalize_draft, so estimate_cost prices those too.
PREPARE = {'generate_image': prepare('image'), 'generate_video': prepare('video')}
PAID_RESULT = (' Cheap jobs start at once; above your auto-approve amount the result is outcome "quote_required" with a '
               'price and next: ask the user when quote.requiresUserConfirmation is true, then make the call in next. '
               'Each call without an idempotencyKey or a quoteToken starts a new job. Spending limits, rates and running-job limits apply (get_account shows them). ')


@register(
    name='generate_image', title='Generate an image', scope='veevee.generate', read_only=False, idempotent=True, open_world=True,
    description=('Create an image. By default waits up to 45 s and returns the finished image; pass wait=false to start it '
                 'and get the id at once.\n'
                 'Pick the model and its options from list_models; omitted options use the defaults listed there.'
                 + PAID_RESULT + 'A result still running names the exact get_generation call that keeps waiting. '
                 + URL_EXPIRY + ' ' + USER_DATA),
    input_schema=image_schema, output_schema=results.RESULT_SCHEMA)
async def generate_image(call):
    priced = await db(paid.price_of, PREPARE['generate_image'], call.principal, call.arguments)
    return await paid.run(call, 'generate_image', priced)


@register(
    name='generate_video', title='Generate a video', scope='veevee.generate', read_only=False, idempotent=True, open_world=True,
    description=("Create a video. By default waits up to 45 s; videos usually take longer, so you'll get the id and the exact "
                 'call to keep waiting. Pass wait=false when starting several.\n'
                 'Pick the model and its options from list_models; omitted options use the defaults listed there (final '
                 'quality; an explicit choice always wins). Seedance 2.5 outputs a native MOV.'
                 + PAID_RESULT + URL_EXPIRY + ' ' + USER_DATA),
    input_schema=video_schema, output_schema=results.RESULT_SCHEMA)
async def generate_video(call):
    priced = await db(paid.price_of, PREPARE['generate_video'], call.principal, call.arguments)
    return await paid.run(call, 'generate_video', priced)


ESTIMATE_SCHEMA = results.obj({**results.QUOTE_SCHEMA['properties'], 'autoApproves': BOOLEAN})


@register(
    name='estimate_cost', title='Estimate cost', scope='veevee.read', read_only=True,
    description=('Price a generate, upscale_media or finalize_draft call without running it. Pass the tool name and the exact arguments you would send; '
                 'returns a quote token.\n'
                 'Nothing is created or charged. autoApproves says whether that call would start without a quote. Pass '
                 'quote.token as quoteToken in the real call (with confirmedByUser: true once the user approved, when '
                 'requiresUserConfirmation is true); the token is valid for 10 minutes and only for these arguments.'),
    input_schema=lambda: obj({'tool': {'enum': list(PREPARE), 'description': 'The paid tool you would call.'},
                              'arguments': {'type': 'object', 'description': 'The arguments you would send to that tool.'}},
                             ('tool', 'arguments')),
    output_schema=ESTIMATE_SCHEMA)
async def estimate_cost(call):
    tool, arguments = call.arguments['tool'], call.arguments['arguments']
    REGISTRY[tool].validate(arguments)
    priced = await db(paid.price_of, PREPARE[tool], call.principal, arguments)
    call.record['costCents'] = priced.cost_cents
    quote = quotes.mint(call.principal, tool, priced.canonical, priced.cost_cents, priced.summary)
    automatic = controls.price_decision(call.principal, priced.cost_cents) == 'submit'
    sentence = (f"{priced.summary} costs {quote['display']}" +
                ('; it would start without a quote.' if automatic else
                 '; ask the user to approve it first.' if quote['requiresUserConfirmation'] else '; send the quoteToken with the call.'))
    return ToolResult({**quote, 'autoApproves': automatic}, sentence)
