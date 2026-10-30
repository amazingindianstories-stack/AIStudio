"""Canvas v1 coercion ported from src/lib/canvas/serialization.js."""
import json
import math
import re

from .svg_sanitize import sanitize_svg

NODE_TYPES = {'rect', 'ellipse', 'triangle', 'diamond', 'shape', 'text', 'sticky', 'stack', 'frame', 'image', 'erd', 'swimlane', 'diagram'}
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
# Mirrors src/lib/canvas/stickies.js, tags.js and fonts.js.
FONT_FAMILY = re.compile(r'[a-z0-9][a-z0-9-]{0,39}')
MAX_TAGS = 300
MAX_TAG_NAME = 60
MAX_TAG_ID = 64
MAX_NODE_TAGS = 8
MAX_REACTION_EMOJIS = 12
MAX_REACTION_EMOJI = 16
MAX_REACTION_VOTES = 1000
ARRAY_INDEX = re.compile(r'0|[1-9][0-9]*')
ANCHORS = {'auto', 'top', 'right', 'bottom', 'left', 'center'}
ROW_ANCHOR = re.compile(r'row:[a-zA-Z0-9_-]{1,64}:(?:left|right)')
STROKE_STYLES = {'dashed', 'dotted'}
CONNECTOR_SHAPES = {'curved', 'straight', 'orthogonal'}
CONNECTOR_CAPS = {'none', 'arrow', 'open-arrow', 'diamond', 'filled-diamond', 'circle',
                  'erd-one', 'erd-many', 'erd-only-one', 'erd-zero-or-one', 'erd-one-or-many', 'erd-zero-or-many'}
VIEWBOX_RE = re.compile(r'-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3}')
MAX_CUSTOM_SVG_UNITS = 51200


def valid_anchor(value):
    return isinstance(value, str) and (value in ANCHORS or bool(ROW_ANCHOR.fullmatch(value)))


def sanitized_custom_svg(svg):
    if not isinstance(svg, str) or not 0 < len(svg) <= MAX_CUSTOM_SVG_UNITS:
        return None
    try:
        return sanitize_svg(svg, fragment=True)[0]
    except ValueError:
        return None


def with_structured_theme(result, r):
    if r.get('strokeStyle') in STROKE_STYLES:
        result['strokeStyle'] = r['strokeStyle']
    for key in ('headerFill', 'color'):
        if isinstance(r.get(key), str):
            result[key] = r[key]
# The editor's JSON.stringify(data).length limit for a saved graph, in UTF-16 units, not counting the
# server stamps (content_length).
MAX_BOARD_JSON_UNITS = 2 * 1024 * 1024
# Per-object author and time fields the server owns (apps.canvas.activity).
# `textBy` is who last replaced the text (sticky author labels).
STAMP_KEYS = ('createdBy', 'createdAt', 'updatedBy', 'updatedAt', 'textBy')
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
    for key in ('createdBy', 'updatedBy', 'textBy'):
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


def with_font(result, raw):
    if isinstance(raw.get('fontFamily'), str) and FONT_FAMILY.fullmatch(raw['fontFamily']):
        result['fontFamily'] = raw['fontFamily']


def unique_strings(raw, limit, length=None):
    result = {}
    for value in raw if isinstance(raw, list) else []:
        if isinstance(value, str) and value and value not in result and (length is None or utf16_length(value) <= length):
            result[value] = None
            if len(result) == limit:
                break
    return list(result)


def reactions(raw):
    """`{emoji: [userId, ...]}`: each person's vote on one emoji, at most once."""
    if not isinstance(raw, dict):
        return None
    result = {}
    for emoji, voters in raw.items():
        if len(result) == MAX_REACTION_EMOJIS:
            break
        # An array-index key would change places in a JavaScript object.
        if not emoji or utf16_length(emoji) > MAX_REACTION_EMOJI or ARRAY_INDEX.fullmatch(emoji):
            continue
        valid = unique_strings(voters, MAX_REACTION_VOTES, MAX_TAG_ID)
        if valid:
            result[emoji] = valid
    return result or None


def with_sticky_extras(result, raw):
    """Sticky-only options, each present only when set."""
    for key in ('autoFit', 'showAuthor'):
        if raw.get(key) is True:
            result[key] = True
    tag_ids = unique_strings(raw.get('tagIds'), MAX_NODE_TAGS, MAX_TAG_ID)
    if tag_ids:
        result['tagIds'] = tag_ids
    valid = reactions(raw.get('reactions'))
    if valid:
        result['reactions'] = valid


