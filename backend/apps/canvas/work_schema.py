"""Bounded shared work-record schema. Also used by the table API."""
import math
import re

KINDS = ('columns', 'table', 'kanban', 'timeline', 'story', 'mindmap', 'org', 'chart')
FIELD_TYPES = ('text', 'number', 'select', 'date', 'people', 'points', 'formula', 'relation')


def text(value, limit=2000):
    return value[:limit] if isinstance(value, str) else ''


def clean_record(raw):
    result = {}
    for key, value in list((raw if isinstance(raw, dict) else {}).items())[:64]:
        if not re.fullmatch(r'[\w-]{1,64}', key, flags=re.ASCII):
            continue
        if isinstance(value, str):
            result[key] = text(value)
        elif isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            result[key] = value
        elif isinstance(value, list):
            result[key] = [text(v, 128) for v in value if isinstance(v, str)][:64]
    return result


def lanes(raw):
    return [{'id': text(v['id'], 64), 'name': text(v.get('name'), 120),
             'color': v['color'] if isinstance(v.get('color'), str) and re.fullmatch(r'#[0-9a-fA-F]{6}', v['color']) else '#dbeafe'}
            for v in (raw if isinstance(raw, list) else [])[:30] if isinstance(v, dict) and isinstance(v.get('id'), str)]


def clean_work_node(raw):
    if raw['type'] == 'card':
        return {'record': clean_record(raw.get('record'))}
    result = {'kind': raw.get('kind') if raw.get('kind') in KINDS else 'table', 'title': text(raw.get('title'), 120)}
    if isinstance(raw.get('datasetId'), str):
        result['datasetId'] = text(raw['datasetId'], 64)
    if result['kind'] == 'columns':
        result.update(lanes=lanes(raw.get('lanes')), swimlanes=lanes(raw.get('swimlanes')))
    return result
