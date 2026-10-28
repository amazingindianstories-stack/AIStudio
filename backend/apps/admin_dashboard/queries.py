"""Bounded PostgreSQL dashboard projections, keysets and CSV export."""
import csv
import io
import json
import math
from datetime import datetime, timezone
from django.db import connection
from django.http import HttpResponse
from apps.authentication.models import User
from apps.common.leases import now_ms
from apps.canvas.serialization import JS_WHITESPACE, js_json
from apps.canvas.views import reply, failure, truthy
from apps.generation.history_parameters import decode_cursor, UUID_TEXT
from .admin_api import node_route, admin_gate, number, text, safe_user
from .models import Pricing, AppSetting, UserLimit
from .default_pricing import DEFAULT_PRICING
from .views import LIMITS, USER_LIMITS, parse

MAX_CSV_ROWS = 20000
COST = """count(*)::int AS count,
 coalesce(sum(case when status='succeeded' then cost_cents else 0 end),0)::int AS cost,
 coalesce(sum(case when status='succeeded' and cost_basis='reconciled' then cost_cents else 0 end),0)::int AS reconciled,
 coalesce(sum(case when status='succeeded' and cost_basis<>'reconciled' then cost_cents else 0 end),0)::int AS estimated"""


def query(sql, parameters=()):
    with connection.cursor() as cursor:
        cursor.execute(sql, parameters)
        return [dict(zip([column.name for column in cursor.description], row)) for row in cursor.fetchall()]


def first(params, name):
    values = params.getlist(name)
    return values[0] if values else None


def utf16_slice(value, limit):
    return value.encode('utf-16-le', errors='surrogatepass')[:2*limit].decode('utf-16-le', errors='surrogatepass')


