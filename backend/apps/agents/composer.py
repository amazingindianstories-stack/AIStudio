"""The composer a message is sent from: the Agents tab's mode (image, video or upscale), its model, settings and, for an
upscale, the source, plus where new work lands. The model sees it as a harness note beside the message, so its next
calls can follow the artist's choices; the model still makes every call, and the tools validate them as usual.

    context = parse(body.get('composer'))     # None when absent; raises Invalid
    note_parts(context)                       # [{'text': 'Veevee: the artist sent this from Image mode ...'}]

``parse`` checks shape and the model; the view resolves the upscale ``source`` (a stored media URL) to the library id
upscale_media takes (``sourceId``). The location is checked by ``apps.mcp.tools.generate.location`` in the view.
"""
import json
import re
import uuid

from jsonschema import Draft202012Validator

from apps.generation.model_registry import model_definition
from apps.mcp import catalog
from apps.mcp.tools.generate import GLOBAL

MODES = ('image', 'video', 'upscale')
MEDIA = ('image', 'video')
VALUE = re.compile(r'^[0-9A-Za-z:._-]{1,16}$')
# The composer settings each mode passes on, by the generate tool's argument name.
OPTIONS = {
    'image': {'aspectRatio': 'value', 'resolution': 'value', 'count': (1, 8)},
    'video': {'aspectRatio': 'value', 'resolution': 'value', 'durationSeconds': (1, 300), 'generateAudio': bool,
              'draft': bool, 'bitrateMode': ('standard', 'high'), 'mode': ('generate', 'edit', 'extend')},
}
REF_CHARS = 2048


class Invalid(ValueError):
    """The composer context is malformed; the message is the 400 answer."""


def option(name, rule, value):
    if rule == 'value':
        ok = isinstance(value, str) and VALUE.match(value)
    elif rule is bool:
        ok = isinstance(value, bool)
    elif isinstance(rule, tuple) and isinstance(rule[0], int):
        ok = isinstance(value, int) and not isinstance(value, bool) and rule[0] <= value <= rule[1]
    else:
        ok = value in rule
    if not ok:
        raise Invalid(f'composer.options.{name} is not a valid value.')
    return value


def chosen_model(mode, media, name):
    model = model_definition(name) if isinstance(name, str) else None
    kind = 'upscale' if mode == 'upscale' else mode
    if model is None or model.get('kind') != kind:
        raise Invalid(f'composer.model is not {"an" if kind in ("image", "upscale") else "a"} {kind} model.')
    if mode == 'upscale' and catalog.UPSCALE_PARAMS.get(model['name']) is None:
        raise Invalid('composer.model is not an upscale model.')
    if mode == 'upscale' and model.get('capabilities', {}).get('upscaleMedia', 'image') != media:
        raise Invalid(f'composer.model does not upscale {media}.')
    return model


def upscale_params(model, value):
    fields = catalog.UPSCALE_PARAMS[model['name']]
    schema = {'type': 'object', 'properties': fields, 'additionalProperties': False}
    if not isinstance(value, dict) or not Draft202012Validator(schema).is_valid(value):
        raise Invalid(f'composer.upscale.params must be {model["name"]} parameters.')
    return value


def location_id(name, value):
    """A project or folder id; ``folderId`` may also be "global" (no project)."""
    if name == 'folderId' and value == GLOBAL:
        return value
    try:
        return str(uuid.UUID(value))
    except (AttributeError, TypeError, ValueError):
        raise Invalid(f'composer.{name} must be {"a project" if name == "projectId" else "a folder"} id.') from None


def parse(value):
    """The validated composer context, without the upscale source resolved; None when the message has none."""
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('mode') not in MODES:
        raise Invalid("composer.mode must be 'image', 'video' or 'upscale'.")
    mode = value['mode']
    found = {'mode': mode}
    if mode == 'upscale':
        upscale = value.get('upscale')
        if not isinstance(upscale, dict) or upscale.get('media') not in MEDIA:
            raise Invalid("composer.upscale.media must be 'image' or 'video'.")
        model = chosen_model(mode, upscale['media'], value.get('model'))
        found.update(media=upscale['media'], params=upscale_params(model, upscale.get('params', {})))
        source = upscale.get('source')
        if source is not None and not (isinstance(source, str) and 0 < len(source) <= REF_CHARS):
            raise Invalid('composer.upscale.source must be a stored media URL.')
        if source:
            found['source'] = source
    else:
        model = chosen_model(mode, None, value.get('model'))
        options = value.get('options', {})
        if not isinstance(options, dict) or set(options) - set(OPTIONS[mode]):
            raise Invalid(f'composer.options takes only {", ".join(OPTIONS[mode])}.')
        found['options'] = {name: option(name, OPTIONS[mode][name], item) for name, item in options.items() if item is not None}
    found.update(model=model['id'], modelName=model['name'])
    for name in ('projectId', 'folderId'):
        if value.get(name) is not None:
            found[name] = location_id(name, value[name])
    return found


def note_parts(context):
    """The harness note for a message sent with ``context``: the mode, model and settings the artist chose."""
    if not isinstance(context, dict) or context.get('mode') not in MODES:
        return []
    model = f"model {context.get('model')} ({context.get('modelName')})"
    if context['mode'] == 'upscale':
        source = (f"sourceId {context['sourceId']}" if context.get('sourceId')
                  else 'no source selected yet (ask for one, or use a library item the artist names)')
        settings = f"upscale_media {model} for {'an image' if context.get('media') == 'image' else 'a video'}, " \
                   f"params {json.dumps(context.get('params') or {}, sort_keys=True)}, {source}"
    else:
        tool = 'generate_image' if context['mode'] == 'image' else 'generate_video'
        options = dict(context.get('options') or {})
        count = options.pop('count', None)
        listed = ', '.join(f'{name} {json.dumps(item)}' for name, item in sorted(options.items()))
        settings = f"{tool} {model}" + (f', {listed}' if listed else '') + (f'; {count} outputs' if count and count > 1 else '')
    return [{'text': f"Veevee: the artist sent this from the composer's {context['mode'].capitalize()} mode: {settings}. "
                     'Use these choices for the work this message asks for, unless the artist says otherwise.'}]
