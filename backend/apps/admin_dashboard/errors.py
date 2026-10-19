"""Read-only admin view of provider errors: failed generations and failed or uncertain portrait assets.

Each row carries the exact provider record (code, message, param, request id, raw body) from
``generations.provider_responses`` or ``managed_portrait_assets.receipt['lastError']``, parsed on read so older rows
that only kept a raw body work too; rows with no record fall back to the stored error text. Every text field is
redacted again on the way out. Paging is a ``(created_at, id)`` keyset over both sources; the total is a SQL count.
"""
import json
import math
from types import SimpleNamespace

from apps.canvas.serialization import JS_WHITESPACE
from apps.canvas.views import failure, reply
from apps.generation import provider_errors
from apps.generation.failure_copy import public_message
from apps.generation.history_parameters import UUID_TEXT, decode_cursor
from apps.generation.model_registry import MODEL_REGISTRY

from .admin_api import admin_gate, node_route, number, text
from .queries import first, query, utf16_slice

DEFAULT_LIMIT, MAX_LIMIT = 50, 200
PORTRAIT_MODEL = 'Portrait asset'
PORTRAIT_PROVIDER = 'byteplus-assets'
SOURCES = ('generation', 'portrait')

GENERATIONS = ("SELECT 'generation' AS source, id, created_at, coalesce(completed_at, updated_at) AS failed_at, user_id, kind, model,"
               " error, provider_responses, moderation_blocked, task_id, NULL::text AS error_code, NULL::jsonb AS receipt, status"
               " FROM generations")
PORTRAITS = ("SELECT 'portrait' AS source, id, created_at, updated_at AS failed_at, created_by_id AS user_id, 'portrait' AS kind,"
             " %s AS model, NULL::text AS error, NULL::jsonb AS provider_responses, NULL::boolean AS moderation_blocked,"
             " byteplus_asset_id AS task_id, error_code, receipt, status FROM managed_portrait_assets")


def models_for(provider):
    """Registry models whose errors this adapter records (Seedance runs on the registry's "byteplus" provider)."""
    return [model['name'] for model in MODEL_REGISTRY
            if provider_errors._REGISTRY_PROVIDER.get(model['provider'], model['provider']) == provider]


def like(value):
    return '%' + value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%'


def filters(params):
    """(generation clauses, values, portrait clauses, values) for the requested filters."""
    generation, generation_values = ["status = 'failed'"], []
    portrait, portrait_values = ["status IN ('FAILED', 'UNCERTAIN')"], []
    source = first(params, 'source')
    if source == 'generation':
        portrait.append('false')
    elif source == 'portrait':
        generation.append('false')
    user = first(params, 'userId')
    if user and UUID_TEXT.fullmatch(user):
        generation.append('user_id = %s'); generation_values.append(user)
        portrait.append('created_by_id = %s'); portrait_values.append(user)
    for name, operator in (('from', '>='), ('to', '<')):
        bound = number(first(params, name)) if first(params, name) else math.nan
        if math.isfinite(bound):
            for clauses, values in ((generation, generation_values), (portrait, portrait_values)):
                clauses.append(f'created_at {operator} %s::text::bigint'); values.append(text(math.floor(bound)))
    model = (first(params, 'model') or '').strip(JS_WHITESPACE)
    if model:
        generation.append('model = %s'); generation_values.append(model)
        if model != PORTRAIT_MODEL:
            portrait.append('false')
    provider = (first(params, 'provider') or '').strip(JS_WHITESPACE)
    if provider:
        generation.append("(model = ANY(%s::text[]) OR coalesce(provider_responses @> %s::jsonb, false))")
        generation_values += [models_for(provider), json.dumps([{'provider': provider}])]
        if provider != PORTRAIT_PROVIDER:
            portrait.append('false')
    code = utf16_slice((first(params, 'code') or '').strip(JS_WHITESPACE), 100)
    if code:
        # Codes of older rows live only inside the stored raw body, so match the JSON text as well as the field.
        generation.append("(coalesce(provider_responses::text, '') LIKE %s OR coalesce(error, '') LIKE %s)")
        generation_values += [like(code), like(code)]
        portrait.append("(coalesce(error_code, '') LIKE %s OR coalesce(receipt->'lastError'->>'code', '') LIKE %s)")
        portrait_values += [like(code), like(code)]
    return generation, generation_values, portrait, portrait_values


