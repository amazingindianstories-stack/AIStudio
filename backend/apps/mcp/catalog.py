"""The model catalogue behind ``list_models`` and ``veevee://models`` (architecture v2 section 6.4).

Only models new jobs may use (``availability``) are listed. Inputs, enums and defaults come from the registry
capabilities; prices are read live from the pricing table on every call and priced with the same ``compute_cost``
the web uses (Seedance 2.5 at least its token estimate, as agents are quoted); ``typicalSeconds`` is the measured p50-p90 of the last 7 days of succeeded jobs, cached 10 minutes.
"""
import threading
import time

from django.db import connection

from apps.common.leases import now_ms
from apps.generation.availability import available
from apps.generation.model_registry import MODEL_REGISTRY, model_definition
from apps.generation.providers.magnific import (ENGINES, PRESETS, TOPAZ_INTERPOLATIONS, TOPAZ_MODELS, VIDEO_FLAVORS,
                                                VIDEO_OUTPUT_FORMATS, VIDEO_PARAMS, VIDEO_RESOLUTIONS)
from apps.generation.services.cancellation import ADAPTERS
from apps.generation.services.pricing import compute_cost, read_pricing
from apps.mcp_auth.controls import booked_cents
from .shapes import dollars

TOOLS = {'image': 'generate_image', 'video': 'generate_video', 'upscale': 'upscale_media'}
PROVIDERS = {'seedream': 'BytePlus Seedream', 'gemini': 'Google Gemini', 'kling': 'Kling', 'byteplus': 'BytePlus ModelArk',
             'omnihuman': 'BytePlus Vision', 'omni': 'Google Gemini Omni', 'magnific': 'Magnific'}
OUTPUT_TYPES = {'image': ['image/png', 'image/jpeg', 'image/webp'], 'video': ['video/mp4', 'video/quicktime']}
TYPICAL_WINDOW_MS = 7 * 86400 * 1000
TYPICAL_TTL_SECONDS = 600
SCALES = ['2x', '4x', '8x', '16x']


def integer(minimum, maximum):
    return {'type': 'integer', 'minimum': minimum, 'maximum': maximum}


def number(minimum, maximum):
    return {'type': 'number', 'minimum': minimum, 'maximum': maximum}


DETAIL = integer(0, 100)
# Magnific parameters per upscale model, as apps/generation/services/upscale_validation.py accepts them.
UPSCALE_PARAMS = {
    'Magnific Creative': {'scaleFactor': {'enum': SCALES}, 'optimizedFor': {'enum': PRESETS}, 'engine': {'enum': ENGINES},
                          'creativity': number(-10, 10), 'hdr': number(-10, 10), 'resemblance': number(-10, 10),
                          'fractality': number(-10, 10), 'prompt': {'type': 'string', 'maxLength': 2000}},
    'Magnific Precision V2': {'scaleFactor': {'enum': SCALES}, 'flavor': {'enum': ['photo', 'sublime', 'photo_denoiser']},
                              'sharpen': number(0, 100), 'smartGrain': number(0, 100), 'ultraDetail': number(0, 100)},
    'Magnific Precision V1': {'sharpen': number(0, 100), 'smartGrain': number(0, 100), 'ultraDetail': number(0, 100)},
}
VIDEO_UPSCALE_FIELDS = {'resolution': {'enum': VIDEO_RESOLUTIONS}, 'creativity': DETAIL, 'sharpen': DETAIL, 'smartGrain': DETAIL,
                        'strength': DETAIL, 'fpsBoost': {'type': 'boolean'}, 'flavor': {'enum': VIDEO_FLAVORS},
                        'outputFormat': {'enum': VIDEO_OUTPUT_FORMATS}, 'enhancementModel': {'enum': TOPAZ_MODELS},
                        'targetFps': integer(15, 60), 'frameInterpolation': {'enum': TOPAZ_INTERPOLATIONS}, 'noise': number(0, 1)}
for _model, _fields in VIDEO_PARAMS.items():
    UPSCALE_PARAMS[_model] = {field: VIDEO_UPSCALE_FIELDS[field] for field in _fields}
# What the web's Upscale composer starts from (src/lib/store.js upscalerParams, magnific-ui.js MAGNIFIC_VIDEO_DEFAULTS);
# upscale_media fills omitted parameters from these. Topaz frameInterpolation applies only with a targetFps.
IMAGE_UPSCALE_DEFAULTS = {'scaleFactor': '2x', 'optimizedFor': 'standard', 'engine': 'automatic', 'creativity': 0, 'hdr': 0,
                          'resemblance': 0, 'fractality': 0, 'flavor': 'photo', 'sharpen': 7, 'smartGrain': 7, 'ultraDetail': 30}
