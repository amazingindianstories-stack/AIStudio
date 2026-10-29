"""Canvas v1 coercion ported from src/lib/canvas/serialization.js."""
import json
import math
import re

NODE_TYPES = {'rect', 'ellipse', 'triangle', 'diamond', 'shape', 'text', 'sticky', 'frame', 'image'}
SHAPE_TYPES = ('rect', 'ellipse', 'triangle', 'diamond', 'shape')
# Mirrors src/lib/canvas/shapes.js and src/lib/canvas/rich-text.js.
SHAPE_KIND = re.compile(r'[a-z][a-z0-9-]{0,39}')
MAX_MARKS = 4000
MAX_HREF_LENGTH = 2048
SIMPLE_MARKS = ('b', 'i', 'u', 's')
# ASCII-only scheme letters without re.IGNORECASE, which folds some non-ASCII
# letters onto ASCII ones where JavaScript does not.
SAFE_HREF = re.compile(r'(?:[hH][tT][tT][pP][sS]?://|[mM][aA][iI][lL][tT][oO]:)[^\x00-\x20\x7f]+')
HIGHLIGHT = re.compile(r'#[0-9a-fA-F]{6}')
ANCHORS = {'auto', 'top', 'right', 'bottom', 'left', 'center'}
# The editor's JSON.stringify(data).length limit for a saved graph, in UTF-16 units.
MAX_BOARD_JSON_UNITS = 2 * 1024 * 1024
JS_WHITESPACE = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff'


def empty_state():
    return {'version': 1, 'viewport': {'x': 0, 'y': 0, 'zoom': 1}, 'nodes': [], 'connectors': []}


def finite(value):
    return type(value) in (int, float) and math.isfinite(value)


def num(value, fallback):
    return value if finite(value) else fallback


def string(value, fallback):
    return value if isinstance(value, str) else fallback


def object_value(value):
    # JS arrays are objects but named property lookups on JSON arrays are absent.
    return value if isinstance(value, dict) else {}


def clamp(value, lower=0, upper=1):
    return min(upper, max(lower, value))


def utf16_length(text):
    return len(text.encode('utf-16-le', 'surrogatepass')) // 2


def integer(value):
    """A JSON number that JavaScript's Number.isInteger accepts, as an int."""
    if type(value) is int:
        return value
    if type(value) is float and math.isfinite(value) and value.is_integer():
        return int(value)
    return None


def marks(raw, text):
    """Rich-text ranges over `text` in UTF-16 code units; see rich-text.js."""
    if not isinstance(raw, list):
        return None
    limit = utf16_length(text)
    result = []
    for entry in raw[:MAX_MARKS]:
        if not isinstance(entry, list) or len(entry) < 3:
            continue
        start, end, kind = integer(entry[0]), integer(entry[1]), entry[2]
        if start is None or end is None:
            continue
        start, end = max(0, start), min(limit, end)
        if start >= end or not isinstance(kind, str):
            continue
        value = entry[3] if len(entry) > 3 else None
        if kind in SIMPLE_MARKS:
            result.append([start, end, kind])
        elif kind == 'h' and isinstance(value, str) and HIGHLIGHT.fullmatch(value):
            result.append([start, end, 'h', value])
        elif kind == 'a' and isinstance(value, str) and len(value) <= MAX_HREF_LENGTH and SAFE_HREF.fullmatch(value):
            result.append([start, end, 'a', value])
    return result or None


def with_stamps(result, raw):
    """Server stamps (apps.canvas.activity) ride along; a save replaces them with the server's own."""
    for key in ('createdBy', 'updatedBy'):
        if isinstance(raw.get(key), str):
            result[key] = raw[key]
    for key in ('createdAt', 'updatedAt'):
        if finite(raw.get(key)):
            result[key] = raw[key]
    return result


def with_marks(result, raw):
    valid = marks(raw.get('marks'), result['text'])
    if valid:
        result['marks'] = valid


