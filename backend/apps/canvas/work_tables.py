"""Board-authorized table/record API. All mutations lock the table and append history."""
import datetime
import math
import re
import uuid
from django.db import transaction
from django.db.models import Avg, Sum, Q, Count
from django.db.models.fields.json import KeyTextTransform
from django.db.models.functions import Cast
from django.db.models import FloatField
from . import access, services
from .models import WorkTable, WorkRecord, WorkRelation, WorkHistory
from .work_schema import FIELD_TYPES, KINDS, clean_record, text
from .work_formulas import parse, calculate, sql_expression


class WorkError(ValueError):
    pass


def identifier(value):
    try:
        return uuid.UUID(str(value))
    except (ValueError, TypeError, AttributeError) as error:
        raise WorkError('Invalid object id.') from error


def fields(raw):
    if not isinstance(raw, list) or not 1 <= len(raw) <= 64:
        raise WorkError('A table needs 1 to 64 fields.')
    result, ids = [], set()
    for field in raw:
        if not isinstance(field, dict) or not isinstance(field.get('id'), str) or not re.fullmatch(r'[a-zA-Z_][a-zA-Z0-9_]{0,63}', field['id']):
            raise WorkError('Field ids must be identifiers with at most 64 characters.')
        key = field['id']
        if '__' in key: raise WorkError('Field ids cannot contain double underscores.')
        if key in ids or field.get('type') not in FIELD_TYPES:
            raise WorkError('Duplicate field or unsupported field type.')
        ids.add(key)
        item = {'id': key, 'name': text(field.get('name'), 120) or key, 'type': field['type']}
        if item['type'] == 'select':
            options = field.get('options', [])
            if not isinstance(options, list) or len(options) > 100 or any(not isinstance(v, str) or len(v) > 120 for v in options):
                raise WorkError('Select options must be up to 100 short strings.')
            item['options'] = list(dict.fromkeys(options))
        if item['type'] == 'formula': item['expression'] = text(field.get('expression'), 256)
        if field.get('format') in ('number', 'currency', 'percent', 'progress'): item['format'] = field['format']
        if isinstance(field.get('currency'), str) and re.fullmatch(r'[A-Z]{3}', field['currency']): item['currency'] = field['currency']
        rules = field.get('colors', [])
        if isinstance(rules, list):
            item['colors'] = [{'min': float(r['min']), 'color': r['color']} for r in rules[:8] if isinstance(r, dict)
                              and type(r.get('min')) in (int, float) and abs(r['min']) < 1e15
                              and isinstance(r.get('color'), str) and re.fullmatch(r'#[a-fA-F0-9]{6}', r['color'])]
        result.append(item)
    numeric = {f['id'] for f in result if f['type'] in ('number', 'points')}
    for field in result:
        if field['type'] == 'formula': parse(field['expression'], numeric)
    return result


def views(raw, schema):
    if not isinstance(raw, list) or len(raw) > 16:
        raise WorkError('Use at most 16 views.')
    ids = {f['id'] for f in schema}
    result = []
    for view in raw:
        if not isinstance(view, dict) or view.get('kind') not in KINDS:
            raise WorkError('Invalid view.')
        item = {'id': text(view.get('id'), 64) or str(uuid.uuid4()), 'name': text(view.get('name'), 120), 'kind': view['kind']}
        for key in ('groupBy', 'swimlaneBy', 'startField', 'endField', 'valueField'):
            if view.get(key) in ids: item[key] = view[key]
        for key in ('hiddenFields', 'hiddenColumns', 'collapsed'):
            item[key] = [text(v, 128) for v in view.get(key, [])[:100] if isinstance(v, str)] if isinstance(view.get(key), list) else []
        if view.get('nodeType') in ('rect', 'ellipse', 'shape'): item['nodeType'] = view['nodeType']
        if view.get('chartType') in ('bar', 'line', 'pie'): item['chartType'] = view['chartType']
        if view.get('branchColor') and re.fullmatch(r'#[a-fA-F0-9]{6}', str(view['branchColor'])): item['branchColor'] = view['branchColor']
        result.append(item)
    return result


