"""Paid finishing: upscale_media (every Magnific image and video model) and finalize_draft (Seedance 2.5 draft to final).

Both take the paid path every generate tool takes (``paid.run``: quote, auto-approve or user confirmation, budget
admission in the row's transaction, idempotency, wait) and go through the shared services the web's Upscale composer
and Finalize button use (``submission.quote_upscale``/``submit_upscale``, ``quote_finalize``/``finalize_draft``).
"""
from urllib.parse import urlsplit

from django.conf import settings
from jsonschema import Draft202012Validator

from apps.generation.models import Generation
from apps.generation.services import submission
from apps.media.models import UploadSession
from apps.mcp_auth import controls
from .. import catalog, errors, paid, quotes, results
from ..registry import URL_EXPIRY, USER_DATA, obj, register
from ..runtime import db
from .generate import LOCATION, PAID_RESULT, PREPARE, location, uploaded

MEDIA = ('image', 'video')
ARTICLES = {'image': 'an image', 'video': 'a video', 'audio': 'an audio'}
DEFAULT_UPSCALERS = {'image': 'magnific-creative', 'video': 'magnific-video-creative'}


def upscalers():
    return [model for model in catalog.offered() if model['kind'] == 'upscale']


def media_of(model):
    return model.get('capabilities', {}).get('upscaleMedia', 'image')


def upscale_schema():
    ids = [model['id'] for model in upscalers()]
    return obj({
        'sourceId': {**results.UUID, 'description': 'The finished image or video generation id to upscale, or your own image or '
                                                    'video reference id from upload_reference.'},
        'model': {'enum': ids, 'description': 'An upscale model id from list_models; it must match the source (image or video '
                                              'upscalers). Omitted means magnific-creative for images and '
                                              'magnific-video-creative for videos.'},
        'params': {'type': 'object', 'description': "The model's parameters (list_models inputs.params); omitted ones take "
                                                    'the defaults listed there (inputs.defaults), as in the web composer.'},
        **LOCATION, **paid.PAID_CONTROLS}, ('sourceId',))


def site_origin():
    parts = urlsplit(settings.PUBLIC_APP_URL or '')
    return f'{parts.scheme}://{parts.netloc}'


def upscale_source(user, identifier):
    """``(media, url, generation id)`` of a finished image or video generation, or of the caller's own ready image/video
    upload (no generation id)."""
    row = Generation.objects.filter(pk=identifier).values('kind', 'status', 'url').first()
    if row is None:
        upload = UploadSession.objects.filter(pk=identifier, actor_id=user.id).first()
        if upload is None:
            raise errors.ToolError(errors.NOT_FOUND, f'sourceId: no generation or upload {identifier} is visible to you. '
                                                     'Use search_generations or upload_reference.')
        media = upload.purpose.split('-')[0]
        if upload.purpose not in ('image-reference', 'video-reference'):
            raise errors.ToolError(errors.INVALID_INPUT, f'sourceId: upload {identifier} is {ARTICLES.get(media, "a " + media)} file; '
                                                         'upscale_media takes images and videos.')
        return media, uploaded(upload, media, 'sourceId'), None
    if row['kind'] not in MEDIA or row['status'] != 'succeeded' or not row['url']:
        raise errors.ToolError(errors.INVALID_INPUT, f'sourceId: generation {identifier} is not a finished image or video.')
    return row['kind'], row['url'], identifier


def upscaler(arguments, media):
    """The chosen upscale model; omitted means the web composer's default for the source's media."""
    offered = upscalers()
    wanted = arguments.get('model') or DEFAULT_UPSCALERS[media]
    model = next((model for model in offered if model['id'] == wanted), None)
    if model is None and not arguments.get('model'):
        model = next((model for model in offered if media_of(model) == media), None)
    if model is None:
        named = f"{arguments['model']} is" if arguments.get('model') else f'No {media} upscale model is'
        raise errors.ToolError(errors.MODEL_UNAVAILABLE, f'{named} switched on right now. Call list_models for the models you can use.',
                               next=paid.LIST_MODELS)
    if media_of(model) != media:
        raise errors.ToolError(errors.INVALID_INPUT, f"{model['name']} upscales {media_of(model)}s and the source is {ARTICLES[media]}. "
                                                     f'Pick {ARTICLES[media]} upscale model from list_models.', next=paid.LIST_MODELS)
    return model


