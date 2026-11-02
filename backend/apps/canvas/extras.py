"""Ink strokes, grids, synced copies, the frame `hidden` flag and the board's visual notes.

Ported from src/lib/canvas/extras.js; both must accept and drop exactly the same input (the shared fixture
fixtures/format_v1_drawing_frames.json holds them to it).
"""
import math

MAX_INK_POINTS = 1500
MAX_INK_NUMBERS = MAX_INK_POINTS * 2
MAX_GRID_CELLS = 2500
MAX_GRID_SIDE = 100
MAX_CELL_TEXT = 1000
MAX_NOTES_TEXT = 200000
MAX_NOTES_REFS = 50
MAX_REF_LABEL = 120
MAX_SYNCED_NAME = 200
ID_LENGTH = 64


def _finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def _integer(value, low, high):
    """A JSON number JavaScript's Number.isInteger accepts, inside [low, high], as an int (else None)."""
    if type(value) is float and math.isfinite(value) and value.is_integer():
        value = int(value)
    if type(value) is int and low <= value <= high:
        return value
    return None


def _utf16_length(text):
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def _utf16_slice(text, limit):
    """JavaScript's text.slice(0, limit): the first `limit` UTF-16 code units."""
    if _utf16_length(text) <= limit:
        return text
    return text.encode('utf-16-le', 'surrogatepass')[:limit * 2].decode('utf-16-le', 'surrogatepass')


def _round1(value):
    # Math.round rounds halves up; Python's round() rounds them to even.
    return math.floor(value * 10 + 0.5) / 10


def _string(value, fallback):
    return value if isinstance(value, str) else fallback


def _identifier(value):
    return isinstance(value, str) and bool(value) and _utf16_length(value) <= ID_LENGTH


def ink(raw, base):
    pts = raw.get('pts')
    if not isinstance(pts, list) or len(pts) < 2 or len(pts) > MAX_INK_NUMBERS:
        return None
    if len(pts) % 2:
        pts = pts[:-1]
    if not all(_finite(value) for value in pts):
        return None
    width = raw.get('strokeWidth')
    result = {**base, 'type': 'ink', 'pts': [_round1(value) for value in pts],
              'vw': raw['vw'] if _finite(raw.get('vw')) and raw['vw'] > 0 else max(base['w'], 1),
              'vh': raw['vh'] if _finite(raw.get('vh')) and raw['vh'] > 0 else max(base['h'], 1),
              'stroke': _string(raw.get('stroke'), '#ffffff'),
              'strokeWidth': min(100, max(0.5, width)) if _finite(width) else 2}
    if raw.get('highlighter') is True:
        result['highlighter'] = True
    return result


def _cells(raw, rows, cols):
    if not isinstance(raw, list):
        return []
    seen, cells = set(), []
    for entry in raw:
        if len(cells) >= MAX_GRID_CELLS:
            break
        if not isinstance(entry, list) or len(entry) < 3:
            continue
        row, col, text = _integer(entry[0], 0, rows - 1), _integer(entry[1], 0, cols - 1), entry[2]
        if row is None or col is None or not isinstance(text, str) or (row, col) in seen:
            continue
        seen.add((row, col))
        cell = [row, col, _utf16_slice(text, MAX_CELL_TEXT)]
        fill = entry[3] if len(entry) > 3 else None
        color = entry[4] if len(entry) > 4 else None
        has_fill = isinstance(fill, str) and fill != ''
        has_color = isinstance(color, str) and color != ''
        if has_fill or has_color:
            cell.append(fill if has_fill else '')
        if has_color:
            cell.append(color)
        cells.append(cell)
    return cells


def _merges(raw, rows, cols):
    if not isinstance(raw, list):
        return []
    merges, taken = [], set()
    for entry in raw:
        if len(merges) >= MAX_GRID_CELLS:
            break
        if not isinstance(entry, list) or len(entry) < 4:
            continue
        row, col = _integer(entry[0], 0, rows - 1), _integer(entry[1], 0, cols - 1)
        row_span, col_span = _integer(entry[2], 1, rows), _integer(entry[3], 1, cols)
        if None in (row, col, row_span, col_span) or row_span * col_span < 2 or row + row_span > rows or col + col_span > cols:
            continue
        covered = {(i, j) for i in range(row, row + row_span) for j in range(col, col + col_span)}
        if covered & taken:
            continue
        taken |= covered
        merges.append([row, col, row_span, col_span])
    return merges


def grid(raw, base):
    rows, cols = _integer(raw.get('rows'), 1, MAX_GRID_SIDE), _integer(raw.get('cols'), 1, MAX_GRID_SIDE)
    if rows is None or cols is None or rows * cols > MAX_GRID_CELLS:
        return None
    return {**base, 'type': 'grid', 'rows': rows, 'cols': cols, 'cells': _cells(raw.get('cells'), rows, cols),
            'merges': _merges(raw.get('merges'), rows, cols), 'stroke': _string(raw.get('stroke'), 'rgba(255,255,255,0.35)')}


def synced(raw, base):
    board, source = raw.get('sourceBoardId'), raw.get('sourceNodeId')
    if not _identifier(board) or not _identifier(source):
        return None
    result = {**base, 'type': 'synced', 'sourceBoardId': board, 'sourceNodeId': source}
    if isinstance(raw.get('name'), str):
        result['name'] = _utf16_slice(raw['name'], MAX_SYNCED_NAME)
    return result


def notes(raw, marks):
    """The visual notes object, or None for nothing. `marks` is serialization.marks."""
    if not isinstance(raw, dict):
        return None
    text = _utf16_slice(raw['text'], MAX_NOTES_TEXT) if isinstance(raw.get('text'), str) else ''
    refs, seen = [], set()
    for item in raw.get('refs') if isinstance(raw.get('refs'), list) else []:
        if len(refs) >= MAX_NOTES_REFS:
            break
        if not isinstance(item, dict) or not _identifier(item.get('id')) or item['id'] in seen:
            continue
        seen.add(item['id'])
        refs.append({'id': item['id'], 'type': _utf16_slice(item['type'], 20) if isinstance(item.get('type'), str) else '',
                     'label': _utf16_slice(item['label'], MAX_REF_LABEL) if isinstance(item.get('label'), str) else ''})
    if not text and not refs:
        return None
    result = {'text': text}
    valid = marks(raw.get('marks'), text)
    if valid:
        result['marks'] = valid
    if refs:
        result['refs'] = refs
    if isinstance(raw.get('updatedBy'), str):
        result['updatedBy'] = raw['updatedBy']
    if _finite(raw.get('updatedAt')):
        result['updatedAt'] = raw['updatedAt']
    return result


def stamp_notes(stored, graph, actor, now):
    """`graph` with the visual notes' author and time set by the server: a changed note belongs to `actor`, an
    unchanged one keeps the stamp it has. Whatever a client sent for the stamp is ignored."""
    current = graph.get('notes')
    if not current:
        return graph
    old = stored.get('notes') or {}
    content = {key: value for key, value in current.items() if key not in ('updatedBy', 'updatedAt')}
    old_content = {key: value for key, value in old.items() if key not in ('updatedBy', 'updatedAt')}
    stamps = {'updatedBy': actor, 'updatedAt': now} if content != old_content else {key: old[key] for key in ('updatedBy', 'updatedAt') if key in old}
    return {**graph, 'notes': {**content, **stamps}}