def relation_targets(values, schema):
    return [v for f in schema if f['type'] == 'relation' and isinstance(values.get(f['id']), list) for v in values[f['id']]]


def cells(raw, schema, previous=None):
    if not isinstance(raw, dict): raise WorkError('Record cells must be an object.')
    if len(raw) > 64: raise WorkError('Too many record fields.')
    result = {}
    for field in schema:
        key, kind = field['id'], field['type']
        value = raw.get(key)
        if value is None or value == '': continue
        if kind == 'formula': continue
        if kind in ('number', 'points'):
            if type(value) not in (int, float) or not -1e12 <= value <= 1e12: raise WorkError(f'{key} must be a finite number between -1e12 and 1e12.')
        elif kind == 'date':
            if not isinstance(value, str): raise WorkError(f'{key} must be an ISO date.')
            try:
                if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value): raise ValueError('ISO date required')
                datetime.date.fromisoformat(value)
            except ValueError as error: raise WorkError(f'{key} must be an ISO date.') from error
        elif kind == 'people':
            value = value if previous and previous.get(key) == value else str(access.active_user(value))
        elif kind == 'relation':
            if not isinstance(value, list) or len(value) > 64: raise WorkError('Relations must be a list of record ids.')
            value = list(dict.fromkeys(str(identifier(v)) for v in value))
        elif not isinstance(value, str) or len(value) > 2000:
            raise WorkError(f'{key} must be text with at most 2000 characters.')
        if kind == 'select' and value not in field['options']: raise WorkError(f'{key} must be a configured option.')
        result[key] = value
    return clean_record(result)


def describe(table, user, board):
    return {'id': str(table.id), 'boardId': str(table.board_id), 'name': table.name, 'fields': table.fields, 'views': table.views,
            'ownerId': str(table.owner_id), 'ownerOnly': table.owner_only, 'version': table.version,
            'canEdit': access.role_for(user, board) >= access.WRITE and (not table.owner_only or str(user.id) == str(table.owner_id) or access.role_for(user, board) >= access.OWN)}


def record_json(record, schema):
    result = dict(record.cells)
    numeric = {f['id'] for f in schema if f['type'] in ('number', 'points')}
    for field in schema:
        if field['type'] == 'formula': result[field['id']] = calculate(field['expression'], record.cells, numeric)
    return {'id': str(record.id), 'cells': result, 'parentId': str(record.parent_id) if record.parent_id else None,
            'blockedBy': [str(r.target_id) for r in record.dependencies.all()], 'position': record.position, 'version': record.version}


def history(table, user, target, action, before, after):
    WorkHistory.objects.create(table=table, actor_id=user.id, target_id=str(target), action=action, before=before, after=after, created_at=services.now_ms())


def require_edit(table, user, board):
    access.require(user, board, access.WRITE)
    if table.owner_only and str(table.owner_id) != str(user.id) and access.role_for(user, board) < access.OWN:
        raise access.AccessError('This table is editable by its owner only.', 403)


def create_table(user, board, data):
    access.require(user, board, access.WRITE)
    schema = fields(data.get('fields'))
    if WorkTable.objects.filter(board_id=board['id']).count() >= 100: raise WorkError('This board has reached its 100 table limit.')
    now = services.now_ms()
    with transaction.atomic():
        table = WorkTable.objects.create(board_id=board['id'], name=text(data.get('name'), 120) or 'Untitled table', fields=schema,
                                         views=views(data.get('views', []), schema), owner_id=user.id, created_at=now, updated_at=now)
        history(table, user, table.id, 'create_table', None, describe(table, user, board))
    return describe(table, user, board)


