"""list_models: the catalogue of models the agent can run now, with inputs, defaults, live prices and run times."""
from .. import catalog, results
from ..registry import ToolResult, obj, register
from ..runtime import db

STRING, INTEGER = {'type': 'string'}, {'type': 'integer'}
MODEL_SCHEMA = results.obj({
    'id': STRING, 'name': STRING, 'kind': {'enum': ['image', 'video', 'upscale']},
    'tool': {'enum': list(catalog.TOOLS.values())}, 'provider': STRING, 'summary': results.nullable(STRING),
    'badge': results.nullable(STRING), 'inputs': {'type': 'object'},
    'price': results.obj({'unit': results.nullable(STRING), 'unitCents': results.nullable(INTEGER),
                          'examples': {'type': 'array', 'items': {'type': 'object'}}, 'note': results.nullable(STRING)}),
    'typicalSeconds': results.nullable({'type': 'array', 'items': INTEGER, 'minItems': 2, 'maxItems': 2}),
    'cancel': {'enum': ['none', 'queued_only', 'until_finished']},
    'output': results.obj({'mimeTypes': {'type': 'array', 'items': STRING}}),
})
CATALOGUE_SCHEMA = results.obj({'models': {'type': 'array', 'items': MODEL_SCHEMA}})


@register(
    name='list_models', title='List models', scope='veevee.read', read_only=True,
    description=('List the image and video models you can use now, with their inputs, limits, defaults, prices and typical '
                 'run time.\n'
                 'Use a model id with the tool named in "tool". inputs lists each option\'s allowed values and the default '
                 'used when you leave it out. Prices are in US cents and are read live; price.examples are what the web '
                 'charges for those settings, and estimate_cost prices an exact call. typicalSeconds is the measured '
                 'median and 90th percentile from start to finish over the last 7 days (null without recent runs). cancel '
                 'says when cancel_generation can stop a job. The list changes when an admin switches a model on or off.'),
    input_schema=obj({}), output_schema=CATALOGUE_SCHEMA)
async def list_models(call):
    found = await db(catalog.catalogue)
    return ToolResult(found, catalog.cheapest(found['models']))