def node(raw):
    r = object_value(raw)
    kind = r.get('type')
    if not isinstance(kind, str) or kind not in NODE_TYPES:
        return None
    if not isinstance(r.get('id'), str) or not r['id']:
        return None
    if not all(finite(r.get(key)) for key in ('x', 'y', 'w', 'h')):
        return None
    result = {key: r[key] for key in ('id', 'x', 'y', 'w', 'h')}
    result.update(parentId=string(r.get('parentId'), None), groupId=string(r.get('groupId'), None))
    if finite(r.get('opacity')):
        result['opacity'] = clamp(r['opacity'])
    result['type'] = kind
    if kind in SHAPE_TYPES:
        # Path shapes name a catalogue outline; unknown well-formed kinds are kept.
        if kind == 'shape':
            if not isinstance(r.get('shape'), str) or not SHAPE_KIND.fullmatch(r['shape']):
                return None
            result['shape'] = r['shape']
        result.update(fill=string(r.get('fill'), '#ffffff'), stroke=string(r.get('stroke'), '#000000'), strokeWidth=num(r.get('strokeWidth'), 1))
        if kind == 'rect' and finite(r.get('cornerRadius')):
            result['cornerRadius'] = r['cornerRadius']
        if isinstance(r.get('text'), str):
            result['text'] = r['text']
            with_marks(result, r)
        if finite(r.get('fontSize')):
            result['fontSize'] = r['fontSize']
        if isinstance(r.get('color'), str):
            result['color'] = r['color']
    elif kind == 'text':
        result.update(text=string(r.get('text'), ''), fontSize=num(r.get('fontSize'), 16),
                      align=r.get('align') if r.get('align') in ('center', 'right') else 'left', color=string(r.get('color'), '#000000'))
        with_marks(result, r)
    elif kind == 'sticky':
        result.update(text=string(r.get('text'), ''), fill=string(r.get('fill'), '#fff59d'), fontSize=num(r.get('fontSize'), 16), color=string(r.get('color'), '#000000'))
        with_marks(result, r)
    elif kind == 'frame':
        result.update(name=string(r.get('name'), 'Frame'), fill=string(r.get('fill'), 'transparent'), stroke=string(r.get('stroke'), '#000000'))
    elif kind == 'image':
        src = string(r.get('src'), '')
        if not src.startswith('/api/media/'):
            return None
        result.update(src=src, aspectLocked=r.get('aspectLocked') is not False)
        if isinstance(r.get('alt'), str):
            result['alt'] = r['alt']
        for key in ('naturalW', 'naturalH'):
            if finite(r.get(key)):
                result[key] = r[key]
        if isinstance(r.get('crop'), (dict, list)):
            crop = object_value(r['crop'])
            result['crop'] = {'x': clamp(num(crop.get('x'), .5)), 'y': clamp(num(crop.get('y'), .5)), 'zoom': clamp(num(crop.get('zoom'), 1), 1, 8)}
    return with_stamps(result, r)


def endpoint(raw, identifiers):
    r = object_value(raw)
    if isinstance(r.get('nodeId'), str):
        if r['nodeId'] not in identifiers:
            return None
        anchor = r.get('anchor')
        return {'nodeId': r['nodeId'], 'anchor': anchor if isinstance(anchor, str) and anchor in ANCHORS else 'auto'}
    if finite(r.get('x')) and finite(r.get('y')):
        return {'x': r['x'], 'y': r['y']}
    return None


def connector(raw, identifiers):
    r = object_value(raw)
    if not isinstance(r.get('id'), str) or not r['id']:
        return None
    start, end = endpoint(r.get('from'), identifiers), endpoint(r.get('to'), identifiers)
    if start is None or end is None:
        return None
    result = {'id': r['id'], 'from': start, 'to': end, 'kind': 'line' if r.get('kind') == 'line' else 'arrow',
              'stroke': string(r.get('stroke'), '#000000'), 'strokeWidth': num(r.get('strokeWidth'), 2)}
    if finite(r.get('opacity')):
        result['opacity'] = clamp(r['opacity'])
    return with_stamps(result, r)


def validate_state(raw):
    obj = object_value(raw)
    viewport = object_value(obj.get('viewport'))
    zoom = viewport.get('zoom')
    nodes = [valid for item in obj.get('nodes', []) if (valid := node(item)) is not None] if isinstance(obj.get('nodes'), list) else []
    identifiers = {item['id'] for item in nodes}
    for item in nodes:
        if item['parentId'] and item['parentId'] not in identifiers:
            item['parentId'] = None
    connectors = [valid for item in obj.get('connectors', []) if (valid := connector(item, identifiers)) is not None] if isinstance(obj.get('connectors'), list) else []
    return {'version': 1, 'viewport': {'x': num(viewport.get('x'), 0), 'y': num(viewport.get('y'), 0), 'zoom': zoom if finite(zoom) and zoom > 0 else 1},
            'nodes': nodes, 'connectors': connectors}


def _number_text(value):
    # JSON.parse uses binary64; JSON.stringify uses decimal within [1e-6,1e21).
    value = float(value)
    if not math.isfinite(value):
        return 'null'
    if value == 0:
        return '0'
    sign = '-' if value < 0 else ''
    raw = repr(abs(value)).lower()
    mantissa, _, exponent = raw.partition('e')
    whole, _, fraction = mantissa.partition('.')
    digits = (whole + fraction).lstrip('0')
    position = len(whole) + int(exponent or 0)
    if whole == '0':
        leading = len(fraction) - len(fraction.lstrip('0'))
        position = -leading
    digits = digits.rstrip('0') or '0'
    if 1e-6 <= abs(value) < 1e21:
        if position <= 0:
            return sign + '0.' + '0' * -position + digits
        if position >= len(digits):
            return sign + digits + '0' * (position - len(digits))
        return sign + digits[:position] + '.' + digits[position:]
    exp = position - 1
    return sign + digits[0] + ('.' + digits[1:] if len(digits) > 1 else '') + 'e' + ('+' if exp >= 0 else '-') + str(abs(exp))


def js_json(value):
    """Compact JSON with JS number/Unicode spelling for the source size gate."""
    if value is None:
        return 'null'
    if value is True:
        return 'true'
    if value is False:
        return 'false'
    if isinstance(value, (int, float)):
        return _number_text(value)
    if isinstance(value, str):
        encoded = json.dumps(value, ensure_ascii=False)
        return ''.join(f'\\u{ord(char):04x}' if 0xd800 <= ord(char) <= 0xdfff else char for char in encoded)
    if isinstance(value, list):
        return '[' + ','.join(js_json(item) for item in value) + ']'
    return '{' + ','.join(js_json(key) + ':' + js_json(item) for key, item in value.items()) + '}'


def json_length(value):
    return len(js_json(value).encode('utf-16-le')) // 2
