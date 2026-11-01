"""Validation of format objects (Docs, Slides, HTML embeds, draw.io diagrams) and the format fields on
other nodes. Mirrors src/lib/canvas/formats/validate.js; shared fixture cases hold both to one output."""

import re

FORMAT_KINDS = ('doc', 'deck', 'html', 'drawio')
FORMAT_STATUSES = ('draft', 'in_review', 'approved', 'done', 'outdated')
DOC_BLOCK_TYPES = ('p', 'h1', 'h2', 'h3', 'ul', 'ol', 'todo', 'quote', 'code', 'table', 'diagram')
SUGGESTION_KINDS = ('replace', 'delete')
FORMAT_DEFAULT_NAMES = {'doc': 'Untitled doc', 'deck': 'Untitled slides', 'html': 'HTML embed', 'drawio': 'Draw.io diagram'}

MAX_ID = 64
MAX_NAME = 120
MAX_DOC_BLOCKS = 400
MAX_BLOCK_TEXT = 5000
MAX_TABLE_ROWS = 20
MAX_TABLE_COLS = 8
MAX_CELL_TEXT = 500
MAX_SUGGESTIONS = 200
MAX_SLIDES = 100
MAX_LANES = 6
MAX_LANE_NAME = 60
MAX_NOTES = 5000
MAX_HTML = 50000
MAX_DRAWIO_XML = 100000
MAX_DRAWIO_PREVIEW = 100000
DRAWIO_PREVIEW_PREFIX = 'data:image/svg+xml;base64,'
MAX_SOURCE = 20000
MERMAID_KEY = re.compile(r'[A-Za-z0-9_\u00C0-\U0010FFFF]+(?:-[A-Za-z0-9_\u00C0-\U0010FFFF]+)*')


def _utf16(text):
    from .serialization import utf16_length
    return utf16_length(text)


def _well_formed(text):
    """`text` with each unpaired surrogate replaced by U+FFFD, as JavaScript's String.toWellFormed."""
    return text.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace')


def limited(value, maximum, fallback=''):
    return _well_formed(value) if isinstance(value, str) and _utf16(value) <= maximum else fallback


def identifier(value):
    return _well_formed(value) if isinstance(value, str) and 0 < _utf16(value) <= MAX_ID else None


def _finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value == value and value not in (float('inf'), float('-inf'))


def with_format_status(result, raw):
    if raw.get('status') in FORMAT_STATUSES:
        result['status'] = raw['status']
    return result


def with_diagram_source(result, raw):
    if raw.get('sourceKind') == 'mermaid' and isinstance(raw.get('source'), str) and _utf16(raw['source']) <= MAX_SOURCE:
        result['sourceKind'] = 'mermaid'
        result['source'] = _well_formed(raw['source'])
    return with_format_status(result, raw)


def with_screen_link(result, raw):
    value = identifier(raw.get('screenLink'))
    if value:
        result['screenLink'] = value
    return result


def with_mermaid_key(result, raw):
    value = identifier(raw.get('mermaidKey'))
    if value and MERMAID_KEY.fullmatch(value):
        result['mermaidKey'] = value
    return result