VIDEO_UPSCALE_DEFAULTS = {'resolution': '2k', 'creativity': 0, 'sharpen': 0, 'smartGrain': 0, 'strength': 60, 'fpsBoost': False,
                          'flavor': 'vivid', 'outputFormat': 'h264', 'enhancementModel': 'starlight_precise_2_5', 'noise': 0}


def upscale_defaults(model):
    """The parameters an upscale_media call uses for each one it omits."""
    fields = UPSCALE_PARAMS.get(model['name'], {})
    chosen = VIDEO_UPSCALE_DEFAULTS if model.get('capabilities', {}).get('upscaleMedia') == 'video' else IMAGE_UPSCALE_DEFAULTS
    return {name: value for name, value in chosen.items() if name in fields}

_typical_lock = threading.Lock()
_typical = {'values': {}, 'expires': 0.0}


def offered():
    """Registry entries the agent tools can run now: available image, video and upscale models."""
    return [model for model in MODEL_REGISTRY if model['kind'] in TOOLS and available(model)]


def pick(choices, preferred):
    return preferred if preferred in choices else (choices[0] if choices else None)


def video_duration(capabilities):
    """5 s when the model allows it, else the shortest allowed length above 5 s; None when the inputs decide."""
    if capabilities.get('inputDrivenVideo'):
        return None
    bounds, durations = capabilities.get('durationRange'), capabilities.get('durations') or []
    if bounds:
        return 5 if bounds['min'] <= 5 <= bounds['max'] else bounds['min']
    return min((value for value in durations if value >= 5), default=min(durations, default=None))


def defaults(model):
    """What a generate call uses for each input it omits; the generate tools and the catalogue share this."""
    capabilities = model.get('capabilities', {})
    ratios, resolutions = capabilities.get('aspectRatios') or [], capabilities.get('resolutions') or []
    if model['kind'] == 'image':
        return {'aspectRatio': pick(ratios, '1:1'), 'resolution': pick(resolutions, '2K' if model['provider'] == 'seedream' else '1K')}
    found = {'aspectRatio': pick(ratios, '16:9'),
             # Final quality by default (the web's Final/High); an explicit choice always wins.
             'resolution': pick(resolutions, '1080p') if '1080p' in resolutions else (resolutions[-1] if resolutions else None),
             'durationSeconds': video_duration(capabilities)}
    if capabilities.get('audio') and not capabilities.get('inputDrivenVideo'):
        found['generateAudio'] = True
    if capabilities.get('draft'):
        found['draft'] = False
    if capabilities.get('bitrate'):
        found['bitrateMode'] = 'high'
    if capabilities.get('editExtend'):
        found['mode'] = 'generate'
    return found


def inputs(model):
    capabilities = model.get('capabilities', {})
    if model['kind'] == 'upscale':
        return {'media': capabilities.get('upscaleMedia', 'image'), 'params': UPSCALE_PARAMS.get(model['name'], {}),
                'defaults': upscale_defaults(model)}
    chosen = defaults(model)
    found = {'aspectRatio': {'enum': capabilities.get('aspectRatios') or [], 'default': chosen['aspectRatio']},
             'resolution': {'enum': capabilities.get('resolutions') or [], 'default': chosen['resolution']},
             'seed': bool(capabilities.get('seed')), 'maxReferenceImages': capabilities.get('maxReferenceImages', 0)}
    if model['kind'] == 'video':
        bounds = capabilities.get('durationRange')
        found['durationSeconds'] = {'enum': capabilities.get('durations') or [], 'default': chosen['durationSeconds'],
                                    'min': bounds['min'] if bounds else None, 'max': bounds['max'] if bounds else None,
                                    'inputDriven': bool(capabilities.get('inputDrivenVideo'))}
        found['maxReferenceVideos'] = capabilities.get('maxReferenceVideos', 0) if capabilities.get('videoReference') else 0
        found['maxReferenceAudios'] = (capabilities.get('maxReferenceAudios', 10 if capabilities.get('editExtend') else 3)
                                       if capabilities.get('audio') else 0)
        if capabilities.get('referenceAudioSeconds'):
            seconds = capabilities['referenceAudioSeconds']
            found['referenceAudioSeconds'] = {'clipMin': seconds['clipMin'], 'clipMax': seconds['clipMax'], 'totalMax': seconds['totalMax']}
        found['firstLastFrame'] = bool(capabilities.get('firstLastFrame'))
        for name in ('generateAudio', 'draft', 'bitrateMode', 'mode'):
            if name in chosen:
                found[name] = {'enum': {'generateAudio': [True, False], 'draft': [True, False], 'bitrateMode': ['standard', 'high'],
                                        'mode': ['generate', 'edit', 'extend']}[name], 'default': chosen[name]}
    return found


def rate(model, pricing):
    key = model.get('pricingKey', model['name'])
    return next((row for row in pricing if row['model'] == key), None)