def query(table, params):
    records = table.records.all()
    schema = {f['id']: f for f in table.fields}
    search = params.get('q', '')[:200]
    if search:
        condition = Q()
        for key in schema: condition |= Q(**{f'cells__{key}__icontains': search})
        records = records.filter(condition)
    key, value = params.get('filterField'), params.get('filterValue', '')
    if key in schema and value != '':
        kind = schema[key]['type']
        if kind in ('number', 'points'):
            try: value = float(value)
            except ValueError as error: raise WorkError('Numeric filter requires a number.') from error
            if not math.isfinite(value): raise WorkError('Numeric filter requires a finite number.')
        records = records.filter(**{f'cells__{key}': value})
    if params.get('ids'):
        records = records.filter(id__in=[identifier(v) for v in params['ids'].split(',')[:200]])
    filtered = records
    group_by = params.get('groupBy') if params.get('groupBy') in schema else None
    group_order = ['cells__' + group_by] if group_by else []
    sort = params.get('sort')
    direction = '-' if params.get('direction') == 'desc' else ''
    if sort in schema:
        numeric = {k for k, f in schema.items() if f['type'] in ('number', 'points')}
        expr = sql_expression(schema[sort]['expression'], numeric) if schema[sort]['type'] == 'formula' else KeyTextTransform(sort, 'cells')
        if schema[sort]['type'] in ('number', 'points'): expr = Cast(expr, FloatField())
        records = records.annotate(sort_value=expr).order_by(*group_order, direction + 'sort_value', 'id')
    else: records = records.order_by(*group_order, 'position', 'id')
    aggregations = {}
    numeric = {k for k, f in schema.items() if f['type'] in ('number', 'points')}
    for key, field in schema.items():
        if field['type'] in ('number', 'points', 'formula'):
            expr = sql_expression(field['expression'], numeric) if field['type'] == 'formula' else Cast(KeyTextTransform(key, 'cells'), FloatField())
            aggregations[key + '_sum'] = Sum(expr)
            aggregations[key + '_avg'] = Avg(expr)
    groups = []
    if group_by:
        rows = filtered.order_by().values('cells__' + group_by).annotate(count=Count('id')).order_by('cells__' + group_by)[:100]
        groups = [{'value': row['cells__' + group_by], 'count': row['count']} for row in rows]
    try: offset = max(0, min(100000, int(params.get('offset', 0))))
    except (ValueError, TypeError) as error: raise WorkError('Invalid page offset.') from error
    total = filtered.count()
    limit = max(total, 1) if params.get('all') == '1' else 200
    page = list(records.prefetch_related('dependencies')[offset:offset + limit])
    return {'records': [record_json(r, table.fields) for r in page], 'total': total, 'offset': offset, 'limit': limit,
            'aggregates': filtered.aggregate(**aggregations) if aggregations else {}, 'groups': groups}


def validate_links(table, record, parent, blocked):
    target_ids = {identifier(v) for v in blocked}
    if parent: target_ids.add(identifier(parent))
    if record and record.id in target_ids: raise WorkError('A record cannot link to itself.')
    if table.records.filter(id__in=target_ids).count() != len(target_ids): raise WorkError('Relations must refer to records in this table.')
    if parent and record:
        ancestor = table.records.get(id=parent)
        seen = set()
        while ancestor:
            if ancestor.id == record.id or ancestor.id in seen: raise WorkError('Hierarchy cannot contain a cycle.')
            seen.add(ancestor.id)
            ancestor = table.records.filter(id=ancestor.parent_id).first() if ancestor.parent_id else None
    if record:
        pending = set(identifier(v) for v in blocked)
        seen = set()
        while pending:
            if record.id in pending: raise WorkError('Dependencies cannot contain a cycle.')
            seen |= pending
            pending = set(WorkRelation.objects.filter(source_id__in=pending).values_list('target_id', flat=True)) - seen