def conditions(params, *, activity=False):
    clauses, values = [], []
    user = first(params, 'userId')
    if user and UUID_TEXT.fullmatch(user): clauses.append('user_id=%s'); values.append(user)
    if activity:
        action = (first(params, 'action') or '').strip(JS_WHITESPACE)
        if action: clauses.append('action=%s'); values.append(utf16_slice(action, 64))
    else:
        for key, choices in [('kind', ('image', 'video')), ('status', ('queued', 'running', 'succeeded', 'failed', 'cancelled'))]:
            value = first(params, key)
            if value in choices: clauses.append(key + '=%s'); values.append(value)
        model = first(params, 'model')
        if model: clauses.append('model=%s'); values.append(model)
        if first(params, 'flagged') == '1': clauses.append('flagged=true')
        search = (first(params, 'q') or '').strip(JS_WHITESPACE)
        if search:
            search = utf16_slice(search, 200).strip(JS_WHITESPACE)
            clauses.append('prompt ILIKE %s')
            values.append('%' + search.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_') + '%')
    return clauses, values


def json_value(value):
    return json.loads(value) if isinstance(value, str) else value


def where(clauses):
    return ' WHERE ' + ' AND '.join(clauses) if clauses else ''


def price_rows():
    """Deployed processes only read prices; the API also lists default models that have no stored price yet."""
    from django.conf import settings
    component = getattr(settings, 'VEEVEE_RUNTIME_COMPONENT', None)
    if component:
        result = [{'model': row.model, 'unitCostCents': row.unit_cost_cents, 'unit': row.unit, 'notes': row.notes}
                  for row in Pricing.objects.all()]
        if component == 'api':
            present = {row['model'] for row in result}
            for default in DEFAULT_PRICING:
                if default['model'] not in present:
                    result.append(dict(default))
                    present.add(default['model'])
        return result
    Pricing.objects.bulk_create([Pricing(model=row['model'], unit_cost_cents=row['unitCostCents'], unit=row['unit'], notes=row['notes']) for row in DEFAULT_PRICING], ignore_conflicts=True)
    return [{'model': row.model, 'unitCostCents': row.unit_cost_cents, 'unit': row.unit, 'notes': row.notes} for row in Pricing.objects.all()]


def statistics():
    totals = query('SELECT ' + COST + ' FROM generations')[0]
    kinds = {row['name']: row['value'] for row in query('SELECT kind AS name,count(*)::int AS value FROM generations GROUP BY kind')}
    models = query('SELECT model AS name,count(*)::int AS value FROM generations GROUP BY model ORDER BY count(*) DESC')
    days = query("SELECT to_char(to_timestamp(created_at/1000.0) at time zone 'utc','YYYY-MM-DD') AS day,count(*)::int AS count FROM generations WHERE created_at >= %s GROUP BY 1 ORDER BY 1 ASC", [now_ms() - 90*86400000])
    return {'totalGenerations': totals['count'], 'totalCostCents': totals['cost'], 'reconciledCostCents': totals['reconciled'], 'estimatedCostCents': totals['estimated'],
            'byKind': [{'name': kind, 'value': kinds.get(kind, 0)} for kind in ('image', 'video')], 'byModel': models, 'overTime': days, 'models': [row['name'] for row in models]}


# Dashboard controls whose routes the ingress gateway may refuse (deploy/gateway.py is the single authority).
GATED_OPERATIONS = {'runtimeAudit': ('POST', '/api/admin/audit/runtime'), 'higgsfieldToken': ('POST', '/api/admin/set-token')}


def operations():
    """Which gated admin operations reach Django here, so the dashboard shows refused ones as off instead of failing.

    Only the deployed entrypoint runs the API (VEEVEE_RUNTIME_COMPONENT=api), and it always starts the gateway in
    front of it; elsewhere (tests, manage.py runserver) nothing sits in between. These routes ignore the gateway's
    feature flags, so its defaults answer for them.
    """
    from django.conf import settings
    if getattr(settings, 'VEEVEE_RUNTIME_COMPONENT', None) != 'api':
        return {name: True for name in GATED_OPERATIONS}
    from deploy.gateway import allowed
    return {name: allowed(method, path) for name, (method, path) in GATED_OPERATIONS.items()}


@node_route(['GET'])
def dashboard(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    try:
        global_values = dict(AppSetting.objects.filter(key__in=LIMITS).values_list('key', 'value'))
        limits = {key: parse(global_values.get(key), definition) for key, definition in LIMITS.items()}
        overrides = {}
        for row in UserLimit.objects.filter(key__in=USER_LIMITS):
            overrides.setdefault(str(row.user_id), {})[row.key] = parse(row.value, LIMITS[row.key])
        per_user = {str(row['user_id']): row for row in query('SELECT user_id,' + COST + ' FROM generations GROUP BY user_id')}
        from apps.mcp_auth.views import admin_summary
        agents = admin_summary()
        users = []
        for user in User.objects.all():
            totals = per_user.get(str(user.id), {})
            users.append({**safe_user(user), 'limits': overrides.get(str(user.id), {}), 'genCount': totals.get('count', 0),
                          'agentAccess': {'enabled': str(user.id) in agents['enabled'], 'activeGrants': agents['grants'].get(str(user.id), 0)},
                          'costCents': totals.get('cost', 0), 'reconciledCostCents': totals.get('reconciled', 0), 'estimatedCostCents': totals.get('estimated', 0)})
        users.sort(key=lambda row: -row['costCents'])
        return reply(request, {'users': users, 'stats': statistics(), 'pricing': price_rows(), 'limits': limits, 'operations': operations()})
    except Exception: return failure()


def activity_page(params):
    clauses, values = conditions(params, activity=True)
    total = query('SELECT count(*)::int AS count FROM activity_logs' + where(clauses), values)[0]['count']
    cursor = decode_cursor(first(params, 'cursor'))
    page_clauses, page_values = clauses[:], values[:]
    if cursor:
        page_clauses.append('(created_at,id)<(%s::text::bigint,%s::uuid)'); page_values += [text(cursor['sort']), cursor['id']]
    raw_limit = number(first(params, 'limit'))
    limit = min(max(raw_limit if raw_limit and not math.isnan(raw_limit) else 50, 1), 200)
    rows = query('SELECT * FROM activity_logs' + where(page_clauses) + ' ORDER BY created_at DESC,id DESC LIMIT %s::text::bigint', page_values + [text(limit + 1)])
    more = len(rows) > limit
    page = rows[:int(limit)] if more else rows
    result = {'rows': [{'id': str(row['id']), 'userId': str(row['user_id']) if row['user_id'] else None, 'action': row['action'], 'detail': json_value(row['detail']), 'createdAt': row['created_at']} for row in page],
              'total': total, 'nextCursor': f"{page[-1]['created_at']}.{page[-1]['id']}" if more and page else None}
    if not cursor: result['actions'] = [row['action'] for row in query('SELECT DISTINCT action FROM activity_logs ORDER BY action')]
    return result


@node_route(['GET'])
def activity(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    try: return reply(request, activity_page(request.query_params))
    except Exception: return failure()


def log_rows(params, *, export=False):
    clauses, values = conditions(params)
    cursor = None if export else decode_cursor(first(params, 'cursor'))
    page_clauses, page_values = clauses[:], values[:]
    if cursor:
        page_clauses.append('(created_at,id)<(%s::text::bigint,%s::uuid)'); page_values += [text(cursor['sort']), cursor['id']]
    raw_limit = number(first(params, 'limit'))
    limit = MAX_CSV_ROWS if export else min(max(raw_limit if raw_limit and not math.isnan(raw_limit) else 100, 1), 200)
    prompt = 'prompt' if export else 'left(prompt,300) AS prompt,length(prompt)>300 AS prompt_truncated'
    rows = query('SELECT id,kind,model,status,cost_cents,cost_basis,user_id,' + prompt + ',flagged,flagged_at,flag_reason,judge_score,created_at FROM generations' + where(page_clauses) + ' ORDER BY created_at DESC,id DESC LIMIT %s::text::bigint', page_values + [text(limit if export else limit+1)])
    more = not export and len(rows) > limit
    page = rows[:int(limit)] if more else rows
    output = []
    for row in page:
        item = {'id': str(row['id']), 'kind': row['kind'], 'model': row['model'], 'status': row['status'], 'costCents': row['cost_cents'] or 0,
                'costBasis': 'reconciled' if row['cost_basis'] == 'reconciled' else 'estimated', 'userId': str(row['user_id']) if row['user_id'] else None,
                'prompt': row['prompt'], 'flagged': row['flagged'], 'flaggedAt': row['flagged_at'], 'flagReason': row['flag_reason'], 'judgeScore': json_value(row['judge_score']), 'createdAt': row['created_at']}
        if not export: item['promptTruncated'] = row['prompt_truncated']
        output.append(item)
    if export: return output
    totals = query('SELECT ' + COST + ' FROM generations' + where(clauses), values)[0]
    return {'rows': output, 'total': totals['count'], 'totalCostCents': totals['cost'], 'reconciledCostCents': totals['reconciled'], 'estimatedCostCents': totals['estimated'],
            'nextCursor': f"{page[-1]['created_at']}.{page[-1]['id']}" if more and page else None}


def iso_time(milliseconds):
    return datetime.fromtimestamp(milliseconds/1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def csv_response(params):
    rows = log_rows(params, export=True)
    emails = {str(user.id): user.email for user in User.objects.all()}
    header = ['time', 'user', 'kind', 'model', 'status', 'cost_cents', 'cost_basis', 'flagged', 'flagged_at', 'flag_reason', 'judge_score', 'prompt']
    lines = [header]
    for row in rows:
        lines.append([iso_time(row['createdAt']), emails.get(row['userId'], ''), row['kind'], row['model'], row['status'], text(row['costCents']), row['costBasis'], text(row['flagged']),
                      iso_time(row['flaggedAt']) if row['flaggedAt'] else '', row['flagReason'] or '', js_json(row['judgeScore']) if truthy(row['judgeScore']) else '', row['prompt']])
    # csv.writer with CRLF ensures lone CR gets quoted; strip row delimiters only.
    encoded = []
    for row in lines:
        stream = io.StringIO(newline='')
        csv.writer(stream, lineterminator='\r\n').writerow(row)
        encoded.append(stream.getvalue()[:-2])
    response = HttpResponse('\n'.join(encoded), content_type='text/csv; charset=utf-8')
    response['Content-Disposition'] = f'attachment; filename="veevee-logs-{iso_time(now_ms())[:10]}.csv"'
    response['Cache-Control'] = 'no-store'
    response['X-Logs-Truncated'] = 'true' if len(rows) == MAX_CSV_ROWS else 'false'
    if len(rows) == MAX_CSV_ROWS: response['X-Logs-Truncated-At'] = str(MAX_CSV_ROWS)
    return response


@node_route(['GET'])
def logs(request):
    refused = admin_gate(request)[1]
    if refused: return refused
    try:
        if first(request.query_params, 'format') == 'csv':
            from apps.common.responses import renew_session
            return renew_session(request, csv_response(request.query_params))
        return reply(request, log_rows(request.query_params))
    except Exception: return failure()