def tags(raw):
    """The board's tag table: `[{id, name, color}]`, ids unique, names non-blank."""
    result, seen = [], set()
    for item in raw if isinstance(raw, list) else []:
        if len(result) == MAX_TAGS:
            break
        r = object_value(item)
        identifier, name, color = r.get('id'), r.get('name'), r.get('color')
        if not isinstance(identifier, str) or not identifier or utf16_length(identifier) > MAX_TAG_ID or identifier in seen:
            continue
        if not isinstance(name, str) or not name.strip(JS_WHITESPACE) or utf16_length(name) > MAX_TAG_NAME:
            continue
        seen.add(identifier)
        result.append({'id': identifier, 'name': name, 'color': color if isinstance(color, str) and HIGHLIGHT.fullmatch(color) else '#9ca3af'})
    return result


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
    if isinstance(r.get('diagramLayerId'), str) and 0 < len(r['diagramLayerId']) <= 64:
        result['diagramLayerId'] = r['diagramLayerId']
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
        if r.get('strokeStyle') in STROKE_STYLES:
            result['strokeStyle'] = r['strokeStyle']
        if kind == 'shape':
            tail = r.get('tail')
            if isinstance(tail, dict):
                if isinstance(tail.get('nodeId'), str) and tail['nodeId']:
                    result['tail'] = {'nodeId': tail['nodeId'], 'anchor': tail['anchor'] if valid_anchor(tail.get('anchor')) else 'auto'}
                elif finite(tail.get('x')) and finite(tail.get('y')):
                    result['tail'] = {'x': tail['x'], 'y': tail['y']}
            svg = sanitized_custom_svg(r.get('svg'))
            if svg:
                result['svg'] = svg
                vb = r.get('svgViewBox')
                if isinstance(vb, str) and len(vb) <= 64 and VIEWBOX_RE.fullmatch(vb):
                    result['svgViewBox'] = vb
                sn = r.get('shapeName')
                if isinstance(sn, str) and 0 < len(sn) <= 120:
                    result['shapeName'] = sn
        if isinstance(r.get('text'), str):
            result['text'] = r['text']
            with_marks(result, r)
        if finite(r.get('fontSize')):
            result['fontSize'] = r['fontSize']
        if isinstance(r.get('color'), str):
            result['color'] = r['color']
        # Shape text is centered unless aligned otherwise.
        if r.get('align') in ('left', 'center', 'right'):
            result['align'] = r['align']
        with_font(result, r)
    elif kind == 'text':
        result.update(text=string(r.get('text'), ''), fontSize=num(r.get('fontSize'), 16),
                      align=r.get('align') if r.get('align') in ('center', 'right') else 'left', color=string(r.get('color'), '#000000'))
        with_marks(result, r)
        with_font(result, r)
    elif kind == 'sticky':
        result.update(text=string(r.get('text'), ''), fill=string(r.get('fill'), '#fff59d'), fontSize=num(r.get('fontSize'), 16), color=string(r.get('color'), '#000000'))
        with_marks(result, r)
        with_font(result, r)
        with_sticky_extras(result, r)
    elif kind == 'stack':
        result['fill'] = string(r.get('fill'), '#fff59d')
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
    elif kind == 'erd':
        cols = int(r['columns']) if r.get('columns') in (1, 2, 3) else 3
        raw_rows = r.get('rows') if isinstance(r.get('rows'), list) else []
        rows = []
        for item in raw_rows[:100]:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
                continue
            raw_cells = item.get('cells')
            cells = [string(raw_cells[0] if len(raw_cells) > 0 else '', ''),
                     string(raw_cells[1] if len(raw_cells) > 1 else '', ''),
                     string(raw_cells[2] if len(raw_cells) > 2 else '', '')] if isinstance(raw_cells, list) else ['', '', '']
            rows.append({'id': item['id'], 'cells': cells})
        if not rows:
            rows.append({'id': 'r1', 'cells': ['PK', 'id', 'uuid']})
        result.update(name=string(r.get('name'), 'Entity'), columns=cols, rows=rows,
                      fill=string(r.get('fill'), '#18181f'), stroke=string(r.get('stroke'), '#6f9bd1'),
                      strokeWidth=num(r.get('strokeWidth'), 2))
        with_structured_theme(result, r)
    elif kind == 'swimlane':
        orientation = 'vertical' if r.get('orientation') == 'vertical' else 'horizontal'
        raw_lanes = r.get('lanes') if isinstance(r.get('lanes'), list) else []
        lanes = []
        for item in raw_lanes[:50]:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
                continue
            lanes.append({'id': item['id'], 'name': string(item.get('name'), 'Lane'), 'size': max(40, num(item.get('size'), 180))})
        if not lanes:
            lanes = [{'id': 'lane-1', 'name': 'Lane 1', 'size': 180}, {'id': 'lane-2', 'name': 'Lane 2', 'size': 180}]
        result.update(name=string(r.get('name'), 'Pool'), orientation=orientation, lanes=lanes,
                      fill=string(r.get('fill'), 'transparent'), stroke=string(r.get('stroke'), '#6b7280'),
                      strokeWidth=num(r.get('strokeWidth'), 2))
        with_structured_theme(result, r)
    elif kind == 'diagram':
        raw_layers = r.get('layers') if isinstance(r.get('layers'), list) else []
        layers = []
        for item in raw_layers[:30]:
            if not isinstance(item, dict) or not isinstance(item.get('id'), str) or not item['id']:
                continue
            layers.append({'id': item['id'], 'name': string(item.get('name'), 'Layer'), 'visible': item.get('visible') is not False})
        if not layers:
            layers = [{'id': 'default', 'name': 'Main layer', 'visible': True}]
        result.update(name=string(r.get('name'), 'Diagram'), layers=layers,
                      fill=string(r.get('fill'), 'rgba(15,23,42,0.45)'), stroke=string(r.get('stroke'), '#6f9bd1'),
                      strokeWidth=num(r.get('strokeWidth'), 2))
        with_structured_theme(result, r)
        if isinstance(r.get('containers'), list):
            containers = []
            for c in r['containers'][:50]:
                if not isinstance(c, dict) or not isinstance(c.get('id'), str) or not c['id']:
                    continue
                if not all(finite(c.get(key)) for key in ('x', 'y', 'w', 'h')):
                    continue
                containers.append({
                    'id': c['id'],
                    'name': string(c.get('name'), 'Container'),
                    'x': c['x'],
                    'y': c['y'],
                    'w': max(40, c['w']),
                    'h': max(40, c['h']),
                    'layerId': c['layerId'] if isinstance(c.get('layerId'), str) and c['layerId'] else 'default',
                })
            if containers:
                result['containers'] = containers
    return with_stamps(result, r)