def _blocks(raw):
    from .serialization import with_marks
    blocks, seen = [], set()
    for item in (raw[:MAX_DOC_BLOCKS] if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        block_id = identifier(item.get('id'))
        if not block_id or block_id in seen or item.get('type') not in DOC_BLOCK_TYPES:
            continue
        seen.add(block_id)
        block = {'id': block_id, 'type': item['type']}
        if item['type'] == 'table':
            rows = []
            for row in (item['rows'][:MAX_TABLE_ROWS] if isinstance(item.get('rows'), list) else []):
                if isinstance(row, list):
                    rows.append([limited(cell, MAX_CELL_TEXT) for cell in row[:MAX_TABLE_COLS]])
            width = max([1] + [len(row) for row in rows])
            block['rows'] = [row + [''] * (width - len(row)) for row in rows] if rows else [['']]
        elif item['type'] == 'diagram':
            block['ref'] = identifier(item.get('ref')) or ''
        else:
            block['text'] = limited(item.get('text'), MAX_BLOCK_TEXT)
            with_marks(block, item)
            if item['type'] == 'todo' and item.get('checked') is True:
                block['checked'] = True
        blocks.append(block)
    return blocks or [{'id': 'b1', 'type': 'p', 'text': ''}]


def _suggestions(raw, block_ids):
    from .serialization import with_marks
    result, seen = [], set()
    for item in (raw[:MAX_SUGGESTIONS] if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        suggestion_id, block_id = identifier(item.get('id')), identifier(item.get('blockId'))
        if not suggestion_id or not block_id or suggestion_id in seen or block_id not in block_ids or item.get('kind') not in SUGGESTION_KINDS:
            continue
        seen.add(suggestion_id)
        suggestion = {'id': suggestion_id, 'blockId': block_id, 'kind': item['kind'],
                      'text': '' if item['kind'] == 'delete' else limited(item.get('text'), MAX_BLOCK_TEXT),
                      'by': limited(item.get('by'), MAX_ID), 'at': item['at'] if _finite(item.get('at')) else 0}
        if item['kind'] == 'replace':
            with_marks(suggestion, item)
        result.append(suggestion)
    return result


def _slides(raw):
    result, seen = [], set()
    for item in (raw[:MAX_SLIDES] if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        slide_id = identifier(item.get('id'))
        if not slide_id or slide_id in seen:
            continue
        seen.add(slide_id)
        result.append({'id': slide_id, 'title': limited(item.get('title'), MAX_NAME), 'frameId': identifier(item.get('frameId')) or '',
                       'notes': limited(item.get('notes'), MAX_NOTES), 'lane': identifier(item.get('lane')) or 'main'})
    return result


def _lanes(raw):
    result, seen = [], set()
    for item in (raw[:MAX_LANES] if isinstance(raw, list) else []):
        if not isinstance(item, dict):
            continue
        lane_id = identifier(item.get('id'))
        if not lane_id or lane_id in seen:
            continue
        seen.add(lane_id)
        result.append({'id': lane_id, 'name': limited(item.get('name'), MAX_LANE_NAME, 'Lane')})
    if not any(lane['id'] == 'main' for lane in result):
        result.insert(0, {'id': 'main', 'name': 'Main'})
    return result[:MAX_LANES]


def format_node(r, base):
    """The `format` node type; None when its kind is unknown."""
    kind = r.get('format')
    if kind not in FORMAT_KINDS:
        return None
    result = {**base, 'type': 'format', 'format': kind, 'name': limited(r.get('name'), MAX_NAME, FORMAT_DEFAULT_NAMES[kind])}
    with_format_status(result, r)
    if r.get('defaultView') is True:
        result['defaultView'] = True
        if r.get('viewLocked') is True:
            result['viewLocked'] = True
    if kind == 'doc':
        result['blocks'] = _blocks(r.get('blocks'))
        suggestions = _suggestions(r.get('suggestions'), {block['id'] for block in result['blocks']})
        if suggestions:
            result['suggestions'] = suggestions
    elif kind == 'deck':
        result['slides'] = _slides(r.get('slides'))
        result['lanes'] = _lanes(r.get('lanes'))
        lane_ids = {lane['id'] for lane in result['lanes']}
        for slide in result['slides']:
            if slide['lane'] not in lane_ids:
                slide['lane'] = 'main'
    elif kind == 'html':
        result['html'] = limited(r.get('html'), MAX_HTML)
    else:
        result['xml'] = limited(r.get('xml'), MAX_DRAWIO_XML)
        preview = limited(r.get('preview'), MAX_DRAWIO_PREVIEW)
        if preview.startswith(DRAWIO_PREVIEW_PREFIX):
            result['preview'] = preview
    return result


def drop_dangling_refs(nodes, identifiers):
    """Screen links and slide frames that point at nothing are dropped."""
    for item in nodes:
        if item.get('screenLink') and item['screenLink'] not in identifiers:
            del item['screenLink']
        if item['type'] == 'format' and item['format'] == 'deck':
            for slide in item['slides']:
                if slide['frameId'] and slide['frameId'] not in identifiers:
                    slide['frameId'] = ''