def union(params):
    generation, generation_values, portrait, portrait_values = filters(params)
    sql = (GENERATIONS + ' WHERE ' + ' AND '.join(generation) + ' UNION ALL ' + PORTRAITS + ' WHERE ' + ' AND '.join(portrait))
    return sql, generation_values + [PORTRAIT_MODEL] + portrait_values


def json_value(value):
    return json.loads(value) if isinstance(value, str) else value


def generation_row(row):
    records = provider_errors.records(json_value(row['provider_responses']))
    main = provider_errors.primary(records) or {}
    shown = SimpleNamespace(kind=row['kind'], model=row['model'], moderation_blocked=row['moderation_blocked'],
                            provider_responses=records)
    return {'provider': main.get('provider') or provider_errors.provider_for_model(row['model']),
            'taskId': main.get('taskId') or row['task_id'], 'records': records, 'primary': main,
            'error': provider_errors.redact(row['error']) if row['error'] else None,
            'userMessage': public_message(shown, row['error'])}


def portrait_row(row):
    receipt = json_value(row['receipt']) or {}
    records = provider_errors.records(receipt.get('lastError'))
    main = records[0] if records else {}
    if not main.get('code') and row['error_code']:
        main = {**main, 'code': row['error_code'], 'source': main.get('source') or 'veevee'}
    return {'provider': PORTRAIT_PROVIDER, 'taskId': row['task_id'], 'records': records, 'primary': main,
            'error': row['error_code'], 'userMessage': None}


def output(row):
    detail = generation_row(row) if row['source'] == 'generation' else portrait_row(row)
    main = detail.pop('primary')
    return {'id': str(row['id']), 'source': row['source'], 'createdAt': row['created_at'], 'failedAt': row['failed_at'],
            'userId': str(row['user_id']) if row['user_id'] else None, 'userEmail': row['email'], 'kind': row['kind'],
            'model': row['model'], 'status': row['status'], 'httpStatus': main.get('httpStatus'), 'code': main.get('code'),
            'message': main.get('message'), 'param': main.get('param'), 'requestId': main.get('requestId'),
            'phase': main.get('phase'), 'origin': main.get('source'), 'receivedAt': main.get('receivedAt'),
            'rawBody': main.get('rawBody'), **detail}


def error_rows(params):
    sql, values = union(params)
    cursor = decode_cursor(first(params, 'cursor'))
    page, page_values = '', []
    if cursor:
        page = ' WHERE (e.created_at, e.id) < (%s::text::bigint, %s::uuid)'
        page_values = [text(cursor['sort']), cursor['id']]
    raw_limit = number(first(params, 'limit'))
    limit = int(min(max(raw_limit if raw_limit and not math.isnan(raw_limit) else DEFAULT_LIMIT, 1), MAX_LIMIT))
    rows = query('SELECT e.*, u.email FROM (' + sql + ') e LEFT JOIN users u ON u.id = e.user_id' + page
                 + ' ORDER BY e.created_at DESC, e.id DESC LIMIT %s::text::bigint', values + page_values + [text(limit + 1)])
    more = len(rows) > limit
    rows = rows[:limit]
    total = query('SELECT count(*)::int AS count FROM (' + sql + ') e', values)[0]['count']
    result = {'rows': [output(row) for row in rows], 'total': total,
              'nextCursor': f"{rows[-1]['created_at']}.{rows[-1]['id']}" if more and rows else None}
    if not cursor:
        result['providers'] = sorted(provider_errors.PROVIDERS)
        result['models'] = [row['model'] for row in query("SELECT DISTINCT model FROM generations WHERE status = 'failed' ORDER BY model")]
    return result


@node_route(['GET'])
def errors(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    try: return reply(request, error_rows(request.query_params))
    except Exception: return failure()