def mutate(user, board, table_id, data):
    with transaction.atomic():
        table = WorkTable.objects.select_for_update().filter(id=identifier(table_id), board_id=board['id']).first()
        if table is None: raise access.AccessError('Table not found.', 404)
        require_edit(table, user, board)
        after = None
        op = data.get('op')
        now = services.now_ms()
        if op == 'settings':
            if data.get('version') != table.version: raise access.AccessError('Table changed. Refresh before saving.', 409)
            before = describe(table, user, board)
            if 'ownerOnly' in data:
                if type(data['ownerOnly']) is not bool: raise WorkError('ownerOnly must be boolean.')
                if data['ownerOnly'] != table.owner_only:
                    if str(table.owner_id) != str(user.id) and access.role_for(user, board) < access.OWN: raise access.AccessError('Only the owner can change table permissions.', 403)
                    table.owner_only = data['ownerOnly']
            if 'name' in data: table.name = text(data['name'], 120) or 'Untitled table'
            if 'fields' in data:
                new_fields = fields(data['fields'])
                old = {f['id']: f for f in table.fields}
                for field in new_fields:
                    if field['id'] in old and old[field['id']]['type'] != field['type'] and table.records.exists():
                        raise WorkError('Create a new field to change the type of an existing field with records.')
                table.fields = new_fields
            if 'views' in data: table.views = views(data['views'], table.fields)
            history(table, user, table.id, 'settings', before, describe(table, user, board))
        elif op in ('add', 'update', 'delete'):
            record = None
            if op != 'add':
                record = table.records.prefetch_related('dependencies').filter(id=identifier(data.get('id'))).first()
                if record is None: raise access.AccessError('Record not found.', 404)
                if data.get('version') != record.version: raise access.AccessError('Record changed. Refresh before saving.', 409)
            before = record_json(record, table.fields) if record else None
            if op == 'delete':
                history(table, user, record.id, op, before, None)
                target = str(record.id)
                relations = [f['id'] for f in table.fields if f['type'] == 'relation']
                linked = Q(parent=record) | Q(id__in=WorkRelation.objects.filter(target=record).values('source_id'))
                for key in relations: linked |= Q(cells__contains={key: [target]})
                for other in table.records.filter(linked).exclude(id=record.id):
                    other.cells = {k: [v for v in value if v != target] if k in relations and isinstance(value, list) else value
                                   for k, value in other.cells.items()}
                    if other.parent_id == record.id: other.parent_id = None
                    other.version += 1
                    other.updated_at = now
                    other.save()
                record.delete()
            else:
                if op == 'add' and table.records.count() >= 10000: raise WorkError('Table record limit is 10000.')
                values = cells(data.get('cells', record.cells if record else {}), table.fields, record.cells if record else None)
                parent = data.get('parentId', str(record.parent_id) if record and record.parent_id else None)
                blocked = data.get('blockedBy', before['blockedBy'] if before else [])
                if not isinstance(blocked, list) or len(blocked) > 64 or any(not isinstance(v, str) for v in blocked): raise WorkError('Use at most 64 dependency record ids.')
                # Typed relation columns also use validated relation rows for dependencies.
                previous = set(relation_targets(record.cells, table.fields)) if record else set()
                blocked = list(dict.fromkeys([v for v in blocked if v not in previous] + relation_targets(values, table.fields)))
                validate_links(table, record, parent, blocked)
                position = data.get('position', record.position if record else table.records.count())
                if type(position) not in (int, float) or int(position) != position or not 0 <= position <= 100000: raise WorkError('Invalid record position.')
                if record:
                    record.cells, record.parent_id, record.position = values, identifier(parent) if parent else None, int(position)
                    record.version += 1
                    record.updated_at = now
                    record.save()
                else:
                    record = WorkRecord.objects.create(table=table, cells=values, parent_id=identifier(parent) if parent else None,
                                                       position=int(position), created_at=now, updated_at=now)
                WorkRelation.objects.filter(source=record).delete()
                WorkRelation.objects.bulk_create([WorkRelation(source=record, target_id=identifier(target)) for target in blocked])
                record = table.records.prefetch_related('dependencies').get(id=record.id)
                after = record_json(record, table.fields)
                history(table, user, record.id, op, before, after)
                from .work_notifications import changed
                changed(user, board, table, before, after)
        else: raise WorkError('Unknown table operation.')
        table.version += 1
        table.updated_at = now
        table.save()
        return {'table': describe(table, user, board), 'record': after}