def upscale_params(model, given):
    """The model's parameters with omitted ones defaulted; unknown or out-of-range ones are refused here, by name."""
    params = {**catalog.upscale_defaults(model), **given}
    schema = obj(catalog.UPSCALE_PARAMS.get(model['name'], {}))
    problem = next(iter(sorted(Draft202012Validator(schema).iter_errors(params), key=lambda error: list(error.absolute_path))), None)
    if problem is not None:
        where = '.'.join(['params', *(str(part) for part in problem.absolute_path)])
        raise errors.ToolError(errors.INVALID_INPUT, f"{where}: {problem.message}. {model['name']} takes the params listed for "
                                                     f"{model['id']} in list_models.", next=paid.LIST_MODELS)
    return params


def upscale_summary(model, media, params):
    parts = [model['name'], params.get('scaleFactor') or params.get('resolution') or '2x']
    if params.get('outputFormat') == 'prores_422_hq':
        parts.append('ProRes 422 HQ')
    return ', '.join(parts) + f' {media} upscale'


def prepare_upscale(principal, arguments):
    identifier = arguments['sourceId'].lower()
    media, url, source_id = upscale_source(principal.user, identifier)
    model = upscaler(arguments, media)
    params = upscale_params(model, arguments.get('params') or {})
    values = {key: value for key, value in arguments.items() if key not in quotes.CONTROL_FIELDS}
    values.update(sourceId=identifier, model=model['id'], params=params)
    for name in LOCATION:
        if isinstance(values.get(name), str):
            values[name] = values[name].lower()
    body = {'model': model['name'], media: url, 'params': params, **location(values)}
    site = site_origin()
    cost = submission.quote_upscale(principal.user, body, origin=site)['costCents']

    def submit(user, request, *, idempotency_key, origin, admit):
        # ``origin`` here is the row's agent origin; the site origin is the one source URL base the web accepts.
        return submission.submit_upscale(user, request, origin=site, idempotency_key=idempotency_key, created_by=origin, admit=admit,
                                         source_id=source_id)
    return paid.Priced(canonical=values, body=body, cost_cents=cost, summary=upscale_summary(model, media, params), submit=submit)


def prepare_finalize(principal, arguments):
    identifier = arguments['id'].lower()
    price = submission.quote_finalize(principal.user, identifier)
    cost = controls.booked_cents(price['model'], price['costCents'], price['duration'], price['resolution'], price['referenceVideos'])
    summary = ', '.join(part for part in (f"{price['model']} final", f"{price['duration']} s" if price['duration'] else None,
                                          price['resolution']) if part)
    if price['model'] == controls.SEEDANCE_25:
        summary += ' (estimate; the final cost is reconciled from provider tokens)'

    def submit(user, draft, *, idempotency_key, origin, admit):
        return submission.finalize_draft(user, draft, idempotency_key=idempotency_key, origin=origin, admit=admit)
    return paid.Priced(canonical={'id': identifier}, body=identifier, cost_cents=cost, summary=summary, submit=submit)


PREPARE.update(upscale_media=prepare_upscale, finalize_draft=prepare_finalize)


@register(
    name='upscale_media', title='Upscale an image or video', scope='veevee.generate', read_only=False, idempotent=True,
    open_world=True,
    description=('Upscale a finished image or video with a Magnific model. Same wait behaviour as the generate tools: by '
                 'default waits up to 45 s, then returns the id and the exact call to keep waiting.\n'
                 'The source is a library generation id or your own upload id; the upscale is a new generation and the '
                 'source is kept. Image upscales are priced per image, video upscales per output frame (the quote prices '
                 'your clip). Pick the model and params from list_models (kind upscale); omitted params take the web '
                 "composer's defaults." + PAID_RESULT + URL_EXPIRY + ' ' + USER_DATA),
    input_schema=upscale_schema, output_schema=results.RESULT_SCHEMA)
async def upscale_media(call):
    priced = await db(paid.price_of, prepare_upscale, call.principal, call.arguments)
    return await paid.run(call, 'upscale_media', priced)


@register(
    name='finalize_draft', title='Finalize a Seedance draft', scope='veevee.generate', read_only=False, idempotent=True,
    open_world=True,
    description=('Render the full-quality final of a Seedance 2.5 draft you approved. The final is a new 1080p generation '
                 'with the draft\'s prompt, length, references and folder; it outputs a native MOV.\n'
                 'Only a finished Seedance 2.5 draft (generate_video with draft: true) under seven days old can be '
                 'finalized. If a final of this draft is already queued or running, you get that one and nothing more is '
                 'charged.' + PAID_RESULT + URL_EXPIRY + ' ' + USER_DATA),
    input_schema=obj({'id': {**results.UUID, 'description': 'The finished draft generation id.'}, **paid.PAID_CONTROLS}, ('id',)),
    output_schema=results.RESULT_SCHEMA)
async def finalize_draft(call):
    priced = await db(paid.price_of, prepare_finalize, call.principal, call.arguments)
    return await paid.run(call, 'finalize_draft', priced)
