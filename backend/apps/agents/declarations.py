"""Gemini ``functionDeclarations`` for the Agents tab, derived from the MCP registry, and the arguments the harness sends.

    tools = [{'functionDeclarations': function_declarations(principal)}]
    arguments = harness_arguments('generate_image', call['args'], idempotency_key=f'{run_id}:{step_index}')
    done = await server.dispatch(principal, 'generate_image', arguments, ...)

Declarations are the tools the principal can call (``registry.visible``, so an agent grant sees ``AGENT_TOOLS`` only),
each with its registry name, description and input schema as ``parametersJsonSchema``. The harness owns approval,
waiting and retries, so ``HARNESS_FIELDS`` are removed from every schema and the model never sends them: a quote token
and the user's confirmation come from the approval card, paid calls never block a step (``wait`` false), and each
step's idempotency key is ``<run id>:<step index>``. Schemas keep only the JSON Schema keywords Gemini documents for
``parametersJsonSchema``; ``const`` becomes a one-value ``enum`` and a ``default`` is spelt out in the description. The
dispatcher still validates every call against the full registry schema, so a dropped keyword is never a looser check.
"""
from apps.mcp import tools  # noqa: F401  importing tools registers them
from apps.mcp.registry import REGISTRY, visible

HARNESS_FIELDS = ('quoteToken', 'confirmedByUser', 'wait', 'maxWaitSeconds', 'idempotencyKey')
KEYWORDS = frozenset({'type', 'format', 'title', 'description', 'enum', 'items', 'prefixItems', 'minItems', 'maxItems',
                      'minimum', 'maximum', 'anyOf', 'oneOf', 'properties', 'additionalProperties', 'required'})
NESTED = ('items', 'additionalProperties')


def gemini_schema(schema):
    """``schema`` reduced to Gemini's documented ``parametersJsonSchema`` keywords."""
    if not isinstance(schema, dict):
        return schema
    out = {}
    for key, value in schema.items():
        if key == 'properties':
            out[key] = {name: gemini_schema(child) for name, child in value.items()}
        elif key in ('anyOf', 'oneOf', 'prefixItems'):
            out[key] = [gemini_schema(child) for child in value]
        elif key in NESTED:
            out[key] = gemini_schema(value)
        elif key in KEYWORDS:
            out[key] = value
    if 'const' in schema and 'enum' not in schema:
        out['enum'] = [schema['const']]
    if 'default' in schema:
        default = schema['default']
        shown = 'true' if default is True else 'false' if default is False else default
        out['description'] = ' '.join(filter(None, [schema.get('description'), f'Default: {shown}.']))
    return out


def model_schema(schema):
    """The input schema without the fields the harness sets, in Gemini's keyword subset."""
    schema = dict(schema)
    properties = {name: value for name, value in schema.get('properties', {}).items() if name not in HARNESS_FIELDS}
    schema['properties'] = properties
    if 'required' in schema:
        required = [name for name in schema['required'] if name not in HARNESS_FIELDS]
        if required:
            schema['required'] = required
        else:
            del schema['required']
    return gemini_schema(schema)


def function_declarations(principal):
    """One ``{'name', 'description', 'parametersJsonSchema'}`` per tool the principal can call, in registry order."""
    return [{'name': spec.name, 'description': spec.description, 'parametersJsonSchema': model_schema(spec.schema())}
            for spec in visible(principal)]


def harness_arguments(name, model_arguments, *, quote_token=None, confirmed=False, idempotency_key=None):
    """The arguments the harness dispatches for one model function call: the model's own values minus any harness
    field it sent, then the harness's values for the fields that tool's schema declares."""
    spec = REGISTRY.get(name)
    properties = spec.schema().get('properties', {}) if spec is not None else {}
    arguments = {key: value for key, value in dict(model_arguments or {}).items() if key not in HARNESS_FIELDS}
    if 'wait' in properties:
        arguments['wait'] = False
    if quote_token is not None and 'quoteToken' in properties:
        arguments['quoteToken'] = quote_token
    if confirmed and 'confirmedByUser' in properties:
        arguments['confirmedByUser'] = True
    if idempotency_key is not None and 'idempotencyKey' in properties:
        arguments['idempotencyKey'] = idempotency_key
    return arguments
