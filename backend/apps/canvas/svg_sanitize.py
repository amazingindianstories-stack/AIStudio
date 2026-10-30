"""Server-side SVG sanitizer for custom shape packs (line 175).

Accepts SVG files up to 50 KB, rejects XML entities/DOCTYPE, strips scripts,
event handlers, external URLs and non-vector elements, and returns normalized
inner vector markup + viewBox.
"""
import re
import xml.etree.ElementTree as ET

MAX_SVG_BYTES = 50 * 1024
MAX_SHAPES_PER_PACK = 100

ALLOWED_TAGS = {
    'svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'use',
}

ALLOWED_ATTRS = {
    'viewBox', 'd', 'points', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
    'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height',
    'fill', 'fill-rule', 'fill-opacity',
    'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
    'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'stroke-opacity',
    'opacity', 'transform', 'id', 'clip-path', 'mask',
    'gradientUnits', 'gradientTransform', 'spreadMethod',
    'offset', 'stop-color', 'stop-opacity', 'preserveAspectRatio', 'href',
}

FORBIDDEN_XML_RE = re.compile(r'<!\s*(?:DOCTYPE|ENTITY)\b', re.IGNORECASE)
SAFE_VIEWBOX_RE = re.compile(r'^\s*-?\d+(?:\.\d+)?[\s,]+-?\d+(?:\.\d+)?[\s,]+\d+(?:\.\d+)?[\s,]+\d+(?:\.\d+)?\s*$')
NUM_PREFIX_RE = re.compile(r'^\s*(\d+(?:\.\d+)?)')
DANGEROUS_VALUE_RE = re.compile(r'(?:javascript\s*:|data\s*:\s*text/html|vbscript\s*:|expression\s*\()', re.IGNORECASE)
EXTERNAL_URL_RE = re.compile(r'url\s*\(\s*[\'"]?\s*(?!#)', re.IGNORECASE)


def _local_name(tag):
    if not isinstance(tag, str):
        return ''
    if '}' in tag:
        return tag.split('}', 1)[1]
    if ':' in tag:
        return tag.split(':', 1)[1]
    return tag


def _clean_element(elem):
    tag = _local_name(elem.tag)
    if tag not in ALLOWED_TAGS:
        return None
    clean = ET.Element(tag)
    for raw_key, raw_val in elem.attrib.items():
        key = _local_name(raw_key)
        if key.lower().startswith('on'):
            continue
        if key not in ALLOWED_ATTRS:
            continue
        val = str(raw_val).strip()
        if DANGEROUS_VALUE_RE.search(val) or EXTERNAL_URL_RE.search(val):
            continue
        if key == 'href' and not val.startswith('#'):
            continue
        clean.set(key, val)
    for child in list(elem):
        cleaned_child = _clean_element(child)
        if cleaned_child is not None:
            clean.append(cleaned_child)
    return clean


def _extract_viewbox(root):
    vb = root.get('viewBox') or root.get('viewbox')
    if vb and SAFE_VIEWBOX_RE.match(vb):
        parts = re.split(r'[\s,]+', vb.strip())
        if len(parts) == 4 and float(parts[2]) > 0 and float(parts[3]) > 0:
            return ' '.join(parts)
    w_match = NUM_PREFIX_RE.match(root.get('width') or '')
    h_match = NUM_PREFIX_RE.match(root.get('height') or '')
    if w_match and h_match:
        w = float(w_match.group(1))
        h = float(h_match.group(1))
        if w > 0 and h > 0:
            return f'0 0 {w:g} {h:g}'
    return '0 0 100 100'


def sanitize_svg(raw_svg):
    """Validate and sanitize an SVG string. Returns (inner_svg, view_box) or raises ValueError."""
    if not isinstance(raw_svg, str):
        raise ValueError('SVG content must be a string.')
    trimmed = raw_svg.strip()
    if not trimmed:
        raise ValueError('SVG content is empty.')
    encoded = trimmed.encode('utf-8', errors='replace')
    if len(encoded) > MAX_SVG_BYTES:
        raise ValueError('SVG exceeds the 50 KB limit.')
    if FORBIDDEN_XML_RE.search(trimmed):
        raise ValueError('SVG may not contain DOCTYPE or ENTITY declarations.')
    source = trimmed if '<svg' in trimmed.lower() else f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">{trimmed}</svg>'
    try:
        root = ET.fromstring(source)
    except ET.ParseError as exc:
        raise ValueError('Invalid SVG XML.') from exc
    if _local_name(root.tag).lower() != 'svg':
        raise ValueError('Root element must be <svg>.')
    view_box = _extract_viewbox(root)
    cleaned_root = _clean_element(root)
    if cleaned_root is None or len(cleaned_root) == 0:
        raise ValueError('SVG contains no supported vector elements.')
    inner = ''.join(ET.tostring(child, encoding='unicode', method='xml') for child in list(cleaned_root))
    if not inner:
        raise ValueError('SVG contains no supported vector elements.')
    return inner, view_box