def endpoint(raw, identifiers):
    r = object_value(raw)
    if isinstance(r.get('nodeId'), str):
        if r['nodeId'] not in identifiers:
            return None
        anchor = r.get('anchor')
        return {'nodeId': r['nodeId'], 'anchor': anchor if valid_anchor(anchor) else 'auto'}
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
    if r.get('shape') in CONNECTOR_SHAPES:
        result['shape'] = r['shape']
    if r.get('strokeStyle') in STROKE_STYLES:
        result['strokeStyle'] = r['strokeStyle']
    if r.get('startCap') in CONNECTOR_CAPS:
        result['startCap'] = r['startCap']
    if r.get('endCap') in CONNECTOR_CAPS:
        result['endCap'] = r['endCap']
    if isinstance(r.get('waypoints'), list):
        waypoints = [{'x': pt['x'], 'y': pt['y']} for pt in r['waypoints'][:64]
                     if isinstance(pt, dict) and finite(pt.get('x')) and finite(pt.get('y'))]
        if waypoints:
            result['waypoints'] = waypoints
    if isinstance(r.get('labels'), list):
        labels = []
        for lbl in r['labels'][:16]:
            if not isinstance(lbl, dict) or not isinstance(lbl.get('id'), str) or not lbl['id']:
                continue
            labels.append({
                'id': lbl['id'],
                'text': string(lbl.get('text'), ''),
                'position': clamp(num(lbl.get('position'), .5)),
                'orientation': 'aligned' if lbl.get('orientation') == 'aligned' else 'horizontal',
            })
        if labels:
            result['labels'] = labels
    return with_stamps(result, r)


def validate_state(raw):
    obj = object_value(raw)
    viewport = object_value(obj.get('viewport'))
    zoom = viewport.get('zoom')
    nodes = [valid for item in obj.get('nodes', []) if (valid := node(item)) is not None] if isinstance(obj.get('nodes'), list) else []
    identifiers = {item['id'] for item in nodes}
    table = tags(obj.get('tags'))
    tag_ids = {item['id'] for item in table}
    for item in nodes:
        if item['parentId'] and item['parentId'] not in identifiers:
            item['parentId'] = None
        # A tag deleted board-wide leaves no reference behind.
        if 'tagIds' in item:
            item['tagIds'] = [value for value in item['tagIds'] if value in tag_ids]
            if not item['tagIds']:
                del item['tagIds']
        if item['type'] == 'shape' and isinstance(item.get('tail'), dict) and 'nodeId' in item['tail'] and item['tail']['nodeId'] not in identifiers:
            del item['tail']
    connectors = [valid for item in obj.get('connectors', []) if (valid := connector(item, identifiers)) is not None] if isinstance(obj.get('connectors'), list) else []
    result = {'version': 1, 'viewport': {'x': num(viewport.get('x'), 0), 'y': num(viewport.get('y'), 0), 'zoom': zoom if finite(zoom) and zoom > 0 else 1},
              'nodes': nodes, 'connectors': connectors}
    # Present only once the board has a tag, so boards without tags keep their shape.
    if table:
        result['tags'] = table
    return result


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


def content_length(data):
    """The board's size against MAX_BOARD_JSON_UNITS: its JSON without the server stamps, so stamping
    an object never takes away room for content."""
    unstamped = dict(data)
    for key in ('nodes', 'connectors'):
        if isinstance(data.get(key), list):
            unstamped[key] = [{name: value for name, value in item.items() if name not in STAMP_KEYS}
                              if isinstance(item, dict) else item for item in data[key]]
    return json_length(unstamped)