def price(model, pricing):
    """The live price: the stored rate plus worked examples priced like the web's estimate."""
    row = rate(model, pricing)
    capabilities = model.get('capabilities', {})
    found = {'unit': row['unit'] if row else None, 'unitCents': row['unitCostCents'] if row else None, 'examples': [], 'note': None}
    try:
        if model['kind'] == 'image':
            for resolution in capabilities.get('resolutions') or []:
                found['examples'].append({'resolution': resolution, 'cents': compute_cost({'model': model['name'], 'resolution': resolution,
                                                                                           'aspectRatio': '1:1'}, pricing)})
            found['note'] = 'Charged per finished image; best-of face mode multiplies by its candidates.'
        elif model['kind'] == 'video':
            chosen = defaults(model)
            seconds = chosen['durationSeconds'] or 10
            for resolution in capabilities.get('resolutions') or []:
                cents = booked_cents(model['name'], compute_cost({'model': model['name'], 'resolution': resolution, 'duration': seconds,
                                                                  'generateAudio': chosen.get('generateAudio', False)}, pricing),
                                     seconds, resolution)
                found['examples'].append({'resolution': resolution, 'durationSeconds': seconds,
                                          'generateAudio': bool(chosen.get('generateAudio')), 'cents': cents})
            found['note'] = ('Duration is the audio length, rounded up.' if capabilities.get('inputDrivenVideo') else
                             'The estimate is booked when the job starts; the provider-reported cost replaces it when it finishes.'
                             if model.get('usageCost') else 'Priced per second of output.')
        elif capabilities.get('upscaleMedia') == 'video':
            found['note'] = 'Priced per 1000 output frames at 2K (720p and 1K x0.78, 4K x1.33); the quote prices your clip.'
        else:
            found['note'] = 'Priced per upscaled image.'
    except ValueError as error:
        found.update(examples=[], note=str(error))
    if row and not row['unitCostCents'] and model['kind'] != 'upscale':
        found['note'] = 'Not priced yet: an admin must set the rate before this model can run.'
    return found


def typical_seconds(*, clock=time.monotonic):
    """``{model_id: [p50, p90]}`` seconds from start to finish over the last 7 days' succeeded jobs, cached 10 minutes.

    Synchronous image models record no provider submission time, so their run is measured from creation."""
    now = clock()
    with _typical_lock:
        if now < _typical['expires']:
            return _typical['values']
    with connection.cursor() as cursor:
        cursor.execute('''SELECT model,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY completed_at - COALESCE(submitted_at, created_at)),
                percentile_cont(0.9) WITHIN GROUP (ORDER BY completed_at - COALESCE(submitted_at, created_at))
            FROM generations WHERE status = 'succeeded' AND completed_at >= %s
              AND completed_at >= COALESCE(submitted_at, created_at) GROUP BY model''', [now_ms() - TYPICAL_WINDOW_MS])
        rows = cursor.fetchall()
    values = {}
    for name, p50, p90 in rows:
        definition = model_definition(name)
        if definition and p50 is not None:
            values[definition['id']] = [max(1, round(p50 / 1000)), max(1, round(p90 / 1000))]
    with _typical_lock:
        _typical.update(values=values, expires=now + TYPICAL_TTL_SECONDS)
    return values


def forget_typical():
    with _typical_lock:
        _typical['expires'] = 0.0


def cancel_rule(model):
    provider = model['provider']
    if model['kind'] != 'video' or provider not in ADAPTERS:
        return 'none'
    return 'until_finished' if provider == 'omni' else 'queued_only'


def catalogue():
    """``{'models': [...]}`` for the models the agent can run now. Runs on a database thread."""
    pricing, typical = read_pricing(), typical_seconds()
    models = []
    for model in offered():
        found = price(model, pricing)
        models.append({
            'id': model['id'], 'name': model['name'], 'kind': model['kind'], 'tool': TOOLS[model['kind']],
            'provider': PROVIDERS.get(model['provider'], model['provider']), 'summary': model.get('hint'),
            'badge': model.get('badge'), 'inputs': inputs(model), 'price': found,
            'typicalSeconds': typical.get(model['id']), 'cancel': cancel_rule(model),
            'output': {'mimeTypes': OUTPUT_TYPES['video' if model['kind'] == 'upscale' and
                                                 model['capabilities'].get('upscaleMedia') == 'video' else
                                                 'image' if model['kind'] == 'upscale' else model['kind']]}})
    return {'models': models}


def cheapest(models):
    """A short sentence naming how many models are listed and the cheapest example, for clients that show text only."""
    priced = [(example['cents'], model['name']) for model in models for example in model['price']['examples'] if example['cents']]
    if not priced:
        return f'{len(models)} models are available.'
    cents, name = min(priced)
    return f'{len(models)} models are available; the cheapest example is {name} at {dollars(cents)}.'
